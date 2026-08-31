"""
Privacy-Preserving Vision Agent — Server
VLM chain: Groq -> OpenAI -> Ollama -> Smart Mock
"""

import base64, json, os, re
from typing import Any, Dict, List, Optional
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="Vision Agent Server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["POST","GET"], allow_headers=["Content-Type"])

BACKEND = "mock"
groq_client = openai_client = ollama_client = None

if os.getenv("GROQ_API_KEY","").startswith("gsk_"):
    try:
        from groq import Groq
        groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        BACKEND = "groq"
        print("[server] ✓ Groq — llama-3.2-11b-vision-preview")
    except Exception as e:
        print(f"[server] Groq failed: {e}")

if BACKEND == "mock" and os.getenv("OPENAI_API_KEY","").startswith("sk-"):
    try:
        from openai import OpenAI
        openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        BACKEND = "openai"
        print("[server] ✓ OpenAI — gpt-4o-mini")
    except Exception as e:
        print(f"[server] OpenAI failed: {e}")

if BACKEND == "mock":
    try:
        import ollama; ollama.list()
        ollama_client = ollama; BACKEND = "ollama"
        print(f"[server] ✓ Ollama — {os.getenv('OLLAMA_MODEL','qwen2.5vl:7b')}")
    except Exception:
        pass

if BACKEND == "mock":
    print("[server] ⚠ Using smart mock planner. Add GROQ_API_KEY to .env for real AI.")

# ── Models ─────────────────────────────────────────────────────────────────────
class Mark(BaseModel):
    id: int
    role: str
    box: Dict[str, Any]
    label: Optional[str] = None

class PageInfo(BaseModel):
    title: Optional[str] = ""
    url: Optional[str] = ""
    url_path: Optional[str] = ""
    scroll_y: Optional[int] = 0
    page_height: Optional[int] = 0
    viewport_height: Optional[int] = 0

class PlanRequest(BaseModel):
    task: str
    image: str
    marks: List[Mark]
    filled_mark_ids: List[int] = []
    page_info: Optional[PageInfo] = None
    step: Optional[int] = 1

class PlanResponse(BaseModel):
    action: str
    mark_id: Optional[int] = None
    value: Optional[str] = None
    use_vault_field: Optional[str] = None
    reasoning: Optional[str] = None

# ── Prompt ─────────────────────────────────────────────────────────────────────
def build_prompt(req: PlanRequest) -> str:
    rem = [m for m in req.marks if m.id not in req.filled_mark_ids]
    marks_summary = [{"id": m.id, "role": m.role, "label": m.label,
                      "box": {k: round(v) for k, v in m.box.items()}} for m in rem]
    pi = req.page_info
    page_ctx = f"URL: {pi.url or pi.url_path}  Title: {pi.title}" if pi else ""
    return f"""You are an autonomous browser agent for form automation and web navigation.
Blacked-out regions are redacted PII: ignore them and never reveal personal data.

{page_ctx}
Task: {req.task}
Step: {req.step}
Already acted on mark IDs: {req.filled_mark_ids}

Interactive elements:
{json.dumps(marks_summary, indent=2)}

ACTIONS:
- navigate(value=URL)
- type(mark_id, value or use_vault_field)
- click(mark_id)
- press_key(mark_id, value=Enter)
- select(mark_id, value)
- scroll_page(value=px)
- none

RULES:
1. Return ONLY valid JSON with no markdown fences.
2. Choose exactly one action per response.
3. For personal data, prefer use_vault_field in [name, email, phone, address, username, company, zip]. Never put actual PII in value.
4. For search flows: type query on the search field, then press Enter on the same field.
5. For sign-up or contact forms: prefer filling the right field with vault data when a matching field exists.
6. If the task is already complete, return none.
7. Do not over-click. Prefer the most direct action that moves the task forward.

JSON shape: {{"action":"...","mark_id":null,"value":null,"use_vault_field":null,"reasoning":"brief explanation"}}"""

