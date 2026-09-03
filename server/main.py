"""
Privacy-Preserving Vision Agent — Server (SIH PS 26171)
FastAPI Backend with Multi-VLM: Google Gemini (AI Studio) -> Groq -> OpenAI -> Smart Mock
"""

import base64
import json
import os
import re
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
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
# The live chain is exactly: Gemini -> Groq -> mock. Nothing else is initialised, because
# nothing else is called.
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

class StepAction(BaseModel):
    type: str  # "click" | "type" | "scroll" | "select" | "press_key" | "done"
    target: Optional[int] = None
    value: Optional[str] = None
    use_vault_field: Optional[str] = None
    reasoning: Optional[str] = None

class StepResponse(BaseModel):
    reasoning: str
    action: StepAction

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

class AgentStepRequest(BaseModel):
    redactedImage: Optional[str] = None
    image: Optional[str] = None
    marks: List[Mark] = []
    task: str
    filled_mark_ids: Optional[List[int]] = []
    step: Optional[int] = 1
    page_info: Optional[PageInfo] = None
    task_hints: Optional[TaskHints] = None

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

# ── Google Gemini VLM Planning ───────────────────────────────────────────────
def plan_with_gemini(req: AgentStepRequest) -> Optional[StepResponse]:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        return None

    img_b64 = req.redactedImage or req.image or ""
    if "," in img_b64:
        img_b64 = img_b64.split(",", 1)[1]

    marks_summary = [
        {"id": m.id, "role": m.role, "label": m.label, "box": m.box}
        for m in req.marks if m.id not in (req.filled_mark_ids or [])
    ][:60]

    prompt_text = f"""You are VisionVault: a visual AI browser agent designed for privacy-preserving web automation.
You receive a sanitized, on-device blacked-out screenshot (where all private credentials & faces have been redacted) and Set-of-Marks numerical element tags.

USER TASK: "{req.task}"
STEP NUMBER: {req.step}
ALREADY PROCESSED MARK IDs: {req.filled_mark_ids}

{describe_page(req.page_info)}

{describe_hints(req.task_hints)}

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
8. When every sub-task in the user prompt is finished, return type: "done".

Respond in STRICT JSON ONLY:
{{
  "reasoning": "Clear explanation of chosen action",
  "action": {{
    "type": "click" | "type" | "scroll" | "select" | "press_key" | "done",
    "target": <mark ID integer or null>,
    "value": "<text to enter or null>",
    "use_vault_field": "<name|email|phone|address|password or null>"
  }}
}}"""

    models_to_try = [
        os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
        "gemini-2.5-flash-lite",
        "gemini-flash-latest",
        "gemini-3-flash-preview"
    ]

    for model_name in models_to_try:
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
            with urllib.request.urlopen(req_post, timeout=12) as resp:
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
            print(f"[server] Gemini ({model_name}) error: {e}")
            continue

    return None

