"""
Privacy-Preserving Vision Agent — Server (SIH PS 26171)
FastAPI Backend with Multi-VLM: Google Gemini (AI Studio) -> Groq -> OpenAI -> Smart Mock
"""

import base64
import io
import json
import os
import re
import threading
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from PIL import Image
    _PIL_AVAILABLE = True
except ImportError:
    _PIL_AVAILABLE = False
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# Load environment variables from .env
load_dotenv(Path(__file__).parent / ".env", override=True)

app = FastAPI(title="VisionVault Privacy Agent Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ensure logs directory exists
LOGS_DIR = Path(__file__).parent / "logs"
LOGS_DIR.mkdir(parents=True, exist_ok=True)
SESSION_LOG = LOGS_DIR / "session.jsonl"

def log_session_event(event_type: str, data: Dict[str, Any]):
    try:
        with open(SESSION_LOG, "a", encoding="utf-8") as f:
            entry = {
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "event": event_type,
                "data": data
            }
            f.write(json.dumps(entry) + "\n")
    except Exception as e:
        print(f"[server-log] Failed to write log: {e}")

# ── Backend Selection ────────────────────────────────────────────────────────
# Chain: Ollama (Qwen2.5-VL 7B) -> OpenRouter -> Gemini -> mock
BACKEND = "mock"
gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
openrouter_key = os.getenv("OPENROUTER_API_KEY", "").strip()
ollama_host = os.getenv("OLLAMA_HOST", "").strip()

if ollama_host:
    BACKEND = "ollama"
    print(f"[server] [OK] Tier 1: Ollama ({ollama_host})")
elif openrouter_key:
    BACKEND = "openrouter"
    print(f"[server] [OK] Tier 2: OpenRouter ({os.getenv('OPENROUTER_MODEL', 'google/gemini-2.5-flash')})")
elif gemini_key:
    BACKEND = "gemini"
    print(f"[server] [OK] Tier 3: Google Gemini ({os.getenv('GEMINI_MODEL', 'gemini-2.0-flash')})")
else:
    print("[server] [INFO] Backend: Deterministic rule-based planner (no API key configured)")

# ── Schemas ──────────────────────────────────────────────────────────────────
class Mark(BaseModel):
    id: int
    role: Optional[str] = "element"
    box: Optional[Dict[str, Any]] = None
    label: Optional[str] = None

class StepAction(BaseModel):
    type: str  # "click" | "type" | "scroll" | "select" | "press_key" | "done"
    target: Optional[int] = None
    value: Optional[str] = None
    use_vault_field: Optional[str] = None
    reasoning: Optional[str] = None

class StepResponse(BaseModel):
    reasoning: str
    action: StepAction
    # Which tier of the planning chain answered. Metadata about the server's own routing —
    # it carries nothing about the page or the user — and the panel shows it so a silent
    # failover to the local model is visible rather than mysterious.
    tier: Optional[str] = None

class PageInfo(BaseModel):
    """Non-sensitive page context sent by the extension on every step.

    Deliberately excludes query strings, fragments and page text, so no PII can reach the
    server through this channel. Modelled explicitly (rather than a free-form dict) so the
    contract between extension and server is enforced by validation."""
    title: Optional[str] = None
    url: Optional[str] = None
    url_path: Optional[str] = None
    scroll_y: Optional[float] = None
    page_height: Optional[float] = None
    viewport_height: Optional[float] = None
    viewport_width: Optional[float] = None
    device_pixel_ratio: Optional[float] = None

class TaskHints(BaseModel):
    """What the client already worked out from the user's own instruction.

    The client parses the instruction locally (extension/task-planner.js) and passes the
    result through so the model does not have to re-derive it. Nothing here is new
    information: it is a restatement of `task`, which the server already receives."""
    search_query: Optional[str] = None
    site: Optional[str] = None
    open_targets: Optional[List[str]] = None
    from_city: Optional[str] = None
    to_city: Optional[str] = None
    date: Optional[str] = None
    category: Optional[str] = None
    recipient: Optional[str] = None
    message: Optional[str] = None
    wants_shop: Optional[bool] = None
    wants_filter: Optional[bool] = None
    wants_add_to_cart: Optional[bool] = None
    max_price: Optional[float] = None
    min_rating: Optional[float] = None
    wants_best: Optional[bool] = None
    wants_star: Optional[bool] = None
    wants_fork: Optional[bool] = None
    wants_clone: Optional[bool] = None
    wants_issue: Optional[bool] = None
    wants_pr: Optional[bool] = None
    wants_non_stop: Optional[bool] = None
    wants_sort: Optional[bool] = None
    sort: Optional[str] = None

class Progress(BaseModel):
    """What the instruction has achieved so far, as observed by the client.

    `searched` means the agent typed something; `query_landed` means the client verified the
    query actually reached the page (a field, the URL or the title). Only the latter makes a
    search task complete — without the distinction the planner declared success on pages where
    the value had gone into an autocomplete widget and nothing ran."""
    navigated: bool = False
    searched: bool = False
    query_landed: bool = Field(default=False, alias="queryLanded")
    scrolled: bool = False
    filled_any: bool = Field(default=False, alias="filledAny")
    opened: List[str] = []
    from_typed: bool = Field(default=False, alias="fromTyped")
    to_typed: bool = Field(default=False, alias="toTyped")
    booking_step: int = Field(default=0, alias="bookingStep")
    cart_added: bool = Field(default=False, alias="cartAdded")
    product_opened: bool = Field(default=False, alias="productOpened")
    filter_applied: bool = Field(default=False, alias="filterApplied")

    model_config = {"populate_by_name": True, "extra": "ignore"}


class AgentStepRequest(BaseModel):
    redactedImage: Optional[str] = None
    image: Optional[str] = None
    marks: List[Mark] = []
    task: str
    filled_mark_ids: Optional[List[int]] = []
    step: Optional[int] = 1
    page_info: Optional[PageInfo] = None
    task_hints: Optional[TaskHints] = None
    progress: Optional[Progress] = None

BOOKING_RE = re.compile(
    r"\b(book|flight|hotel|train|bus|cab|ticket|reserve|makemytrip|goibibo|irctc|redbus|cleartrip)\b",
    re.I
)


def describe_hints(hints: Optional[TaskHints], task: str = "") -> str:
    """Renders the client's parse of the instruction into the prompt.

    For booking/travel tasks the search_query hint is suppressed — it would tell the model
    to look for a single search box, but booking sites use separate From/To city fields.
    """
    if not hints:
        return ""
    lines = []
    booking = bool(BOOKING_RE.search(task or ""))
    if hints.search_query and not booking:
        lines.append(
            'SEARCH QUERY (already extracted from the user\'s words by the client):\n'
            '  "%s"\n'
            '  If you type into a search box, use EXACTLY this string. Do not add the rest of\n'
            '  the sentence: "and show me", "please", and similar words are how the user talks\n'
            '  to you, not part of what they want searched.' % hints.search_query
        )
    if hints.wants_add_to_cart or hints.wants_shop or hints.wants_filter:
        crit = []
        if hints.max_price:
            crit.append(f"budget <= ₹{int(hints.max_price)}")
        if hints.min_rating:
            crit.append(f"rating >= {hints.min_rating}")
        if hints.wants_best:
            crit.append("pick best among them")
        if hints.wants_filter:
            crit.append("apply price filter")
        crit_str = f" with criteria: {', '.join(crit)}" if crit else ""
        lines.append(
            f"E-COMMERCE GOAL: Search for '{hints.search_query or 'product'}'{crit_str}.\n"
            + ("On results: apply requested price filter and select matching product.\n" if hints.wants_filter else "On results: select and open the highest-rated product matching constraints.\n")
            + ("On product page: click 'Add to Cart' and finish." if hints.wants_add_to_cart else ("Stop once filter is applied or product opened." if hints.wants_filter else "Stop once product is opened."))
        )
    if hints.open_targets:
        lines.append("AFTER SEARCHING, the user asked to open: %s" % ", ".join(hints.open_targets))
    if not lines and not booking:
        lines.append("The instruction contains no search query.")
    return "\n".join(lines)

FILLABLE_ROLES = {"input:text", "input:search", "input:email", "input:tel",
                  "input:password", "textarea", "editable", "combobox"}
SELECT_ROLES = {"select", "input:select", "combobox"}
CLICKABLE_ROLES = {"link", "button", "clickable", "input:submit", "input:checkbox", "input:radio", "checkbox", "radio"}
SEARCH_LABEL_RE = re.compile(r"search|find|query|keyword|looking for|explore", re.I)


def extract_travel_entities(task: str) -> dict:
    """Extracts origin city (from_city), destination city (to_city), date, and service category from task string."""
    t = (task or "").strip()
    entities = {"from_city": None, "to_city": None, "date": None, "category": None}

    if re.search(r"\b(hotels?|homestays?|villas?|resorts?|rooms?|lodging)\b", t, re.I):
        entities["category"] = "hotels"
    elif re.search(r"\b(trains?|rail|irctc)\b", t, re.I):
        entities["category"] = "trains"
    elif re.search(r"\b(buses?|bus|volvo)\b", t, re.I):
        entities["category"] = "buses"
    elif re.search(r"\b(cabs?|taxi|car rental)\b", t, re.I):
        entities["category"] = "cabs"
    elif re.search(r"\b(flights?|flying|fly|airline|airlines?|airways?|airport|airports?)\b", t, re.I):
        entities["category"] = "flights"
    elif re.search(r"\b(makemytrip|goibibo|cleartrip|expedia|booking\.com)\b", t, re.I):
        entities["category"] = "flights"

    # Only look for origin/destination if travel context is present or explicit "from X to Y" syntax
    is_travel = bool(entities["category"]) or bool(re.search(r"\b(book|tickets?|travel|trip|vacation)\b", t, re.I))

    from_to = re.search(r"\bfrom\s+([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s+(?:on|for|date|and|,|tickets?|flights?)|$)", t, re.I)
    to_from = re.search(r"\bto\s+([a-zA-Z\s]+?)\s+from\s+([a-zA-Z\s]+?)(?:\s+(?:on|for|date|and|,|tickets?|flights?)|$)", t, re.I)
    bare_to = re.search(r"\b(?:flights?|tickets?|cabs?|bus|trains?)\s+(?:from\s+)?([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)(?:\s+(?:on|for|date|and|,)|$)", t, re.I) or \
              re.search(r"\b([a-zA-Z\s]+?)\s+to\s+([a-zA-Z\s]+?)\s+(?:flights?|tickets?|cabs?|bus|trains?)\b", t, re.I)

    if from_to:
        entities["from_city"] = from_to.group(1).strip()
        entities["to_city"] = from_to.group(2).strip()
        if not entities["category"]: entities["category"] = "flights"
    elif to_from:
        entities["to_city"] = to_from.group(1).strip()
        entities["from_city"] = to_from.group(2).strip()
        if not entities["category"]: entities["category"] = "flights"
    elif bare_to:
        entities["from_city"] = bare_to.group(1).strip()
        entities["to_city"] = bare_to.group(2).strip()
        if not entities["category"]: entities["category"] = "flights"
    elif is_travel:
        m_to = re.search(r"\bto\s+([a-zA-Z\s]+?)(?:\s+(?:on|for|date|and|,|tickets?|flights?)|$)", t, re.I)
        m_from = re.search(r"\bfrom\s+([a-zA-Z\s]+?)(?:\s+(?:on|for|date|and|,|tickets?|flights?)|$)", t, re.I)
        if m_to: entities["to_city"] = m_to.group(1).strip()
        if m_from: entities["from_city"] = m_from.group(1).strip()

    for k in ["from_city", "to_city"]:
        if entities[k]:
            entities[k] = re.sub(r"^(?:the|a|an)\s+", "", entities[k], flags=re.I)
            entities[k] = re.sub(r"\s+(?:flights?|tickets?|cabs?|bus|trains?|hotels?)$", "", entities[k], flags=re.I).strip()

    return entities


def _is_message_send_button(m: Mark) -> bool:
    """Strictly matches the message send button, avoiding attachments like 'Send document'."""
    label = (m.label or "").strip().lower()
    role = (m.role or "").lower()
    if any(w in label for w in ["document", "contact", "photo", "video", "location", "file", "media", "audio", "voice", "call", "new"]):
        return False
    if label in ("send", "send message", "send msg", "send (enter)"):
        return True
    if re.search(r"^\s*send(\s+message)?\s*$", label, re.I):
        return True
    return False


def rank_marks_for_task(marks: List[Mark], task: str, category: Optional[str] = None, task_hints: Optional[TaskHints] = None, progress: Optional[Progress] = None) -> List[Mark]:
    """Sorts marks so task-relevant targets (tabs, inputs, buttons, suggestions) appear first."""
    entities = extract_travel_entities(task)
    search_q = extract_search_query(task)
    wants_add_to_cart = bool(task_hints and task_hints.wants_add_to_cart) or bool(re.search(r"\b(add\s+to\s+cart|add\s+to\s+basket|buy\s+now)\b", task or "", re.I))

    has_travel_intent = bool(
        category or
        entities.get("category") or
        entities.get("from_city") or
        entities.get("to_city") or
        re.search(r"\b(flights?|hotels?|airports?|airlines?|makemytrip|goibibo|cleartrip|irctc|redbus)\b", task or "", re.I)
    )
    cat = (category or entities.get("category") or "flights") if has_travel_intent else None
    from_city = (entities.get("from_city") or "").lower()
    to_city = (entities.get("to_city") or "").lower()

    def score_mark(m: Mark) -> int:
        label = (m.label or "").lower()
        role = (m.role or "").lower()
        score = 0

        # Messaging / Chat platform prioritization (WhatsApp, Telegram, etc.):
        is_msg_task = bool(re.search(r"\b(whatsapp|telegram|slack|message|msg|send\s+.*to|chat|text\s+.*to)\b", task or "", re.I))
        if is_msg_task:
            # 1. Real Send message button gets highest priority
            if _is_message_send_button(m):
                return 800
            # 2. Message input box
            if role == "editable" or "type a message" in label:
                return 600
            # 3. Search contacts input ("Search or start new chat")
            if ("search" in label and role in FILLABLE_ROLES) or "search or start new chat" in label:
                return 400
            # 4. Back button / Chats tab (to recover from dialpad or wrong views)
            if re.search(r"^\s*(back|<|←)\s*$", label) or re.search(r"^\s*chats?\b", label):
                return 300
            # 5. Penalize dialpad and non-messaging items on WhatsApp
            if any(w in label for w in ["send document", "add contact", "new call", "ask meta ai", "go to calls", "enter a phone number", "phone number"]):
                return -1000

        # E-commerce & general search query prioritization:
        if search_q and not has_travel_intent and not is_msg_task:
            # If user wants to add to cart, heavily boost Add to Cart buttons
            if wants_add_to_cart and any(w in label for w in ["add to cart", "add to basket", "buy now"]):
                return 800

            query_landed = bool(progress and progress.query_landed)
            if not query_landed:
                # 1. Heavily boost actual search inputs
                if _is_search_mark(m) and role in FILLABLE_ROLES:
                    return 500
                # 2. Search submit buttons
                if any(w in label for w in ["search", "find", "go"]) and any(w in role for w in ["button", "submit", "clickable"]):
                    return 200
            else:
                # If filter is requested and not yet applied, boost price filter dropdowns and controls
                filter_applied = bool(progress and getattr(progress, "filter_applied", False))
                if (task_hints and (task_hints.wants_filter or task_hints.max_price)) and not filter_applied:
                    if role in SELECT_ROLES or any(w in label for w in ["min", "max", "to", "price", "filter", "under", "₹"]):
                        score += 450
                # Boost candidate product links on results page
                if role in ["link", "clickable"] and len(label) > 15:
                    score += 250

            # 3. Penalize common hallucination / distractor targets
            distractor_re = r"\b(sign\s*in|sign\s*up|log\s*in|accounts?|profile|register|bestsellers?|best\s*sellers?|trending|todays?\s*deals?|deals?|customer\s*service|help|prime|sell|registry|gift\s*cards?|orders?|returns?)\b"
            if not wants_add_to_cart:
                distractor_re = r"\b(sign\s*in|sign\s*up|log\s*in|accounts?|profile|register|bestsellers?|best\s*sellers?|trending|todays?\s*deals?|deals?|customer\s*service|help|prime|sell|registry|gift\s*cards?|cart|basket|orders?|returns?)\b"
            if re.search(distractor_re, label):
                return -1000

        # Anti-hallucination Category Guard:
        # If user wants flights, penalize promotional hotel cards, homestays, packages, etc.
        if cat == "flights":
            if re.search(r"\b(hotels?|homestays?|villas?|resorts?|holiday\s*packages?|trains?|buses?|cabs?)\b", label):
                return -1000
            if re.search(r"^\s*flights?\s*$", label):
                score += 100
        elif cat == "hotels":
            if re.search(r"\b(flights?|trains?|buses?|cabs?)\b", label):
                return -1000
            if re.search(r"^\s*hotels?\s*$", label):
                score += 100

        # Fillable inputs or travel field pickers (From / To / Departure / Search)
        is_travel_field = any(w in label for w in ["from", "origin", "departure", "flying from", "source", "to", "destination", "arrival", "flying to"])
        if role in FILLABLE_ROLES or (is_travel_field and role in CLICKABLE_ROLES):
            score += 50
            if any(w in label for w in ["from", "origin", "departure", "flying from", "source"]):
                score += 40
            if any(w in label for w in ["to", "destination", "arrival", "flying to"]):
                score += 40
            if any(w in label for w in ["date", "depart"]):
                score += 20
            if "search" in label or role == "input:search":
                score += 30

        # Search / Find action buttons
        if ("search" in label or "find" in label) and ("button" in role or "clickable" in role or role == "input:submit"):
            score += 60

        # Dropdown options / suggestions
        if any(w in role for w in ["option", "suggestion", "listitem"]):
            score += 70

        # Relevant cities
        if from_city and from_city in label:
            score += 35
        if to_city and to_city in label:
            score += 35

        return score

    return sorted(marks, key=score_mark, reverse=True)


def marks_for_prompt(req: "AgentStepRequest", with_boxes: bool) -> List[dict]:
    """The element table sent to a planner, trimmed to what it can act on, ranked by task relevance."""
    limit = 45
    available = [m for m in req.marks if m.id not in (req.filled_mark_ids or [])]
    cat = req.task_hints.category if req.task_hints else None
    ranked = rank_marks_for_task(available, req.task, cat, req.task_hints, req.progress)
    out = []
    for m in ranked:
        entry = {"id": m.id, "role": m.role, "label": (m.label or "")[:60]}
        if with_boxes and m.box:
            entry["box"] = m.box
        out.append(entry)
        if len(out) >= limit:
            break
    return out


def describe_progress(progress: Optional["Progress"]) -> str:
    """Renders what has already been achieved, so no tier repeats a completed sub-task."""
    if not progress:
        return "PROGRESS SO FAR: nothing done yet (this is the first step)."
    done, todo = [], []
    (done if progress.navigated else todo).append("navigate to the site")
    if getattr(progress, "from_typed", False):
        done.append("origin city entered/selected")
    if getattr(progress, "to_typed", False):
        done.append("destination city entered/selected")
    if progress.searched or progress.query_landed:
        (done if progress.query_landed else todo).append(
            "run the search (typed, but the query has NOT landed on the page yet)"
            if not progress.query_landed else "run the search")
    if progress.scrolled:
        done.append("scroll the page")
    if progress.filled_any:
        done.append("fill at least one form field")
    if getattr(progress, "product_opened", False):
        done.append("select/open product")
    if getattr(progress, "cart_added", False):
        done.append("add product to cart")
    if progress.opened:
        done.append("open: " + ", ".join(progress.opened))
    return ("PROGRESS SO FAR:\n"
            "- Done: %s\n"
            "- Still outstanding: %s"
            % (", ".join(done) if done else "nothing yet",
               ", ".join(todo) if todo else "nothing known to be outstanding"))


def describe_page(page_info: Optional[PageInfo]) -> str:
    """Renders page_info into a short prompt block. Used by every planning tier."""
    if not page_info:
        return "PAGE CONTEXT: (not supplied)"
    below_fold = ""
    if page_info.page_height and page_info.viewport_height:
        remaining = max(0.0, page_info.page_height - (page_info.scroll_y or 0) - page_info.viewport_height)
        below_fold = "\n- Unseen content below the fold: %dpx" % int(remaining)
    return (
        "PAGE CONTEXT:\n"
        "- Title: %s\n"
        "- URL (origin + path only): %s\n"
        "- Viewport: %dx%d CSS px%s"
        % (
            page_info.title or "unknown",
            page_info.url or "unknown",
            int(page_info.viewport_width or 0),
            int(page_info.viewport_height or 0),
            below_fold,
        )
    )

def robust_json_parse(text: str) -> Optional[dict]:
    if not text:
        return None
    data = None
    try:
        data = json.loads(text)
    except Exception:
        pass
    if not isinstance(data, dict):
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            snippet = match.group(0)
            try:
                data = json.loads(snippet)
            except Exception:
                try:
                    cleaned = snippet.replace("'", '"')
                    data = json.loads(cleaned)
                except Exception:
                    try:
                        fixed_keys = re.sub(r'([{,]\s*)([a-zA-Z0-9_]+)\s*:', r'\1"\2":', snippet)
                        data = json.loads(fixed_keys)
                    except Exception:
                        pass
    if isinstance(data, dict):
        if not data.get("action"):
            data["action"] = {"type": "done", "target": None, "value": None}
        elif isinstance(data["action"], str):
            data["action"] = {"type": data["action"], "target": None, "value": None}
        return data

    # Truncated JSON recovery: extract fields if closing braces were cut off
    t_match = re.search(r'"type"\s*:\s*"([^"]+)"', text)
    if t_match:
        act_type = t_match.group(1)
        target_match = re.search(r'"target"\s*:\s*(\d+)', text)
        value_match = re.search(r'"value"\s*:\s*"([^"]*)"', text)
        reason_match = re.search(r'"reasoning"\s*:\s*"([^"]*)"', text)
        target_val = int(target_match.group(1)) if target_match else None
        return {
            "reasoning": reason_match.group(1) if reason_match else "Extracted action from response",
            "action": {
                "type": act_type,
                "target": target_val,
                "value": value_match.group(1) if value_match else None,
            },
        }

    # Empty or stalled JSON recovery
    if text.strip() in ('{"', '{', '{}', '{\n}', '{"}', '{\n\n}'):
        return {
            "reasoning": "Task complete or no further UI action needed",
            "action": {"type": "done", "target": None, "value": None},
        }
    return None

# ── Tier circuit breaker ─────────────────────────────────────────────────────
#
# A hosted tier that is out of quota stays out of quota. Re-asking it on every step is pure
# latency: measured during a live run with both hosted providers exhausted, each planning step
# spent ~20s failing four Gemini models and one Groq model before reaching a tier that could
# answer. With the breaker the same step costs ~2s.
#
# Cooldowns are derived from what the provider actually said. A rate-limit message that names a
# retry time is believed; an authentication failure is treated as long-lived, because a rejected
# key will not start working in the next thirty seconds; anything else gets a short pause so a
# transient blip does not disable a tier for the session.

_RETRY_AFTER_RE = re.compile(r"try again in\s+(?:(\d+)m)?\s*([\d.]+)s", re.I)

DEFAULT_COOLDOWN_S = 90.0
AUTH_COOLDOWN_S = 1800.0
MAX_COOLDOWN_S = 1800.0

# name -> {"until": epoch seconds, "reason": str}
_tier_cooldowns: Dict[str, Dict[str, Any]] = {}

# Individual model -> epoch seconds. Some providers rate-limit per model, not per account.
_model_cooldowns: Dict[str, float] = {}


def _parse_retry_after(message: str) -> Optional[float]:
    """Seconds the provider asked us to wait, if it said."""
    match = _RETRY_AFTER_RE.search(message or "")
    if not match:
        return None
    minutes = float(match.group(1) or 0)
    seconds = float(match.group(2) or 0)
    return min(MAX_COOLDOWN_S, minutes * 60 + seconds + 5)


def tier_available(name: str) -> bool:
    entry = _tier_cooldowns.get(name)
    if not entry:
        return True
    if time.time() >= entry["until"]:
        del _tier_cooldowns[name]
        print(f"[server] {name} cooldown expired, trying it again")
        return True
    return False


def trip_tier(name: str, error: Any) -> None:
    """Takes a tier out of the chain for a while, based on what went wrong."""
    text = str(error)
    lowered = text.lower()
    if "429" in text or "rate limit" in lowered or "quota" in lowered or "resource_exhausted" in lowered:
        cooldown = _parse_retry_after(text) or DEFAULT_COOLDOWN_S
        kind = "rate limited"
    elif "401" in text or "403" in text or "api key" in lowered or "unauthor" in lowered or "permission" in lowered:
        cooldown, kind = AUTH_COOLDOWN_S, "rejected our credentials"
    else:
        cooldown, kind = DEFAULT_COOLDOWN_S / 3, "erroring"
    _tier_cooldowns[name] = {"until": time.time() + cooldown, "reason": kind}
    print(f"[server] {name} {kind}; skipping it for {int(cooldown)}s")


def tier_status() -> Dict[str, Any]:
    now = time.time()
    return {
        name: {"reason": e["reason"], "retry_in_s": max(0, int(e["until"] - now))}
        for name, e in _tier_cooldowns.items()
    }


# Models a provider says do not exist are not worth asking again this session.
_dead_models: set = set()

# ── Google Gemini VLM Planning ───────────────────────────────────────────────
def plan_with_gemini(req: AgentStepRequest) -> Optional[StepResponse]:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        return None

    img_b64 = req.redactedImage or req.image or ""
    if "," in img_b64:
        img_b64 = img_b64.split(",", 1)[1]

    marks_summary = marks_for_prompt(req, with_boxes=bool(img_b64))

    prompt_text = f"""You are VisionVault: a visual AI browser agent designed for privacy-preserving web automation.
You receive a sanitized, on-device blacked-out screenshot (where all private credentials & faces have been redacted) and Set-of-Marks numerical element tags.

USER TASK: "{req.task}"
STEP NUMBER: {req.step}
ALREADY PROCESSED MARK IDs: {req.filled_mark_ids}

{describe_page(req.page_info)}

{describe_progress(req.progress)}

{describe_hints(req.task_hints, req.task)}

AVAILABLE INTERACTIVE ELEMENTS:
{json.dumps(marks_summary, indent=2)}

INSTRUCTIONS:
1. Examine the user task and look at the marks.
2. Select EXACTLY ONE logical next action to make progress towards the user's task.
3. NEVER invent personal data. For anything personal, set "use_vault_field" and leave "value" null.
   The client resolves it locally; you never see the real value. Valid keys, and only these:
     name      full personal name
     username  login handle / user id  (NOT the person's name)
     email     email address
     phone     phone or mobile number
     address   street address, city, postcode
     company   employer or organisation
     about     free-text bio or notes
     password  password or passcode
   Choose the key by the FIELD'S OWN LABEL, not by its input type. A field labelled
   "Username" takes "username" even though it is a plain text input; a field labelled
   "Full name" takes "name". If no key fits, pick the closest one rather than inventing text.
4. If a button needs to be clicked (e.g., submit, navigation link, search button), choose "click" with its target mark ID.
5. When typing into a search box, use the SEARCH QUERY above verbatim. Never type the user's whole sentence.
6. Target elements ONLY by an "id" listed above; those ids are stable across steps.
7. Do not repeat an action on an id already listed as processed.
8. Return "done" ONLY when everything the task needs is marked done under PROGRESS.
   A search whose query has not landed on the page is NOT done.

Respond in STRICT JSON ONLY:
{{
  "reasoning": "Clear explanation of chosen action",
  "action": {{
    "type": "click" | "type" | "scroll_page" | "select" | "press_key" | "done",
    "target": <mark ID integer or null>,
    "value": "<text to enter or null>",
    "use_vault_field": "<name|email|phone|address|password or null>"
  }}
}}"""

    models_to_try = list(dict.fromkeys([
        os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
        "gemini-2.0-flash",
        "gemini-1.5-flash",
    ]))

    last_err = None
    for model_name in models_to_try:
        if model_name in _dead_models:
            continue
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={key}"
        parts: List[Dict[str, Any]] = [{"text": prompt_text}]
        if img_b64:
            parts.append({
                "inline_data": {
                    "mime_type": "image/png",
                    "data": img_b64
                }
            })

        payload = {
            "contents": [{"parts": parts}],
            "generationConfig": {
                "response_mime_type": "application/json",
                "temperature": 0.1
            }
        }

        try:
            req_post = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req_post, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                candidate = data.get("candidates", [{}])[0]
                content = candidate.get("content", {}).get("parts", [{}])[0].get("text", "")
                parsed = robust_json_parse(content)
                if parsed and isinstance(parsed, dict):
                    act = parsed.get("action", {})
                    reasoning = parsed.get("reasoning", f"Google Gemini ({model_name}) plan")
                    print(f"[server] [GEMINI] Action: {act.get('type')} (target: {act.get('target')}) - {reasoning}")
                    return StepResponse(
                        reasoning=reasoning,
                        action=StepAction(
                            type=act.get("type", "done"),
                            target=act.get("target"),
                            value=act.get("value"),
                            use_vault_field=act.get("use_vault_field"),
                            reasoning=reasoning
                        )
                    )
        except Exception as e:
            last_err = e
            text = str(e)
            print(f"[server] Gemini ({model_name}) error: {text}")
            if "404" in text or "not found" in text.lower():
                # This model name is wrong for this account; it will not start existing.
                _dead_models.add(model_name)
            elif "429" in text or "quota" in text.lower() or "503" in text or "unavailable" in text.lower() or "401" in text or "403" in text:
                trip_tier("gemini", e)
                return None
            continue

    if last_err:
        trip_tier("gemini", last_err)
    return None

# ── OpenRouter fallback ───────────────────────────────────────────────────────
def plan_with_openrouter(req: AgentStepRequest) -> Optional[StepResponse]:
    key = openrouter_key
    if not key:
        return None

    img_b64 = req.redactedImage or req.image or ""
    if img_b64 and not img_b64.startswith("data:image"):
        img_b64 = f"data:image/png;base64,{img_b64}"

    marks_summary = marks_for_prompt(req, with_boxes=bool(img_b64))
    model = os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash")

    prompt = build_planner_prompt(req, marks_summary)

    if img_b64:
        content: Any = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": img_b64}},
        ]
    else:
        content = prompt

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.1,
        "max_tokens": 900,
        "response_format": {"type": "json_object"},
    }

    try:
        request = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
                "HTTP-Referer": "https://github.com/visionvault",
                "X-Title": "VisionVault",
            },
        )
        with urllib.request.urlopen(request, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        raw = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
        parsed = robust_json_parse(raw)
        if not parsed:
            print(f"[server] OpenRouter unparseable: {raw[:160]!r}")
            return None
        act = parsed.get("action", {})
        reasoning = parsed.get("reasoning", f"OpenRouter ({model}) plan")
        print(f"[server] [OPENROUTER] Action: {act.get('type')} (target: {act.get('target')}) - {reasoning}")
        return StepResponse(
            reasoning=reasoning,
            action=StepAction(
                type=act.get("type", "done"),
                target=act.get("target"),
                value=act.get("value"),
                use_vault_field=act.get("use_vault_field"),
                reasoning=reasoning,
            ),
        )
    except Exception as e:
        text = str(e)
        print(f"[server] OpenRouter ({model}) error: {text}")
        if "401" in text or "403" in text:
            trip_tier("openrouter", e)
        elif "429" in text or "rate limit" in text.lower():
            trip_tier("openrouter", e)
        return None

# ── Instruction parsing (mirrors extension/task-planner.js) ───────────────────
TAIL_RE = re.compile(
    r"\s*(?:,|\band\b|\bthen\b)?\s*(?:please\s+)?(?:show|display|tell|give|list)\s+"
    r"(?:me|us|it)?\s*(?:the\s+)?(?:results?|details?|options?|list|prices?)?\s*[.!]?\s*$",
    re.I,
)
CLAUSE_SPLIT_RE = re.compile(
    r"\s+(?:and|then|,)\s+(?:also\s+)?(?=open|click|select|scroll|show|tell|display|go|buy|add|book|play|read|check)",
    re.I,
)
POLITE_TAIL_RE = re.compile(r"[\s,.!]*\b(?:please|thanks|thank you|pls|plz)\b[\s,.!]*$", re.I)
SEARCH_RE = re.compile(r"\b(?:search|look)\s+(?:for\s+|up\s+)?(.+)$", re.I)
OPEN_TARGET_RE = re.compile(r"\b(?:open|click|select|choose|tap)\s+(?:on\s+)?(?:the\s+)?(.+?)(?=\s+(?:and|then|,)\s+|$)", re.I)


def extract_search_query(task: str) -> Optional[str]:
    """The text the user wants typed into a search box, with clauses and tails removed."""
    match = SEARCH_RE.search(task or "")
    if not match:
        return None
    query = CLAUSE_SPLIT_RE.split(match.group(1))[0]
    query = TAIL_RE.sub("", query)
    query = POLITE_TAIL_RE.sub("", query)
    query = query.strip().strip("\"'`").strip()
    query = re.sub(r"[\s,;:.\-]+$", "", query).strip()
    if not query or re.fullmatch(r"(?:me|it|this|that|results?|them)", query, re.I):
        return None
    return query


def extract_open_targets(task: str) -> List[str]:
    """Things the user explicitly asked to open or click, in order."""
    targets = []
    for clause in CLAUSE_SPLIT_RE.split(task or "")[1:]:
        match = OPEN_TARGET_RE.search(clause)
        if match:
            target = TAIL_RE.sub("", match.group(1)).strip().lower()
            if len(target) >= 2:
                targets.append(target)
    return targets


# ── Ollama: fully local fallback ─────────────────────────────────────────────
#
# Third tier, and the only one that needs no network beyond localhost. It runs whenever both
# hosted providers fail — quota exhausted, network down, key revoked — so the agent keeps
# working offline instead of collapsing to fixed rules.
#
# Deliberately text-only. The models people actually have installed locally (qwen2.5-coder,
# llama3.x, mistral) have no vision head, and the redacted screenshot is not needed to choose
# among a numbered list of elements: the Set-of-Marks table, page context and progress carry
# the decision. Sending an image such a model cannot read would only add seconds of latency.

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_TIMEOUT = float(os.getenv("OLLAMA_TIMEOUT", "60"))
# Keeps the model resident between steps, so only the first call pays the load cost.
OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "20m")