def parse_vlm(raw: str) -> PlanResponse:
    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    raw = re.sub(r"\s*```$", "", raw)
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if not m:
        raise ValueError(f"No JSON: {raw[:200]}")
    return PlanResponse(**json.loads(m.group()))

# ── Endpoints ──────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "backend": BACKEND}

@app.post("/plan-action", response_model=PlanResponse)
def plan_action(req: PlanRequest):
    img_bytes = base64.b64decode(req.image.split(",")[-1])
    print(f"[audit] backend={BACKEND} step={req.step} task='{req.task[:60]}' marks={len(req.marks)} filled={req.filled_mark_ids} img={len(img_bytes)}B")
    try:
        if BACKEND == "groq":   return groq_plan(req)
        if BACKEND == "openai": return openai_plan(req)
        if BACKEND == "ollama": return ollama_plan(req)
    except Exception as e:
        print(f"[server] {BACKEND} error: {e} — falling back to mock")
    return mock_plan(req)

def groq_plan(req: PlanRequest) -> PlanResponse:
    r = groq_client.chat.completions.create(
        model="llama-3.2-11b-vision-preview",
        messages=[{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": req.image if req.image.startswith("data:") else f"data:image/png;base64,{req.image.split(',')[-1]}"}},
            {"type": "text", "text": build_prompt(req)},
        ]}],
        temperature=0.1, max_tokens=300,
    )
    return parse_vlm(r.choices[0].message.content)

def openai_plan(req: PlanRequest) -> PlanResponse:
    img_b64 = req.image.split(",")[-1]
    r = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}", "detail": "low"}},
            {"type": "text", "text": build_prompt(req)},
        ]}],
        temperature=0.1, max_tokens=300,
    )
    return parse_vlm(r.choices[0].message.content)

def ollama_plan(req: PlanRequest) -> PlanResponse:
    model = os.getenv("OLLAMA_MODEL", "qwen2.5vl:7b")
    r = ollama_client.chat(model=model,
        messages=[{"role": "user", "content": build_prompt(req), "images": [req.image.split(",")[-1]]}],
        options={"temperature": 0.1})
    return parse_vlm(r["message"]["content"])

# ── Smart mock planner ─────────────────────────────────────────────────────────
SITE_URLS = {
    "amazon":    "https://www.amazon.com",
    "google":    "https://www.google.com",
    "youtube":   "https://www.youtube.com",
    "github":    "https://www.github.com",
    "wikipedia": "https://www.wikipedia.org",
    "twitter":   "https://www.twitter.com",
    "linkedin":  "https://www.linkedin.com",
    "reddit":    "https://www.reddit.com",
    "flipkart":  "https://www.flipkart.com",
    "instagram": "https://www.instagram.com",
    "facebook":  "https://www.facebook.com",
    "netflix":   "https://www.netflix.com",
    "whatsapp":  "https://web.whatsapp.com",
}

def extract_query(task: str, site: str = "") -> str:
    t = task.lower()
    patterns = [
        rf"on {re.escape(site)}\s+(?:and\s+)?(?:search|find|look\s+for|buy|watch)\s+(.+)" if site else None,
        r"search\s+for\s+(.+?)(?:\s+on\s+\w+)?$",
        r"search\s+(.+?)(?:\s+on\s+\w+)?$",
        r"find\s+(.+?)(?:\s+on\s+\w+)?$",
        r"buy\s+(.+?)(?:\s+on\s+\w+)?$",
        r"watch\s+(.+?)(?:\s+on\s+\w+)?$",
    ]
    for pat in patterns:
        if not pat:
            continue
        m = re.search(pat, t)
        if m:
            q = m.group(1).strip().rstrip(".")
            if q and q not in SITE_URLS:
                return q
    return ""

def extract_repo_name(task: str) -> str:
    m = re.search(r"(?:name[d]?|called|with name|named)\s+['\"]?([a-zA-Z0-9_\-]+)['\"]?", task, re.I)
    return m.group(1) if m else ""

