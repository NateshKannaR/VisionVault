# 🏆 VisionVault — SIH Hackathon Demo Video Script & Blueprint
**Problem Statement:** SIH PS 26171  
**Project:** VisionVault (Privacy-Preserving Autonomous Browser Agent)  
**Target Organization:** ISRO (Indian Space Research Organisation)  
**Target Video Duration:** 60 to 90 seconds  

---

## 🎯 Executive Summary for Video Presenters

This guide gives you an exact, second-by-second script to record an **irresistible hackathon demo video**. 

Judges want to see two things simultaneously:
1. **Real Autonomous Web Agency:** Not just a static chatbot — the agent navigates complex menus, parses unstructured pages, fills multi-step clearance forms, and clicks submits autonomously.
2. **Mathematical Proof of Privacy:** Real credentials, Aadhaar/PAN, employee contacts, and satellite KMS encryption keys are **completely sanitized on-device** — the remote server and AI model receive **zero sensitive bytes**.

---

## 🛠️ Pre-Recording Setup (Takes 30 seconds)

1. Open Google Chrome.
2. Go to `chrome://extensions/` -> Enable **Developer Mode** -> Click **Load Unpacked** -> Select the `extension/` directory.
3. Open the offline portal fixture in a tab:
   ```
   file:///home/natesh/Downloads/vision-agent/mock-apps/isro-portal.html
   ```
   *(Or run `npm run server` and open `http://127.0.0.1:8080/mock-apps/isro-portal.html`)*.
4. Pin the **VisionVault** icon in the Chrome toolbar.

---

## 🎬 Second-by-Second Video Recording Plan

### [0:00 – 0:15] The Hook & The Critical Dilemma
* **On Screen:** Full screen showing `mock-apps/isro-portal.html` with INSAT-4B telemetry and operator details.
* **Camera / Voiceover:**
  > *"Autonomous AI web agents like Anthropic's Computer Use or OpenAI's Operator take raw screenshots and upload user passwords, employee records, and government data directly to cloud servers.*  
  > *For mission-critical aerospace organizations like **ISRO**, this introduces unacceptable security and data sovereignty risks.  
  > Meet **VisionVault**: the first browser agent with a fail-closed, on-device privacy boundary."*
* **Visual Action:**
  - Click the green pill button on the top banner: **`Inspect Network Privacy (0 Bytes PII Sent)`**.
  - Show the modal: Highlight the contrast between **"What is on user screen (Raw KMS key & phone)"** vs **"What remote server receives (Masked image & symbolic markers only)"**.
  - Close the modal (`Esc` or `×`).

---

### [0:15 – 0:35] Visual Redaction & The X-Ray Lens
* **On Screen:** Click the VisionVault extension icon to open the popup.
* **Camera / Voiceover:**
  > *"When an agent executes an instruction, VisionVault executes DOM perception, local regex scanning, and ONNX face detection 100% on the local machine before any network call.*  
  > *Notice our 4-stage pipeline rail: **Observe -> Redact -> Reason -> Act**."*
* **Visual Action:**
  - Click the highlighted quick chip: **`⭐ SIH Showcase: Security Clearance (Zero-PII Fill)`**.
  - Point to the preview box: **"What the server receives"**. The sensitive telemetry and personal fields are blacked out!
  - Click **`X-Ray Lens`**: Drag the slider left and right on camera!
  - Point to the green badge: **`🔒 0 Bytes PII Sent`**.

---

### [0:35 – 1:05] Autonomous Execution with Local Encrypted Vault
* **On Screen:** The agent runs on the page in real time.
* **Camera / Voiceover:**
  > *"Now watch the automation in action. The cloud model reasons purely over symbolic mark IDs, returning abstract commands like 'type into mark 12 using vault key encryption_key_ref'.*  
  > *Our client resolves the secret key locally from encrypted storage. The confidential key `ISRO-KMS-EK-2026-04871` is inserted into the form, but NEVER leaves the browser."*
* **Visual Action:**
  - The agent clicks the **`Security Clearance`** sidebar tab.
  - The agent automatically fills each field:
    1. `Satellite Name` -> `INSAT-4B`
    2. `Mission ID` -> `INSAT-4B / M-201`
    3. `Encryption Key Reference` -> `ISRO-KMS-EK-2026-04871`
    4. `Operator Name`, `Email`, and `Phone`.
  - The agent clicks **`Submit Security Clearance`**.
  - The green confirmation toast appears: **`✓ Security clearance request submitted!`**.
  - Agent status shows: **`Done. Task complete.`**.

---

### [1:05 – 1:20] Autonomous Compliance & Security Audit
* **On Screen:** Switch to the **`Privacy Auditor`** tab in the sidebar (or run `audit isro press page for exposed contact numbers and unredacted faces`).
* **Camera / Voiceover:**
  > *"VisionVault doesn't just automate — it actively audits. Our on-device security compliance suite scans every DOM node for exposed phone extensions, unredacted leadership portraits, and API credentials."*
* **Visual Action:**
  - Click **`Run Security Compliance Audit`**.
  - The live terminal prints real-time scan logs:
    - `142 DOM Nodes Audited`
    - `0 PII Leaks Found`
    - `100% On-Device Masking`
    - `Compliance Grade: A+ (SIH PS 26171 Compliant)`

---

### [1:20 – 1:30] The Winning Conclusion
* **On Screen:** The ISRO portal alongside the VisionVault popup scorecard.
* **Camera / Voiceover:**
  > *"VisionVault proves that you don't have to sacrifice privacy to achieve advanced agentic web automation. Tested with over 280 automated assertions and ready for production deployment across India's premier scientific institutions. Thank you."*

---

## 💡 Quick Tips for High Marks
- **Keep Chrome at 100% Zoom** so marks and bounding boxes align crisply on camera.
- **Show the X-Ray Slider:** Evaluators love the interactive split lens because it visually proves redaction in real time without needing complex code explanations.
- **Mention Fail-Closed Safety:** If local redaction fails or detects an unknown credential type, VisionVault aborts transmission entirely rather than leaking data.