# Cached so a dead Ollama is not re-probed on every single step.
_ollama_state: Dict[str, Any] = {"checked_at": 0.0, "model": None, "warming": False}


def compress_image_for_ollama(b64_str: str, max_dim: int = 768, quality: int = 75) -> str:
    """Downscales screenshot to reduce visual tokens from ~3500 to ~600 for Ollama VLM.
    This prevents OOM, thread locks, and timeouts on laptop GPUs over local Wi-Fi."""
    if not _PIL_AVAILABLE or not b64_str:
        return b64_str
    try:
        raw = base64.b64decode(b64_str)
        img = Image.open(io.BytesIO(raw))
        if max(img.size) > max_dim:
            img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        img.save(buf, format="JPEG", quality=quality, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("utf-8")
    except Exception as e:
        print(f"[server] Ollama image compression fallback: {e}")
        return b64_str


def _http_json(url: str, payload: Optional[dict], timeout: float, method: str = "POST") -> Optional[dict]:
    """Small JSON-over-HTTP helper. Returns None on any failure rather than raising."""
    try:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url, data=data, method=method,
            headers={"Content-Type": "application/json"} if data else {},
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="ignore")
        except Exception:
            pass
        print(f"[server] HTTP {method} to {url} failed: {e} - Response: {err_body}")
        return None
    except Exception as e:
        print(f"[server] HTTP {method} to {url} failed: {e}")
        return None


