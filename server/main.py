"""
Privacy-Preserving Vision Agent — Server (SIH PS 26171)

FastAPI planning service. It receives a sanitized view of the user's screen — a redacted
screenshot, a Set-of-Marks element table, and PII-scrubbed page content — and answers with ONE
browser action at a time. It also decomposes a task into a workflow plan up front, and writes
the final summary when the workflow ends.

Planning chain, in order:  Gemini (hosted VLM) -> Groq (hosted) -> Ollama (local) -> rules.
Every tier answers in the same schema; every answer is checked by repair_plan() before it
leaves. The server never sees personal data and cannot ask for any: anything personal is
requested as a symbolic vault key that the client resolves on-device.
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

try:
    from PIL import Image
    _PIL_AVAILABLE = True
except ImportError:
    _PIL_AVAILABLE = False
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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
# The live chain is exactly: Gemini -> Groq -> Ollama -> rules. Nothing else is initialised,
# because nothing else is called.
BACKEND = "mock"
gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
groq_client = None

if gemini_key:
    BACKEND = "gemini"
    print(f"[server] [OK] Backend: Google Gemini ({os.getenv('GEMINI_MODEL', 'gemini-3.6-flash')})")

groq_key = os.getenv("GROQ_API_KEY", "").strip()
if groq_key.startswith("gsk_"):
    try:
        from groq import Groq
        groq_client = Groq(api_key=groq_key)
        if BACKEND == "mock":
            BACKEND = "groq"
        print(f"[server] [OK] Fallback Engine: Groq ({os.getenv('GROQ_MODEL', 'qwen/qwen3.6-27b')})")
    except Exception as e:
        print(f"[server] Groq initialization failed: {e}")

if BACKEND == "mock":
    print("[server] [INFO] Backend: Deterministic rule-based planner (no API key configured)")

# ── Schemas ──────────────────────────────────────────────────────────────────
class Mark(BaseModel):
    id: int
    role: Optional[str] = "element"
    box: Optional[Dict[str, Any]] = None
    label: Optional[str] = None

# Every action a planner may ask the client to perform. Anything outside this set is repaired
# into something inside it, so a hallucinated verb never reaches the executor.
ACTION_TYPES = {
    "click", "type", "select", "press_key", "scroll_page", "scroll", "scroll_to", "hover",
    "navigate", "open_tab", "read_page", "answer", "next_milestone", "wait", "upload", "done",
}

class StepAction(BaseModel):
    type: str
    target: Optional[int] = None
    value: Optional[str] = None
    use_vault_field: Optional[str] = None
    reasoning: Optional[str] = None

class Finding(BaseModel):
    """Structured information the agent read off a page, kept for later steps and the summary.

    Items are whatever the page listed — products, results, rows — as small dicts of short
    strings. Nothing here originates from the user; it is page content that already passed the
    client's PII scrub."""
    kind: str = "items"
    title: str = ""
    milestone: Optional[int] = None
    items: List[Dict[str, Any]] = []
    text: Optional[str] = None

class StepResponse(BaseModel):
    reasoning: str
    action: StepAction
    # Which tier of the planning chain answered. Metadata about the server's own routing —
    # it carries nothing about the page or the user — and the panel shows it so a silent
    # failover to the local model is visible rather than mysterious.
    tier: Optional[str] = None
    # The planner believes the current milestone is achieved by (or before) this action.
    milestone_done: bool = False
    # 0..1, the planner's own estimate; shown in the panel and used to word the log.
    confidence: Optional[float] = None
    # Structured data extracted from page content on this step, if any.
    findings: Optional[Finding] = None
    # Set with "done": a one-paragraph account of what was achieved.
    summary: Optional[str] = None

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


MILESTONE_KINDS = {"navigate", "search", "open", "read", "answer", "fill", "scroll", "act", "confirm"}

class Milestone(BaseModel):
    """One stage of a workflow. `kind` tells both planner and client what "done" looks like."""
    id: int
    title: str
    kind: str = "act"
    status: str = "pending"          # pending | active | done | skipped
    target: Optional[str] = None     # a URL, a query, a label, a selection rule
    note: Optional[str] = None

    model_config = {"extra": "ignore"}

class Plan(BaseModel):
    goal: str = ""
    milestones: List[Milestone] = []
    current: int = 0

    model_config = {"extra": "ignore"}

class PageContent(BaseModel):
    """What the page says, read by the client and scrubbed of anything matching a PII rule
    before it left the browser. Present only on steps where the planner asked to read."""
    headings: List[str] = []
    text: Optional[str] = None
    items: List[Dict[str, Any]] = []
    tables: List[Dict[str, Any]] = []
    truncated: bool = False

    model_config = {"extra": "ignore"}

class SiteHints(BaseModel):
    """What worked on this site before, from the client's local memory. Labels only."""
    search_label: Optional[str] = None
    dismissed: List[str] = []
    successes: int = 0
    notes: List[str] = []

    model_config = {"extra": "ignore"}

class RecentAction(BaseModel):
    type: str
    label: Optional[str] = None
    ok: Optional[bool] = None
    note: Optional[str] = None

    model_config = {"extra": "ignore"}


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
    # Workflow state. All optional so a client that does not track a plan still works.
    plan: Optional[Plan] = None
    findings: List[Finding] = []
    page_content: Optional[PageContent] = None
    site_hints: Optional[SiteHints] = None
    recent_actions: List[RecentAction] = []
    # Guidance the user typed when they modified or rejected an action.
    user_note: Optional[str] = None
    # Standing preferences the user chose to share with the planner (budget, brands, ...).
    preferences: Optional[str] = None
    elapsed_ms: Optional[int] = None

    model_config = {"extra": "ignore"}


class PlanRequest(BaseModel):
    task: str
    page_info: Optional[PageInfo] = None
    preferences: Optional[str] = None
    site_hints: Optional[SiteHints] = None
    task_hints: Optional[TaskHints] = None

    model_config = {"extra": "ignore"}

class PlanResponse(BaseModel):
    goal: str
    milestones: List[Milestone]
    tier: Optional[str] = None
    # Things the plan will need from the user that a vault is unlikely to hold.
    needs: List[str] = []

class SummaryRequest(BaseModel):
    task: str
    plan: Optional[Plan] = None
    findings: List[Finding] = []
    actions: List[Dict[str, Any]] = []
    progress: Optional[Progress] = None
    elapsed_ms: Optional[int] = None
    outcome: Optional[str] = None     # success | partial | stopped | failed
    warnings: List[str] = []
    page_info: Optional[PageInfo] = None

    model_config = {"extra": "ignore"}

class SummaryResponse(BaseModel):
    summary: str
    highlights: List[str] = []
    tier: Optional[str] = None


def describe_hints(hints: Optional[TaskHints]) -> str:
    """Renders the client's parse of the instruction into the prompt."""
    if not hints:
        return ""
    lines = []
    if hints.search_query:
        lines.append(
            'SEARCH QUERY (already extracted from the user\'s words by the client):\n'
            '  "%s"\n'
            '  If you type into a search box, use EXACTLY this string. Do not add the rest of\n'
            '  the sentence: "and show me", "please", and similar words are how the user talks\n'
            '  to you, not part of what they want searched.' % hints.search_query
        )
    if hints.open_targets:
        lines.append("AFTER SEARCHING, the user asked to open: %s" % ", ".join(hints.open_targets))
    if not lines:
        lines.append("The instruction contains no search query.")
    return "\n".join(lines)

def marks_for_prompt(req: "AgentStepRequest", with_boxes: bool) -> List[dict]:
    """The element table sent to a planner, trimmed to what it can act on.

    Pixel boxes are included only for a model that is also receiving the screenshot, since
    they exist to let it correlate a numbered mark with what it can see. For a text-only model
    they are ~40 tokens per element of noise, and on this project that mattered twice over:
    it slowed generation, and it burned a shared daily token budget four times faster than
    necessary."""
    limit = 48
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


def describe_plan(plan: Optional[Plan]) -> str:
    """The workflow so far, with the milestone the planner must work on marked."""
    if not plan or not plan.milestones:
        return "WORKFLOW PLAN: (none — treat the whole task as one milestone)"
    lines = ["WORKFLOW PLAN (goal: %s):" % (plan.goal or "the user's task")]
    current = current_milestone(plan)
    for m in plan.milestones:
        marker = ">>" if current is not None and m.id == current.id else "  "
        status = m.status.upper() if m.status != "pending" else ""
        target = " [%s]" % m.target if m.target else ""
        lines.append("%s %d. (%s) %s%s %s" % (marker, m.id, m.kind, m.title, target, status))
    if current is not None:
        lines.append("CURRENT MILESTONE: %d — %s. Work ONLY on this. When it is achieved, say so with "
                     "\"milestone_done\": true (or use action \"next_milestone\" if it is already "
                     "achieved and nothing needs doing)." % (current.id, current.title))
    else:
        lines.append("ALL MILESTONES ARE DONE. Return \"done\" with a summary.")
    return "\n".join(lines)


def describe_findings(findings: List[Finding], limit_items: int = 12) -> str:
    if not findings:
        return "FINDINGS SO FAR: none."
    lines = ["FINDINGS SO FAR (read from pages earlier in this run):"]
    for f in findings[-4:]:
        lines.append("- %s%s" % (f.title or f.kind, " (milestone %s)" % f.milestone if f.milestone else ""))
        if f.text:
            lines.append("    " + f.text[:400])
        for item in (f.items or [])[:limit_items]:
            lines.append("    * " + compact_item(item))
    return "\n".join(lines)


def compact_item(item: Dict[str, Any]) -> str:
    bits = []
    for key in ("title", "price", "rating", "meta"):
        v = item.get(key)
        if v:
            bits.append("%s: %s" % (key, str(v)[:90]))
    if item.get("mark_id") is not None:
        bits.append("mark: %s" % item["mark_id"])
    return " | ".join(bits) or json.dumps(item)[:120]


def describe_page_content(content: Optional[PageContent]) -> str:
    if not content:
        return ""
    lines = ["PAGE CONTENT (read this step; already scrubbed of personal data):"]
    if content.headings:
        lines.append("- Headings: " + " / ".join(h[:60] for h in content.headings[:8]))
    if content.items:
        lines.append("- Listed items (%d%s):" % (len(content.items), ", truncated" if content.truncated else ""))
        for item in content.items[:20]:
            lines.append("    * " + compact_item(item))
    for table in (content.tables or [])[:2]:
        headers = table.get("headers") or []
        rows = table.get("rows") or []
        lines.append("- Table [%s] (%d rows):" % (", ".join(str(h)[:20] for h in headers[:8]), len(rows)))
        for row in rows[:8]:
            lines.append("    | " + " | ".join(str(c)[:30] for c in (row or [])[:8]))
    if content.text:
        lines.append("- Text: " + content.text[:1200])
    return "\n".join(lines)


