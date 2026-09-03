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

## 2. Load the extension

Once, in Chrome:

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → pick `extension/`.
2. Click the toolbar icon to open the side panel.
3. **Vault** tab → enter the details you want the agent to be able to type. They are stored in
   `chrome.storage.local` and are never transmitted; the server only ever sees a field *name*.

After changing any extension file, press the reload icon on the card in `chrome://extensions`.

## 3. Run a task

Go to any website, open the panel, and describe what you want:

```
search for iqoo neo 6 and show me
scroll down and show me more headlines
fill the signup form with my details
open flipkart and search for running shoes
```

Then **Scan & redact screen**. The panel shows the exact image that would be sent, with every
masked region outlined — this is the review step, and nothing has been transmitted yet. Press
**Run automation** to let it act.

While it runs, each step names the planner that chose it (Gemini / Groq / Local model / rules)
and what it did. When it finishes it says what it actually achieved — *"Done — ran the search"*
— not just how many calls succeeded.

## What to expect

Measured on ten public websites the night this was written: six of seven search tasks reached
the results page (Amazon, Flipkart, Wikipedia, YouTube, GitHub, MDN), both scroll tasks acted,
Stack Overflow served a CAPTCHA and the agent stopped and said so, and MakeMyTrip's journey
planner could not be driven from a sentence. Most tasks finish in one step, a few in two. The
local scan is 1.3-3.5s depending on the page; planning is whatever the model takes.

## What it will do, and what it will not

- **Stops when the task is done.** Not when it runs out of steps.
- **Says when it could not finish**, and why: *"Typed 'webassembly simd' — the page has not run
  the search."* It does not claim success it cannot verify.
- **Asks you for anything the vault does not have**, once, with an option to remember it. It
  never invents personal data, and it never guesses: a field labelled *Aadhaar number* is set
  aside rather than filled with the nearest thing in the vault. It finishes everything else
  first and asks at the end, so one unknown field does not leave the rest of the form empty.
- **Pauses before consequential clicks** — pay, buy, checkout, submit, delete, sign-up, log-in
  — and before any control it cannot read a label from. Change this under
  Settings → Click confirmation.
- **Never submits a half-filled form.** If a planner tries, it fills the next field instead.
- **Stops at a CAPTCHA and tells you.** It does not try to solve or get around one.
- **Closes cookie banners** so they stop swallowing clicks, but never touches a dialog about
  payment, orders or deletion. Switch it off under Settings if you would rather it did not.

## If something looks wrong

| Symptom | What to do |
| :--- | :--- |
| "No planning server reachable" | `npm run server`. The agent still works without it. |
| Planning feels slow | Settings → Backend → **Recheck**. A tier that is rate-limited is shown struck through with the retry time. |
| Scan finds nothing | The page may not have finished loading. Scan again. |
| A site defeats the search | The panel says so explicitly. Some sites implement search with no form, no submit control and no OpenSearch descriptor; see `LIMITATIONS.md`. |
| "Stopped — the site is asking for verification" | The site served a CAPTCHA. Solve it yourself, then run the task again. |
| "Chrome does not allow extensions to read its own pages" | You are on `chrome://` or the Web Store. Open an ordinary website. |
| Anything at all | `server/logs/uvicorn.log` has the planner's side; the panel's Activity list has the client's. |

## Checking it yourself

```bash
npm test                          # source hygiene, panel wiring, and 26 guard + 40 planner tests
npm run test:chain                # disables each planner in turn, proves the fallback
npm run eval                      # drives real Chrome over 6 annotated pages
npm run verify                    # privacy invariants, checked against the bytes on the wire
npm run real-sites                # ten public websites, real tasks
npm run report                    # regenerates eval_report.md from measured results only
```