def _rank_ollama_models(models: List[dict]) -> List[str]:
    """Ranks Qwen vision models first, then other vision models, then small instruction models."""
    def key(m):
        name = (m.get("name") or "")
        size = m.get("size") or 0
        details = m.get("details") or {}
        params = str(details.get("parameter_size") or "")
        try:
            billions = float(re.sub(r"[^0-9.]", "", params) or 0)
        except ValueError:
            billions = 0.0
        # Priority 0: Qwen models (qwen2.5-vl, qwen)
        # Priority 1: Other vision models (minicpm-v, llava)
        # Priority 2: General instruction models
        # Priority 3: Coder or embedding models
        #
        # The coder/embedding test comes FIRST, and that ordering is the whole point. It used
        # to sit in the elif chain below the Qwen test, so "qwen2.5-coder:14b" matched `qwen`,
        # was ranked top, and got picked ahead of qwen2.5:1.5b-instruct. Measured on a live
        # run: 54.6s, 28.4s and 33.7s for three consecutive steps, against a 30s client
        # timeout — so the agent got nothing back at all while a perfectly good small model
        # sat unused. A model trained to write code is also the wrong tool for reading a page.
        if re.search(r"coder|embed|\bcode\b", name, re.I):
            priority = 3
        elif re.search(r"qwen.*vl|qwen", name, re.I):
            priority = 0
        elif re.search(r"minicpm|llava|vision|vl\b", name, re.I):
            priority = 1
        else:
            priority = 2
        return (priority, billions or size / 1e9, name)
    return [m.get("name") for m in sorted(models, key=key) if m.get("name")]


