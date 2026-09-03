"""
test-server-contract.py — Tests the SERVER's half of the privacy contract, over real HTTP.

Scope, stated plainly: this exercises the planning endpoint only. It does not open a browser,
does not visit any website, and proves nothing about detection or redaction — those are
measured by eval/run-full-eval.js against a live Chrome session.

What it does check, against whichever backend the server has configured:

  1. The endpoint accepts the exact payload the extension sends, page_info included.
  2. Every reply is a well-formed StepResponse with a known action type.
  3. Any element it targets is one of the marks it was given — never an invented id.
  4. It never returns a literal personal value for a credential field; it must use the
     symbolic use_vault_field key, which the client resolves on-device.
  5. It terminates: given a page with nothing left to do, it returns "done".
  6. It tolerates a request with no image at all (the fail-closed path sends no image).

Usage:
    python main.py                       # in server/, first
    python eval/test-server-contract.py  # then this
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000"
ENDPOINT = f"{BASE}/api/agent/step"

VALID_ACTIONS = {
    "click", "type", "press_key", "select", "scroll", "scroll_page",
    "clear", "hover", "focus", "wait", "navigate", "open_tab", "done", "none",
}
VAULT_KEYS = {"name", "username", "email", "phone", "address", "company", "about", "password"}

# Values that must never come back from the server: if any appears in a reply, the planner
# invented personal data instead of asking for a vault key.
FORBIDDEN_VALUES = [
    "ada@localhost.test", "Ada Lovelace", "EngineNo1!", "+44 20 7946 0102",
    "priya.raghavan@examplemail.com", "4539 8842 1176 3320",
]

SIGNUP_MARKS = [
    {"id": 4148216, "role": "input:text", "label": "full name", "box": {"x": 45, "y": 146, "w": 858, "h": 38}},
    {"id": 5615249, "role": "input:email", "label": "email address", "box": {"x": 45, "y": 222, "w": 858, "h": 38}},
    {"id": 8467407, "role": "input:tel", "label": "phone number", "box": {"x": 45, "y": 299, "w": 858, "h": 38}},
    {"id": 8480666, "role": "input:text", "label": "username", "box": {"x": 45, "y": 375, "w": 420, "h": 38}},
    {"id": 4274590, "role": "input:password", "label": "password", "box": {"x": 480, "y": 375, "w": 420, "h": 38}},
    {"id": 9001122, "role": "button", "label": "create account", "box": {"x": 45, "y": 452, "w": 160, "h": 40}},
]

PAGE_INFO = {
    "title": "Create your account",
    "url": "http://127.0.0.1:8080/pages/signup-form.html",
    "url_path": "/pages/signup-form.html",
    "scroll_y": 0,
    "page_height": 1400,
    "viewport_height": 820,
    "viewport_width": 1200,
    "device_pixel_ratio": 1,
}

# A 1x1 transparent PNG stands in for the redacted frame; the contract under test is the
# response shape, not the model's vision.
TINY_PNG = ("data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")

failures = []
checks = 0


def check(condition, description, detail=""):
    global checks
    checks += 1
    if condition:
        print(f"  ok    {description}")
    else:
        print(f"  FAIL  {description}" + (f"\n          {detail}" if detail else ""))
        failures.append(description)


def post(payload, timeout=90):
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def step(task, marks, filled=None, image=TINY_PNG):
    return post({
        "task": task,
        "marks": marks,
        "filled_mark_ids": filled or [],
        "step": 1,
        "redactedImage": image,
        "image": image,
        "page_info": PAGE_INFO,
    })


def validate_shape(reply, marks, label):
    check(isinstance(reply, dict) and "action" in reply, f"{label}: reply has an action")
    action = (reply or {}).get("action") or {}
    atype = action.get("type")
    check(atype in VALID_ACTIONS, f"{label}: action type {atype!r} is a known action")

    target = action.get("target")
    if target is not None:
        ids = {m["id"] for m in marks}
        check(target in ids, f"{label}: target {target} is one of the supplied marks",
              f"supplied: {sorted(ids)}")

    key = action.get("use_vault_field")
    if key is not None:
        check(key in VAULT_KEYS, f"{label}: vault key {key!r} is a recognised key")

    blob = json.dumps(reply)
    leaked = [v for v in FORBIDDEN_VALUES if v in blob]
    check(not leaked, f"{label}: reply contains no invented personal values", f"found: {leaked}")
    return action


def main():
    print(__doc__.strip().splitlines()[0])
    print("=" * 78)

    try:
        with urllib.request.urlopen(f"{BASE}/health", timeout=5) as r:
            health = json.loads(r.read().decode("utf-8"))
    except Exception as exc:
        print(f"\nCannot reach {BASE}/health — start the server first (cd server && python main.py).")
        print(f"  {exc}")
        return 2

    print(f"backend: {health.get('backend')}   chain: {' -> '.join(health.get('chain', []))}\n")

    print("[1] Fills a form field using a symbolic vault key, not a literal value")
    action = validate_shape(step("Fill the signup form with my details", SIGNUP_MARKS), SIGNUP_MARKS, "form")
    if action.get("type") == "type":
        has_key = bool(action.get("use_vault_field"))
        check(has_key, "form: a personal field is requested via use_vault_field",
              f"got value={action.get('value')!r} use_vault_field={action.get('use_vault_field')!r}")

    print("\n[2] Terminates when there is nothing left to do")
    done_marks = [{"id": 777001, "role": "link", "label": "home", "box": {"x": 0, "y": 0, "w": 40, "h": 20}}]
    reply = step("Nothing to do here, the task is already complete", done_marks,
                 filled=[777001])
    action = validate_shape(reply, done_marks, "terminal")
    check(action.get("type") in {"done", "none"},
          "terminal: returns done when no work remains", f"got {action.get('type')!r}")

    print("\n[3] Accepts a request carrying no image (the fail-closed path sends none)")
    try:
        reply = post({
            "task": "Continue", "marks": SIGNUP_MARKS, "filled_mark_ids": [],
            "step": 2, "page_info": PAGE_INFO,
        })
        validate_shape(reply, SIGNUP_MARKS, "no-image")
    except urllib.error.HTTPError as exc:
        check(False, "no-image: request without an image is accepted", f"HTTP {exc.code}")

    print("\n[4] Rejects a malformed request rather than guessing")
    try:
        post({"marks": []})  # no task
        check(False, "validation: missing task is rejected")
    except urllib.error.HTTPError as exc:
        check(exc.code == 422, "validation: missing task rejected with 422", f"got {exc.code}")

    print("\n" + "=" * 78)
    if failures:
        print(f"{len(failures)} of {checks} checks FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"All {checks} server-contract checks passed.")
    print("Detection and redaction are NOT covered here - see eval/run-full-eval.js.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
