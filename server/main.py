"""
Privacy-Preserving Vision Agent — Server (SIH PS 26171)
FastAPI Backend with Multi-VLM: Google Gemini (AI Studio) -> Groq -> OpenAI -> Smart Mock
"""

import base64
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
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# Load environment variables from .env
load_dotenv()

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
# Chain: Ollama (minicpm-v) -> Gemini -> OpenRouter -> mock
BACKEND = "mock"
gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
openrouter_key = os.getenv("OPENROUTER_API_KEY", "").strip()

if gemini_key:
    BACKEND = "gemini"
    print(f"[server] [OK] Tier 2: Google Gemini ({os.getenv('GEMINI_MODEL', 'gemini-3.6-flash')})")

if openrouter_key:
    if BACKEND == "mock":
        BACKEND = "openrouter"
    print(f"[server] [OK] Tier 3: OpenRouter ({os.getenv('OPENROUTER_MODEL', 'google/gemini-2.5-flash')})")

if BACKEND == "mock":
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
    if hints.open_targets:
        lines.append("AFTER SEARCHING, the user asked to open: %s" % ", ".join(hints.open_targets))
    if not lines and not booking:
        lines.append("The instruction contains no search query.")
    return "\n".join(lines)

def marks_for_prompt(req: "AgentStepRequest", with_boxes: bool) -> List[dict]:
    """The element table sent to a planner, trimmed to what it can act on.

    Pixel boxes are included only for a model that is also receiving the screenshot, since
    they exist to let it correlate a numbered mark with what it can see. For a text-only model
    they are ~40 tokens per element of noise, and on this project that mattered twice over:
    it slowed generation, and it burned a shared daily token budget four times faster than
    necessary."""
    limit = 40
    out = []
    for m in req.marks:
        if m.id in (req.filled_mark_ids or []):
            continue
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
    if progress.searched or progress.query_landed:
        (done if progress.query_landed else todo).append(
            "run the search (typed, but the query has NOT landed on the page yet)"
            if not progress.query_landed else "run the search")
    if progress.scrolled:
        done.append("scroll the page")
    if progress.filled_any:
        done.append("fill at least one form field")
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
    try:
        return json.loads(text)
    except Exception:
        pass
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        snippet = match.group(0)
        try:
            return json.loads(snippet)
        except Exception:
            try:
                cleaned = snippet.replace("'", '"')
                return json.loads(cleaned)
            except Exception:
                try:
                    fixed_keys = re.sub(r'([{,]\s*)([a-zA-Z0-9_]+)\s*:', r'\1"\2":', snippet)
                    return json.loads(fixed_keys)
                except Exception:
                    pass
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
# 25s, not 35: past this the client is better served by the deterministic tier, which
# answers instantly. A local model that cannot reply in 25s is too big for the loop.
OLLAMA_TIMEOUT = float(os.getenv("OLLAMA_TIMEOUT", "25"))
# Keeps the model resident between steps, so only the first call pays the load cost.
OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "20m")

# Cached so a dead Ollama is not re-probed on every single step.
_ollama_state: Dict[str, Any] = {"checked_at": 0.0, "model": None, "warming": False}


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
    except Exception:
        return None


def _rank_ollama_models(models: List[dict]) -> List[str]:
    """Fastest usable planner first.

    Local inference speed is dominated by parameter count: measured on this machine a 14B Q4
    model produces 3.8 tok/s, which makes a ~90-token JSON plan take 40 seconds — far too slow
    to sit in an interactive loop. A small instruction-tuned model answers the same
    multiple-choice question in a couple of seconds, so size ascending is the right default.
    Coder-specialised and embedding-only models rank last; they are tuned for other work."""
    def key(m):
        name = (m.get("name") or "")
        size = m.get("size") or 0
        details = m.get("details") or {}
        params = str(details.get("parameter_size") or "")
        try:
            billions = float(re.sub(r"[^0-9.]", "", params) or 0)
        except ValueError:
            billions = 0.0
        specialised = 1 if re.search(r"coder|embed|vision|code", name, re.I) else 0
        return (specialised, billions or size / 1e9, name)
    return [m.get("name") for m in sorted(models, key=key) if m.get("name")]