def ollama_model(force: bool = False) -> Optional[str]:
    """The local model to plan with, or None when Ollama is not reachable.

    Discovers available models from {OLLAMA_HOST}/api/tags. Re-probed at most every 30s so an
    Ollama that starts (or changes models) mid-session is picked up automatically."""
    now = time.time()
    if not force and now - _ollama_state["checked_at"] < 30:
        return _ollama_state["model"]
    if not force and _ollama_state.get("warming"):
        return _ollama_state["model"]

    _ollama_state["checked_at"] = now
    tags = _http_json(f"{OLLAMA_HOST}/api/tags", None, 5.0, method="GET")
    models = (tags or {}).get("models", [])
    names = [m.get("name") for m in models if m.get("name")]
    if not names:
        _ollama_state["model"] = None
        return None

    preferred = os.getenv("OLLAMA_MODEL", "qwen2.5:3b-instruct").strip()

    # A model trained to write code is the wrong tool for reading a page, and the ones people
    # have installed locally are usually the largest thing on the machine. Both fuzzy paths
    # below match on a family prefix, so without this filter "qwen2.5-vl:7b" happily resolves
    # to "qwen2.5-coder:14b" merely because both start with "qwen2.5" — which is what happened
    # here, at 28-55s per step against a 30s client timeout. An exact request is still
    # honoured: if someone names a coder model outright, that is their decision to make.
    WRONG_TOOL_RE = re.compile(r"coder|embed|\bcode\b", re.I)
    usable = [n for n in names if not WRONG_TOOL_RE.search(n)] or names

    chosen = None
    if preferred:
        exact = next((n for n in names if n.lower() == preferred.lower()), None)
        prefix = next((n for n in usable if n.lower().startswith(preferred.split(":")[0].lower())), None)
        fuzzy = next((n for n in usable if any(p in n.lower() for p in preferred.lower().split(":") if len(p) >= 3)), None)
        chosen = exact or prefix or fuzzy

    # Prioritize any Qwen model from the tags if preferred didn't match directly
    if not chosen:
        chosen = next((n for n in usable if "qwen" in n.lower()), None)

    if not chosen:
        ranked = _rank_ollama_models(models)
        chosen = ranked[0] if ranked else names[0]

    _ollama_state["model"] = chosen
    print(f"[server] Ollama /api/tags at {OLLAMA_HOST}: {names} -> Using Tier 1 model: {chosen}")
    return chosen


def warm_ollama() -> None:
    """Loads the local model into memory once at startup.

    A cold Ollama spends 30-60s mapping weights before it emits a token. Paying that during
    the first fallback would look like a hang; paying it in the background at boot means the
    fallback is ready by the time anything needs it."""
    def run():
        model = ollama_model(force=True)
        if not model:
            return
        _ollama_state["warming"] = True
        try:
            _http_json(f"{OLLAMA_HOST}/api/chat", {
                "model": model, "stream": False, "keep_alive": OLLAMA_KEEP_ALIVE,
                "options": {"num_predict": 1},
                "messages": [{"role": "user", "content": "ok"}],
            }, 180)
            print(f"[server] [OK] Local fallback ready: Ollama {model}")
        finally:
            _ollama_state["warming"] = False
    threading.Thread(target=run, daemon=True).start()


