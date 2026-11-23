# VisionVault limits and evaluation

- **Detection coverage.** DOM, face, and OCR checks can miss unconventional formats, canvas and embedded content, unsupported languages, or poorly rendered text. Coverage depends on enabled detectors and what the browser can access. Review the scan before using a remote planner.
- **Browser permissions.** Browser-internal pages, store pages, and some frames restrict extension access. File URLs require separate browser permission. The panel's X-ray control can temporarily reveal source pixels in the local browser.
- **Automation.** The rules planner handles known action families. Websites can change their layout or display sign-in and verification challenges. Review destinations, submissions, and values entered into pages.
- **Provider exposure.** A configured hosted tier can receive task context and masked images. Provider policies and regional routing depend on the chosen service and account.
- **Environment scope.** Chromium is the runtime tested in CI. The Firefox build requires browser-specific validation and signing before distribution. Evaluation with live providers and websites depends on model availability, credentials, and page behavior.
- **Fixtures.** The local employee and HR portal illustrates the workflow with shared demo credentials and simulated records. It should only be used with synthetic data.
- **Evidence.** The [archived evaluation](eval_report.md) describes the checked-in synthetic corpus and earlier runs. The extension's self-check exercises a small synthetic input. The [verification matrix](README.md#verification) lists the reproducible checks for the current implementation.
