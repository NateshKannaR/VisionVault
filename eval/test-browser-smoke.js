"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, readdir, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { unzipSync } = require("fflate");
const { launchWithExtension, startFixtureServer } = require("./lib/harness");

async function main() {
  const preview = spawn(process.execPath, ["scripts/preview-site.js"], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const token = randomBytes(32).toString("hex");
  const plannerRequests = [];
  const planner = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    plannerRequests.push({ url: request.url, auth: request.headers.authorization, body });
    if (request.headers.authorization !== "Bearer " + token) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = { tier: "mock", action: { type: "done" }, partial: false };
    response.end("data: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n");
  });
  planner.listen(0, "127.0.0.1");
  await once(planner, "listening");
  let fixture;
  let h;
  try {
    const [line] = await once(preview.stdout, "data");
    const base = line.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(base, "preview reported its URL");
    fixture = await startFixtureServer();
    h = await launchWithExtension({ headless: true });
    const page = await h.browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewport({ width: 1350, height: 960 });
    await page.goto(base, { waitUntil: "networkidle0" });
    assert.match(await page.$eval("#preview", (node) => node.textContent), /\[EMAIL_1\]/);
    assert.match(await page.$eval("#preview", (node) => node.textContent), /\[PHONE_NUMBER_1\]/);
    assert.match(await page.$eval("#lab-findings", (node) => node.textContent), /Email Address/);
    await page.click('[data-example="config"]');
    assert.match(await page.$eval("#preview", (node) => node.textContent), /\[EMAIL_1\]/);
    assert.match(await page.$eval("#lab-findings", (node) => node.textContent), /Database Connection URI/);

    await page.click("#clear-lab");
    assert.equal(await page.$eval("#source", (node) => node.value), "");
    assert.equal(await page.$eval("#copy", (node) => node.disabled), true);
    assert.equal(await page.$eval("#lab-findings", (node) => node.hidden), true);
    await page.$eval("#source", (node) => {
      node.value = "<b>fixture</b> jordan@example.test";
      node.dispatchEvent(new Event("input"));
    });
    assert.match(await page.$eval("#preview", (node) => node.textContent), /<b>fixture<\/b> \[EMAIL_1\]/);
    assert.equal(await page.$("#preview b"), null);
    await page.click('[data-example="support"]');
    await page.click("#copy");
    await page.waitForFunction(() => document.getElementById("lab-status").textContent === "Redacted output copied.");
    await page.$eval("#lab-status", (node) => { node.hidden = true; });
    if (process.env.VV_SCREENSHOT) await page.screenshot({ path: process.env.VV_SCREENSHOT, fullPage: false });

    for (const width of [320, 360]) {
      await page.setViewport({ width, height: 800, isMobile: true, hasTouch: true });
      await page.reload({ waitUntil: "domcontentloaded" });
      assert.ok(await page.evaluate((limit) => document.documentElement.scrollWidth <= limit, width));
    }
    await page.click("#site-menu");
    assert.equal(await page.$eval("#site-menu", (node) => node.getAttribute("aria-expanded")), "true");
    await page.keyboard.press("Escape");
    assert.equal(await page.$eval("#site-menu", (node) => node.getAttribute("aria-expanded")), "false");
    assert.equal(await page.evaluate(() => document.activeElement.id), "site-menu");
    await page.click("#site-menu");
    await page.click('#site-navigation a[href="#lab"]');
    assert.equal(new URL(page.url()).hash, "#lab");
    assert.equal(await page.$eval("#site-menu", (node) => node.getAttribute("aria-expanded")), "false");

    for (const portal of ["employee-portal/", "hr-portal/"]) {
      assert.equal((await fetch(base + "/" + portal, { method: "HEAD" })).status, 200);
    }
    const video = await fetch(base + "/images/ProtoType%20VisionVault.mp4", { method: "HEAD" });
    assert.equal(video.status, 200);
    assert.equal(video.headers.get("content-type"), "video/mp4");
    await page.waitForFunction(() => document.getElementById("demoVideoPlayer").readyState >= 1);
    await page.focus('[data-seek="12"]');
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const video = document.getElementById("demoVideoPlayer");
      return !video.seeking && video.currentTime >= 11.99 &&
        document.querySelector('[data-seek="12"]').getAttribute("aria-current") === "true";
    });
    await page.$eval("#demoVideoPlayer", (node) => node.pause());
    assert.equal(await page.$('a[href="login.html"]'), null);
    await page.focus('#stagesGrid button[data-stage="2"]');
    await page.keyboard.press("Enter");
    assert.equal(await page.$eval('#stagesGrid [aria-pressed="true"]', (node) => node.dataset.stage), "2");
    const firefoxSetup = "#install details:nth-of-type(2)";
    await page.click(firefoxSetup + " summary");
    assert.equal(await page.$eval(firefoxSetup, (node) => node.open), true);
    const hostedDemo = await h.browser.newPage();
    for (const route of ["login.html", "login/index.html"]) {
      await hostedDemo.goto(fixture.baseUrl + "/isro-panel/" + route);
      await hostedDemo.waitForFunction(() => location.pathname === "/employee-portal.html");
      assert.equal(await hostedDemo.$("#login-form"), null);
    }
    hostedDemo.on("pageerror", (error) => errors.push(error.message));
    await hostedDemo.setViewport({ width: 320, height: 800, isMobile: true, hasTouch: true });
    for (const [portal, initial, target] of [
      ["employee-portal.html", "overview", "form-hr"],
      ["hr-portal.html", "missions", "emp-list"],
      ["isro-intranet-demo.html", "messages", "form-housing"],
    ]) {
      const url = fixture.baseUrl + "/isro-panel/" + portal;
      await hostedDemo.goto(url, { waitUntil: "domcontentloaded" });
      await hostedDemo.waitForSelector("body[data-navigation-ready]");
      if (portal !== "isro-intranet-demo.html") {
        assert.equal(await hostedDemo.$eval("#local-session-bar", (node) => getComputedStyle(node).display), "none");
      }
      assert.equal(await hostedDemo.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, portal);
      await hostedDemo.click(".workspace-menu");
      assert.equal(await hostedDemo.$eval(".workspace-menu", (node) => node.getAttribute("aria-expanded")), "true");
      await hostedDemo.keyboard.press("Escape");
      assert.equal(await hostedDemo.evaluate(() => document.activeElement.className), "workspace-menu");
      await hostedDemo.click(".workspace-menu");
      await hostedDemo.focus(`.nav-item[data-page="${target}"]`);
      await hostedDemo.keyboard.press("Enter");
      assert.equal(new URL(hostedDemo.url()).hash, "#page-" + target);
      assert.equal(await hostedDemo.$eval(".nav-item[aria-current='page']", (node) => node.dataset.page), target);
      assert.equal(await hostedDemo.evaluate(() => document.activeElement.closest(".page").id), "page-" + target);
      assert.equal(await hostedDemo.$eval(".workspace-menu", (node) => node.getAttribute("aria-expanded")), "false");
      await hostedDemo.goBack();
      await hostedDemo.waitForSelector("#page-" + initial + ".active");
      await hostedDemo.goto(url + "#page-" + target);
      await hostedDemo.waitForSelector("#page-" + target + ".active");
      assert.equal(await hostedDemo.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, target);
      if (portal === "hr-portal.html") {
        assert.equal(await hostedDemo.$eval("#emp-tbody", (node) => node.rows.length), 6);
        assert.equal(await hostedDemo.$eval("#emp-tbody tr", (node) => getComputedStyle(node).display), "grid");
        await hostedDemo.type("#emp-search", "no such fixture");
        assert.match(await hostedDemo.$eval("#personnel-results", (node) => node.textContent), /No matching personnel/);
        await hostedDemo.$eval("#emp-search", (node) => {
          node.value = "Natesh";
          node.dispatchEvent(new Event("input"));
        });
        assert.equal(await hostedDemo.$eval("#personnel-results", (node) => node.textContent), "1 person");
        await hostedDemo.click("#emp-tbody .topbar-action");
        await hostedDemo.waitForSelector("#page-messages.active");
      }
    }
    await hostedDemo.goto(base + "/employee-portal/");
    await hostedDemo.click('[data-open-page="mission-log"]');
    assert.equal(new URL(hostedDemo.url()).pathname, "/employee-portal/");
    assert.equal(new URL(hostedDemo.url()).hash, "#page-mission-log");
    await hostedDemo.waitForSelector("#page-mission-log.active");
    await hostedDemo.close();
    assert.equal((await fetch(base + "/data/prototype-state.json")).status, 404);
    for (const browser of ["chromium", "firefox"]) {
      const response = await fetch(base + `/downloads/visionvault-${browser}.zip`);
      assert.equal(response.status, 200);
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
      const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString());
      assert.equal(manifest.manifest_version, 3);
      assert.equal(manifest.version, "1.1.0");
      assert.ok(files["popup.html"] && files["shield-panel.js"] && files["planner/connection.js"]);
      for (const script of manifest.background.scripts || []) assert.ok(files[script], script);
      assert.equal(Boolean(manifest.background.service_worker), browser === "chromium");
    }

    const panel = await h.browser.newPage();
    panel.on("pageerror", (error) => errors.push(error.message));
    await panel.setViewport({ width: 325, height: 850 });
    await panel.goto(`chrome-extension://${h.extensionId}/popup.html`);
    await panel.waitForFunction(() => document.getElementById("backendBadge").textContent === "On-device");
    assert.equal(await panel.$eval("#s-autoAgent", (node) => node.checked), false);
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await panel.focus("#tab-run");
    await panel.keyboard.press("ArrowRight");
    assert.equal(await panel.$eval("#tab-vault", (node) => node.getAttribute("aria-selected")), "true");
    for (const tab of ["run", "vault", "history", "privacy", "benchmarks", "shield", "settings"]) {
      await panel.click("#tab-" + tab);
      await panel.waitForSelector("#panel-" + tab + ".active h1");
      assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, tab);
    }
    await h.worker.evaluate(() => chrome.storage.local.set({
      taskHistory: [
        { task: "Find the sample form", ts: Date.now(), steps: 1, ok: true },
        { task: "Stopped fixture task", ts: Date.now(), stopped: true, ok: false },
        { task: "Failed fixture task", ts: Date.now(), error: "Fixture error", ok: false },
      ],
    }));
    await panel.click("#tab-history");
    await panel.waitForSelector("button.history-item");
    await panel.select("#historyOutcome", "stopped");
    assert.match(await panel.$eval("#historyList", (node) => node.textContent), /Stopped fixture task/);
    assert.equal((await panel.$$("button.history-item")).length, 1);
    await panel.select("#historyOutcome", "all");
    await panel.type("#historySearch", "sample");
    assert.equal(await panel.$eval("#historyCount", (node) => node.textContent), "1 of 3 tasks");
    await panel.focus("button.history-item");
    await panel.keyboard.press("Enter");
    assert.equal(await panel.$eval("#task", (node) => node.value), "Find the sample form");
    assert.equal(await panel.evaluate(() => document.activeElement.id), "task");
    await panel.click("#tab-history");
    await panel.click("#clearHistory");
    await panel.waitForSelector(".history-empty");
    assert.equal(await panel.$eval("#clearHistory", (node) => node.disabled), true);
    await panel.click("#tab-benchmarks");
    await panel.click("#btnRunLiveVerification");
    assert.match(await panel.$eval("#benchVerificationResult", (node) => node.textContent), /^Passed/);

    await testVaultBackup(h.browser, panel);

    await panel.click("#tab-shield");
    await panel.click("#loadPromptSample");
    await panel.click("#scrubPromptBtn");
    assert.match(await panel.$eval("#scrubbedPromptOutput", (node) => node.value), /\[EMAIL_1\]/);
    assert.match(await panel.$eval("#scrubFindingsList", (node) => node.textContent), /Email Address/);
    await panel.click("#permanentMasks");
    assert.match(await panel.$eval("#scrubbedPromptOutput", (node) => node.value), /\[REDACTED\]/);
    assert.doesNotMatch(await panel.$eval("#scrubbedPromptOutput", (node) => node.value), /jordan@|\[EMAIL_1\]/);
    await panel.click("#permanentMasks");

    await panel.focus("#tool-text");
    await panel.keyboard.press("ArrowRight");
    assert.equal(await panel.$eval("#tool-file", (el) => el.getAttribute("aria-selected")), "true");
    await dropShieldFile(panel, "fixture.txt", "Document email: casey@example.test");
    await panel.waitForSelector("#pdfResultWrap", { visible: true });
    assert.equal(await panel.$eval("#pdfSanitizedOutput", (el) => el.value), "Document email: [EMAIL_1]");

    await panel.click("#tool-restore");
    await panel.type("#llmResponseInput", "Reply to [EMAIL_1]");
    assert.equal(await panel.$eval("#unmaskBtn", (el) => el.disabled), true);
    await panel.select("#restoreSource", "text");
    await panel.click("#unmaskBtn");
    assert.equal(await panel.$eval("#unmaskedOutput", (el) => el.value), "Reply to jordan@example.test");
    await panel.select("#restoreSource", "file");
    await panel.click("#unmaskBtn");
    assert.equal(await panel.$eval("#unmaskedOutput", (el) => el.value), "Reply to casey@example.test");
    await panel.click("#tool-file");
    await dropShieldFile(panel, "fixture.pdf", "%PDF-1.4\n1 0 obj <</Type /Page>> endobj\n%%EOF");
    await panel.waitForSelector("#fileStatus.error");
    assert.equal(await panel.$eval("#pdfResultWrap", (el) => el.hidden), true);
    await panel.click("#tool-text");
    await panel.type("#rawPromptInput", " Edited.");
    assert.equal(await panel.$eval("#scrubFindingsWrap", (el) => el.hidden), true);
    await panel.click("#tool-restore");
    assert.equal(await panel.$eval("#unmaskBtn", (el) => el.disabled), true);
    await panel.click("#clearShieldSession");
    assert.equal(await panel.$eval("#llmResponseInput", (el) => el.value), "");
    await testActiveChatMasking(h.browser, panel);

    const sample = await h.browser.newPage();
    await sample.goto(fixture.baseUrl + "/pages/signup-form.html");
    await sample.bringToFront();
    const [fixtureTab] = await h.worker.evaluate(() => chrome.tabs.query({ active: true }));
    const scanned = await h.worker.evaluate((tabId) => phaseScan("Fill the form", tabId, false), fixtureTab.id);
    assert.ok(scanned.piiCount > 0, "scan detects regions on the signup fixture");
    assert.ok(scanned.markCount > 0, "scan detects interactive controls");
    assert.match(scanned.preview, /^data:image\/png/);
    // Open the workspace as an extension tab and leave the fixture foreground for capture.
    await panel.evaluate(() => {
      document.getElementById("tab-run").click();
      document.getElementById("scanBtn").click();
    });
    await panel.waitForFunction(() => !document.getElementById("runBtn").hidden ||
      document.getElementById("statusMsg").classList.contains("error"), { polling: 100, timeout: 35000 });
    assert.equal(await panel.$eval("#runBtn", (el) => el.hidden), false,
      await panel.$eval("#statusMsg", (el) => el.textContent));
    assert.match(await panel.$eval("#previewContext", (node) => node.textContent), /127\.0\.0\.1/);
    const otherTab = await h.browser.newPage();
    await otherTab.goto(fixture.baseUrl + "/pages/signup-form.html");
    await otherTab.bringToFront();
    await panel.evaluate(() => document.getElementById("runBtn").click());
    await panel.waitForFunction(() => /reviewed tab changed/.test(document.getElementById("statusMsg").textContent),
      { polling: 100 });
    await otherTab.close();
    await sample.bringToFront();
    const wrongReview = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "RUN", scanId: "expired-review" }));
    assert.match(wrongReview.error, /review has expired/);

    const plannerUrl = "http://127.0.0.1:" + planner.address().port;
    const response = await h.worker.evaluate(
      (url, key) => callServer({ task: "Find the address field", privacy_budget: { level: 0 } }, url, key),
      plannerUrl, token,
    );
    assert.equal(response.action, "done");
    assert.equal(plannerRequests[0].url, "/api/agent/step/stream");
    assert.equal(plannerRequests[0].auth, "Bearer " + token);
    assert.ok(!plannerRequests[0].body.includes(token));
    await assert.rejects(
      h.worker.evaluate((url, key) => callServer({
        task: "Contact fixture@example.test", privacy_budget: { level: 0 },
      }, url, key), plannerUrl, token),
      /blocked sensitive text/,
    );
    assert.equal(plannerRequests.length, 1, "blocked prompts never reach the planner");
    await h.worker.evaluate(() => AuditLog.record({
      task: "Inspect image fixture", url: "http://127.0.0.1:8000/api/agent/step",
      body: "{}", image: "data:image/png;base64,iVBORw0KGgo=", outcome: "ok",
    }));
    await panel.bringToFront();
    await panel.click("#tab-privacy");
    await panel.waitForSelector("#auditList details");
    assert.equal(await panel.$eval("#auditCount", (el) => el.textContent), "2");
    await panel.select("#auditPayload", "image");
    assert.equal(await panel.$eval("#auditCountVisible", (el) => el.textContent), "1 of 2 requests");
    assert.match(await panel.$eval("#auditList summary", (el) => el.textContent), /Inspect image fixture/);
    await panel.type("#auditSearch", "does not match");
    assert.match(await panel.$eval("#auditList", (el) => el.textContent), /No matching requests/);
    await panel.click("#clearAudit");
    await panel.waitForSelector("#auditStatus.success");
    assert.equal(await panel.$eval("#auditCount", (el) => el.textContent), "0");
    assert.deepEqual(errors, []);
    console.log("Chromium smoke passed for the built site, package downloads, panel, and local scan.");
  } finally {
    if (h) await h.close();
    fixture?.server.close();
    planner.close();
    preview.kill();
  }
}