def build_planner_prompt(req: "AgentStepRequest", marks_summary: List[dict]) -> str:
    """The instruction shared by every text-tier planner, so tiers behave consistently."""
    hints = req.task_hints
    entities = extract_travel_entities(req.task)
    from_city = (hints.from_city if hints and hints.from_city else entities.get("from_city"))
    to_city = (hints.to_city if hints and hints.to_city else entities.get("to_city"))
    hint_cat = getattr(hints, "category", None) if hints else None
    entities_cat = entities.get("category")
    has_travel = bool(
        entities_cat or
        (hint_cat and hint_cat in ("flights", "hotels", "trains", "buses", "cabs") and
         re.search(r"\b(flights?|hotels?|airports?|airlines?|makemytrip|goibibo|cleartrip|irctc|redbus|tickets?|book)\b", req.task or "", re.I))
    )
    category = (hint_cat or entities_cat) if has_travel else None

    cat_rule = ""
    if category == "flights":
        cat_rule = """
*** CRITICAL SERVICE CATEGORY: FLIGHTS ONLY ***
- The user requested a FLIGHT search.
- NEVER click on 'Hotels', 'Hotels in Goa', 'Homestays', 'Villas', or 'Holiday Packages' under ANY circumstances!
- If not currently on the Flights tab, click ONLY the 'Flights' tab.
- NEVER click promotional hotel cards even if they mention the destination city! Focus strictly on flight origin/destination fields and the 'Search' button.
"""
    elif category == "hotels":
        cat_rule = """
*** CRITICAL SERVICE CATEGORY: HOTELS ONLY ***
- The user requested a HOTEL search. Stay in the Hotels section.
"""

    travel_context = ""
    if has_travel and (from_city or to_city or category):
        travel_context = f"""TRAVEL PARAMETERS DETECTED:
  SERVICE CATEGORY: {category.upper() if category else 'FLIGHTS'}
  ORIGIN / FROM CITY: "{from_city or 'Not specified'}"
  DESTINATION / TO CITY: "{to_city or 'Not specified'}"
{cat_rule}
CRITICAL INSTRUCTIONS FOR TRAVEL/BOOKING SITES:
- If typing into the 'From' / origin city box: type ONLY "{from_city}". NEVER type full sentences like "{req.task}".
- If typing into the 'To' / destination city box: type ONLY "{to_city}". NEVER type full sentences like "{req.task}".
- If a suggestion list appears after typing, click the matching city option from the dropdown.
- Do NOT press Enter on city fields."""

    is_messaging = bool(re.search(r"\b(whatsapp|telegram|slack|message|msg|send\s+.*to|chat|text\s+.*to)\b", req.task or "", re.I)) or \
                   bool(req.page_info and req.page_info.url and re.search(r"web\.whatsapp\.com|telegram|slack", req.page_info.url, re.I))

    messaging_context = ""
    if is_messaging:
        messaging_context = """
*** CRITICAL MESSAGING / CHAT DIRECTIVE ***
The user is performing a messaging action (e.g. on WhatsApp, Telegram, or chat platform).
1. If the screen is currently on 'Phone number', dial pad, or 'Calls' view, your IMMEDIATE action is to click 'Back' (<) or 'Chats' tab to return to your chats.
2. If the target contact or chat is not open, look for the contact in the chat list. If not visible, type the contact name into 'Search or start new chat' to find them.
3. Once the contact is visible, click the contact to open the conversation.
4. If the message text has not been entered into the chat message box, type the message into the message box ('Type a message').
5. If the message text is in the message box, or if the Send button (green send arrow, paper airplane, or button labeled 'Send') is visible:
   YOUR IMMEDIATE ACTION MUST BE TO CLICK THE SEND BUTTON! NEVER click 'Send document', 'Add contact', or 'New call'!
6. NEVER return 'done' while a message draft is sitting in the input box unsent!
"""

    search_context = ""
    search_q = (hints.search_query if hints and hints.search_query else extract_search_query(req.task))
    if search_q and (not req.progress or not req.progress.query_landed) and not is_messaging:
        search_context = f"""
*** CRITICAL SEARCH DIRECTIVE ***
- SEARCH QUERY TO EXECUTE: "{search_q}"
- The user wants to search for: "{search_q}".
- Your IMMEDIATE action MUST be to type "{search_q}" into the search input box.
- DO NOT click on 'Sign In', 'Account & Lists', 'Bestsellers', 'Deals', 'Trending', 'Customer Service', or category links!
- DO NOT explore or browse other sections before typing the search query into the search box!
"""

    return f"""You are VisionVault, a browser automation planner. You choose ONE next UI action.

USER TASK: "{req.task}"
STEP NUMBER: {req.step}
ALREADY PROCESSED MARK IDs: {req.filled_mark_ids}

{describe_page(req.page_info)}

{describe_progress(req.progress)}

{describe_hints(req.task_hints, req.task)}
{travel_context}
{messaging_context}
{search_context}
AVAILABLE INTERACTIVE ELEMENTS (choose "target" from these ids ONLY):
{json.dumps(marks_summary, indent=2)}

RULES:
1. Choose exactly ONE action that makes progress on the task.
2. Never invent personal data. For anything personal set "use_vault_field" and leave "value" null.
   Valid keys: name, username, email, phone, address, company, about, password.
3. For BOOKING/TRAVEL tasks (flights, hotels, trains, cabs):
   - Fill origin/source city field first, then destination, then date, then search/find button.
   - City pickers are usually autocomplete inputs — type the city name and then click the
     suggestion that appears. Do NOT press Enter on a city picker.
   - Date pickers: click the date field, then click the correct date in the calendar.
   - After filling all fields, click the Search/Find button.
   - On results page: click the desired flight/hotel/train to select it.
   - Then proceed through passenger details, payment steps as shown.
4. When typing a search query, use the SEARCH QUERY above verbatim. When a search query is present and has not landed yet, you MUST type it into the search box. NEVER click sign-in, login, account, or category links.
5. Do not repeat an action listed under PROGRESS as already done.
6. Return "done" ONLY when the ENTIRE task (including message delivery or booking confirmation) is complete. If a Send button is available on a chat, click Send.
7. If a dropdown/suggestion list appeared, click the correct option from it.
8. If a calendar/date picker appeared, click the correct date.
9. If a modal/overlay appeared, interact with it to proceed.

Respond with STRICT JSON and nothing else:
{{"reasoning": "<one sentence>",
  "action": {{"type": "click"|"type"|"scroll_page"|"select"|"press_key"|"done",
              "target": <mark id or null>, "value": "<text or null>",
              "use_vault_field": "<key or null>"}}}}"""


def plan_with_ollama(req: "AgentStepRequest") -> Optional[StepResponse]:
    model = ollama_model()
    if not model:
        return None

    # Qwen2.5-VL, minicpm-v and other vision models in the family accept an image.
    # Send the redacted screenshot when vision is enabled.
    # Set-of-Marks text mode (OLLAMA_VISION=false by default) delivers fast (<1-2s), lightweight (~2KB)
    # requests without GPU VRAM exhaustion or HTTP 400 image decoding failures on local laptops.
    is_vision = bool(re.search(r"minicpm|llava|bakllava|moondream|vision|vl\b|qwen", model, re.I))
    use_vision = os.getenv("OLLAMA_VISION", "false").lower() in ("true", "1", "yes")
    img_b64 = (req.redactedImage or req.image or "") if (use_vision and is_vision) else ""
    if img_b64 and "," in img_b64:
        img_b64 = img_b64.split(",", 1)[1]

    # Use unified ranked marks with bounding boxes for full spatial awareness
    marks_summary = marks_for_prompt(req, with_boxes=True)

    messages = [
        {"role": "system",
         "content": "You output ONE strict JSON object and nothing else. "
                    "If the task goal is already completed or satisfied, return action type \"done\". "
                    "Keep \"reasoning\" under 12 words."},
    ]
    user_msg: Dict[str, Any] = {"role": "user", "content": build_planner_prompt(req, marks_summary)}
    if img_b64 and use_vision:
        compressed_b64 = compress_image_for_ollama(img_b64, max_dim=768, quality=75)
        if compressed_b64 and len(compressed_b64.strip()) > 100:
            user_msg["images"] = [compressed_b64.strip()]
    messages.append(user_msg)

    payload = {
        "model": model,
        "format": "json",
        "stream": False,
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "options": {"temperature": 0.1, "num_predict": 300, "num_ctx": 8192},
        "messages": messages,
    }

    # One retry only. A second full generation on a slow local model costs more time than the
    # deterministic tier below would take to answer perfectly well.
    for attempt in (1, 2):
        t0 = time.time()
        data = _http_json(f"{OLLAMA_HOST}/api/chat", payload, OLLAMA_TIMEOUT)
        elapsed = time.time() - t0
        if not data:
            print(f"[server] Ollama ({model}) attempt {attempt}: no response ({elapsed:.1f}s)")
            continue
        content = (data.get("message") or {}).get("content", "")
        parsed = robust_json_parse(content)
        if not parsed or not isinstance(parsed, dict):
            print(f"[server] Ollama ({model}) attempt {attempt}: unparseable output ({elapsed:.1f}s): {repr(content[:120])}")
            continue
        act = parsed.get("action") or {}
        if isinstance(act, str):
            act = {"type": act}
        reasoning = parsed.get("reasoning") or f"Local {model} plan"
        print(f"[server] [OLLAMA:{model}] Action: {act.get('type')} (target: {act.get('target')}) - {reasoning} ({elapsed:.1f}s)")
        return StepResponse(
            reasoning=reasoning,
            action=StepAction(
                type=act.get("type", "done"),
                target=act.get("target"),
                value=act.get("value"),
                use_vault_field=act.get("use_vault_field"),
                reasoning=reasoning,
            ),
        )
    return None

