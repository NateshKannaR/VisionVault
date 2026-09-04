# Using VisionVault

Two things need to be running: the planning server, and the extension. Neither depends on the
other being perfect — if the server is down the extension plans on-device instead, and
detection and redaction never leave your machine either way.

## 1. Start the server

```powershell
npm run server
```

That stops whatever is holding port 8000, starts a fresh instance, and prints the live chain:

```json
{"chain":["gemini","groq","ollama","mock"],
 "models":{"gemini":"gemini-3.6-flash","groq":"qwen/qwen3.6-27b","ollama":"qwen2.5:1.5b-instruct"},
 "cooldowns":{}}
```

Read it as: which planners are available, in order. If a hosted one is out of quota it appears
under `cooldowns` and the next tier answers instead — you do not have to do anything.

For the fully local tier, [Ollama](https://ollama.com) must be running with a small instruct
model installed:

```bash
ollama pull qwen2.5:1.5b-instruct
```

Small matters. A 14B model on this machine produces 3.8 tokens/second, which makes one planning
step take 40 seconds; the 1.5B model answers in about half a second and is just as good at
"which of these numbered elements". Pin it with `OLLAMA_MODEL=qwen2.5:1.5b-instruct` in
`server/.env` if you have several installed.

## 2. Load the extension

Once, in Chrome:

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → pick `extension/`.
2. Click the toolbar icon to open the side panel.
3. **Vault** tab → enter the details you want the agent to be able to type. They are stored in
   `chrome.storage.local` and are never transmitted; the server only ever sees a field *name*.
4. **Settings** tab → optionally add standing **preferences** ("budget under ₹50,000", "prefer
   Dell or Lenovo", "vegetarian"). These are sent with each task so choices match you. Keep
   anything personal in the Vault instead — that is the half that never leaves.

After changing any extension file, press the reload icon on the card in `chrome://extensions`.

## 3. Run a task

Go to any website, type what you want, and press **Run task**.

```
search for iqoo neo 6 and show me
find the best laptop under 50000, compare the ratings and add the best one to the cart
read this page and tell me the top stories
fill the signup form with my details
open flipkart and search for running shoes
scroll down and show me more headlines
```

The panel breaks the instruction into a **workflow** and shows it as a checklist, ticking each
milestone off as the page proves it happened:

```
  1. Search for "laptop under 50000"        search   ✓
  2. Read and compare the results           read     ✓
  3. Open the best match                    open     ●  ← running now
  4. Add it to the cart                     act
  5. Summarise what was found               answer
```

Under it, the live line names what is happening, which planner decided it, and how confident
that planner was. When the run ends you get a completion card: what was achieved, the results
it found, how long it took, and anything it could not do.

### Reviewing before anything is sent

Press **Preview what is sent** instead of Run, and the panel shows the exact redacted image
with every masked region outlined and colour-coded by which detector caught it. Nothing has
been transmitted at that point. **Send & run** proceeds. To make that the default, tick
Settings → *Pause after the scan so I can review*.

## What to expect

Measured on the evaluation fixtures the night this was written: a five-stage shopping journey —
search, read four products, compare ratings against a stated budget, open the right one, add it
to the cart, report — completes in **45 seconds over 9 actions**, picks the correct product,
and stops for approval before the cart step. Most single-step tasks (a search, a scroll)
finish in one or two steps. The local scan is 1.3–3.5s depending on the page; planning is
0.6–3.5s per step depending on which tier answers.

## What it will do, and what it will not

- **Works to a plan, and finishes it.** A milestone the page cannot satisfy is skipped and
  reported, not retried until the run dies — the rest of the workflow still runs.
- **Reads pages, not just buttons.** "Compare the ratings" makes it extract the products, their
  prices and their ratings, and choose on your terms. Page text is scrubbed of anything
  matching a PII pattern, and sensitive table columns are dropped, before it is sent.
- **Understands controls by purpose.** "Add to cart" finds a button that says *Add to bag*;
  "continue" finds *Proceed*.
- **Recovers when a page changes underneath it.** If the element it planned for has gone, it
  re-reads the page and looks for the control that now serves the same purpose, and says so:
  *"The expected 'Continue' changed. Searching for an equivalent action… Found 'Proceed'."*
- **Follows a new tab** the page opens, rather than losing the thread.
- **Says when it could not finish**, and why: *"Typed 'webassembly simd' — the page has not run
  the search."* It does not claim success it cannot verify.
- **Asks you for anything the vault does not have**, once, with an option to remember it. It
  never invents personal data, and it never guesses: a field labelled *Aadhaar number* is set
  aside rather than filled with the nearest thing in the vault. It finishes everything else
  first and asks at the end, so one unknown field does not leave the rest of the form empty.
- **Pauses before consequential clicks** — pay, buy, checkout, add to cart, submit, delete,
  sign-up, log-in — and before any control it cannot read a label from. You can **Approve**,
  **Cancel**, or **Modify**: type what to do instead and it takes that over its own plan.
- **Hands back for a CAPTCHA or a file chooser** — the two things an extension cannot do — and
  carries on when you press Continue.
- **Never submits a half-filled form.** If a planner tries, it fills the next field instead.
- **Closes cookie banners** so they stop swallowing clicks, but never touches a dialog about
  payment, orders or deletion. Switch it off under Settings if you would rather it did not.
- **Gets faster on sites you use.** It remembers, per site, which search box worked and which
  banner it closed. Labels only, on this device. Settings → Site memory → Forget clears it.

## If something looks wrong

| Symptom | What to do |
| :--- | :--- |
| "No planning server reachable" | `npm run server`. The agent still works without it. |
| Planning feels slow | Settings → Backend → **Recheck**. A tier that is rate-limited or timing out is shown struck through with the retry time; the next tier is already answering. |
| Scan finds nothing | The page may not have finished loading. Scan again. |
| A site defeats the search | The panel says so explicitly. Some sites implement search with no form, no submit control and no OpenSearch descriptor; see `LIMITATIONS.md`. |
| "Stopped — the site is asking for verification" | The site served a CAPTCHA. Solve it on the page, then press **Continue**. |
| A milestone was skipped | The page had no way to do it. The completion card names which one and why; the rest of the workflow still ran. |
| "Chrome does not allow extensions to read its own pages" | You are on `chrome://` or the Web Store. Open an ordinary website. |
| Anything at all | `server/logs/uvicorn.log` has the planner's side, including where each step's time went; the panel's Activity list has the client's. |

## Checking it yourself

```bash
npm test                          # hygiene, panel wiring, and 110 unit checks
npm run test:workflow             # decomposition, milestone planning, choosing
npm run test:chain                # disables each planner in turn, proves the fallback
npm run verify                    # privacy invariants, checked against the bytes on the wire
npm run verify:journey            # the full multi-step shopping workflow, end to end
npm run eval                      # drives real Chrome over 7 annotated pages
npm run real-sites                # 22 public websites, real tasks
npm run report                    # regenerates eval_report.md from measured results only
```