# ── Groq VLM Inference ────────────────────────────────────────────────────────
def plan_with_groq(req: AgentStepRequest) -> Optional[StepResponse]:
    if not groq_client:
        return None
    
    img_b64 = req.redactedImage or req.image or ""
    if img_b64 and not img_b64.startswith("data:image"):
        img_b64 = f"data:image/png;base64,{img_b64}"
        
    marks_summary = [
        {"id": m.id, "role": m.role, "label": m.label, "box": m.box}
        for m in req.marks if m.id not in (req.filled_mark_ids or [])
    ][:60]
    
    prompt = f"""You are VisionVault: an autonomous, privacy-preserving visual browser agent.
You receive a client-side sanitized/redacted screenshot where all private PII (names, emails, passwords, credit cards, faces) has been securely blacked out on-device.
You also receive interactive element marks with numerical IDs.

USER TASK: "{req.task}"
STEP NUMBER: {req.step}
ALREADY PROCESSED MARK IDs: {req.filled_mark_ids}

{describe_page(req.page_info)}

{describe_hints(req.task_hints)}

INTERACTIVE ELEMENTS:
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
8. When the goal is finished, return type: "done".

Respond in STRICT JSON ONLY:
{{
  "reasoning": "Explanation of the chosen action",
  "action": {{
    "type": "click" | "type" | "scroll" | "select" | "press_key" | "done",
    "target": <mark ID integer or null>,
    "value": "<text to enter or null>",
    "use_vault_field": "<name|email|phone|address|password or null>"
  }}
}}"""

    models_to_try = [
        os.getenv("GROQ_MODEL", "qwen/qwen3.6-27b"),
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
        "groq/compound-mini"
    ]

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt}
            ]
        }
    ]
    if img_b64:
        messages[0]["content"].append({
            "type": "image_url",
            "image_url": {"url": img_b64}
        })

    raw_content = ""
    for model_name in models_to_try:
        try:
            chat_completion = groq_client.chat.completions.create(
                model=model_name,
                messages=messages,
                temperature=0.1,
                max_tokens=450,
                response_format={"type": "json_object"}
            )
            raw_content = chat_completion.choices[0].message.content or ""
            if raw_content:
                break
        except Exception:
            continue
    
    data = robust_json_parse(raw_content)
    if not data or not isinstance(data, dict):
        return None

    action_data = data.get("action", {})
    return StepResponse(
        reasoning=data.get("reasoning", "Groq VLM planned step"),
        action=StepAction(
            type=action_data.get("type", "done"),
            target=action_data.get("target"),
            value=action_data.get("value"),
            use_vault_field=action_data.get("use_vault_field"),
            reasoning=data.get("reasoning", "")
        )
    )

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


# ── Rule-Based Mock Planner ──────────────────────────────────────────────────
def mock_plan(marks: List[Mark], task: str, filled_ids: Optional[List[int]] = None,
              page_info: Optional[PageInfo] = None) -> StepResponse:
    task_lower = (task or "").lower()
    filled_set = set(filled_ids or [])
    available = [m for m in marks if m.id not in filled_set]

    def find_mark(predicate):
        return next((m for m in available if predicate(m)), None)

    # 1. Search: type ONLY the query, never the whole sentence.
    #
    #    "search for iqoo neo 6 and show me" must search for "iqoo neo 6". Stripping a list of
    #    stop-words from the sentence (the previous approach) left "iqoo neo 6 and show me" in
    #    the box. The client-side planner in extension/task-planner.js does the same parsing;
    #    keep the two in step.
    query = extract_search_query(task)
    if query:
        search_box = find_mark(lambda m: m.role in ["input:search", "input:text", "editable"])
        if search_box:
            return StepResponse(
                reasoning=f'Search for "{query}"',
                action=StepAction(type="type", target=search_box.id, value=query,
                                  reasoning=f'Search for "{query}"')
            )

    # 2. Open something the user NAMED. A link is never clicked merely because a word from the
    #    task appears in its text — on a dense results page that matches dozens of links and
    #    the agent wanders instead of finishing.
    for target in extract_open_targets(task):
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
    if any(kw in task_lower for kw in ["scroll", "load more", "read more", "next page", "more results"]):
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

# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "backend": BACKEND,
        "chain": [t for t in ["gemini" if gemini_key else None, "groq" if groq_client else None, "mock"] if t],
        "models": {
            "gemini": os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
            "groq": os.getenv("GROQ_MODEL", "qwen/qwen3.6-27b")
        }
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

    # Tier 1: Google Gemini Vision AI
    if BACKEND == "gemini" or gemini_key:
        plan = plan_with_gemini(req)

    # Tier 2: Groq VLM Failover
    if not plan and groq_client:
        plan = plan_with_groq(req)

    # Tier 3: Deterministic Rule-Based Fallback
    if not plan:
        plan = mock_plan(req.marks, req.task, req.filled_mark_ids, req.page_info)

    log_session_event("agent_step_response", {
        "reasoning": plan.reasoning,
        "action": plan.action.model_dump()
    })

    return plan

@app.post("/plan-action", response_model=StepResponse)
async def legacy_plan_action(req: AgentStepRequest):
    return await agent_step(req)

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    print(f"[server] Starting VisionVault AI Server on http://127.0.0.1:{port}")
    uvicorn.run("main:app", host="127.0.0.1", port=port, reload=True)
