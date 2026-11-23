#!/usr/bin/env python3
"""Exercise the real planner dispatch with deterministic provider doubles."""

import sys
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import main  # noqa: E402

PASS, FAIL = 0, 0


def check(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}\n       {detail}")


def make_request(**overrides):
    marks = [
        main.Mark(id=101, role="link", label="Sign in"),
        main.Mark(id=102, role="input:search", label="Search the site"),
        main.Mark(id=103, role="button", label="Go"),
    ]
    base = dict(
        task="search for onnxruntime",
        marks=marks,
        filled_mark_ids=[],
        step=1,
        page_info=main.PageInfo(title="Example", url="https://example.test/",
                                viewport_width=1280, viewport_height=860,
                                page_height=3000, scroll_y=0),
        task_hints=main.TaskHints(search_query="onnxruntime", site=None, open_targets=[]),
        progress=main.Progress(),
    )
    base.update(overrides)
    return main.AgentStepRequest(**base)


def describe(plan):
    a = plan.action
    return f"{a.type} target={a.target} value={a.value!r}"


print("\nplanning chain fallback\n")
tiers = ("ollama", "openrouter", "gemini", "mock")
for failed_count, expected in enumerate(tiers):
    main._tier_cooldowns.clear()
    calls = []

    def provider(tier):
        def run(_request):
            calls.append(tier)
            if tiers.index(tier) < failed_count:
                raise TimeoutError("stubbed timeout")
            return main.StepResponse(
                reasoning="fixture",
                action=main.StepAction(type="type", target=102, value="onnxruntime"),
            )
        return run

    with patch.multiple(main, OLLAMA_HOST="http://localhost:11434",
                        openrouter_key="fixture", gemini_key="fixture",
                        plan_with_ollama=provider("ollama"),
                        plan_with_openrouter=provider("openrouter"),
                        plan_with_gemini=provider("gemini")):
        plan = main.plan_step(make_request())

    check(f"falls back to {expected}", plan.tier == expected, str(plan.tier))
    check(f"{expected}: expected attempt order", calls == list(tiers[:failed_count + 1])[:3], str(calls))
    check(f"{expected}: usable action", plan.action.type == "type" and plan.action.target == 102
          and plan.action.value == "onnxruntime", describe(plan))
main._tier_cooldowns.clear()

# Once the search has landed, no tier may invent more work.
print()
done_req = make_request(progress=main.Progress(navigated=True, searched=True, query_landed=True),
                        filled_mark_ids=[102], step=2)
with patch.multiple(main, OLLAMA_HOST="", openrouter_key="", gemini_key=""):
    plan = main.plan_step(done_req)
check("a completed task terminates", plan.action.type == "done", describe(plan))

# A vault field must never be accompanied by a literal value.
leaky = main.StepResponse(reasoning="x", action=main.StepAction(
    type="type", target=102, value="hunter2", use_vault_field="password"))
repaired = main.repair_plan(leaky, make_request(), "test")
check("a literal value alongside a vault field is dropped",
      repaired.action.value is None and repaired.action.use_vault_field == "password",
      describe(repaired))

# ── Circuit breaker ──────────────────────────────────────────────────────────────────────
#
# A tier that is out of quota stays out of quota. Re-asking it every step cost ~20s per step
# during a live run with both hosted providers exhausted, so the breaker is a latency feature
# as much as a resilience one.
print()
main._tier_cooldowns.clear()

check("an unfailed tier is available", main.tier_available("gemini"))

rate_limit_429 = ("Error code: 429 - {'error': {'message': 'Rate limit reached for model `x` ... "
            "Please try again in 30m40.32s. ...'}}")
main.trip_tier("openrouter", rate_limit_429)
check("a rate-limited tier is skipped", not main.tier_available("openrouter"))
wait_s = main.tier_status()["openrouter"]["retry_in_s"]
check("the provider's own retry time is honoured", 1700 <= wait_s <= 1800, f"got {wait_s}s")

main._tier_cooldowns.clear()
main.trip_tier("gemini", "HTTP Error 401: Unauthorized - invalid api key")
check("a rejected key rests the tier for much longer",
      main.tier_status()["gemini"]["retry_in_s"] > 1000,
      str(main.tier_status()))

main._tier_cooldowns.clear()
main.trip_tier("gemini", "HTTP Error 503: temporarily unavailable")
rest = main.tier_status()["gemini"]["retry_in_s"]
check("a transient error rests it only briefly", rest < 60, f"got {rest}s")

main._tier_cooldowns.clear()
main._tier_cooldowns["openrouter"] = {"until": time.time() - 1, "reason": "rate limited"}
check("an expired cooldown lets the tier back in", main.tier_available("openrouter"))
check("...and is cleared once expired", "openrouter" not in main.tier_status())

# Whatever the breaker does, a plan still comes back.
main._tier_cooldowns.clear()
main.trip_tier("gemini", rate_limit_429)
main.trip_tier("openrouter", rate_limit_429)
with patch.multiple(main, OLLAMA_HOST="", openrouter_key="fixture", gemini_key="fixture"):
    plan = main.plan_step(make_request())
check("a plan is still produced with both hosted tiers rested",
      plan is not None and plan.action.type == "type", describe(plan) if plan else "none")
main._tier_cooldowns.clear()

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