def describe_recent(actions: List[RecentAction]) -> str:
    if not actions:
        return ""
    lines = ["RECENT ACTIONS (most recent last):"]
    for a in actions[-6:]:
        lines.append("- %s%s%s%s" % (
            a.type,
            " on \"%s\"" % a.label if a.label else "",
            " — FAILED" if a.ok is False else "",
            " (%s)" % a.note if a.note else ""))
    lines.append("Do not repeat an action that already succeeded, and do not retry one that failed "
                 "the same way — choose a different route.")
    return "\n".join(lines)


def describe_site_hints(hints: Optional[SiteHints]) -> str:
    if not hints:
        return ""
    bits = []
    if hints.search_label:
        bits.append("the search box that worked last time was labelled \"%s\"" % hints.search_label)
    if hints.notes:
        bits.extend(hints.notes[:4])
    if hints.successes:
        bits.append("%d task(s) completed here before" % hints.successes)
    return "WHAT WORKED ON THIS SITE BEFORE: " + "; ".join(bits) + "." if bits else ""


def current_milestone(plan: Optional[Plan]) -> Optional[Milestone]:
    if not plan:
        return None
    for m in plan.milestones:
        if m.status not in ("done", "skipped"):
            return m
    return None


def plan_complete(plan: Optional[Plan]) -> bool:
    return bool(plan and plan.milestones) and current_milestone(plan) is None


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
# A tier that is merely slow may be fast again in a minute, so it rests briefly rather than
# being written off for half an hour like a rejected key.
SLOW_COOLDOWN_S = 120.0
MAX_TIER_TIMEOUTS = 2

# How long a whole tier may spend before the next one takes over, however many models it has
# left to try. Without this, four models at 15s each made a single step cost a minute.
TIER_BUDGET_S = 22.0

# How long the WHOLE chain may spend planning one step. Past this the local tiers answer, and
# they answer in under a second.
#
# This is the single most important latency number in the system. Measured on a five-step
# shopping journey with the hosted providers degraded — 503s, read timeouts, and a vision
# model rejecting its own JSON — individual steps cost 13s, 17s, 30s and 30s, and the run took
# 164 seconds. Nothing was broken; every tier was simply allowed to fail slowly in turn. With
# this deadline the same run is bounded, because a step that has spent its budget stops asking
# hosted models and uses the local one.
STEP_PLAN_BUDGET_S = float(os.getenv("STEP_PLAN_BUDGET_S", "12"))
# One hosted call inside a step. A model that cannot answer a multiple-choice question in this
# long is not useful in an interactive loop, whatever it would eventually have said.
STEP_CALL_TIMEOUT_S = 9.0

# name -> {"until": epoch seconds, "reason": str}
_tier_cooldowns: Dict[str, Dict[str, Any]] = {}

# Consecutive timeouts per tier. Reset by any answer.
_tier_timeouts: Dict[str, int] = {}

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
    elif "timed out" in lowered or "timeout" in lowered:
        cooldown, kind = SLOW_COOLDOWN_S, "too slow to answer"
    else:
        cooldown, kind = DEFAULT_COOLDOWN_S / 3, "erroring"
    _tier_cooldowns[name] = {"until": time.time() + cooldown, "reason": kind}
    _tier_timeouts[name] = 0
    print(f"[server] {name} {kind}; skipping it for {int(cooldown)}s")


def note_dud(name: str, why: str = "timed out") -> None:
    """A tier that keeps failing slowly is worse than one that is absent.

    Every such call costs the client most of its budget and then falls through to the next tier
    anyway. Timeouts and 503s are not errors the ordinary breaker sees — a 503 is not a quota
    message and a timeout is not reported at all — so a provider having a bad afternoon was
    re-asked on every single step, at ~20s each. This is that missing signal: two consecutive
    duds and the tier rests briefly, then gets another chance."""
    _tier_timeouts[name] = _tier_timeouts.get(name, 0) + 1
    if _tier_timeouts[name] >= MAX_TIER_TIMEOUTS:
        trip_tier(name, why if "timed out" in why else f"{why} timed out")


def note_success(name: str) -> None:
    _tier_timeouts[name] = 0


def tier_status() -> Dict[str, Any]:
    now = time.time()
    return {
        name: {"reason": e["reason"], "retry_in_s": max(0, int(e["until"] - now))}
        for name, e in _tier_cooldowns.items()
    }


# Models a provider says do not exist are not worth asking again this session.
_dead_models: set = set()


# ── The planning prompt, shared by every model tier ──────────────────────────
#
# One prompt builder so the tiers behave consistently and so a rule fixed for one model is
# fixed for all of them. `rich` adds page content, findings and recent actions; the compact
# form is what a small local model gets, because every token it reads costs real time.

VAULT_KEYS_TEXT = """     name      full personal name
     username  login handle / user id  (NOT the person's name)
     email     email address
     phone     phone or mobile number
     address   street address, city, postcode
     company   employer or organisation
     about     free-text bio or notes
     password  password or passcode"""


def build_planner_prompt(req: "AgentStepRequest", marks_summary: List[dict], rich: bool = True) -> str:
    sections = [
        'USER TASK: "%s"' % req.task,
        "STEP NUMBER: %s" % req.step,
        "ALREADY PROCESSED MARK IDs: %s" % (req.filled_mark_ids or []),
        describe_page(req.page_info),
        describe_plan(req.plan),
        describe_progress(req.progress),
        describe_hints(req.task_hints),
    ]
    if rich:
        sections.append(describe_findings(req.findings))
        sections.append(describe_page_content(req.page_content))
        sections.append(describe_recent(req.recent_actions))
        sections.append(describe_site_hints(req.site_hints))
        if req.preferences:
            sections.append("USER PREFERENCES (apply when choosing between options): %s" % req.preferences[:400])
        if req.user_note:
            sections.append("THE USER JUST SAID: \"%s\" — follow this over the original plan where they conflict." % req.user_note[:300])
    sections.append("AVAILABLE INTERACTIVE ELEMENTS (choose \"target\" from these ids ONLY):\n%s"
                    % json.dumps(marks_summary, indent=1))

    if not rich:
        # The short form. A small local model reads every token at real cost, and beyond a
        # certain prompt length it stops following instructions and starts stalling.
        compact_rules = """RULES: one action for the CURRENT MILESTONE. Never invent personal data: for a personal
field set "use_vault_field" (name, username, email, phone, address, company, about, password)
and leave "value" null. For a search, "type" the SEARCH QUERY exactly into the search box.
To compare or extract, use "read_page"; when decided, use "answer" with the conclusion in
"value". Use "next_milestone" if the current milestone is already achieved. Return "done"
only when every milestone is done."""
        compact_schema = """Respond with STRICT JSON only:
{"reasoning": "<short>", "milestone_done": <true|false>,
 "action": {"type": "click"|"type"|"scroll_page"|"read_page"|"answer"|"next_milestone"|"done",
            "target": <mark id or null>, "value": "<text or null>", "use_vault_field": "<key or null>"}}"""
        return "\n\n".join([s for s in sections if s] + [compact_rules, compact_schema])

    rules = """RULES:
1. Choose exactly ONE action that makes progress on the CURRENT MILESTONE.
2. Never invent personal data. For anything personal set "use_vault_field" and leave "value" null.
   Valid keys, and only these:
%s
   Pick the key from the field's own label, not its input type. If no key fits, pick the closest one.
3. When typing a search query, use the SEARCH QUERY above verbatim. Never type the user's whole
   sentence, and never append "and show me", "please" or similar.
4. Understand controls by PURPOSE, not exact wording: "Continue", "Proceed", "Next" and "Go" all
   advance; "Add to cart", "Add to bag" and "Add to basket" all add; "Buy now", "Checkout" and
   "Place order" all start payment.
5. To compare, choose between, extract or summarise what a page shows, first use "read_page"
   (no target). The page content arrives on the next step. Do not read the same page twice.
6. When you have decided or extracted something, use "answer": put the conclusion in "value"
   and any structured data in "findings" ({"title": ..., "items": [{"title","price","rating","meta"}]}).
7. If an item you want is in PAGE CONTENT but has no mark, use "scroll_to" with a few words of
   its title in "value"; it will be clickable on the next step.
8. Use "navigate" (value = full URL) only for a site's home page or a URL you were given.
9. Do not repeat an action listed as already done, and do not retry an action that just failed
   the same way — find another route (another control, scrolling, the site's own search).
10. Set "milestone_done": true when this action completes the current milestone.
    Use action "next_milestone" when the current milestone is already achieved.
11. Return "done" ONLY when every milestone is done (or nothing on the page can advance the
    task — then say why in "reasoning"). With "done", write a 1-3 sentence "summary" of what
    was achieved for the user, mentioning concrete results from FINDINGS where relevant.
12. "confidence" is your own 0-1 estimate that this action is right.""" % VAULT_KEYS_TEXT

    schema = """Respond with STRICT JSON and nothing else:
{"reasoning": "<one sentence>",
 "confidence": <0.0-1.0>,
 "milestone_done": <true|false>,
 "action": {"type": "click"|"type"|"select"|"press_key"|"scroll_page"|"scroll_to"|"navigate"|"read_page"|"answer"|"next_milestone"|"done",
            "target": <mark id or null>, "value": "<text or null>",
            "use_vault_field": "<key or null>"},
 "findings": {"title": "<what these are>", "items": [...]} or null,
 "summary": "<only with done>"}"""

    return "\n\n".join([s for s in sections if s] + [rules, schema])