def extract_phone(task: str) -> str:
    """Extract phone number digits from task string."""
    m = re.search(r'(\+?\d[\d\s\-]{6,}\d)', task)
    if m:
        return re.sub(r'[\s\-]', '', m.group(1))
    return ""

def extract_message(task: str) -> str:
    # Match: send "hi" / say hi / message hi to ...
    for pat in [
        r'(?:send|say|message|msg|text|write)\s+["\']([^"\']+)["\']',
        r'(?:send|say|message|msg|text|write)\s+(\w+)\s+(?:to|message)',
        r'message\s+\d[\d\s]+\s+(\w.*?)$',
    ]:
        m = re.search(pat, task, re.I)
        if m: return m.group(1).strip()
    return ""

def extract_contact(task: str) -> str:
    m = re.search(r"(?:to|contact|person)\s+['\"]?([A-Za-z][a-zA-Z\s]+?)['\"]?\s*(?:message|msg|say|send|$)", task, re.I)
    return m.group(1).strip() if m else ""

def mock_plan(req: PlanRequest) -> PlanResponse:
    done = set(req.filled_mark_ids)
    rem = [m for m in req.marks if m.id not in done]
    all_marks = req.marks
    task_l = req.task.lower().strip()
    pi = req.page_info
    cur_url = (pi.url if pi else "") or ""
    cur_title = (pi.title if pi else "") or ""

    def first(fn, pool=None):
        return next((m for m in (pool or rem) if fn(m)), None)

    if (req.step or 0) > 20:
        return PlanResponse(action="none", reasoning="Max steps reached.")

    for site, url in SITE_URLS.items():
        if site in task_l and site not in cur_url.lower() and site not in cur_title.lower():
            return PlanResponse(action="navigate", value=url, reasoning=f"Navigate to {site}")

    cur_site = next((s for s in SITE_URLS if s in cur_url.lower()), None)

    if "github" in cur_url.lower():
        is_new_repo = any(w in task_l for w in ["new repo", "create repo", "new repository", "create repository"])
        is_on_new_repo_page = "/new" in cur_url or "new repository" in cur_title.lower()
        if is_new_repo:
            if not is_on_new_repo_page:
                return PlanResponse(action="navigate", value="https://github.com/new", reasoning="Open new repository form")
            repo_name = extract_repo_name(req.task)
            name_field = first(lambda m: m.role == "input:text")
            if name_field and name_field.id not in done:
                return PlanResponse(action="type", mark_id=name_field.id, value=repo_name or "my-new-repo", reasoning=f"Fill repo name: {repo_name or 'my-new-repo'}")
            create_btn = first(lambda m: m.role == "button" and m.label and any(w in m.label.lower() for w in ["create repository", "create repo"]))
            if create_btn:
                return PlanResponse(action="click", mark_id=create_btn.id, reasoning="Click Create repository")
            submit = first(lambda m: m.role in ("button", "input:submit") and m.label and m.label.lower() in ("submit", "create", "save", "done"))
            if submit:
                return PlanResponse(action="click", mark_id=submit.id, reasoning="Submit form")

    if "whatsapp" in cur_url.lower():
        is_send = any(w in task_l for w in ["send", "message", "msg", "text", "say", "hi", "hello"])
        phone = extract_phone(req.task)
        message = extract_message(req.task) or re.sub(r'(send|message|msg|whatsapp|to|\d[\d\s\-]+)', '', req.task, flags=re.I).strip() or "hi"

        if is_send and phone:
            wa_chat_url = f"https://web.whatsapp.com/send?phone={phone}"
            in_chat = phone in cur_url or "/send" in cur_url or "/_/" in cur_url
            if "whatsapp" not in cur_url.lower() or (not in_chat and "/send" not in cur_url):
                return PlanResponse(action="navigate", value=wa_chat_url, reasoning=f"Open WhatsApp chat with {phone}")

            msg_box = first(lambda m: m.role == "editable")
            if not msg_box:
                msg_box = first(lambda m: m.role in ("textarea", "input:text"))
            if msg_box and msg_box.id not in done:
                return PlanResponse(action="type", mark_id=msg_box.id, value=message, reasoning=f"Type: {message}")

            send_btn = first(lambda m: m.role == "button" and m.label and any(w in m.label.lower() for w in ["send", "submit"]))
            if not send_btn:
                send_btn = first(lambda m: m.role == "button")
            if send_btn:
                return PlanResponse(action="click", mark_id=send_btn.id, reasoning="Click Send button")
            if msg_box:
                return PlanResponse(action="press_key", mark_id=msg_box.id, value="Enter", reasoning="Send via Enter")

        elif is_send:
            contact = extract_contact(req.task)
            search_box = first(lambda m: m.role in ("input:text", "input:search", "editable"))
            if search_box and search_box.id not in done:
                return PlanResponse(action="type", mark_id=search_box.id, value=contact, reasoning=f"Search contact: {contact}")
            if search_box and search_box.id in done:
                return PlanResponse(action="press_key", mark_id=search_box.id, value="Enter", reasoning="Open contact")
            msg_box = first(lambda m: m.role == "editable")
            if msg_box and msg_box.id not in done:
                return PlanResponse(action="type", mark_id=msg_box.id, value=message, reasoning=f"Type: {message}")
            if msg_box and msg_box.id in done:
                return PlanResponse(action="press_key", mark_id=msg_box.id, value="Enter", reasoning="Send message")

    is_search = any(w in task_l for w in ["search", "find", "look", "buy", "watch", "open", "go to"])
    if is_search and cur_site:
        query = extract_query(task_l, cur_site)
        search_box = first(lambda m: m.role in ("input:search", "input:text"), pool=all_marks)
        if search_box:
            if search_box.id not in done:
                q = query or re.sub(r"(go to|open|search for|search|find|buy|watch|on \w+)", "", task_l).strip()
                return PlanResponse(action="type", mark_id=search_box.id, value=q, reasoning=f"Type '{q}' in search box")
            return PlanResponse(action="press_key", mark_id=search_box.id, value="Enter", reasoning="Submit search")

    if any(w in task_l for w in ["fill", "register", "signup", "sign up", "form"]):
        form_fields = [
            ("name", first(lambda m: m.role == "input:text")),
            ("email", first(lambda m: m.role == "input:email")),
            ("phone", first(lambda m: m.role == "input:tel")),
            ("address", first(lambda m: m.role in ("input:text", "textarea") and (m.label or "").lower() in {"address", "street address"})),
        ]
        for key, field in form_fields:
            if field and field.id not in done:
                return PlanResponse(action="type", mark_id=field.id, use_vault_field=key, reasoning=f"Fill {key} field")

    name_f = first(lambda m: m.role == "input:text")
    email_f = first(lambda m: m.role == "input:email")
    tel_f = first(lambda m: m.role == "input:tel")
    pass_f = first(lambda m: m.role == "input:password")

    if name_f:
        return PlanResponse(action="type", mark_id=name_f.id, use_vault_field="name", reasoning="Name field")
    if email_f:
        return PlanResponse(action="type", mark_id=email_f.id, use_vault_field="email", reasoning="Email field")
    if tel_f:
        return PlanResponse(action="type", mark_id=tel_f.id, use_vault_field="phone", reasoning="Phone field")
    if pass_f:
        return PlanResponse(action="type", mark_id=pass_f.id, value="Demo@1234", reasoning="Password field")

    SUBMIT = {"submit", "next", "continue", "register", "save", "login", "log in", "sign in", "sign up", "send", "confirm", "proceed", "done", "search", "add to cart", "buy now", "checkout", "place order", "apply", "create", "create repository"}
    submit_f = first(lambda m: m.role in ("button", "input:submit") and m.label and m.label.lower() in SUBMIT)
    if submit_f:
        return PlanResponse(action="click", mark_id=submit_f.id, reasoning=f"Click: {submit_f.label}")

    return PlanResponse(action="none", reasoning="Task complete or no actionable elements found.")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
