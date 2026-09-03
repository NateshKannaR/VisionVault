#!/usr/bin/env python3
"""
test-fallback-chain.py — proves the planning chain degrades as documented.

The chain is Gemini -> Groq -> Ollama -> deterministic rules. Each tier is disabled in turn and
the next one has to answer, in the same schema, with a usable action. This is the only way to
know the fallback actually works: in normal operation the first tier answers and the rest are
never exercised, so a broken lower tier would stay invisible until the day it is needed.

Run: python eval/test-fallback-chain.py
"""

import json
import os
import sys
import time
from pathlib import Path

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


def plan_through_chain(req, disable):
    """Runs the same tier sequence as the endpoint, with `disable` tiers forced to fail.

    Mirrors agent_step() exactly, circuit breaker included, so what this proves is what the
    endpoint actually does."""
    plan, tier = None, None
    if ("gemini" not in disable and (main.BACKEND == "gemini" or main.gemini_key)
            and main.tier_available("gemini")):
        plan = main.plan_with_gemini(req)
        tier = "gemini" if plan else None
    if not plan and "groq" not in disable and main.groq_client and main.tier_available("groq"):
        plan = main.plan_with_groq(req)
        tier = "groq" if plan else None
    if not plan and "ollama" not in disable and main.tier_available("ollama"):
        plan = main.plan_with_ollama(req)
        tier = "ollama" if plan else None
    if not plan:
        plan = main.mock_plan(req.marks, req.task, req.filled_mark_ids, req.page_info, req.progress)
        tier = "mock"
    return main.repair_plan(plan, req, tier), tier


def describe(plan):
    a = plan.action
    return f"{a.type} target={a.target} value={a.value!r}"


print("\nplanning chain fallback\n")

# Which tiers are configured at all. A tier that is not configured is skipped, not failed.
have_gemini = bool(main.gemini_key)
have_groq = bool(main.groq_client)
have_ollama = bool(main.ollama_model(force=True))
print(f"  configured: gemini={have_gemini} groq={have_groq} ollama={main.ollama_model()}\n")

SCENARIOS = [
    ("full chain", set(), None),
    ("gemini down", {"gemini"}, "groq" if have_groq else ("ollama" if have_ollama else "mock")),
    ("gemini + groq down", {"gemini", "groq"}, "ollama" if have_ollama else "mock"),
    ("every model down", {"gemini", "groq", "ollama"}, "mock"),
]

for label, disable, expected_tier in SCENARIOS:
    req = make_request()
    t0 = time.time()
    plan, tier = plan_through_chain(req, disable)
    elapsed = time.time() - t0

    print(f"  [{label}] answered by {tier} in {elapsed:.1f}s -> {describe(plan)}")
    check(f"{label}: a plan is always produced", plan is not None)
    if expected_tier:
        check(f"{label}: {expected_tier} took over", tier == expected_tier, f"got {tier}")
    check(f"{label}: the action is usable",
          plan.action.type == "type" and plan.action.target == 102 and plan.action.value == "onnxruntime",
          describe(plan))

# Once the search has landed, no tier may invent more work.
print()
done_req = make_request(progress=main.Progress(navigated=True, searched=True, query_landed=True),
                        filled_mark_ids=[102], step=2)
plan, tier = plan_through_chain(done_req, {"gemini", "groq", "ollama"})
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

groq_429 = ("Error code: 429 - {'error': {'message': 'Rate limit reached for model `x` ... "
            "Please try again in 30m40.32s. ...'}}")
main.trip_tier("groq", groq_429)
check("a rate-limited tier is skipped", not main.tier_available("groq"))
wait_s = main.tier_status()["groq"]["retry_in_s"]
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
main._tier_cooldowns["groq"] = {"until": time.time() - 1, "reason": "rate limited"}
check("an expired cooldown lets the tier back in", main.tier_available("groq"))
check("...and is cleared once expired", "groq" not in main.tier_status())

# Whatever the breaker does, a plan still comes back.
main._tier_cooldowns.clear()
main.trip_tier("gemini", groq_429)
main.trip_tier("groq", groq_429)
plan, tier = plan_through_chain(make_request(), set())
check("a plan is still produced with both hosted tiers rested",
      plan is not None and plan.action.type == "type", describe(plan) if plan else "none")
main._tier_cooldowns.clear()

print(f"\n{PASS} passed, {FAIL} failed\n")
sys.exit(1 if FAIL else 0)
