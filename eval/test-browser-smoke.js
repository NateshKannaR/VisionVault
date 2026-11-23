"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
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
      assert.ok(files["popup.html"] && files["planner/connection.js"]);
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
      taskHistory: [{ task: "Find the sample form", ts: Date.now(), steps: 1, ok: true }],
    }));
    await panel.click("#tab-history");
    await panel.waitForSelector("button.history-item");
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

    const sample = await h.browser.newPage();
    await sample.goto(fixture.baseUrl + "/pages/signup-form.html");
    await sample.bringToFront();
    const [fixtureTab] = await h.worker.evaluate(() => chrome.tabs.query({ active: true }));
    const scanned = await h.worker.evaluate((tabId) => phaseScan("Fill the form", tabId, false), fixtureTab.id);
    assert.ok(scanned.piiCount > 0, "scan detects regions on the signup fixture");
    assert.ok(scanned.markCount > 0, "scan detects interactive controls");
    assert.match(scanned.preview, /^data:image\/png/);
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
    assert.deepEqual(errors, []);
    console.log("Chromium smoke passed for the built site, package downloads, panel, and local scan.");
  } finally {
    if (h) await h.close();
    fixture?.server.close();
    planner.close();
    preview.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