async function testActiveChatMasking(browser, panel) {
  const chat = await browser.newPage();
  try {
    const fixtureUrl = "https://chatgpt.com/visionvault-local-test";
    await chat.setRequestInterception(true);
    chat.on("request", (request) => {
      if (request.url() === fixtureUrl) {
        void request.respond({ status: 200, contentType: "text/html", body: '<textarea id="prompt-textarea"></textarea>' });
      } else {
        void request.abort();
      }
    });
    await chat.goto(fixtureUrl);
    await chat.bringToFront();
    await panel.evaluate(() => {
      document.getElementById("tab-shield").click();
      document.getElementById("tool-text").click();
    });
    await panel.waitForFunction(() => !document.getElementById("chatDetectedCard").hidden, { polling: 100 });
    await panel.evaluate(() => document.getElementById("scrubActiveChatBtn").click());
    await panel.waitForFunction(() => document.getElementById("chatScrubStatus").classList.contains("error"), { polling: 100 });
    assert.match(await panel.$eval("#chatScrubStatus", (node) => node.textContent), /empty/);

    await chat.$eval("#prompt-textarea", (node) => { node.value = "Tell jordan@example.test about the update."; });
    await panel.evaluate(() => document.getElementById("scrubActiveChatBtn").click());
    await panel.waitForFunction(() => document.getElementById("chatScrubStatus").classList.contains("success"), { polling: 100 });
    assert.equal(await chat.$eval("#prompt-textarea", (node) => node.value), "Tell [EMAIL_1] about the update.");
  } finally {
    await chat.close();
  }
}