def _parse_step_json(parsed: dict, default_reasoning: str) -> StepResponse:
    """Turns a model's JSON into a StepResponse, tolerating the shapes models actually emit."""
    act = parsed.get("action") or {}
    if isinstance(act, str):
        act = {"type": act}
    reasoning = str(parsed.get("reasoning") or default_reasoning)
    findings = None
    raw_f = parsed.get("findings")
    if isinstance(raw_f, dict) and (raw_f.get("items") or raw_f.get("text")):
        items = raw_f.get("items") or []
        if isinstance(items, list):
            clean = []
            for it in items[:25]:
                if isinstance(it, dict):
                    clean.append({k: (str(v)[:160] if v is not None else "") for k, v in it.items() if k in ("title", "price", "rating", "meta", "url", "mark_id")})
                elif isinstance(it, str):
                    clean.append({"title": it[:160]})
            findings = Finding(kind=str(raw_f.get("kind") or "items"), title=str(raw_f.get("title") or "")[:120],
                               items=clean, text=(str(raw_f.get("text"))[:800] if raw_f.get("text") else None))
    confidence = parsed.get("confidence")
    try:
        confidence = max(0.0, min(1.0, float(confidence))) if confidence is not None else None
    except (TypeError, ValueError):
        confidence = None
    target = act.get("target")
    try:
        target = int(target) if target is not None and str(target).strip() != "" else None
    except (TypeError, ValueError):
        target = None
    value = act.get("value")
    return StepResponse(
        reasoning=reasoning,
        action=StepAction(
            type=str(act.get("type") or "done").lower().strip(),
            target=target,
            value=(str(value) if value is not None else None),
            use_vault_field=(str(act.get("use_vault_field")) if act.get("use_vault_field") else None),
            reasoning=reasoning,
        ),
        milestone_done=bool(parsed.get("milestone_done")),
        confidence=confidence,
        findings=findings,
        summary=(str(parsed.get("summary"))[:800] if parsed.get("summary") else None),
    )


# ── Google Gemini VLM Planning ───────────────────────────────────────────────
def _gemini_models() -> List[str]:
    return [
        os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
        "gemini-2.5-flash-lite",
        "gemini-flash-latest",
        "gemini-3-flash-preview",
    ]


def gemini_generate(prompt_text: str, img_b64: str = "", timeout: float = 15.0,
                    tier_name: str = "gemini", deadline: Optional[float] = None) -> Optional[dict]:
    """One JSON answer from the first Gemini model that responds. None when the tier fails.

    `deadline` is an absolute epoch time the whole tier must respect, so a step's budget is
    honoured however many models are left to try."""
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        return None
    started = time.time()
    tier_deadline = min(started + TIER_BUDGET_S, deadline) if deadline else started + TIER_BUDGET_S
    failed_slowly = False
    tried = 0
    for model_name in _gemini_models():
        if model_name in _dead_models:
            continue
        # Spending the whole step budget working down a list of models that are all slow
        # helps nobody: the next tier answers in under a second. Two attempts, then hand over.
        left = tier_deadline - time.time()
        if tried >= 2 or left < 1.5:
            if tried:
                print(f"[server] Gemini stopping after {tried} model(s) in {time.time() - started:.0f}s; handing over")
                failed_slowly = True
            break
        tried += 1
        timeout = min(timeout, left)
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={key}"
        parts: List[Dict[str, Any]] = [{"text": prompt_text}]
        if img_b64:
            parts.append({"inline_data": {"mime_type": "image/png", "data": img_b64}})
        payload = {
            "contents": [{"parts": parts}],
            "generationConfig": {"response_mime_type": "application/json", "temperature": 0.1},
        }
        try:
            req_post = urllib.request.Request(
                url, data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req_post, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                candidate = data.get("candidates", [{}])[0]
                content = candidate.get("content", {}).get("parts", [{}])[0].get("text", "")
                parsed = robust_json_parse(content)
                if parsed and isinstance(parsed, dict):
                    note_success(tier_name)
                    return parsed
                print(f"[server] Gemini ({model_name}) returned unparseable output: {content[:160]!r}")
        except Exception as e:
            text = str(e)
            print(f"[server] Gemini ({model_name}) error: {text}")
            if "404" in text or "not found" in text.lower():
                # This model name is wrong for this account; it will not start existing.
                _dead_models.add(model_name)
            elif "429" in text or "quota" in text.lower():
                trip_tier(tier_name, e)
                return None
            elif "timed out" in text.lower() or "503" in text or "502" in text or "unavailable" in text.lower():
                # Slow or unavailable, not refused. Both cost a full round trip for nothing.
                failed_slowly = True
            continue
    if failed_slowly:
        note_dud(tier_name, "was slow or unavailable")
    return None


def plan_with_gemini(req: AgentStepRequest, deadline: Optional[float] = None) -> Optional[StepResponse]:
    img_b64 = req.redactedImage or req.image or ""
    if "," in img_b64:
        img_b64 = img_b64.split(",", 1)[1]
    marks_summary = marks_for_prompt(req, with_boxes=bool(img_b64))
    prompt = ("You are VisionVault: a visual AI browser agent for privacy-preserving web automation. "
              "You receive a sanitized screenshot (faces, credentials and personal data already "
              "blacked out on the user's device) plus Set-of-Marks numbered element tags.\n\n"
              + build_planner_prompt(req, marks_summary, rich=True))
    parsed = gemini_generate(prompt, img_b64, timeout=STEP_CALL_TIMEOUT_S, deadline=deadline)
    if not parsed:
        return None
    plan = _parse_step_json(parsed, "Gemini plan")
    print(f"[server] [GEMINI] Action: {plan.action.type} (target: {plan.action.target}) - {plan.reasoning}")
    return plan

# Model families on this provider that accept an image alongside text. Everything else is
# text-only and errors on a multimodal content array rather than ignoring the image.
_VISION_MODEL_RE = re.compile(r"qwen3|llama-4|scout|maverick|vision|vl\b", re.I)


def _groq_models() -> List[str]:
    """This provider's models, best first.

    The configured model leads because it is the only one here that reads an image. The rest
    are text-only and all answered a planning prompt in under a second when benchmarked, so
    the order among them barely matters; what matters is that they exist, because the vision
    model exhausts its daily token budget long before the day is over."""
    return [
        os.getenv("GROQ_MODEL", "qwen/qwen3.6-27b"),
        "qwen/qwen3.8-27b",
        "openai/gpt-oss-20b",
        "openai/gpt-oss-120b",
        "groq/compound-mini",
    ]


def _accepts_images(model_name: str) -> bool:
    return bool(_VISION_MODEL_RE.search(model_name or ""))


def groq_generate(prompt: str, img_data_url: str = "", max_tokens: int = 900,
                  deadline: Optional[float] = None, call_timeout: Optional[float] = None) -> Optional[dict]:
    """One JSON answer from the first Groq model that responds. None when the tier fails."""
    if not groq_client:
        return None

    # Only some models on this provider accept an image. The rest reject a multimodal content
    # array outright ("messages[0].content must be a string"), which meant that whenever the
    # one vision model was rate-limited — routinely, on a free tier — every fallback model in
    # this tier failed too, and the whole tier silently vanished from the chain.
    #
    # A text-only model is still a perfectly good planner here: the Set-of-Marks table, page
    # context and progress carry the decision, as the local tier demonstrates. So each model
    # gets the payload shape it can actually accept.
    def messages_for(model_name: str):
        if img_data_url and _accepts_images(model_name):
            return [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": img_data_url}},
            ]}]
        return [{"role": "user", "content": prompt}]

    raw_content = ""
    last_error = None
    started = time.time()
    tier_deadline = min(started + TIER_BUDGET_S, deadline) if deadline else started + TIER_BUDGET_S
    tried = 0
    for model_name in _groq_models():
        if model_name in _dead_models or _model_cooldowns.get(model_name, 0) > time.time():
            continue
        # Two models per step at most. A third is another full timeout for a tier that has
        # already failed twice, and the tier below answers in about a second.
        if tried >= 2 or time.time() > tier_deadline - 2.0:
            if tried:
                print(f"[server] Groq stopping after {tried} model(s) in {time.time() - started:.0f}s; handing over")
                note_dud("groq", "was slow")
            break
        tried += 1
        try:
            # A per-call timeout, not just a per-tier budget. The budget is checked BEFORE a
            # call; without this the call itself is unbounded, and one that ran for 29s blew
            # a 12s step budget from inside — the client's own abort was what ended it.
            per_call = max(2.0, min(call_timeout or STEP_CALL_TIMEOUT_S, tier_deadline - time.time()))
            # max_retries=0 matters as much as the timeout. The SDK retries a failed call twice
            # by default, so a 9-second timeout became a 27-second one — measured, a single
            # step spent 22.5s inside this tier while its budget said 12. The planning chain is
            # already a retry policy, and a better one: the next tier is a different model.
            chat_completion = groq_client.with_options(timeout=per_call, max_retries=0).chat.completions.create(
                model=model_name,
                messages=messages_for(model_name),
                temperature=0.1,
                # 900, not 450: a model that writes a paragraph of reasoning before the JSON
                # runs out mid-document and the whole call is rejected with
                # "max completion tokens reached before generating a valid document".
                max_tokens=max_tokens,
                response_format={"type": "json_object"}
            )
            raw_content = chat_completion.choices[0].message.content or ""
            if raw_content:
                break
        except Exception as e:
            # Silence here made a whole tier look like it did not exist: during live runs every
            # Groq call failed and the log said nothing, so the local model appeared to be the
            # second tier. A failing tier must say why it failed.
            text = str(e)
            print(f"[server] Groq ({model_name}) error: {type(e).__name__}: {text}")
            if "404" in text or "does not exist" in text.lower():
                _dead_models.add(model_name)
            elif "429" in text or "rate limit" in text.lower():
                # Groq quotas are per-model, so this rules out one model, not the tier.
                _model_cooldowns[model_name] = time.time() + (_parse_retry_after(text) or DEFAULT_COOLDOWN_S)
            elif "json_validate_failed" in text or "failed to validate json" in text.lower():
                # The model wrote something that is not the JSON object we asked for. That is
                # about this prompt and this model, not about the account: rest the model
                # briefly so the tier still has its others to fall back on.
                _model_cooldowns[model_name] = time.time() + 60
            last_error = e
            continue

    data = robust_json_parse(raw_content)
    if not data or not isinstance(data, dict):
        if raw_content:
            print(f"[server] Groq returned unparseable output: {raw_content[:160]!r}")
        elif last_error is not None:
            # Every model was refused. Rest the whole tier rather than repeating that on the
            # next step, which is where ~20s of per-step latency was going.
            trip_tier("groq", last_error)
        return None
    note_success("groq")
    return data


