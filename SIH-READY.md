# VisionVault — SIH Finalization Pack

## 1-line pitch
VisionVault is a privacy-preserving browser agent that keeps sensitive visual data local, redacts it before any network call, and lets a server-side planner act on a sanitized screen using symbolic mark IDs rather than raw user data.

## Why this is a top-tier SIH idea
- Strong privacy story: the real screen data stays on the user's machine.
- Real browser automation: the agent does not merely classify screenshots; it acts on the web page.
- Human-centered design: the local vault resolves personal data only after the server picks a symbolic field.
- Production-oriented safety: fail-closed redaction prevents accidental leaks.
- Clear tradeoff story: client latency vs server reasoning, with measured evaluation data.

## Core technical narrative
1. Local capture: the browser captures the active screen.
2. Local perception: DOM scanning, OCR, face detection, and region detection run on-device.
3. Local sanitization: sensitive regions are redacted before any outbound request.
4. Server reasoning: the model sees only the redacted image and stable element marks.
5. Safe execution: the client resolves symbolic values locally and performs the action.

## What judges want to see
- privacy boundary is explicit
- no raw sensitive data leaves the browser
- redaction is verified, not assumed
- action loop is end-to-end and grounded in a real task
- evaluation numbers exist and are reproducible

## Demo flow for final pitch
1. Open a form page in Chrome.
2. Load the extension and open the side panel.
3. Enter personal details into the local vault.
4. Ask: "Fill the signup form with my details."
5. Show the redacted preview before network transmission.
6. Run automation and show the form gets filled without the server seeing the actual values.
7. Highlight the proof: local vault field names only, redacted image sent upstream.

## One-minute competition summary
VisionVault demonstrates a browser-native privacy architecture: the user machine performs local perception and sanitization, while the server handles planning from a symbolic, redacted view. This preserves privacy without destroying the value of cloud reasoning. The result is a practical agentic workflow that can act on web pages while keeping personal data on-device.

## Final readiness checklist
- [x] Local redaction pipeline exists
- [x] Privacy-first agent loop exists
- [x] Server planner exists
- [x] Eval report exists
- [x] Setup docs exist
- [x] Firefox packaging support exists
- [ ] Final showcase video prepared
- [ ] One-click startup script polished
- [ ] Final README trimmed to SIH-style pitch

## Commands
```bash
npm test
npm run eval
npm run report
npm run build:firefox
npm run server
```

## Recommended final demo prompt
"Fill the signup form with my details and complete the form safely without exposing personal data."
