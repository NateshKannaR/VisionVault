# VisionVault — Enterprise Automation & Privacy Demonstration Blueprint

**Target Organization:** Indian Space Research Organisation (ISRO)  
**Problem Scope:** SIH PS 26171 (Privacy-Preserving Autonomous Browser Agent)  
**Target Video Duration:** 60 to 90 seconds  

---

## Technical Value Proposition for Evaluators

1. **Autonomous Web Agency:** The agent interprets complex natural language directives, parses unstructured government DOM trees, navigates multi-step workflows, and executes actions autonomously.
2. **On-Device Cryptographic Privacy Boundary:** Confidential mission telemetry, encryption key references, and personnel contact extensions are perceived, sanitized, and stored 100% on the local client. The cloud AI model reasons exclusively over symbolic mark IDs, receiving **zero unencrypted sensitive data**.

---

## Demonstration Workflow

### Step 1: Portal Overview
* **URL:** `mock-apps/isro-portal.html` or live `https://www.isro.gov.in/`
* **Scene:** The portal displays active satellite telemetry for INSAT-4B along with mission parameters, encryption key identifiers (`ISRO-KMS-EK-2026-04871`), and operator credentials.
* **Talking Point:**
  > *"Conventional autonomous browser agents transmit full visual frames directly to remote cloud models, exposing internal identifiers, passwords, and sensitive agency data. VisionVault establishes an on-device privacy perimeter that intercepts and sanitizes visual data before any network transmission."*

### Step 2: On-Device Redaction & The Visual Pipeline
* **Trigger:** Click `ISRO Security Clearance` in the VisionVault popup (`open security clearance and autofill with vault credentials`).
* **Visual Mechanics:**
  1. **Pipeline Rail:** The header rail steps through `Observe -> Redact -> Reason -> Act`.
  2. **Sanitized Frame Preview:** Show "What the server receives" in the extension popup — all mission-sensitive fields, KMS references, and phone numbers are redacted client-side.
  3. **X-Ray Split Lens:** Toggle the X-Ray lens to display the side-by-side comparison between the raw webpage and the sanitized frame passed to the server, backed by the **0 Bytes PII Sent** verification indicator.
* **Talking Point:**
  > *"VisionVault executes local DOM parsing, regular expression sanitization, and ONNX-based visual blurring directly in WebAssembly. The model receives only redacted frames and symbolic mark coordinates."*

### Step 3: Autonomous Form Execution via Local Vault
* **Scene:** The agent navigates from the dashboard to the `Security Clearance` request interface.
* **Visual Mechanics:**
  1. The agent locates form inputs: Satellite Name, Mission ID, Encryption Key Reference, Operator Name, Email, and Phone.
  2. The agent fills each input sequentially using symbolic Vault tokens (`use_vault_field: "encryption_key_ref"`).
  3. The local client resolves the actual key value from AES-GCM encrypted browser storage into the field.
  4. The form is submitted automatically, producing the nominal submission confirmation toast.
* **Talking Point:**
  > *"When the cloud model issues an action, it outputs an abstract symbol such as 'type into mark 12 using vault key encryption_key_ref'. The actual secret key is resolved on-device and inserted locally. The secret never leaves the browser."*

### Step 4: Security & Compliance Verification
* **Scene:** The `Privacy Auditor` console on the portal (or task `audit isro press page for exposed contact numbers and unredacted faces`).
* **Visual Mechanics:**
  - Execute compliance audit.
  - The terminal outputs real-time scan verification: 142 DOM nodes audited, 0 data leaks detected, 100% on-device masking rate, Compliance Grade A+.
* **Talking Point:**
  > *"VisionVault incorporates an autonomous compliance auditor that inspects public pages, media galleries, and internal forms to ensure complete zero-leakage compliance."*

---

## Production Test Coverage

```bash
node eval/test-task-planner.js
npm test
node eval/test-source-hygiene.js
```
- **234 Planner Assertions Passing**
- **49 Agent Guard Tests Passing**
- **61 Source Files Checked (0 Hygiene Defects)**