# ── Rule-Based Mock Planner ──────────────────────────────────────────────────
def mock_plan(marks: List[Mark], task: str, filled_ids: Optional[List[int]] = None,
              page_info: Optional[PageInfo] = None,
              progress: Optional[Progress] = None) -> StepResponse:
    task_lower = (task or "").lower()
    filled_set = set(filled_ids or [])
    available = [m for m in marks if m.id not in filled_set]
    done_so_far = progress or Progress()

    def find_mark(predicate):
        return next((m for m in available if predicate(m)), None)

    # 1. Search: type ONLY the query, never the whole sentence.
    #
    #    "search for iqoo neo 6 and show me" must search for "iqoo neo 6". Stripping a list of
    #    stop-words from the sentence (the previous approach) left "iqoo neo 6 and show me" in
    #    the box. The client-side planner in extension/task-planner.js does the same parsing;
    #    keep the two in step.
    query = extract_search_query(task)
    if query and not done_so_far.query_landed:
        search_box = find_mark(lambda m: m.role in ["input:search", "input:text", "editable"])
        if search_box:
            return StepResponse(
                reasoning=f'Search for "{query}"',
                action=StepAction(type="type", target=search_box.id, value=query,
                                  reasoning=f'Search for "{query}"')
            )

    # 2. Fill form fields — type for text inputs, select for dropdowns
    fill_kws = ["fill", "sign up", "register", "checkout", "enter", "complete"]
    if any(kw in task_lower for kw in fill_kws):
        select_field = find_mark(lambda m: m.role in SELECT_ROLES)
        if select_field:
            return StepResponse(
                reasoning="Select a value in the dropdown",
                action=StepAction(type="select", target=select_field.id,
                                  use_vault_field=None, reasoning="Fill dropdown field")
            )
        text_field = find_mark(lambda m: m.role in FILLABLE_ROLES)
        if text_field:
            return StepResponse(
                reasoning="Fill the form field",
                action=StepAction(type="type", target=text_field.id,
                                  use_vault_field="name", reasoning="Fill form field")
            )

    # 3. Open something the user NAMED. A link is never clicked merely because a word from the
    #    task appears in its text — on a dense results page that matches dozens of links and
    #    the agent wanders instead of finishing.
    for target in extract_open_targets(task):
        if target in (done_so_far.opened or []):
            continue
        if target in ("first", "first result", "top result"):
            link = find_mark(lambda m: m.role == "link" and m.label and len(m.label) > 8)
            if link:
                return StepResponse(
                    reasoning=f"Open the first result: {link.label}",
                    action=StepAction(type="click", target=link.id, reasoning="Open the first result")
                )
            continue
        hit = find_mark(lambda m: m.label and target in m.label.lower()
                        and m.role in ("link", "button", "clickable"))
        if hit:
            return StepResponse(
                reasoning=f'Open "{hit.label}"',
                action=StepAction(type="click", target=hit.id, reasoning=f'Open "{hit.label}"')
            )

    # 4. Scroll when the task asks for more content and page_info shows more exists below.
    if (any(kw in task_lower for kw in ["scroll", "load more", "read more", "next page", "more results"])
            and not done_so_far.scrolled):
        remaining = None
        if page_info and page_info.page_height and page_info.viewport_height:
            remaining = page_info.page_height - (page_info.scroll_y or 0) - page_info.viewport_height
        if remaining is None or remaining > 50:
            return StepResponse(
                reasoning="Scroll down to reveal more page content",
                action=StepAction(type="scroll_page", value="500", reasoning="Reveal more content")
            )

    # 5. Finish if no specific pending task match
    return StepResponse(
        reasoning="All requested task actions completed",
        action=StepAction(type="done", reasoning="Task finished successfully")
    )

# ── Plan validation and repair ───────────────────────────────────────────────
#
# Applied to the output of EVERY tier, hosted or local, before it reaches the client.
#
# A planner's answer is a claim about the page, and claims can be checked cheaply against the
# element table we just sent it. Doing so here rather than in the client means one
# implementation covers all four tiers, and the client's own guard is left to police things
# only it can see (repetition across steps, whether a query actually landed).
#
# Each repair below corresponds to a mistake observed in practice:
#   * a small local model answering "click" for a text field it correctly identified
#   * "type" aimed at a link, because the label matched the query
#   * "type" with no value at all, when the query was right there in the hints
#   * an action aimed at a mark id that is not on the page (hallucinated or stale)
#   * more work proposed after everything the user asked for was already done




def _is_search_mark(mark: Mark) -> bool:
    return mark.role == "input:search" or bool(SEARCH_LABEL_RE.search(mark.label or ""))