# ── Groq VLM Inference ────────────────────────────────────────────────────────
def plan_with_groq(req: AgentStepRequest, deadline: Optional[float] = None) -> Optional[StepResponse]:
    if not groq_client:
        return None

    img_b64 = req.redactedImage or req.image or ""
    if img_b64 and not img_b64.startswith("data:image"):
        img_b64 = f"data:image/png;base64,{img_b64}"

    # Boxes only if at least one model in this tier will actually see the image.
    marks_summary = marks_for_prompt(
        req, with_boxes=bool(img_b64) and any(_accepts_images(m) for m in _groq_models())
    )
    prompt = ("You are VisionVault: an autonomous, privacy-preserving visual browser agent. "
              "You receive a client-side redacted screenshot (personal data and faces blacked out "
              "on-device) and numbered interactive element marks. Keep \"reasoning\" to one short sentence.\n\n"
              + build_planner_prompt(req, marks_summary, rich=True))
    data = groq_generate(prompt, img_b64, deadline=deadline)
    if not data:
        return None
    plan = _parse_step_json(data, "Groq plan")
    print(f"[server] [GROQ] Action: {plan.action.type} (target: {plan.action.target}) - {plan.reasoning}")
    return plan

# ── Instruction parsing (mirrors extension/task-planner.js) ───────────────────
#
# Kept in step with the client by hand and by test: eval/test-workflow.js runs the same
# sentences through the JavaScript and eval/test-fallback-chain.py through this file.
TAIL_RE = re.compile(
    r"\s*(?:,|\band\b|\bthen\b)?\s*(?:please\s+)?(?:can\s+you\s+)?(?:show|display|tell|give|list|find)\s+"
    r"(?:me|us|it)?\s*(?:the\s+)?(?:results?|details?|options?|list|prices?|it)?\s*[.!]?\s*$",
    re.I,
)
CLAUSE_VERBS = (
    r"open|click|select|choose|pick|scroll|show|tell|display|go|buy|add|book|play|read|check|"
    r"compare|analy[sz]e|extract|summari[sz]e|note|find|search|look|fill|enter|type|navigate|visit|"
    r"prepare|proceed|apply|filter|sort|verify|make sure|ensure|save|copy|list|get|bring|report|"
    r"give|send|compose|write|reply|log|sign|register|track|remove|update|create|complete|start|"
    r"review|evaluate|examine|research|then|finally"
)
# A clause boundary is a comma/semicolon/full stop, or a conjunction, that is followed by a verb
# from the list above. "search for salt and pepper" has no verb after "and", so it stays one
# clause; "find laptops, compare them" splits at the comma because "compare" is a verb.
CLAUSE_SPLIT_RE = re.compile(
    r"(?:\s*[,;.]\s*(?:and\s+then|and|then|after that|afterwards|finally|next)?\s*"
    r"|\s+(?:and\s+then|and|then|after that|afterwards|finally|next)\s+)"
    r"(?:also\s+)?(?=(?:%s)\b)" % CLAUSE_VERBS,
    re.I,
)
POLITE_TAIL_RE = re.compile(r"[\s,.!]*\b(?:please|thanks|thank you|pls|plz)\b[\s,.!]*$", re.I)
SEARCH_RE = re.compile(r"\b(?:search|look|find|browse)\s+(?:for\s+|up\s+|me\s+)?(.+)$", re.I)
OPEN_TARGET_RE = re.compile(r"\b(?:open|click|select|choose|tap)\s+(?:on\s+)?(?:the\s+)?(.+?)(?=\s+(?:and|then|,)\s+|$)", re.I)
QUERY_LEAD_RE = re.compile(r"^(?:the\s+)?(?:best|cheapest|top(?:\s+rated)?|good|a|an|some|most (?:suitable|popular))\s+", re.I)
# Qualifiers that describe how to choose, not what to type: "laptop under my budget" searches
# for "laptop"; the budget is applied when the results are compared.
QUERY_STOP_RE = re.compile(
    r"\s+(?:that|which|having|with the (?:best|highest|most|lowest)|"
    r"(?:under|within|below|inside) (?:my|our|the) budget)\b.*$", re.I)
# A clause that only says what the user wants to SEE. Not an instruction to the browser.
TAIL_CLAUSE_RE = re.compile(r"^(?:show|display)\s+(?:me|us)\b", re.I)
ANSWER_CLAUSE_RE = re.compile(
    r"^(?:tell|give)\s+(?:me|us)\b|^(?:list|report|extract|summari[sz]e|note|what|which|how much|how many)\b", re.I)


def extract_search_query(task: str) -> Optional[str]:
    """The text the user wants typed into a search box, with clauses and tails removed."""
    match = SEARCH_RE.search(task or "")
    if not match:
        return None
    query = CLAUSE_SPLIT_RE.split(match.group(1))[0]
    query = TAIL_RE.sub("", query)
    query = POLITE_TAIL_RE.sub("", query)
    query = QUERY_STOP_RE.sub("", query)
    query = QUERY_LEAD_RE.sub("", query)
    query = query.strip().strip("\"'`").strip()
    query = re.sub(r"[\s,;:.\-]+$", "", query).strip()
    if not query or re.fullmatch(r"(?:me|it|this|that|results?|them)", query, re.I):
        return None
    return query[:120]


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


# ── Task decomposition (rules) ───────────────────────────────────────────────
#
# The deterministic planner's view of a task: an ordered list of milestones. Mirrors
# extension/task-planner.js decomposeTask(); the model tiers produce the same shape and are
# preferred when available, but this is what the client gets when nothing else answers.

KNOWN_SITES = {
    "amazon": "https://www.amazon.in", "flipkart": "https://www.flipkart.com",
    "myntra": "https://www.myntra.com", "makemytrip": "https://www.makemytrip.com",
    "make my trip": "https://www.makemytrip.com", "goibibo": "https://www.goibibo.com",
    "irctc": "https://www.irctc.co.in", "swiggy": "https://www.swiggy.com",
    "zomato": "https://www.zomato.com", "youtube": "https://www.youtube.com",
    "google": "https://www.google.com", "wikipedia": "https://www.wikipedia.org",
    "github": "https://github.com", "reddit": "https://www.reddit.com",
    "stack overflow": "https://stackoverflow.com", "stackoverflow": "https://stackoverflow.com",
    "hacker news": "https://news.ycombinator.com", "bbc": "https://www.bbc.com/news",
    "mdn": "https://developer.mozilla.org", "linkedin": "https://www.linkedin.com",
    "gmail": "https://mail.google.com", "booking": "https://www.booking.com",
    "ebay": "https://www.ebay.com", "imdb": "https://www.imdb.com",
    "bookmyshow": "https://in.bookmyshow.com", "snapdeal": "https://www.snapdeal.com",
    "duckduckgo": "https://duckduckgo.com", "bing": "https://www.bing.com",
    "npm": "https://www.npmjs.com", "pypi": "https://pypi.org",
}

SITE_RE = re.compile(r"\b(?:open|go\s+to|goto|visit|navigate\s+to|launch|browse)\s+(.+?)(?=\s+(?:and|then|,)\s+|$)", re.I)


def site_url_for(name: str) -> Optional[str]:
    key = re.sub(r"\.(com|in|org|net|co\.in)$", "", (name or "").lower().strip())
    if key in KNOWN_SITES:
        return KNOWN_SITES[key]
    if re.fullmatch(r"[a-z0-9-]+(\.[a-z]{2,})+", name or "", re.I):
        return "https://" + name
    return None


def decompose_task(task: str) -> Plan:
    """Rules-only decomposition of an instruction into milestones."""
    text = re.sub(r"^\s*(?:hey|hi|ok|okay|please|can you|could you|would you|i want to|i want you to|i need to|help me|let's|lets)\s+",
                  "", task or "", flags=re.I).strip()
    text = POLITE_TAIL_RE.sub("", TAIL_RE.sub("", text)).strip()
    clauses = [c.strip(" ,.;") for c in CLAUSE_SPLIT_RE.split(text) if c and c.strip(" ,.;")]
    milestones: List[Milestone] = []
    wants_answer = False
    wants_best = False

    def add(kind: str, title: str, target: Optional[str] = None, note: Optional[str] = None):
        # Two reads in a row ("compare the options", "analyse the ratings") are one read of one
        # page; keep both titles but do not read the page twice.
        if kind == "read" and milestones and milestones[-1].kind == "read":
            if title != "Read the page":
                milestones[-1].title = (milestones[-1].title + "; " + title)[:80]
            return
        milestones.append(Milestone(id=len(milestones) + 1, title=title[:80], kind=kind,
                                    target=(target[:120] if target else None), note=note))

    for clause in clauses:
        low = clause.lower()
        if TAIL_CLAUSE_RE.match(low):
            continue
        site_match = SITE_RE.search(clause)
        if site_match:
            candidate = site_match.group(1).strip("\"'` ")
            looks_like_site = not re.search(r"\b(result|link|item|product|tab|menu|first|second|third|top|best|page)\b", candidate, re.I)
            url = site_url_for(candidate) if looks_like_site else None
            if url:
                add("navigate", "Open %s" % candidate, url)
                rest = (clause[:site_match.start()] + " " + clause[site_match.end():]).strip(" ,")
                rest = re.sub(r"^(?:and|then)\s+", "", rest, flags=re.I).strip()
                if not rest:
                    continue
                clause, low = rest, rest.lower()

        query = extract_search_query(clause)
        if query and re.match(r"^(?:search|look|find|browse)\b", low):
            add("search", 'Search for "%s"' % query, query)
            if re.search(r"\b(best|cheapest|top rated|highest rated|most suitable|good|compare)\b", low):
                wants_best = True
            continue
        if re.match(r"^(?:compare|analy[sz]e|check|review|evaluate|examine|research|read|look at)\b", low):
            add("read", clause[:1].upper() + clause[1:], None, "compare")
            continue
        if ANSWER_CLAUSE_RE.match(low) or re.search(r"\b(summary|summari[sz]e)\b", low):
            add("read", "Read the page", None, "extract")
            add("answer", clause[:1].upper() + clause[1:], clause)
            wants_answer = True
            continue
        if re.match(r"^(?:select|choose|pick)\b", low) and re.search(r"\b(best|most suitable|top|cheapest|highest|first)\b", low):
            add("open", clause[:1].upper() + clause[1:], "best")
            continue
        m = re.match(r"^(?:add)\b.*\b(?:cart|bag|basket)\b", low)
        if m:
            add("act", "Add it to the cart", "add to cart", "asks for approval")
            continue
        if re.search(r"\b(checkout|check out|buy now|place (?:the )?order|proceed to (?:buy|pay))\b", low):
            add("act", "Go to checkout", "checkout", "asks for approval")
            continue
        if re.search(r"\b(fill|register|sign\s?up|signup|enter my details|complete the form|apply)\b", low):
            add("fill", "Fill in the form from the vault")
            continue
        if re.search(r"\b(scroll|load more|next page|more results|read more)\b", low):
            add("scroll", "Scroll for more")
            continue
        m = OPEN_TARGET_RE.search(clause)
        if m and re.match(r"^(?:open|click|select|choose|tap)\b", low):
            target = TAIL_RE.sub("", m.group(1)).strip().lower()
            if target:
                add("open", "Open \"%s\"" % target, target)
                continue
        if re.search(r"\b(log\s?in|sign\s?in|login)\b", low):
            add("act", "Sign in", "sign in", "asks for approval")
            continue
        add("act", clause[:1].upper() + clause[1:], clause)

    if not milestones:
        add("act", text or task or "Do the task", text or task)
    # "the best X" implies comparing and choosing, even when the sentence never says so. Only
    # added when the user did not spell those steps out themselves.
    kinds = [m.kind for m in milestones]
    if wants_best and "read" not in kinds:
        idx = next((i for i, m in enumerate(milestones) if m.kind == "search"), len(milestones) - 1) + 1
        milestones.insert(idx, Milestone(id=0, kind="read", title="Read and compare the results", note="compare"))
        milestones.insert(idx + 1, Milestone(id=0, kind="open", title="Open the best match", target="best"))
    elif wants_best and "open" not in kinds:
        idx = max(i for i, m in enumerate(milestones) if m.kind == "read") + 1
        milestones.insert(idx, Milestone(id=0, kind="open", title="Open the best match", target="best"))
    if wants_answer and milestones[-1].kind != "answer":
        add("answer", "Summarise what was found", "summary")
    for i, m in enumerate(milestones):
        m.id = i + 1
    return Plan(goal=(task or "")[:200], milestones=milestones, current=0)


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