def ollama_model(force: bool = False) -> Optional[str]:
    """The local model to plan with, or None when Ollama is not reachable.

    Re-probed at most every 30s so an Ollama that starts (or stops) mid-session is picked up
    without adding a round trip to every planning step. Set OLLAMA_MODEL to pin a specific one."""
    now = time.time()
    if not force and now - _ollama_state["checked_at"] < 30:
        return _ollama_state["model"]
    # While the warm-up is mapping a model into memory, Ollama serialises API calls, so a probe
    # issued now would block and then time out — reporting the tier as absent purely because it
    # was busy getting ready. The warm-up has already resolved the name; trust it.
    if not force and _ollama_state.get("warming"):
        return _ollama_state["model"]

    _ollama_state["checked_at"] = now
    # 5s, not 2s: Ollama serialises API calls while it is mapping a model into memory, so a
    # probe issued during the startup warm-up would otherwise time out and report the whole
    # tier as absent.
    tags = _http_json(f"{OLLAMA_HOST}/api/tags", None, 5.0, method="GET")
    models = (tags or {}).get("models", [])
    names = [m.get("name") for m in models if m.get("name")]
    if not names:
        _ollama_state["model"] = None
        return None

    preferred = os.getenv("OLLAMA_MODEL", "").strip()
    if preferred:
        exact = next((n for n in names if n == preferred), None)
        prefix = next((n for n in names if n.startswith(preferred.split(":")[0])), None)
        chosen = exact or prefix
        if chosen:
            _ollama_state["model"] = chosen
            return chosen

    _ollama_state["model"] = _rank_ollama_models(models)[0]
    return _ollama_state["model"]


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
    travel_context = ""
    if hints:
        parts = []
        if getattr(hints, 'from_city', None): parts.append(f"FROM: {hints.from_city}")
        if getattr(hints, 'to_city', None): parts.append(f"TO: {hints.to_city}")
        if getattr(hints, 'date', None): parts.append(f"DATE: {hints.date}")
        if parts:
            travel_context = "TRAVEL PARAMETERS:\n" + "\n".join(f"  {p}" for p in parts) + "\n"

    return f"""You are VisionVault, a browser automation planner. You choose ONE next UI action.

USER TASK: "{req.task}"
STEP NUMBER: {req.step}
ALREADY PROCESSED MARK IDs: {req.filled_mark_ids}

{describe_page(req.page_info)}

{describe_progress(req.progress)}

{describe_hints(req.task_hints, req.task)}
{travel_context}
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
4. When typing a search query, use the SEARCH QUERY above verbatim.
5. Do not repeat an action listed under PROGRESS as already done.
6. Return "done" ONLY when the ENTIRE task (including booking confirmation) is complete.
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

    marks_summary = [
        {"id": m.id, "role": m.role, "label": (m.label or "")[:48]}
        for m in req.marks if m.id not in (req.filled_mark_ids or [])
    ][:30]

    # minicpm-v and other vision models in the family accept an image.
    # Send the redacted screenshot when available so the model can see the page.
    is_vision = re.search(r"minicpm|llava|bakllava|moondream|vision|vl\b", model, re.I)
    img_b64 = (req.redactedImage or req.image or "") if is_vision else ""
    if img_b64 and "," in img_b64:
        img_b64 = img_b64.split(",", 1)[1]

    messages = [
        {"role": "system",
         "content": "You output ONE strict JSON object and nothing else. "
                    "Keep \"reasoning\" under 12 words."},
    ]
    user_msg: Dict[str, Any] = {"role": "user", "content": build_planner_prompt(req, marks_summary)}
    if img_b64 and is_vision:
        user_msg["images"] = [img_b64]
    messages.append(user_msg)

    payload = {
        "model": model,
        "format": "json",
        "stream": False,
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "options": {"temperature": 0.1, "num_predict": 140, "num_ctx": 4096},
        "messages": messages,
    }

    # One retry only. A second full generation on a slow local model costs more time than the
    # deterministic tier below would take to answer perfectly well.
    for attempt in (1, 2):
        data = _http_json(f"{OLLAMA_HOST}/api/chat", payload, OLLAMA_TIMEOUT)
        if not data:
            print(f"[server] Ollama ({model}) attempt {attempt}: no response")
            continue
        content = (data.get("message") or {}).get("content", "")
        parsed = robust_json_parse(content)
        if not parsed or not isinstance(parsed, dict):
            print(f"[server] Ollama ({model}) attempt {attempt}: unparseable output")
            continue
        act = parsed.get("action") or {}
        reasoning = parsed.get("reasoning") or f"Local {model} plan"
        print(f"[server] [OLLAMA:{model}] Action: {act.get('type')} (target: {act.get('target')}) - {reasoning}")
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

FILLABLE_ROLES = {"input:text", "input:search", "input:email", "input:tel",
                  "input:password", "textarea", "editable", "combobox"}
SELECT_ROLES = {"select", "input:select", "combobox"}
CLICKABLE_ROLES = {"link", "button", "clickable", "input:submit", "input:checkbox", "input:radio", "checkbox", "radio"}
SEARCH_LABEL_RE = re.compile(r"search|find|query|keyword|looking for|explore", re.I)


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

    # Nothing to repair on a terminal action.
    if kind in ("done", "", "none", "finish", "stop"):
        return plan

    target = marks.get(action.target) if action.target is not None else None

    # 1. A target that is not on the page cannot be acted on. Prefer re-aiming at a sensible
    #    element over sending the client an id it will fail to resolve.
    if action.target is not None and target is None:
        notes.append(f"target {action.target} is not on this page")
        target = None
        action.target = None

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

        # 2a. "click" aimed at an actual SEARCH INPUT specifically — should be type instead.
        # Do NOT convert clicks on suggestions, comboboxes, buttons, or links!
        if kind == "click" and target is not None and target.role in ("input:search", "input:text") and _is_search_mark(target):
            notes.append("clicking a search box does not run a search; typing instead")
            kind, action.type = "type", "type"
            action.value = query

        # 2b. "select" aimed at something that is not a dropdown — retarget.
        elif kind == "select" and target is not None and target.role not in SELECT_ROLES:
            real_select = next((m for m in available if m.role in SELECT_ROLES), None)
            if real_select:
                notes.append(f"{target.role} is not a dropdown; retargeted to select element")
                action.target = real_select.id

        # 2c. "type" aimed at a non-fillable role.
        elif kind == "type" and target is not None and target.role not in FILLABLE_ROLES and search_box:
            notes.append(f"{target.role} cannot accept text; retargeted to the search box")
            action.target = search_box.id

        # 2d. "type" aimed at a native dropdown — switch to select.
        elif kind == "type" and target is not None and target.role == "select":
            notes.append("target is a dropdown; switching type to select")
            kind, action.type = "select", "select"

        # 2e. "type" with no target — use the search box.
        elif kind == "type" and action.target is None and search_box:
            notes.append("no target given; using the search box")
            action.target = search_box.id

        # 2f. "type" with no value — fill from query.
        if kind == "type" and not action.value and not action.use_vault_field:
            notes.append("empty value; using the extracted search query")
            action.value = query

        # 2g. Typed value contains the whole sentence — trim to query.
        if kind == "type" and action.value and not action.use_vault_field:
            value = action.value.strip()
            if len(value) > len(query) and query.lower() in value.lower():
                notes.append("trimmed the typed value to the extracted query")
                action.value = query

    elif is_booking:
        # For booking flows: only fix clearly wrong targets, leave click/type completely alone!
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
    return {
        "status": "ok",
        "backend": BACKEND,
        "chain": [t for t in [
            "ollama" if local_model else None,
            "gemini" if gemini_key else None,
            "openrouter" if openrouter_key else None,
            "mock",
        ] if t],
        "models": {
            "ollama": local_model,
            "gemini": os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
            "openrouter": os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash"),
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

    # Tier 1: Friend's Ollama — minicpm-v is a vision model, runs locally on the network
    if tier_available("ollama"):
        plan = plan_with_ollama(req)
        if plan:
            tier = "ollama"

    # Tier 2: Google Gemini
    if not plan and gemini_key and tier_available("gemini"):
        plan = plan_with_gemini(req)
        if plan:
            tier = "gemini"

    # Tier 3: OpenRouter fallover
    if not plan and openrouter_key and tier_available("openrouter"):
        plan = plan_with_openrouter(req)
        if plan:
            tier = "openrouter"

    # Tier 3: local Ollama — no internet required
    if not plan and tier_available("ollama"):
        plan = plan_with_ollama(req)
        if plan:
            tier = "ollama"

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

        if tier_available("ollama"):
            plan = plan_with_ollama(req)
            if plan:
                tier = "ollama"
                yield emit({"tier": tier, "reasoning": plan.reasoning, "partial": True})

        if not plan and gemini_key and tier_available("gemini"):
            plan = plan_with_gemini(req)
            if plan:
                tier = "gemini"
                yield emit({"tier": tier, "reasoning": plan.reasoning, "partial": True})

        if not plan and openrouter_key and tier_available("openrouter"):
            plan = plan_with_openrouter(req)
            if plan:
                tier = "openrouter"
                yield emit({"tier": tier, "reasoning": plan.reasoning, "partial": True})

        if not plan and tier_available("ollama"):
            plan = plan_with_ollama(req)
            if plan:
                tier = "ollama"
                yield emit({"tier": tier, "reasoning": plan.reasoning, "partial": True})

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