def repair_plan(plan: StepResponse, req: AgentStepRequest, tier: str) -> StepResponse:
    """Returns a plan that is consistent with the elements and progress we sent the planner."""
    action = plan.action
    marks = {m.id: m for m in req.marks}
    available = [m for m in req.marks if m.id not in set(req.filled_mark_ids or [])]
    progress = req.progress or Progress()
    query = (req.task_hints.search_query if req.task_hints else None)
    notes: List[str] = []

    kind = (action.type or "").lower().strip()

    # Planners emit "scroll" for a page scroll, because that is the word in the prompt and in
    # every description of the task. The client's page-scroll action is "scroll_page"; a bare
    # "scroll" with no target means the same thing, and saying so here means no planner has to
    # get the spelling right.
    if kind == "scroll" and action.target is None:
        kind = action.type = "scroll_page"

    target = marks.get(action.target) if action.target is not None else None

    # 1. A target that is not on the page cannot be acted on. Prefer re-aiming at a sensible
    #    element over sending the client an id it will fail to resolve.
    if action.target is not None and target is None:
        notes.append(f"target {action.target} is not on this page")
        target = None
        action.target = None

    # Messaging Guard: On WhatsApp / chat platforms, if a Send button is visible (meaning draft text is present),
    # clicking the Send button is MANDATORY. Do not allow 'done' or re-clicking the draft message!
    is_messaging = bool(re.search(r"\b(whatsapp|telegram|slack|message|msg|send\s+.*to|chat|text\s+.*to)\b", req.task or "", re.I)) or \
                   bool(req.page_info and req.page_info.url and re.search(r"web\.whatsapp\.com|telegram|slack", req.page_info.url, re.I))

    # WhatsApp recovery: If on Phone number / Calls dial pad screen instead of Chats, recover to Chats
    is_on_dialpad = bool(
        req.page_info and req.page_info.url and "web.whatsapp.com" in req.page_info.url and
        any(re.search(r"\b(enter a phone number|phone number|voice and video calling|go to calls)\b", m.label or "", re.I) for m in req.marks)
    )
    if is_messaging and is_on_dialpad:
        back_or_chats = next((
            m for m in available
            if (re.search(r"^\s*(back|<|←)\s*$", m.label or "", re.I) and any(r in (m.role or "").lower() for r in ["button", "clickable"])) or
               (re.search(r"^\s*chats?\b", m.label or "", re.I) and any(r in (m.role or "").lower() for r in ["button", "clickable", "tab"]))
        ), None)
        if back_or_chats:
            notes.append("On WhatsApp dialpad screen; clicking Back / Chats to return to chats")
            kind, action.type = "click", "click"
            action.target = back_or_chats.id
            action.reasoning = "Exit phone dialpad and return to chats list"
            target = back_or_chats
            plan.reasoning = "Return to Chats"

    send_btn = next((
        m for m in available
        if _is_message_send_button(m)
    ), None) if is_messaging else None

    if is_messaging and send_btn:
        if kind in ("done", "", "none", "finish", "stop") or (kind == "click" and (target is None or target.id != send_btn.id)):
            target_desc = (target.label if target and target.label else "") or str(action.target)
            notes.append(f"Intercepted '{kind}' on '{target_desc}' while Send button is available; clicking Send button to send the message")
            kind, action.type = "click", "click"
            action.target = send_btn.id
            action.reasoning = "Click Send button to send the message"
            target = send_btn
            plan.reasoning = "Click Send button to send message"

    # Messaging: Contact search interception
    # If the recipient is known, clicking on the search contacts box or clicking an unrelated contact must TYPE recipient!
    recipient = (req.task_hints.recipient if req.task_hints and getattr(req.task_hints, "recipient", None) else None)
    if not recipient and is_messaging:
        rec_m = re.search(r"\bto\s+([a-zA-Z0-9_\s]+?)(?:\s+(?:on|via|in)\s+(?:whatsapp|slack|telegram)|$)", req.task or "", re.I)
        if rec_m:
            recipient = rec_m.group(1).strip()

    if is_messaging and recipient:
        search_contacts_box = next((
            m for m in available
            if ("search or start a new chat" in (m.label or "").lower()) or
               ("search" in (m.label or "").lower() and any(r in (m.role or "").lower() for r in FILLABLE_ROLES))
        ), None)
        if search_contacts_box and kind == "click" and target is not None:
            t_lbl = (target.label or "").lower()
            if target.id == search_contacts_box.id or "search" in t_lbl:
                notes.append(f"Clicking search contacts box does not search; typing recipient '{recipient}' instead")
                kind, action.type = "type", "type"
                action.target = search_contacts_box.id
                action.value = recipient
                action.reasoning = f"Type recipient '{recipient}' into search contacts box"
                target = search_contacts_box
                plan.reasoning = f"Search contact '{recipient}'"
            elif recipient.lower() not in t_lbl and not any(r in (target.role or "").lower() for r in ["tab", "navigation"]) and not _is_message_send_button(target):
                notes.append(f"Intercepted click on unrelated '{t_lbl}' when looking for '{recipient}'; typing into search contacts box")
                kind, action.type = "type", "type"
                action.target = search_contacts_box.id
                action.value = recipient
                action.reasoning = f"Type recipient '{recipient}' into search contacts box"
                target = search_contacts_box
                plan.reasoning = f"Search contact '{recipient}'"

    # Terminal actions: if still done after guards, return plan.
    if kind in ("done", "", "none", "finish", "stop"):
        return plan

    # 2. Only repair search-specific mistakes when there is an outstanding search query
    # AND the task is not a booking/travel flow (where clicking fields is intentional).
    is_booking = bool(re.search(
        r"\b(book|flights?|hotels?|trains?|bus|cabs?|tickets?|reserve|reservation|makemytrip|goibibo|irctc|redbus|cleartrip|expedia|airbnb)\b",
        req.task or "", re.I
    )) or bool(req.page_info and req.page_info.url and re.search(r"makemytrip|goibibo|booking|expedia|irctc|cleartrip", req.page_info.url, re.I))

    if query and not progress.query_landed and not is_booking:
        search_box = next((m for m in available if _is_search_mark(m) and m.role in FILLABLE_ROLES), None)
        if search_box is None:
            search_box = next((m for m in available if m.role in FILLABLE_ROLES), None)

        is_search_submit = (
            target is not None and 
            ("button" in (target.role or "").lower() or target.role == "input:submit" or "clickable" in (target.role or "").lower()) and
            bool(re.search(r"\b(search|find|go|submit)\b", target.label or "", re.I))
        )
        is_dismiss_btn = (
            target is not None and
            bool(re.search(r"\b(close|dismiss|accept|agree|got it|continue without)\b", target.label or "", re.I))
        )

        # 2a. "click" aimed at an actual SEARCH INPUT specifically — should be type instead.
        if search_box and kind == "click" and target is not None and target.id == search_box.id:
            notes.append("clicking a search box does not run a search; typing instead")
            kind, action.type = "type", "type"
            action.target = search_box.id
            action.value = query
            action.reasoning = f"Type '{query}' into search box"
            target = search_box

        # 2b. "click" aimed at unrelated navigation, sign-in, categories, links before search query has landed:
        elif search_box and kind == "click" and not is_search_submit and not is_dismiss_btn:
            target_desc = (target.label if target and target.label else None) or str(action.target)
            notes.append(f"Intercepted click on '{target_desc}' before search query '{query}' was entered; retargeted to search box")
            kind, action.type = "type", "type"
            action.target = search_box.id
            action.value = query
            action.reasoning = f"Type '{query}' into search box"
            target = search_box

        # 2c. Ignored scroll before search query has landed:
        elif search_box and kind in ("scroll_page", "scroll"):
            notes.append(f"Ignored scroll before search query '{query}' was entered; typing into search box instead")
            kind, action.type = "type", "type"
            action.target = search_box.id
            action.value = query
            action.reasoning = f"Type '{query}' into search box"
            target = search_box

        # 2d. "select" aimed at something that is not a dropdown — retarget.
        elif kind == "select" and target is not None and target.role not in SELECT_ROLES:
            real_select = next((m for m in available if m.role in SELECT_ROLES), None)
            if real_select:
                notes.append(f"{target.role} is not a dropdown; retargeted to select element")
                action.target = real_select.id

        # 2e. "type" aimed at a non-fillable role or non-search input when a search box exists:
        elif kind == "type" and search_box and (action.target is None or (target is not None and target.role not in FILLABLE_ROLES) or (target is not None and target.id != search_box.id and not _is_search_mark(target))):
            notes.append("retargeted typing to the search box")
            action.target = search_box.id
            target = search_box

        # 2f. "type" aimed at a native dropdown — switch to select.
        elif kind == "type" and target is not None and target.role == "select":
            notes.append("target is a dropdown; switching type to select")
            kind, action.type = "select", "select"

        # 2g. "type" with no value — fill from query.
        if kind == "type" and not action.value and not action.use_vault_field:
            notes.append("empty value; using the extracted search query")
            action.value = query

        # 2h. Typed value contains the whole sentence — trim to query.
        if kind == "type" and action.value and not action.use_vault_field:
            value = action.value.strip()
            if len(value) > len(query) and query.lower() in value.lower():
                notes.append("trimmed the typed value to the extracted query")
                action.value = query

    elif is_booking:
        entities = extract_travel_entities(req.task)
        category = (req.task_hints.category if req.task_hints and getattr(req.task_hints, "category", None) else entities.get("category", "flights"))
        from_city = (req.task_hints.from_city if req.task_hints and req.task_hints.from_city else entities.get("from_city"))
        to_city = (req.task_hints.to_city if req.task_hints and req.task_hints.to_city else entities.get("to_city"))

        # Category Guard: If searching for flights, keep agent in Flights and prevent any wrong-section navigation or clicks
        if category == "flights":
            current_url = (req.page_info.url if req.page_info and req.page_info.url else "").lower()
            flights_tab = next((m for m in available if re.search(r"^\s*flights?\s*$", m.label or "", re.I) and not re.search(r"search|find", m.label or "", re.I)), None) or \
                          next((m for m in available if re.search(r"\bflights?\b", m.label or "", re.I) and not re.search(r"\b(hotels?|packages?|homestays?|cabs?|trains?|buses?|search|find)\b", m.label or "", re.I)), None)

            # Check 1: If current page URL is in /hotels, /cabs, /activities, /railways, /bus-tickets, /holidays, navigate directly to /flights/
            is_wrong_section = bool(re.search(r"/(hotels|cabs|activities|tours|railways|trains|bus-tickets|buses|holidays|homestays)/?", current_url))
            if is_wrong_section:
                notes.append(f"Browser navigated to wrong section ({current_url}); navigating directly to Flights")
                return StepResponse(
                    reasoning="Navigate to Flights section",
                    action=StepAction(type="navigate", value="https://www.makemytrip.com/flights/", reasoning="Go to Flights")
                )

            # Check 2: If model clicked an unrelated category tab/card (hotels, cabs, trains, buses)
            t_label = (target.label or "") if target else ""
            a_reason = action.reasoning or ""
            target_label = (t_label + " " + a_reason).lower()
            if kind == "click" and re.search(r"\b(hotels?|homestays?|villas?|resorts?|cabs?|taxis?|trains?|buses?|holidays?)\b", target_label):
                target_desc = (target.label if target and target.label else None) or action.target
                notes.append(f"Intercepted click on unrelated category element '{target_desc}' during FLIGHT search")
                from_field = next((m for m in available if re.search(r"\b(from|origin|departure|source)\b", m.label or "", re.I) and (m.role in FILLABLE_ROLES or m.role in CLICKABLE_ROLES)), None)
                to_field = next((m for m in available if re.search(r"\b(to|destination|arrival)\b", m.label or "", re.I) and (m.role in FILLABLE_ROLES or m.role in CLICKABLE_ROLES)), None)
                search_btn = next((m for m in available if re.search(r"\b(search|find)\b", m.label or "", re.I) and ("button" in m.role or "clickable" in m.role or m.role == "input:submit")), None)

                if flights_tab and "/flights" not in current_url:
                    action.target = flights_tab.id
                    action.reasoning = "Switch to Flights tab"
                    target = flights_tab
                elif from_city and not getattr(progress, "from_typed", False) and from_field:
                    kind, action.type = "type", "type"
                    action.target = from_field.id
                    action.value = from_city
                    action.reasoning = f"Type origin city '{from_city}' into From field"
                    target = from_field
                elif to_city and not getattr(progress, "to_typed", False) and to_field:
                    kind, action.type = "type", "type"
                    action.target = to_field.id
                    action.value = to_city
                    action.reasoning = f"Type destination city '{to_city}' into To field"
                    target = to_field
                elif search_btn:
                    action.target = search_btn.id
                    action.reasoning = "Click Search Flights button"
                    target = search_btn
                elif flights_tab:
                    action.target = flights_tab.id
                    action.reasoning = "Click Flights tab"
                    target = flights_tab

            # Check 3: Foreign airport guard (e.g. Genoa, Italy vs Goa, India)
            if (to_city and "goa" in to_city.lower()) or (from_city and "goa" in from_city.lower()):
                t_label = (target.label or "") if target else ""
                a_reason = (action.reasoning or "")
                dest_clicked = (t_label + " " + a_reason).lower()
                if kind == "click" and ("genoa" in dest_clicked or "italy" in dest_clicked):
                    notes.append(f"Intercepted click on foreign airport '{t_label or action.target}' during domestic Goa flight search")
                    goa_sugg = next((m for m in available if re.search(r"\b(dabolim|goi|mopa|gox|goa)\b", m.label or "", re.I) and not re.search(r"\b(genoa|italy)\b", m.label or "", re.I)), None)
                    if goa_sugg:
                        action.target = goa_sugg.id
                        action.reasoning = f"Select domestic Goa airport: {goa_sugg.label}"
                        target = goa_sugg

        # Scroll Guard: On booking search pages, form is at the top. Never scroll down away from search form before searching!
        is_search_done = getattr(progress, "searched", False) or getattr(progress, "query_landed", False)
        scroll_y = int((req.page_info.scroll_y or 0) if req.page_info else 0)
        if not is_search_done:
            if scroll_y > 120:
                notes.append(f"Page was scrolled down {scroll_y}px away from search form; scrolling back to top")
                return StepResponse(
                    reasoning="Scroll back to top to access search fields",
                    action=StepAction(type="scroll_page", value=str(-scroll_y), reasoning="Scroll to top of page")
                )
            elif kind in ("scroll_page", "scroll"):
                notes.append("Ignored scroll_page on travel form before search is submitted")
                to_field = next((m for m in available if re.search(r"\b(to|destination|arrival)\b", m.label or "", re.I) and (m.role in FILLABLE_ROLES or m.role in CLICKABLE_ROLES)), None)
                from_field = next((m for m in available if re.search(r"\b(from|origin|departure|source)\b", m.label or "", re.I) and (m.role in FILLABLE_ROLES or m.role in CLICKABLE_ROLES)), None)
                search_btn = next((m for m in available if re.search(r"\b(search|find)\b", m.label or "", re.I) and ("button" in m.role or "clickable" in m.role or m.role == "input:submit")), None)
                if getattr(progress, "from_typed", False) and to_city and to_field:
                    kind, action.type = "type", "type"
                    action.target = to_field.id
                    action.value = to_city
                    action.reasoning = f"Type destination city '{to_city}' into To field"
                    target = to_field
                elif from_city and from_field:
                    kind, action.type = "type", "type"
                    action.target = from_field.id
                    action.value = from_city
                    action.reasoning = f"Type origin city '{from_city}' into From field"
                    target = from_field
                elif search_btn:
                    kind, action.type = "click", "click"
                    action.target = search_btn.id
                    action.reasoning = "Click Search Flights button"
                    target = search_btn

        # Guard: If origin city is already done and model attempts to type origin city again or target From field:
        if getattr(progress, "from_typed", False) and from_city and to_city:
            t_label = (target.label or "") if target else ""
            is_typing_from = (kind == "type" and action.value and from_city.lower() in action.value.lower()) or \
                             (re.search(r"\b(from|origin|departure|source)\b", t_label, re.I))
            if is_typing_from:
                if not getattr(progress, "to_typed", False):
                    to_field = next((m for m in available if re.search(r"\b(to|destination|arrival)\b", m.label or "", re.I)), None)
                    if to_field:
                        notes.append(f"Origin city '{from_city}' already completed; retargeted to destination field for '{to_city}'")
                        kind, action.type = "type", "type"
                        action.target = to_field.id
                        action.value = to_city
                        action.reasoning = f"Type destination city '{to_city}' into To field"
                        target = to_field
                else:
                    search_btn = next((m for m in available if re.search(r"\b(search|find)\b", m.label or "", re.I) and ("button" in m.role or "clickable" in m.role or m.role == "input:submit")), None)
                    if search_btn:
                        notes.append(f"Both origin '{from_city}' and destination '{to_city}' completed; retargeted to Search button")
                        kind, action.type = "click", "click"
                        action.target = search_btn.id
                        action.reasoning = "Click Search Flights button"
                        target = search_btn

        # Guard: If both origin and destination cities are entered, proceed immediately to Search Flights button
        if getattr(progress, "from_typed", False) and getattr(progress, "to_typed", False):
            search_btn = next((m for m in available if re.search(r"\b(search|find)\b", m.label or "", re.I) and ("button" in m.role or "clickable" in m.role or m.role == "input:submit")), None)
            t_label = (target.label or "") if target else ""
            if search_btn and (kind != "click" or (target and target.id != search_btn.id and re.search(r"\b(from|to|origin|destination|departure|arrival|flight)\b", t_label, re.I))):
                notes.append("Origin and destination cities already entered; clicking Search Flights button")
                kind, action.type = "click", "click"
                action.target = search_btn.id
                action.reasoning = "Click Search Flights button"
                target = search_btn

        # Convert clicks on destination/origin input boxes into type actions
        if kind == "click" and target is not None:
            t_label = (target.label or "").lower()
            a_reason = (action.reasoning or "").lower()
            is_dest = (any(w in t_label or w in a_reason for w in ["to", "destination", "arrival", "dest", "flying to"]) or getattr(progress, "from_typed", False)) and not getattr(progress, "to_typed", False)
            is_orig = any(w in t_label or w in a_reason for w in ["from", "origin", "departure", "source"]) and not getattr(progress, "from_typed", False)

            if is_dest and to_city and (target.role in FILLABLE_ROLES or "to" in t_label or "destination" in t_label or "enter" in a_reason):
                notes.append(f"Model clicked destination input to enter text; converted to type '{to_city}'")
                kind, action.type = "type", "type"
                action.value = to_city
                action.reasoning = f"Type destination city '{to_city}' into To field"
            elif is_orig and from_city and (target.role in FILLABLE_ROLES or "from" in t_label or "origin" in t_label or "enter" in a_reason):
                notes.append(f"Model clicked origin input to enter text; converted to type '{from_city}'")
                kind, action.type = "type", "type"
                action.value = from_city
                action.reasoning = f"Type origin city '{from_city}' into From field"

        # Fix: If kind is "type" and value contains the whole sentence or travel keywords:
        if kind == "type" and action.value:
            val_lower = action.value.lower().strip()
            t_label = (target.label or "") if target else ""
            t_role = (target.role or "") if target else ""
            target_text = (t_label + " " + t_role).lower()

            is_to_target = any(w in target_text for w in ["to", "destination", "dest", "arrival", "flying to", "arriving"]) or "to" in (action.reasoning or "").lower()
            is_from_target = any(w in target_text for w in ["from", "origin", "source", "depart", "flying from", "departing"]) or "from" in (action.reasoning or "").lower()

            if ("flight" in val_lower or "from" in val_lower or "to" in val_lower or len(action.value) > 20):
                if is_to_target and to_city:
                    notes.append(f"trimmed destination input from full sentence to '{to_city}'")
                    action.value = to_city
                elif is_from_target and from_city:
                    notes.append(f"trimmed origin input from full sentence to '{from_city}'")
                    action.value = from_city
                elif to_city and not is_from_target:
                    notes.append(f"trimmed input to destination city '{to_city}'")
                    action.value = to_city
                elif from_city:
                    notes.append(f"trimmed input to origin city '{from_city}'")
                    action.value = from_city

        # 2b. "select" aimed at non-dropdown.
        if kind == "select" and target is not None and target.role not in SELECT_ROLES:
            real_select = next((m for m in available if m.role in SELECT_ROLES), None)
            if real_select:
                notes.append(f"{target.role} is not a dropdown; retargeted to select element")
                action.target = real_select.id
        # 2d. "type" aimed at a native select element specifically.
        elif kind == "type" and target is not None and target.role == "select":
            notes.append("target is a native select; switching type to select")
            kind, action.type = "select", "select"

    # 3. Everything the user asked for is done: further actions are the planner inventing work.
    #    This is what turns "search for X" into an endless tour of a results page.
    elif _goal_complete(req, progress):
        notes.append("every part of the task is already done")
        return StepResponse(
            reasoning="Task complete — " + "; ".join(notes),
            action=StepAction(type="done", reasoning="Nothing left that the instruction asked for."),
        )

    # 4. A vault field must never carry a literal value: the whole point is that the server
    #    does not know it. If a planner supplied both, the symbolic key wins.
    if action.use_vault_field and action.value:
        notes.append("dropped a literal value supplied alongside a vault field")
        action.value = None

    # 5. An action that needs a target but has none cannot be executed.
    if kind in ("click", "type", "select", "press_key") and action.target is None:
        notes.append(f"no usable target for {kind}")
        fallback = mock_plan(req.marks, req.task, req.filled_mark_ids, req.page_info, progress)
        fallback.reasoning = f"{fallback.reasoning} (repaired: {'; '.join(notes)})"
        return fallback

    if notes:
        print(f"[server] [repair:{tier}] {'; '.join(notes)}")
        plan.reasoning = f"{plan.reasoning} (repaired: {'; '.join(notes)})"
    return plan