async function testVaultBackup(browser, panel) {
  const directory = await mkdtemp(path.join(tmpdir(), "visionvault-test-download-"));
  try {
    const cdp = await browser.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
    await panel.click("#tab-vault");
    await panel.type("#v-email", "vault-fixture@example.test");
    await panel.click("#saveVault");
    await panel.waitForSelector("#vaultStatus.success");
    await panel.click("#exportVaultBackupBtn");
    await panel.type("#vaultBackupPassphrase", "fixture-backup-passphrase");
    await panel.click("#vaultBackupConfirm");
    await panel.waitForFunction(() => !document.getElementById("vaultBackupDialog").open ||
      document.getElementById("vaultBackupStatus").classList.contains("error"));
    assert.equal(await panel.$eval("#vaultBackupDialog", node => node.open), false,
      await panel.$eval("#vaultBackupStatus", node => node.textContent));
    let filename;
    for (let attempt = 0; attempt < 30 && !filename; attempt++) {
      filename = (await readdir(directory)).find((name) => name.endsWith(".json"));
      if (!filename) await delay(150);
    }
    assert.ok(filename, "encrypted backup reached the browser download directory");
    const backup = await readFile(path.join(directory, filename), "utf8");
    assert.equal(JSON.parse(backup).algorithm, "AES-256-GCM");
    assert.doesNotMatch(backup, /vault-fixture@example/);

    await panel.$eval("#v-email", (node) => { node.value = ""; });
    await panel.type("#v-email", "temporary@example.test");
    await panel.click("#saveVault");
    await panel.waitForSelector("#vaultStatus.success");
    await panel.$eval("#vaultBackupFileInput", (node, data) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([data], "fixture-backup.json"));
      node.files = transfer.files;
      node.dispatchEvent(new Event("change"));
    }, backup);
    await panel.type("#vaultBackupPassphrase", "wrong-fixture-passphrase");
    await panel.click("#vaultBackupConfirm");
    await panel.waitForSelector("#vaultBackupStatus.error");
    assert.equal(await panel.$eval("#v-email", (node) => node.value), "temporary@example.test");
    await panel.$eval("#vaultBackupPassphrase", (node) => { node.value = ""; });
    await panel.type("#vaultBackupPassphrase", "fixture-backup-passphrase");
    await panel.click("#vaultBackupConfirm");
    await panel.waitForFunction(() => !document.getElementById("vaultBackupDialog").open);
    assert.equal(await panel.$eval("#v-email", (node) => node.value), "vault-fixture@example.test");
    const stored = await panel.evaluate(() => chrome.storage.local.get(["vault", "vaultEncrypted"]));
    assert.ok(stored.vaultEncrypted);
    assert.equal(stored.vault, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function dropShieldFile(panel, name, content) {
  await panel.$eval("#pdfDropZone", (drop, fileName, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], fileName));
    drop.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true }));
  }, name, content);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