def ollama_generate(system: str, user: str, num_predict: int = 160, attempts: int = 2,
                    deadline: Optional[float] = None) -> Optional[dict]:
    """A JSON object from the local model, within whatever time is left.

    `deadline` matters as much here as it does for a hosted tier. The local tier is the last
    one that can think, so it is reached exactly when the step is already late — and a 25s
    timeout with a retry could add 50 seconds to a step that had already spent its budget.
    Measured: this was the whole of a 20s-per-step plateau that looked like a hosted-model
    problem and was not."""
    model = ollama_model()
    if not model:
        return None
    payload = {
        "model": model,
        "format": "json",
        "stream": False,
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "options": {"temperature": 0.1, "num_predict": num_predict, "num_ctx": 4096},
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    # One retry only, and only if there is time for it. A second full generation on a slow
    # local model costs more than the deterministic tier below would take to answer perfectly
    # well.
    for attempt in range(1, attempts + 1):
        timeout = OLLAMA_TIMEOUT
        if deadline is not None:
            timeout = min(timeout, max(0.0, deadline - time.time()))
            if timeout < 1.5:
                print(f"[server] Ollama ({model}): no time left in this step's budget")
                return None
        data = _http_json(f"{OLLAMA_HOST}/api/chat", payload, timeout)
        if not data:
            print(f"[server] Ollama ({model}) attempt {attempt}: no response within {timeout:.0f}s")
            continue
        content = (data.get("message") or {}).get("content", "")
        parsed = robust_json_parse(content)
        if parsed and isinstance(parsed, dict):
            return parsed
        print(f"[server] Ollama ({model}) attempt {attempt}: unparseable output")
    return None


def plan_with_ollama(req: "AgentStepRequest", deadline: Optional[float] = None) -> Optional[StepResponse]:
    model = ollama_model()
    if not model:
        return None

    # Every token generated locally costs real time, so the request is kept small: only the
    # elements that could plausibly be acted on, short labels, and a hard cap on the reply.
    marks_summary = [
        {"id": m.id, "role": m.role, "label": (m.label or "")[:48]}
        for m in req.marks if m.id not in (req.filled_mark_ids or [])
    ][:30]

    # The compact prompt, plus the one piece of rich context a small model can use well: the
    # current milestone. Page content is included only when it was just read, since that is
    # the step whose whole point is to look at it.
    prompt = build_planner_prompt(req, marks_summary, rich=False)
    if req.page_content:
        prompt += "\n\n" + describe_page_content(req.page_content)[:2500]
    if req.findings:
        prompt += "\n\n" + describe_findings(req.findings, limit_items=6)[:1500]

    parsed = ollama_generate(
        "You output ONE strict JSON object and nothing else. Keep \"reasoning\" under 12 words.",
        prompt, deadline=deadline)
    if not parsed:
        return None
    plan = _parse_step_json(parsed, f"Local {model} plan")
    print(f"[server] [OLLAMA:{model}] Action: {plan.action.type} (target: {plan.action.target}) - {plan.reasoning}")
    return plan

# ── Rule-Based Mock Planner ──────────────────────────────────────────────────
#
# Label vocabulary the rules understand. Controls are matched by purpose: a site that says
# "Proceed" where another says "Continue" should not defeat a rule about continuing.
SYNONYMS = {
    "add to cart": [r"add to (?:cart|bag|basket)", r"\bbuy\b(?! now)", r"add item"],
    "checkout": [r"check ?out", r"buy now", r"place order", r"proceed to (?:buy|pay|checkout)", r"continue to payment", r"pay now"],
    "continue": [r"\bcontinue\b", r"\bproceed\b", r"\bnext\b", r"\bgo\b", r"\bok\b", r"\bdone\b"],
    "sign in": [r"sign ?in", r"log ?in", r"\blogin\b"],
    "sign up": [r"sign ?up", r"register", r"create (?:an )?account", r"join"],
    "search": [r"\bsearch\b", r"\bfind\b", r"\bgo\b"],
    "submit": [r"\bsubmit\b", r"\bapply\b", r"\bsend\b", r"\bsave\b", r"\bconfirm\b"],
    "filter": [r"\bfilter", r"\bsort\b", r"refine"],
    "book": [r"\bbook\b", r"reserve", r"select (?:seat|room|flight)"],
    "next page": [r"next page", r"\bnext\b", r"load more", r"show more", r"see more"],
}


def label_matches(target: str, label: str) -> bool:
    """Does a control's label mean what `target` means?"""
    t = (target or "").lower().strip()
    l = (label or "").lower()
    if not t or not l:
        return False
    if t in l:
        return True
    for key, patterns in SYNONYMS.items():
        if key in t or t in key:
            if any(re.search(p, l, re.I) for p in patterns):
                return True
    words = [w for w in re.findall(r"[a-z0-9]+", t) if len(w) >= 3 and w not in ("the", "and", "for", "with", "this", "that", "into", "from")]
    return bool(words) and all(w in l for w in words)


def _pick_best_item(findings: List[Finding], preferences: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """The item a person would pick: highest rating, then lowest price, within any stated budget."""
    items: List[Dict[str, Any]] = []
    for f in findings:
        items.extend([i for i in (f.items or []) if i.get("title")])
    if not items:
        return None

    def money(v):
        m = re.search(r"(\d[\d,]*(?:\.\d+)?)", str(v or "").replace(",", ""))
        return float(m.group(1)) if m else None

    def rating(v):
        m = re.search(r"(\d(?:\.\d)?)", str(v or ""))
        return float(m.group(1)) if m else None

    budget = None
    m = re.search(r"(?:under|below|less than|upto|up to|max(?:imum)?)\s*(?:rs\.?|₹|\$|inr)?\s*(\d[\d,]*)", (preferences or ""), re.I)
    if m:
        budget = float(m.group(1).replace(",", ""))
    pool = [i for i in items if budget is None or (money(i.get("price")) is None or money(i.get("price")) <= budget)] or items
    pool.sort(key=lambda i: (-(rating(i.get("rating")) or 0), money(i.get("price")) or 1e12))
    return pool[0]


def mock_plan(marks: List[Mark], task: str, filled_ids: Optional[List[int]] = None,
              page_info: Optional[PageInfo] = None,
              progress: Optional[Progress] = None,
              plan: Optional[Plan] = None,
              findings: Optional[List[Finding]] = None,
              page_content: Optional[PageContent] = None,
              recent_actions: Optional[List[RecentAction]] = None,
              preferences: Optional[str] = None) -> StepResponse:
    """Deterministic planning. Milestone-aware when a plan is supplied; otherwise the classic
    search/open/scroll rules."""
    task_lower = (task or "").lower()
    filled_set = set(filled_ids or [])
    available = [m for m in marks if m.id not in filled_set]
    done_so_far = progress or Progress()
    findings = findings or []
    recent = recent_actions or []

    def find_mark(predicate):
        return next((m for m in available if predicate(m)), None)

    def step(kind, reasoning, target=None, value=None, vault=None, milestone_done=False, findings_out=None, summary=None):
        return StepResponse(reasoning=reasoning, milestone_done=milestone_done, confidence=0.5,
                            findings=findings_out, summary=summary,
                            action=StepAction(type=kind, target=target, value=value,
                                              use_vault_field=vault, reasoning=reasoning))

    def is_search_box(m):
        return m.role == "input:search" or (m.role in ("input:text", "editable") and bool(SEARCH_LABEL_RE.search(m.label or "")))

    just_read = bool(recent) and recent[-1].type == "read_page" and recent[-1].ok is not False

    milestone = current_milestone(plan)
    if milestone is not None:
        kind, target = milestone.kind, (milestone.target or "")
        if kind == "navigate":
            if done_so_far.navigated or (page_info and page_info.url and target and page_info.url.startswith(target.rstrip("/"))):
                return step("next_milestone", "Already on the site", milestone_done=True)
            return step("navigate", "Open %s" % target, value=target, milestone_done=True)
        if kind == "search":
            query = target or extract_search_query(task)
            if done_so_far.query_landed:
                return step("next_milestone", "The search has run", milestone_done=True)
            box = find_mark(is_search_box) or find_mark(lambda m: m.role in FILLABLE_ROLES)
            if box and query:
                return step("type", 'Search for "%s"' % query, target=box.id, value=query)
        if kind == "read":
            if page_content and just_read:
                items = [i for i in (page_content.items or []) if i.get("title")][:20]
                summary_text = None
                if not items and page_content.text:
                    summary_text = page_content.text[:600]
                return step("answer",
                            "Read %d item(s) from the page" % len(items) if items else "Read the page",
                            value=("Found %d items on this page." % len(items)) if items else (summary_text or "Read the page."),
                            milestone_done=True,
                            findings_out=Finding(kind="items", title=milestone.title, milestone=milestone.id,
                                                 items=items, text=summary_text))
            if not just_read:
                return step("read_page", "Read what the page shows")
            return step("next_milestone", "Nothing more to read here", milestone_done=True)
        if kind == "answer":
            best = _pick_best_item(findings, preferences)
            if best:
                text = "Best match: %s%s%s." % (
                    best.get("title", ""),
                    " at %s" % best["price"] if best.get("price") else "",
                    " rated %s" % best["rating"] if best.get("rating") else "")
            else:
                n = sum(len(f.items or []) for f in findings)
                text = "Read %d item(s) across %d page read(s)." % (n, len(findings)) if findings else "No structured results were found on the pages visited."
            return step("answer", "Summarise the findings", value=text, milestone_done=True)
        if kind == "open":
            if target == "best":
                best = _pick_best_item(findings, preferences)
                if best:
                    title = str(best.get("title") or "")
                    hit = None
                    if best.get("mark_id") is not None:
                        hit = find_mark(lambda m: m.id == int(best["mark_id"]))
                    if not hit:
                        hit = find_mark(lambda m: m.role == "link" and m.label and label_matches(title[:40], m.label))
                    if hit:
                        return step("click", "Open the best match: %s" % title[:60], target=hit.id, milestone_done=True)
                    if best.get("url"):
                        return step("navigate", "Open the best match: %s" % title[:60], value=str(best["url"]), milestone_done=True)
                    return step("scroll_to", "Bring the best match into view", value=title[:60])
                link = find_mark(lambda m: m.role == "link" and m.label and len(m.label) > 8)
                if link:
                    return step("click", "Open the first result: %s" % link.label, target=link.id, milestone_done=True)
            elif target in ("first", "first result", "top result", "the first result"):
                link = find_mark(lambda m: m.role == "link" and m.label and len(m.label) > 8)
                if link:
                    return step("click", "Open the first result: %s" % link.label, target=link.id, milestone_done=True)
            else:
                hit = find_mark(lambda m: m.label and m.role in CLICKABLE_ROLES and label_matches(target, m.label))
                if hit:
                    return step("click", 'Open "%s"' % hit.label, target=hit.id, milestone_done=True)
                if target and not just_read:
                    return step("scroll_to", 'Look for "%s" on the page' % target, value=target)
        if kind == "act":
            hit = find_mark(lambda m: m.label and m.role in CLICKABLE_ROLES and label_matches(target, m.label))
            if hit:
                return step("click", '%s ("%s")' % (milestone.title, hit.label), target=hit.id, milestone_done=True)
            if target and not just_read:
                return step("scroll_to", 'Look for "%s" on the page' % target, value=target)
        if kind == "scroll":
            if done_so_far.scrolled:
                return step("next_milestone", "Scrolled", milestone_done=True)
            return step("scroll_page", "Scroll down to reveal more content", value="600", milestone_done=True)
        if kind == "fill":
            for m in available:
                if m.role in FILLABLE_ROLES and not is_search_box(m) and m.label:
                    key = vault_key_for_label(m.label)
                    if key:
                        return step("type", 'Fill "%s" from the local vault' % m.label, target=m.id, vault=key)
            return step("next_milestone", "Every field that could be filled has been", milestone_done=True)
        if kind == "confirm":
            return step("next_milestone", "Nothing to confirm on this page", milestone_done=True)
        # Fell through: the milestone could not be advanced by rules on this page.
        return step("done", "No rule could advance \"%s\" on this page" % milestone.title)

    # ── No plan: the classic rules. ─────────────────────────────────────────────────────
    query = extract_search_query(task)
    if query and not done_so_far.query_landed:
        search_box = find_mark(lambda m: m.role in ["input:search", "input:text", "editable"])
        if search_box:
            return step("type", 'Search for "%s"' % query, target=search_box.id, value=query)

    for target in extract_open_targets(task):
        if target in (done_so_far.opened or []):
            continue
        if target in ("first", "first result", "top result"):
            link = find_mark(lambda m: m.role == "link" and m.label and len(m.label) > 8)
            if link:
                return step("click", "Open the first result: %s" % link.label, target=link.id)
            continue
        hit = find_mark(lambda m: m.label and m.role in ("link", "button", "clickable") and label_matches(target, m.label))
        if hit:
            return step("click", 'Open "%s"' % hit.label, target=hit.id)

    if (any(kw in task_lower for kw in ["scroll", "load more", "read more", "next page", "more results"])
            and not done_so_far.scrolled):
        remaining = None
        if page_info and page_info.page_height and page_info.viewport_height:
            remaining = page_info.page_height - (page_info.scroll_y or 0) - page_info.viewport_height
        if remaining is None or remaining > 50:
            return step("scroll_page", "Scroll down to reveal more page content", value="500")

    return step("done", "All requested task actions completed")


FIELD_LABEL_RULES = [
    (re.compile(r"user\s*name|username|user id|handle|login\s*id", re.I), "username"),
    (re.compile(r"e-?mail", re.I), "email"),
    (re.compile(r"phone|mobile|tel(ephone)?|contact number", re.I), "phone"),
    (re.compile(r"password|passcode", re.I), "password"),
    (re.compile(r"address|street|city|postcode|post code|zip|postal", re.I), "address"),
    (re.compile(r"company|organisation|organization|employer", re.I), "company"),
    (re.compile(r"about|bio|description|notes", re.I), "about"),
    (re.compile(r"full\s*name|first\s*name|last\s*name|surname|\bname\b", re.I), "name"),
]


def vault_key_for_label(label: str) -> Optional[str]:
    for pattern, key in FIELD_LABEL_RULES:
        if pattern.search(label or ""):
            return key
    return None

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
#   * a verb outside the action vocabulary

FILLABLE_ROLES = {"input:text", "input:search", "input:email", "input:tel",
                  "input:password", "input:url", "input:number", "textarea", "editable"}
CLICKABLE_ROLES = {"link", "button", "clickable", "input:submit", "input:checkbox", "input:radio",
                   "checkbox", "option", "tab", "menuitem"}
SEARCH_LABEL_RE = re.compile(r"search|find|query|keyword|looking for|explore", re.I)


def _is_search_mark(mark: Mark) -> bool:
    return mark.role == "input:search" or bool(SEARCH_LABEL_RE.search(mark.label or ""))


def _fallback(req: AgentStepRequest, notes: List[str]) -> StepResponse:
    fb = mock_plan(req.marks, req.task, req.filled_mark_ids, req.page_info, req.progress,
                   req.plan, req.findings, req.page_content, req.recent_actions, req.preferences)
    fb.reasoning = f"{fb.reasoning} (repaired: {'; '.join(notes)})"
    return fb


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
    if kind in ("none", "finish", "stop", "complete", "finished", ""):
        kind = action.type = "done"
    if kind in ("read", "extract", "observe", "look"):
        kind = action.type = "read_page"
    if kind in ("goto", "go_to", "visit", "open_url"):
        kind = action.type = "navigate"

    # A verb outside the vocabulary cannot be executed. The rules answer instead.
    if kind not in ACTION_TYPES:
        notes.append(f"unknown action \"{kind}\"")
        return _fallback(req, notes)

    # A workflow with milestones outstanding is not done, whatever the planner says. This is
    # the plan's whole purpose: a model asked to do six things will happily stop after two.
    if kind == "done" and req.plan and req.plan.milestones and not plan_complete(req.plan):
        current = current_milestone(req.plan)
        # "done" right after an answer/read is the model finishing its milestone, not the task.
        if plan.milestone_done or (req.recent_actions and req.recent_actions[-1].type in ("answer", "read_page")):
            notes.append("milestone finished, not the task")
            plan.action = StepAction(type="next_milestone", reasoning=plan.reasoning)
            plan.milestone_done = True
            plan.reasoning = f"{plan.reasoning} (repaired: {'; '.join(notes)})"
            return plan
        notes.append(f"\"done\" with milestone \"{current.title}\" outstanding")
        fb = _fallback(req, notes)
        # Only accept a rules-made answer that actually does something; otherwise honour the
        # planner's stop, with its reason, so the client can report it.
        if fb.action.type != "done":
            return fb
        plan.reasoning = f"{plan.reasoning} (could not advance \"{current.title}\" here)"
        return plan

    # A search that has not run yet, with a box to type into on screen, is typed into. Scrolling,
    # reading or waiting instead is a planner stalling — the small local model does exactly this
    # when the prompt grows — and there is no page on which typing the query is the wrong move.
    current = current_milestone(req.plan)
    searching = bool(query) and not progress.query_landed and (current is None or current.kind in ("search", "navigate"))
    if searching and kind in ("scroll_page", "scroll_to", "read_page", "next_milestone", "wait", "hover"):
        box = next((m for m in available if _is_search_mark(m) and m.role in FILLABLE_ROLES), None) \
            or next((m for m in available if m.role in FILLABLE_ROLES), None)
        if box is not None:
            notes.append(f"{kind} while the search is still to run; typing the query instead")
            kind = "type"
            plan.action = action = StepAction(type="type", target=box.id, value=query, reasoning=plan.reasoning)

    # Nothing to repair on a terminal or page-level action.
    if kind in ("done", "next_milestone", "read_page", "wait"):
        if kind == "read_page" and req.page_content and req.recent_actions and req.recent_actions[-1].type == "read_page":
            # Reading the same page twice gains nothing; answer from what was read.
            notes.append("page already read; answering from it")
            return _fallback(req, notes)
        return plan

    if kind == "answer":
        if not action.value and not plan.findings:
            notes.append("empty answer")
            return _fallback(req, notes)
        return plan

    if kind == "navigate":
        value = (action.value or "").strip()
        if not re.match(r"^https?://", value, re.I):
            notes.append("navigate without a URL")
            return _fallback(req, notes)
        return plan

    if kind == "scroll_to":
        if not (action.value or "").strip():
            notes.append("scroll_to without text")
            kind = action.type = "scroll_page"
        return plan

    target = marks.get(action.target) if action.target is not None else None

    # 1. A target that is not on the page cannot be acted on. Prefer re-aiming at a sensible
    #    element over sending the client an id it will fail to resolve.
    if action.target is not None and target is None:
        notes.append(f"target {action.target} is not on this page")
        target = None
        action.target = None

    # 2. Search intent that is still outstanding drives the strongest repairs, because it is
    #    the single most common thing a user asks for and the easiest to get wrong.
    if searching:
        search_box = next((m for m in available if _is_search_mark(m) and m.role in FILLABLE_ROLES), None)
        if search_box is None:
            search_box = next((m for m in available if m.role in FILLABLE_ROLES), None)

        # 2a. "click" aimed at a text field, when what the task needs is typing into it.
        if kind == "click" and target is not None and target.role in FILLABLE_ROLES:
            notes.append("clicking a text field does not run a search; typing instead")
            kind, action.type = "type", "type"
            action.value = query

        # 2a-ii. "click" on a LINK while a search box is sitting right there.
        #
        # A link navigates, and navigating away from the page that has the search box is how a
        # search gets lost. Observed live on eBay: the first action of a search task was a click
        # on an unlabelled link, which left the home page; the search box was then gone, two
        # attempts to reveal one failed, and the milestone was abandoned. A button is left
        # alone — on GitHub and MDN a button is exactly what mounts the search input — but a
        # link, with a usable box already visible, is never the way to run a search.
        elif kind == "click" and target is not None and target.role == "link" and search_box is not None:
            notes.append("a link navigates away from the search box; typing into it instead")
            kind, action.type = "type", "type"
            action.target = search_box.id
            action.value = query

        # 2b. "type" aimed at something that cannot hold text.
        elif kind == "type" and target is not None and target.role not in FILLABLE_ROLES and search_box:
            notes.append(f"{target.role} cannot accept text; retargeted to the search box")
            action.target = search_box.id

        # 2c. "type" with nowhere to type.
        elif kind == "type" and action.target is None and search_box:
            notes.append("no target given; using the search box")
            action.target = search_box.id

        # 2d. "type" with nothing to type, when the query is known.
        if kind == "type" and not action.value and not action.use_vault_field:
            notes.append("empty value; using the extracted search query")
            action.value = query

        # 2e. A typed value that swallowed the user's whole sentence.
        if kind == "type" and action.value and not action.use_vault_field:
            value = action.value.strip()
            if len(value) > len(query) and query.lower() in value.lower():
                notes.append("trimmed the typed value to the extracted query")
                action.value = query

    # 3. Everything the user asked for is done: further actions are the planner inventing work.
    #    This is what turns "search for X" into an endless tour of a results page.
    elif _goal_complete(req, progress):
        notes.append("every part of the task is already done")
        return StepResponse(
            reasoning="Task complete — " + "; ".join(notes),
            action=StepAction(type="done", reasoning="Nothing left that the instruction asked for."),
            summary=plan.summary,
        )

    # 3b. A click aimed at a text field on a non-search step is almost always a "type" that
    #     lost its verb — observed constantly from the 1.5B local model.
    if kind == "click" and target is not None and target.role in FILLABLE_ROLES and not _is_search_mark(target):
        key = vault_key_for_label(target.label or "")
        if key:
            notes.append("clicking a form field; filling it instead")
            kind, action.type = "type", "type"
            action.use_vault_field = key
            action.value = None

    # 4. A vault field must never carry a literal value: the whole point is that the server
    #    does not know it. If a planner supplied both, the symbolic key wins.
    if action.use_vault_field and action.value:
        notes.append("dropped a literal value supplied alongside a vault field")
        action.value = None

    # 5. An action that needs a target but has none cannot be executed.
    if kind in ("click", "type", "select", "press_key", "hover", "upload") and action.target is None:
        notes.append(f"no usable target for {kind}")
        return _fallback(req, notes)

    if notes:
        print(f"[server] [repair:{tier}] {'; '.join(notes)}")
        plan.reasoning = f"{plan.reasoning} (repaired: {'; '.join(notes)})"
    return plan


def _goal_complete(req: AgentStepRequest, progress: Progress) -> bool:
    """True when nothing the instruction asked for is outstanding."""
    if req.plan and req.plan.milestones:
        return plan_complete(req.plan)
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


# ── Workflow planning ─────────────────────────────────────────────────────────

PLAN_PROMPT = """You are VisionVault's workflow planner. Break the user's browser task into an ordered list of
milestones a browser agent will carry out one at a time on live websites.

USER TASK: "%s"
%s
%s
%s

Milestone kinds (use ONLY these):
  navigate  open a website (target = full URL, only if you are sure of it)
  search    run a search (target = the exact query to type; keep it short and literal)
  read      read the page to compare / analyse / extract (the agent reads content and records findings)
  open      open one item (target = its label, or "best" to pick from the findings, or "first")
  fill      fill a form from the user's private vault (the agent never sees the values)
  scroll    scroll to reveal more
  act       any other single interaction, e.g. click "Add to cart", apply a filter, select a date
            (target = what to look for, described by purpose)
  answer    produce a conclusion or summary for the user from the findings
  confirm   a point where the user must approve (payment, sending, deleting)

Rules: 3-8 milestones; each a short imperative title; no milestone for things already implied by
another (a search implies being on the site's page). Put a "read" before any comparison or choice.
Do NOT add a "navigate" milestone unless the user named a site: PAGE CONTEXT says where they
already are, and they mean to do this there. Do NOT add milestones the user did not ask for —
no adding to a cart, no checkout, no form filling, no scrolling unless their own words call for it.
End with "answer" if the user asked to be told, shown, or given a summary. Never invent personal
data; forms are filled from the vault. List anything you will need from the user under "needs"
(for example a budget, dates, a destination) — only if the task does not already say it.

Respond with STRICT JSON only:
{"goal": "<one line>",
 "milestones": [{"kind": "...", "title": "...", "target": "<or null>", "note": "<or null>"}],
 "needs": ["..."]}"""


def _plan_from_json(parsed: dict, task: str) -> Optional[Plan]:
    raw = parsed.get("milestones")
    if not isinstance(raw, list) or not raw:
        return None
    milestones: List[Milestone] = []
    for entry in raw[:8]:
        if not isinstance(entry, dict):
            continue
        kind = str(entry.get("kind") or "act").lower().strip()
        if kind not in MILESTONE_KINDS:
            kind = "act"
        title = str(entry.get("title") or entry.get("goal") or "").strip()
        if not title:
            continue
        target = entry.get("target")
        note = entry.get("note")
        milestones.append(Milestone(id=len(milestones) + 1, kind=kind, title=title[:80],
                                    target=(str(target)[:160] if target else None),
                                    note=(str(note)[:120] if note else None)))
    if not milestones:
        return None
    return Plan(goal=str(parsed.get("goal") or task)[:200], milestones=milestones, current=0)


# Words that must appear in the task before a plan may contain the matching kind of milestone.
# A planner is asked for a workflow and will happily supply a plausible shopping journey for
# "search for running shoes" — observed live, a 1.5B local model returned seven milestones
# including "Fill form" and "Click 'Add to cart'" for a task that asked only to search. Acting
# on invented work is worse than not planning at all: it spends the run's steps, and on a real
# site an invented "add to cart" is a click nobody asked for.
INVENTED_MILESTONE_GUARDS = [
    ("fill", re.compile(r"\b(fill|form|sign\s?up|signup|register|apply|enter my details|checkout)\b", re.I)),
    ("confirm", re.compile(r"\b(confirm|approve|verify|checkout|pay|order|book)\b", re.I)),
]
CART_RE = re.compile(r"\b(cart|bag|basket|checkout|check out|buy|purchase|order|pay|book|reserve|subscribe)\b", re.I)
CART_TARGET_RE = re.compile(r"\b(cart|bag|basket|checkout|buy|purchase|order|pay|payment|book now|subscribe)\b", re.I)
SCROLL_RE = re.compile(r"\b(scroll|load more|more results|next page|read more)\b", re.I)


def sanitize_plan(plan: Plan, task: str) -> Plan:
    """Removes milestones the user's own words do not support.

    The model plans; the user's sentence decides what is in scope. Anything transactional, any
    form filling and any scrolling has to be traceable to a word the user actually typed."""
    kept: List[Milestone] = []
    dropped: List[str] = []
    for m in plan.milestones:
        text = f"{m.title} {m.target or ''}"
        drop = None
        if m.kind == "act" and CART_TARGET_RE.search(text) and not CART_RE.search(task):
            drop = "the task never mentions buying, ordering or a cart"
        for kind, pattern in INVENTED_MILESTONE_GUARDS:
            if m.kind == kind and not pattern.search(task):
                drop = f"the task never asks to {kind}"
        if m.kind == "scroll" and not SCROLL_RE.search(task):
            # Scrolling is how a page is read, not a thing the user asked for. The read and
            # open milestones scroll on their own when they need to.
            drop = "scrolling is a means, not a milestone here"
        if drop:
            dropped.append(f"{m.kind}:{m.title} ({drop})")
            continue
        kept.append(m)
    if dropped:
        print("[server] [plan] dropped " + "; ".join(dropped))
    if not kept:
        return plan
    for i, m in enumerate(kept):
        m.id = i + 1
    plan.milestones = kept
    return plan


def make_plan(req: PlanRequest) -> PlanResponse:
    prompt = PLAN_PROMPT % (
        req.task,
        describe_page(req.page_info),
        ("USER PREFERENCES: %s" % req.preferences[:400]) if req.preferences else "",
        describe_site_hints(req.site_hints),
    )
    needs: List[str] = []
    plan: Optional[Plan] = None
    tier = None

    # Planning happens once per task, not once per step, so it can afford to wait longer for
    # the best planner: a good decomposition saves more time later than it costs here.
    plan_deadline = time.time() + 26
    if (BACKEND == "gemini" or gemini_key) and tier_available("gemini"):
        parsed = gemini_generate(prompt, "", timeout=16.0, deadline=plan_deadline)
        if parsed:
            plan = _plan_from_json(parsed, req.task)
            needs = [str(n)[:60] for n in (parsed.get("needs") or []) if n][:4] if plan else []
            tier = "gemini" if plan else None
    if not plan and groq_client and tier_available("groq"):
        parsed = groq_generate(prompt, "", max_tokens=700, deadline=plan_deadline, call_timeout=18.0)
        if parsed:
            plan = _plan_from_json(parsed, req.task)
            needs = [str(n)[:60] for n in (parsed.get("needs") or []) if n][:4] if plan else []
            tier = "groq" if plan else None
    if not plan and tier_available("ollama") and ollama_model():
        parsed = ollama_generate("You output ONE strict JSON object and nothing else.", prompt,
                                 num_predict=320, attempts=1, deadline=plan_deadline)
        if parsed:
            plan = _plan_from_json(parsed, req.task)
            tier = "ollama" if plan else None
    if not plan:
        plan = decompose_task(req.task)
        tier = "mock"

    rules = decompose_task(req.task)

    if tier != "mock":
        # A simple instruction has a provably correct decomposition, and the rules produce it.
        # A model asked to plan will elaborate anyway — that is what it is for — so when the
        # rules see one or two stages and the model returns four or more, the model is padding.
        if len(rules.milestones) <= 2 and len(plan.milestones) > len(rules.milestones) + 1:
            print(f"[server] [plan] using the rules plan: the task has "
                  f"{len(rules.milestones)} stage(s), the model proposed {len(plan.milestones)}")
            plan, tier, needs = rules, "mock", []
        else:
            plan = sanitize_plan(plan, req.task)

    # A hosted model occasionally produces a plan that skips the obvious first step. The rules
    # are good at exactly that part, so the two are reconciled: if the rules found a site to
    # open or a query to type and the model's plan has neither, prepend them.
    kinds = {m.kind for m in plan.milestones}
    prepend = [m for m in rules.milestones if m.kind in ("navigate", "search") and m.kind not in kinds]
    if prepend and tier != "mock":
        merged = prepend + plan.milestones
        for i, m in enumerate(merged):
            m.id = i + 1
        plan.milestones = merged[:8]

    print(f"[server] [PLAN:{tier}] " + " -> ".join(f"{m.kind}:{m.title}" for m in plan.milestones))
    return PlanResponse(goal=plan.goal, milestones=plan.milestones, tier=tier, needs=needs)


# ── Summary ───────────────────────────────────────────────────────────────────

SUMMARY_PROMPT = """You are VisionVault's reporter. Write what a browser agent achieved for the user, in plain
language, for a completion screen. No preamble, no markdown.

Report ONLY what the actions, milestones and findings below actually show. This matters:
- If FINDINGS is empty, the agent never read the page. Say nothing whatever about what the page
  contained, how many results there were, or whether they were relevant — you do not know.
- Name concrete results, prices and ratings ONLY when they appear in FINDINGS.
- Say plainly what was skipped or not completed, and why, using the warnings.
- Do not describe how long anything took; the interface already shows that.
- Never invent a judgement about quality, relevance or availability.

USER TASK: "%s"
OUTCOME: %s
ELAPSED: %s
%s
%s
ACTIONS PERFORMED (%d): %s
WARNINGS: %s

Respond with STRICT JSON only:
{"summary": "<2-4 sentences>", "highlights": ["<up to 5 short bullet facts>"]}"""


def deterministic_summary(req: SummaryRequest) -> SummaryResponse:
    done = [m for m in (req.plan.milestones if req.plan else []) if m.status == "done"]
    total = len(req.plan.milestones) if req.plan else 0
    bits = []
    if total:
        bits.append("Completed %d of %d milestones" % (len(done), total))
        if done:
            bits[-1] += ": " + "; ".join(m.title.lower() for m in done[:5])
    highlights: List[str] = []
    for f in req.findings[-3:]:
        if f.text:
            highlights.append(f.text[:140])
        for item in (f.items or [])[:3]:
            highlights.append(compact_item(item)[:140])
    best = _pick_best_item(req.findings)
    if best and best.get("title"):
        highlights.insert(0, "Best match: %s%s%s" % (
            best["title"][:80], " at %s" % best["price"] if best.get("price") else "",
            " (%s)" % best["rating"] if best.get("rating") else ""))
    ok = sum(1 for a in req.actions if a.get("ok") is not False)
    bits.append("%d action(s) performed" % ok)
    if req.warnings:
        bits.append("Needs your attention: " + "; ".join(w[:80] for w in req.warnings[:2]))
    outcome = req.outcome or ("success" if total and len(done) == total else "partial")
    lead = {"success": "Done.", "partial": "Partly done.", "stopped": "Stopped.", "failed": "Could not complete the task."}.get(outcome, "Finished.")
    return SummaryResponse(summary=lead + " " + ". ".join(bits) + ".", highlights=highlights[:5], tier="mock")


def make_summary(req: SummaryRequest) -> SummaryResponse:
    plan_text = describe_plan(req.plan) if req.plan else ""
    findings_text = describe_findings(req.findings)
    actions_text = "; ".join(
        "%s%s%s" % (a.get("action") or a.get("type") or "?",
                    " %s" % (a.get("field") or a.get("value") or "")[:40] if (a.get("field") or a.get("value")) else "",
                    " (failed)" if a.get("ok") is False else "")
        for a in req.actions[-14:]) or "none"
    prompt = SUMMARY_PROMPT % (
        req.task, req.outcome or "unknown",
        ("%.1fs" % (req.elapsed_ms / 1000.0)) if req.elapsed_ms else "unknown",
        plan_text, findings_text, len(req.actions), actions_text,
        "; ".join(req.warnings) if req.warnings else "none")

    def finish(parsed: dict, tier: str) -> Optional[SummaryResponse]:
        summary = str(parsed.get("summary") or "").strip()
        if not summary:
            return None
        highlights = [str(h)[:160] for h in (parsed.get("highlights") or []) if h][:5]
        return SummaryResponse(summary=summary[:900], highlights=highlights, tier=tier)

    # The summary is written once, after the work is done, so a slow answer costs the user
    # nothing they are waiting to act on. It still gets a ceiling.
    sum_deadline = time.time() + 18
    if (BACKEND == "gemini" or gemini_key) and tier_available("gemini"):
        parsed = gemini_generate(prompt, "", timeout=12.0, deadline=sum_deadline)
        out = finish(parsed, "gemini") if parsed else None
        if out:
            return out
    if groq_client and tier_available("groq"):
        parsed = groq_generate(prompt, "", max_tokens=500, deadline=sum_deadline, call_timeout=14.0)
        out = finish(parsed, "groq") if parsed else None
        if out:
            return out
    if tier_available("ollama") and ollama_model():
        parsed = ollama_generate("You output ONE strict JSON object and nothing else.", prompt,
                                 num_predict=220, attempts=1, deadline=sum_deadline)
        out = finish(parsed, "ollama") if parsed else None
        if out:
            return out
    return deterministic_summary(req)


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    local_model = ollama_model()
    return {
        "status": "ok",
        "backend": BACKEND,
        "chain": [t for t in [
            "gemini" if gemini_key else None,
            "groq" if groq_client else None,
            "ollama" if local_model else None,
            "mock",
        ] if t],
        "models": {
            "gemini": os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
            "groq": os.getenv("GROQ_MODEL", "qwen/qwen3.6-27b"),
            "ollama": local_model,
        },
        "ollama_host": OLLAMA_HOST,
        # Tiers currently rested by the circuit breaker, and how long until they are retried.
        "cooldowns": tier_status(),
        "capabilities": ["plan", "step", "summary", "read_page", "answer", "milestones"],
    }

@app.post("/api/agent/step", response_model=StepResponse)
async def agent_step(req: AgentStepRequest):
    log_session_event("agent_step_request", {
        "task": req.task,
        "marks_count": len(req.marks),
        "filled_count": len(req.filled_mark_ids or []),
        "step": req.step,
        "has_image": bool(req.redactedImage or req.image),
        "has_page_content": bool(req.page_content),
        "milestone": (current_milestone(req.plan).title if current_milestone(req.plan) else None),
        "page": (req.page_info.url if req.page_info else None),
    })

    plan = None
    tier = None
    # One budget for the whole chain. Each hosted tier gets whatever is left of it; when it is
    # spent, the local tiers answer immediately rather than the step waiting out another
    # provider's bad afternoon.
    t_start = time.time()
    deadline = t_start + STEP_PLAN_BUDGET_S
    spent: Dict[str, int] = {}

    def took(name: str, since: float) -> None:
        ms = int((time.time() - since) * 1000)
        if ms > 30:
            spent[name] = ms

    # The chain degrades on capability, not on correctness: every tier answers in the same
    # schema, and each one down is cheaper/more local than the last. A tier returning None
    # means it failed (quota, network, unparseable output) and the next one takes over
    # without the client ever seeing an error.
    #
    #   1 Gemini  hosted VLM, reads the redacted screenshot
    #   2 Groq    hosted VLM, reads the redacted screenshot
    #   3 Ollama  fully local text model on the user's own machine — works with no internet
    #   4 mock    deterministic rules; always answers, never fails

    # Tier 1: Google Gemini Vision AI
    if (BACKEND == "gemini" or gemini_key) and tier_available("gemini"):
        t = time.time()
        plan = plan_with_gemini(req, deadline)
        took("gemini", t)
        if plan:
            tier = "gemini"

    # Tier 2: Groq VLM failover
    if not plan and groq_client and tier_available("groq") and time.time() < deadline:
        t = time.time()
        plan = plan_with_groq(req, deadline)
        took("groq", t)
        if plan:
            tier = "groq"

    # Tier 3: local Ollama — no internet required. It gets a floor of its own even when the
    # hosted tiers have eaten the budget, because the alternative is fixed rules.
    if not plan and tier_available("ollama"):
        t = time.time()
        plan = plan_with_ollama(req, max(deadline, time.time() + 5.0))
        took("ollama", t)
        if plan:
            tier = "ollama"

    # Tier 4: deterministic rules — cannot fail
    if not plan:
        plan = mock_plan(req.marks, req.task, req.filled_mark_ids, req.page_info, req.progress,
                         req.plan, req.findings, req.page_content, req.recent_actions, req.preferences)
        tier = "mock"

    # Every tier's answer is checked against the elements and progress we sent it, so one
    # implementation covers hosted VLMs and the local model alike.
    plan = repair_plan(plan, req, tier or "unknown")
    plan.tier = tier
    if plan.confidence is None:
        plan.confidence = {"gemini": 0.85, "groq": 0.8, "ollama": 0.6, "mock": 0.55}.get(tier or "", 0.5)

    total_ms = int((time.time() - t_start) * 1000)
    # Where a step's time actually went, per tier. Printed because guessing at this was wrong
    # twice: a 29-second Groq call inside a 12-second budget, and a local model reading a
    # prompt far larger than it could process quickly.
    if total_ms > 2500:
        detail = ", ".join(f"{k} {v}ms" for k, v in spent.items()) or "no tier reported time"
        print(f"[server] step took {total_ms}ms via {tier} ({detail})")

    log_session_event("agent_step_response", {
        "tier": tier,
        "ms": total_ms,
        "spent": spent,
        "reasoning": plan.reasoning,
        "action": plan.action.model_dump(),
        "milestone_done": plan.milestone_done,
    })

    return plan

@app.post("/api/agent/plan", response_model=PlanResponse)
async def agent_plan(req: PlanRequest):
    log_session_event("agent_plan_request", {"task": req.task, "page": (req.page_info.url if req.page_info else None)})
    out = make_plan(req)
    log_session_event("agent_plan_response", {"tier": out.tier, "milestones": [m.title for m in out.milestones]})
    return out

@app.post("/api/agent/summary", response_model=SummaryResponse)
async def agent_summary(req: SummaryRequest):
    out = make_summary(req)
    log_session_event("agent_summary", {"tier": out.tier, "outcome": req.outcome})
    return out

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
