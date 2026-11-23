"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "visionvault-fixture-"));
  const server = spawn(process.execPath, ["isro-panel/server.js"], {
    env: { ...process.env, VISIONVAULT_DEMO_DATA: directory, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const [line] = await once(server.stdout, "data");
    const base = line.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert.ok(base, "fixture server reported its URL");
    const get = (route, cookie) => fetch(base + route, {
      redirect: "manual", headers: cookie ? { Cookie: cookie } : {},
    });
    const post = (route, data, cookie) => fetch(base + route, {
      method: "POST", body: JSON.stringify(data),
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    });
    const login = (username, password) => post("/api/login", { username, password });

    const homepage = await get("/");
    assert.match(await homepage.text(), /id="lab-title"/);
    for (const [route, type] of [
      ["/assets/site.css", "text/css; charset=utf-8"],
      ["/assets/site.js", "text/javascript; charset=utf-8"],
      ["/assets/prompt-scrubber.js", "text/javascript; charset=utf-8"],
      ["/downloads/visionvault-chromium.zip", "application/zip"],
    ]) {
      const response = await fetch(base + route, { method: "HEAD" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), type);
    }
    assert.equal((await get("/login.html")).status, 200);
    assert.equal((await get("/employee-portal.html")).status, 303);
    assert.equal((await get("/api/state")).status, 401);
    assert.equal((await get("/data/prototype-state.json")).status, 404);
    assert.equal((await get("/server.js")).status, 404);
    assert.equal((await login("natesh", "incorrect fixture password")).status, 401);

    const hrLogin = await login("hr.admin", "ISRO-HR-DEMO-2026");
    const employeeLogin = await login("natesh", "ISRO-EMP-DEMO-2026");
    const hr = hrLogin.headers.get("set-cookie")?.split(";")[0];
    const employee = employeeLogin.headers.get("set-cookie")?.split(";")[0];
    assert.ok(hr && employee);
    assert.equal((await get("/employee-portal.html", employee)).status, 200);
    assert.equal((await get("/hr-portal.html", employee)).status, 303);
    assert.equal((await get("/hr-portal.html", hr)).status, 200);
    assert.equal((await post("/api/missions", { satellite_name: "Fixture" }, employee)).status, 403);
    assert.equal((await post("/api/forms", { formId: "hr" }, employee)).status, 201);
    assert.equal((await post("/api/messages", {
      empId: "ISRO-10101", text: "A synthetic demo message",
    }, hr)).status, 201);
    const fixture = await (await get("/api/state?emp=RK", employee)).json();
    assert.deepEqual(Object.keys(fixture.forms), ["NK_hr"]);
    assert.ok(fixture.messages.length > 1 && fixture.messages.every((message) => message.empInitials === "NK"));
    assert.equal((await post("/api/logout", {}, employee)).status, 200);
    assert.equal((await get("/api/me", employee)).status, 401);
    console.log("Demo portal smoke passed for sign-in, role access, messages, forms, and sign-out.");
  } finally {
    server.kill();
    if (server.exitCode === null && server.signalCode === null) await once(server, "exit");
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