def _goal_complete(req: AgentStepRequest, progress: Progress) -> bool:
    """True when nothing the instruction asked for is outstanding."""
    hints = req.task_hints
    if hints and hints.search_query and not progress.query_landed:
        return False
    if hints and hints.open_targets:
        if not all(t in (progress.opened or []) for t in hints.open_targets):
            return False
    task_lower = (req.task or "").lower()
    if any(k in task_lower for k in ("scroll", "load more", "next page")) and not progress.scrolled:
        return False
    if any(k in task_lower for k in ("fill", "sign up", "register", "checkout")) and not progress.filled_any:
        return False
    # With no search query, no named targets and no scroll/fill intent there is nothing this
    # function can verify, so it must not claim the task is finished.
    return bool(hints and (hints.search_query or hints.open_targets))


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    local_model = ollama_model()
    current_backend = "ollama" if local_model else ("openrouter" if openrouter_key else ("gemini" if gemini_key else "mock"))
    return {
        "status": "ok",
        "backend": current_backend,
        "chain": [t for t in [
            "ollama" if local_model else None,
            "openrouter" if openrouter_key else None,
            "gemini" if gemini_key else None,
            "mock",
        ] if t],
        "models": {
            "ollama": local_model,
            "openrouter": os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash"),
            "gemini": os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
        },
        "ollama_host": OLLAMA_HOST,
        # Tiers currently rested by the circuit breaker, and how long until they are retried.
        "cooldowns": tier_status(),
    }

@app.post("/api/agent/step", response_model=StepResponse)
async def agent_step(req: AgentStepRequest):
    log_session_event("agent_step_request", {
        "task": req.task,
        "marks_count": len(req.marks),
        "filled_count": len(req.filled_mark_ids or []),
        "step": req.step,
        "has_image": bool(req.redactedImage or req.image),
        "page": (req.page_info.url if req.page_info else None),
    })

    plan = None
    tier = None

    # Tier 1: Friend's Ollama — Qwen2.5-VL 7B running locally on network
    if tier_available("ollama"):
        plan = plan_with_ollama(req)
        if plan:
            tier = "ollama"

    # Tier 2: OpenRouter (e.g. Gemini 2.5 Flash / Qwen)
    if not plan and openrouter_key and tier_available("openrouter"):
        plan = plan_with_openrouter(req)
        if plan:
            tier = "openrouter"

    # Tier 3: Google Gemini
    if not plan and gemini_key and tier_available("gemini"):
        plan = plan_with_gemini(req)
        if plan:
            tier = "gemini"

    # Tier 4: deterministic rules — cannot fail
    if not plan:
        plan = mock_plan(req.marks, req.task, req.filled_mark_ids, req.page_info, req.progress)
        tier = "mock"

    # Every tier's answer is checked against the elements and progress we sent it, so one
    # implementation covers hosted VLMs and the local model alike.
    plan = repair_plan(plan, req, tier or "unknown")
    plan.tier = tier

    log_session_event("agent_step_response", {
        "tier": tier,
        "reasoning": plan.reasoning,
        "action": plan.action.model_dump()
    })

    return plan

@app.post("/api/agent/step/stream")
async def agent_step_stream(req: AgentStepRequest):
    """SSE streaming variant of /api/agent/step.

    Emits one `data:` event per planning tier attempted, then a final event with the
    repaired plan. The client can render intermediate reasoning while the chain runs.
    """
    async def generate():
        plan = None
        tier = None

        def emit(obj):
            return f"data: {json.dumps(obj)}\n\n"

        # Tier 1: Friend's Ollama
        if tier_available("ollama"):
            plan = plan_with_ollama(req)
            if plan:
                tier = "ollama"
                yield emit({"tier": tier, "reasoning": plan.reasoning, "partial": True})

        # Tier 2: OpenRouter
        if not plan and openrouter_key and tier_available("openrouter"):
            plan = plan_with_openrouter(req)
            if plan:
                tier = "openrouter"
                yield emit({"tier": tier, "reasoning": plan.reasoning, "partial": True})

        # Tier 3: Google Gemini
        if not plan and gemini_key and tier_available("gemini"):
            plan = plan_with_gemini(req)
            if plan:
                tier = "gemini"
                yield emit({"tier": tier, "reasoning": plan.reasoning, "partial": True})

        # Tier 4: Mock
        if not plan:
            plan = mock_plan(req.marks, req.task, req.filled_mark_ids, req.page_info, req.progress)
            tier = "mock"

        plan = repair_plan(plan, req, tier or "unknown")
        plan.tier = tier

        final = plan.model_dump()
        final["tier"] = tier
        final["partial"] = False
        yield emit(final)
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/plan-action", response_model=StepResponse)
async def legacy_plan_action(req: AgentStepRequest):
    return await agent_step(req)

@app.on_event("startup")
def _startup() -> None:
    warm_ollama()


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    print(f"[server] Starting VisionVault AI Server on http://127.0.0.1:{port}")
    uvicorn.run("main:app", host="127.0.0.1", port=port, reload=True)
