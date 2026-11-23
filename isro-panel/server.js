const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.VISIONVAULT_DEMO_DATA || path.join(ROOT, "data"));
const DATA_FILE = path.join(DATA_DIR, "prototype-state.json");

const EMPLOYEES = [
  { name: "Natesh Kanna R", id: "ISRO-10101", dept: "Flight Software & Spacecraft Control", initials: "NK", station: "MCF Hassan", email: "natesh.kanna@isro.gov.in", role: "Lead Flight Software Architect", phone: "+91 94440 12890", image: "images/emp-natesh.jpeg" },
  { name: "Rajesh Kumar", id: "ISRO-10234", dept: "Propulsion Systems (MCF)", initials: "RK", station: "MCF Hassan", email: "rajesh.kumar@isro.gov.in", role: "Mission Controller — Propulsion", phone: "+91 80 2217 2296", image: "images/emp-kavita.jpeg" },
  { name: "Dr. Ananya Sen", id: "ISRO-10482", dept: "Satellite Navigation (URSC)", initials: "AS", station: "URSC Bengaluru", email: "ananya.sen@isro.gov.in", role: "Lead Guidance & Astrodynamics", phone: "+91 80 2508 4100", image: "images/emp-ananya.jpeg" },
  { name: "Vikramaditya Hegde", id: "ISRO-10519", dept: "Cryogenic Systems (LPSC)", initials: "VH", station: "LPSC Valiamala", email: "v.hegde@isro.gov.in", role: "Cryogenic Telemetry Specialist", phone: "+91 471 256 7100", image: "images/emp-vikram.jpeg" },
  { name: "Kavita Krishnan", id: "ISRO-10640", dept: "Electro-Optics & Payloads (SAC)", initials: "KK", station: "SAC Ahmedabad", email: "k.krishnan@isro.gov.in", role: "Optical Remote Sensing Lead", phone: "+91 79 2691 3000", image: "images/emp-rajesh.jpeg" },
  { name: "Rizwana Parveen", id: "ISRO-10788", dept: "Deep Space Tracking (ISTRAC)", initials: "RP", station: "ISTRAC Bengaluru", email: "rizwana.parveen@isro.gov.in", role: "Orbital Analyst & Remote Sensing", phone: "+91 80 2839 5200", image: "images/emp-rizwan.jpeg" }
];

const USERS = {
  "hr.admin": { password: "ISRO-HR-DEMO-2026", role: "HR", name: "Priya Menon" },
  "natesh": { password: "ISRO-EMP-DEMO-2026", role: "EMPLOYEE", name: "Natesh Kanna R", empId: "ISRO-10101", initials: "NK" },
  "nkanna": { password: "ISRO-EMP-DEMO-2026", role: "EMPLOYEE", name: "Natesh Kanna R", empId: "ISRO-10101", initials: "NK" },
  "rkumar": { password: "ISRO-EMP-DEMO-2026", role: "EMPLOYEE", name: "Rajesh Kumar", empId: "ISRO-10234", initials: "RK" },
  "rajesh": { password: "ISRO-EMP-DEMO-2026", role: "EMPLOYEE", name: "Rajesh Kumar", empId: "ISRO-10234", initials: "RK" },
  "asen": { password: "ISRO-EMP-DEMO-2026", role: "EMPLOYEE", name: "Dr. Ananya Sen", empId: "ISRO-10482", initials: "AS" },
  "vhegde": { password: "ISRO-EMP-DEMO-2026", role: "EMPLOYEE", name: "Vikramaditya Hegde", empId: "ISRO-10519", initials: "VH" },
  "kkrishnan": { password: "ISRO-EMP-DEMO-2026", role: "EMPLOYEE", name: "Kavita Krishnan", empId: "ISRO-10640", initials: "KK" },
  "rizwana": { password: "ISRO-EMP-DEMO-2026", role: "EMPLOYEE", name: "Rizwana Parveen", empId: "ISRO-10788", initials: "RP" },
  "rparveen": { password: "ISRO-EMP-DEMO-2026", role: "EMPLOYEE", name: "Rizwana Parveen", empId: "ISRO-10788", initials: "RP" },
  "mrizwan": { password: "ISRO-EMP-DEMO-2026", role: "EMPLOYEE", name: "Rizwana Parveen", empId: "ISRO-10788", initials: "RP" }
};
const sessions = new Map();
const SESSION_SECONDS = 8 * 60 * 60;
const MIME = {
  "": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".zip": "application/zip",
};
const PAGES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/login", "login.html"],
  ["/login.html", "login.html"],
  ["/employee-portal", "employee-portal.html"],
  ["/employee-portal.html", "employee-portal.html"],
  ["/hr-portal", "hr-portal.html"],
  ["/hr-portal.html", "hr-portal.html"],
  ["/isro-intranet-demo", "isro-intranet-demo.html"],
  ["/isro-intranet-demo.html", "isro-intranet-demo.html"],
]);

const SITE_FILES = new Set([
  "/assets/icon32.png",
  "/assets/site.css",
  "/assets/site.js",
  "/assets/prompt-scrubber.js",
  "/downloads/SHA256SUMS",
  "/downloads/visionvault-chromium.zip",
  "/downloads/visionvault-firefox.zip",
]);

const DEFAULT_MISSIONS = [
  {
    satellite_name: "Chandrayaan-3 Propulsion", mission_id: "CH-3 / PR-01", operator: "Natesh Kanna R",
    launch_date: "2023-07-14", orbit_type: "Lunar Polar Orbit", orbital_inclination: "90.00°",
    apogee: "100 km (Lunar)", perigee: "100 km (Lunar)", ground_station_freq: "8.400 GHz (X-Band Deep Space)",
    encryption_key_ref: "ISRO-KMS-EK-2026-07741",
    tle_line_1: "1 57320U 23098A   26248.11029481 +.00000210  00000-0  10000-4 0  9997",
    tle_line_2: "2 57320  89.9410 112.4410 0010410 270.1200  90.4100  0.08331400  8821",
    name: "Natesh Kanna R", username: "natesh", email: "natesh.kanna@isro.gov.in", phone: "+91 94440 12890",
    company: "ISRO Master Control Facility (MCF)", zip: "573201", address: "MCF Salgame Road, Hassan, Karnataka, India",
    about: "Lead Flight Software Architect — Spacecraft Guidance & Autonomous Telemetry", status: "Operational", vehicle: "LVM3-M4", dept: "Flight Software & Spacecraft Control",
    empId: "ISRO-10101", desc: "Lunar orbiter and propulsion module maintaining high-gain autonomous telemetry link."
  },
  {
    satellite_name: "INSAT-4B", mission_id: "INSAT-4B / M-201", operator: "Rajesh Kumar",
    launch_date: "2007-03-12", orbit_type: "Geostationary (GEO)", orbital_inclination: "0.05°",
    apogee: "35,786 km", perigee: "35,786 km", ground_station_freq: "14.250 GHz (Ku-Band)",
    encryption_key_ref: "ISRO-KMS-EK-2026-04871",
    tle_line_1: "1 30798U 07007A   26248.51249811 -.00000124  00000-0  10000-4 0  9991",
    tle_line_2: "2 30798   0.0512  87.2145 0001248 145.2104 214.8901  1.00273412 71234",
    name: "Rajesh Kumar", username: "rkumar", email: "rajesh.kumar@isro.gov.in", phone: "+91 80 2217 2296",
    company: "ISRO Master Control Facility (MCF)", zip: "573201", address: "MCF Salgame Road, Hassan, Karnataka, India",
    about: "Mission Controller — Propulsion Systems", status: "Operational", vehicle: "PSLV-C58", dept: "Propulsion Systems (MCF)",
    empId: "ISRO-10234", desc: "Geostationary communication satellite for C-band and Ku-band telemetry."
  },
  {
    satellite_name: "NavIC IRNSS-1J", mission_id: "NAVIC-1J / N-504", operator: "Dr. Ananya Sen",
    launch_date: "2023-05-29", orbit_type: "Geosynchronous (GSO)", orbital_inclination: "29.00°",
    apogee: "36,000 km", perigee: "250 km", ground_station_freq: "L5 / S-Band (1176.45 MHz)",
    encryption_key_ref: "ISRO-KMS-EK-2026-09122",
    tle_line_1: "1 43286U 18036A   26248.42109844 +.00000018  00000-0  00000-0 0  9993",
    tle_line_2: "2 43286  28.9812  45.1204 0002140 180.1240 179.8800  1.00271400  3210",
    name: "Dr. Ananya Sen", username: "asen", email: "ananya.sen@isro.gov.in", phone: "+91 80 2508 4100",
    company: "U R Rao Satellite Centre (URSC)", zip: "560017", address: "HAL Airport Road, Vimanapura, Bengaluru, Karnataka",
    about: "Lead Guidance & Astrodynamics — Navigation Cell", status: "Operational", vehicle: "GSLV-F12", dept: "Satellite Navigation (URSC)",
    empId: "ISRO-10482", desc: "Regional satellite navigation constellation satellite with atomic clock sync."
  },
  {
    satellite_name: "LVM3-M4 Cryogenic Stage", mission_id: "LVM3-C25 / CRY-03", operator: "Vikramaditya Hegde",
    launch_date: "2023-07-14", orbit_type: "Translunar Injection", orbital_inclination: "21.50°",
    apogee: "36,500 km", perigee: "170 km", ground_station_freq: "2.250 GHz (S-Band Telemetry)",
    encryption_key_ref: "ISRO-KMS-EK-2026-05523",
    tle_line_1: "1 57321U 23098B   26248.21029481 +.00000180  00000-0  10000-4 0  9995",
    tle_line_2: "2 57321  21.4910 140.2100 0012410 180.1200 180.4100  1.04214000  6612",
    name: "Vikramaditya Hegde", username: "vhegde", email: "v.hegde@isro.gov.in", phone: "+91 471 256 7100",
    company: "Liquid Propulsion Systems Centre (LPSC)", zip: "695547", address: "Valiamala, Thiruvananthapuram, Kerala, India",
    about: "Cryogenic Telemetry Specialist — Liquid Propulsion Directorate", status: "Operational", vehicle: "LVM3-M4", dept: "Cryogenic Systems (LPSC)",
    empId: "ISRO-10519", desc: "C25 cryogenic upper stage telemetry and LOX/LH2 tank monitoring."
  },
  {
    satellite_name: "Aditya-L1 Primary Optics", mission_id: "ADITYA-L1 / SOL-01", operator: "Kavita Krishnan",
    launch_date: "2023-09-02", orbit_type: "Halo Orbit (Sun-Earth L1)", orbital_inclination: "0.00°",
    apogee: "1.5 Million km", perigee: "1.5 Million km", ground_station_freq: "2.200 GHz (S-Band Spacecraft)",
    encryption_key_ref: "ISRO-KMS-EK-2026-03319",
    tle_line_1: "1 57714U 23132A   26248.33019481 +.00000000  00000-0  00000-0 0  9990",
    tle_line_2: "2 57714   0.0010 320.1410 0000010   0.0000   0.0000  0.00551000  1204",
    name: "Kavita Krishnan", username: "kkrishnan", email: "k.krishnan@isro.gov.in", phone: "+91 79 2691 3000",
    company: "Space Applications Centre (SAC)", zip: "380015", address: "Ambawadi Vistar, Ahmedabad, Gujarat, India",
    about: "Optical Remote Sensing Lead — Solar Coronagraph Team", status: "Operational", vehicle: "PSLV-C57", dept: "Electro-Optics & Payloads (SAC)",
    empId: "ISRO-10640", desc: "Solar coronagraph and multi-spectral telescope positioned at Sun-Earth L1."
  },
  {
    satellite_name: "EOS-08 Earth Observation", mission_id: "EOS-08 / EO-808", operator: "Rizwana Parveen",
    launch_date: "2024-08-16", orbit_type: "Circular Low Earth Orbit (LEO)", orbital_inclination: "37.40°",
    apogee: "475 km", perigee: "475 km", ground_station_freq: "8.025 GHz (X-Band Downlink)",
    encryption_key_ref: "ISRO-KMS-EK-2026-01188",
    tle_line_1: "1 60492U 24147A   26248.91024810 +.00001420  00000-0  12480-4 0  9992",
    tle_line_2: "2 60492  37.4012 189.1245 0008410 120.4410 239.8100 15.24102810  5102",
    name: "Rizwana Parveen", username: "rparveen", email: "rizwana.parveen@isro.gov.in", phone: "+91 80 2839 5200",
    company: "ISRO Telemetry, Tracking and Command Network (ISTRAC)", zip: "560058", address: "Plot No. 12 & 13, 3rd Main, 2nd Phase, Peenya, Bengaluru",
    about: "Orbital Analyst & Remote Sensing — Earth Observation Directorate", status: "Operational", vehicle: "SSLV-D3", dept: "Deep Space Tracking (ISTRAC)",
    empId: "ISRO-10788", desc: "Next-generation Earth observation microsatellite with thermal infrared imaging."
  }
];

// Shared by the synthetic demo clients. This key only supports the local fixture.
const KEY_RAW = "ISRO-SECURE-2024-AES256-CHANNEL!";

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(KEY_RAW, "utf8"), iv);
  const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}
function decrypt(b64) {
  try {
    const b = Buffer.from(b64, "base64");
    const iv = b.subarray(0, 12);
    const tag = b.subarray(b.length - 16);
    const ct = b.subarray(12, b.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(KEY_RAW, "utf8"), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (err) {
    return "[decryption failed]";
  }
}

function createDefaultMessages() {
  return DEFAULT_MISSIONS.map((m, idx) => {
    const payload = JSON.stringify({
      type: "VAULT_MISSION",
      vault: m,
      timestamp: new Date().toISOString()
    });
    return {
      id: `msg-mission-init-${idx + 1}`,
      empId: m.empId,
      empInitials: EMPLOYEES.find(e => e.id === m.empId)?.initials || "NK",
      from: "HR",
      time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
      ciphertext: encrypt(payload),
      clientEncrypted: true
    };
  });
}

function writeState(next) {
  const staged = DATA_FILE + ".tmp";
  fs.writeFileSync(staged, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(staged, DATA_FILE);
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(DATA_FILE)) {
  writeState({ missions: DEFAULT_MISSIONS, messages: createDefaultMessages(), forms: {} });
}
let state = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

function commit(next) {
  writeState(next);
  state = next;
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw Object.assign(new Error("Expected application/json"), { status: 415 });
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      req.resume();
      throw Object.assign(new Error("Request exceeds 64 KiB"), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error("Invalid JSON object"), { status: 400 });
  }
}

function cookieToken(req) {
  return (req.headers.cookie || "").match(/(?:^|;\s*)isro_session=([a-f0-9]{64})(?:;|$)/)?.[1];
}

function sessionFrom(req) {
  const token = cookieToken(req);
  const session = sessions.get(token);
  if (!session || session.expires <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session.user;
}

function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
  const page = PAGES.get(pathname);
  if (page === "hr-portal.html" || page === "employee-portal.html") {
    const user = sessionFrom(req);
    const role = page === "hr-portal.html" ? "HR" : "EMPLOYEE";
    if (user?.role !== role) {
      res.writeHead(303, { Location: "/login.html", "Cache-Control": "no-store" }).end();
      return;
    }
  }
  let file = page ? path.join(ROOT, page) : null;
  if (pathname === "/visionvault-extension.zip") {
    file = path.join(ROOT, "downloads", "visionvault-chromium.zip");
  } else if (SITE_FILES.has(pathname)) {
    file = path.join(ROOT, pathname.slice(1));
  } else if (pathname.startsWith("/images/")) {
    const image = pathname.slice("/images/".length);
    if (image && path.basename(image) === image && /\.(?:jpe?g|mp4)$/i.test(image)) {
      file = path.join(ROOT, "images", image);
    }
  }
  if (!file || !fs.existsSync(file)) return json(res, 404, { error: "Not found" });
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file).toLowerCase()],
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function messagesFor(initials) {
  return state.messages.filter((message) => !initials || message.empInitials === initials)
    .map(({ id, empId, empInitials, from, time, ciphertext }) => ({
      id, empId, empInitials, from, time, enc: ciphertext,
    }));
}

const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  try {
    const host = req.headers.host;
    if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host || "")) {
      return json(res, 403, { error: "Use the localhost demo address" });
    }
    const origin = "http://" + host;
    const url = new URL(req.url, origin);
    const pathname = decodeURIComponent(url.pathname);
    if (url.origin !== origin || (req.headers.origin && req.headers.origin !== origin)) {
      return json(res, 403, { error: "Cross-origin requests are disabled" });
    }
    if (!pathname.startsWith("/api/")) return serveStatic(req, res, pathname);

    if (pathname === "/api/health" && req.method === "GET") {
      return json(res, 200, { ok: true, service: "visionvault-local-demo" });
    }
    if (pathname === "/api/login" && req.method === "POST") {
      const input = await body(req);
      const username = typeof input.username === "string" ? input.username.toLowerCase() : "";
      const account = Object.hasOwn(USERS, username) ? USERS[username] : null;
      if (!account || account.password !== input.password) {
        return json(res, 401, { error: "Invalid demo username or password" });
      }

      for (const [key, session] of sessions) {
        if (session.expires <= Date.now()) sessions.delete(key);
      }
      if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
      sessions.delete(cookieToken(req));
      const token = crypto.randomBytes(32).toString("hex");
      const { role, name, empId, initials } = account;
      const user = { username, role, name, empId, initials };
      sessions.set(token, { user, expires: Date.now() + SESSION_SECONDS * 1000 });
      return json(res, 200, user, {
        "Set-Cookie": `isro_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`,
      });
    }
    if (pathname === "/api/logout" && req.method === "POST") {
      sessions.delete(cookieToken(req));
      return json(res, 200, { ok: true }, {
        "Set-Cookie": "isro_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      });
    }

    const user = sessionFrom(req);
    if (!user) return json(res, 401, { error: "Demo sign-in required" });
    if (pathname === "/api/me" && req.method === "GET") return json(res, 200, user);
    const employee = user.role === "EMPLOYEE";
    const filter = employee ? user.initials : url.searchParams.get("emp");
    if (pathname === "/api/state" && req.method === "GET") {
      return json(res, 200, {
        user,
        missions: employee ? state.missions.filter((mission) => mission.empId === user.empId) : state.missions,
        employees: employee ? EMPLOYEES.filter((person) => person.id === user.empId) : EMPLOYEES,
        messages: messagesFor(filter),
        forms: Object.fromEntries(Object.entries(state.forms).filter(([key]) => !filter || key.startsWith(filter + "_"))),
      });
    }
    if (pathname === "/api/messages" && req.method === "POST") {
      const input = await body(req);
      const recipient = EMPLOYEES.find((person) => person.id === (employee ? user.empId : input.empId));
      const text = typeof input.text === "string" ? input.text.trim() : "";
      const enc = typeof input.enc === "string" ? input.enc : "";
      if (!recipient || (!text && !enc) || text.length > 8000 || enc.length > 20000) {
        return json(res, 400, { error: "Provide a demo recipient and a message up to 8,000 characters" });
      }
      if (enc && decrypt(enc) === "[decryption failed]") {
        return json(res, 400, { error: "Invalid demo message encoding" });
      }
      const message = {
        id: crypto.randomUUID(),
        empId: recipient.id,
        empInitials: recipient.initials,
        from: employee ? "EMP" : "HR",
        time: new Date().toISOString(),
        ciphertext: enc || encrypt(text),
      };
      commit({ ...state, messages: [...state.messages, message].slice(-500) });
      return json(res, 201, { id: message.id, from: message.from, time: message.time });
    }
    if (pathname === "/api/messages" && req.method === "DELETE") {
      commit({ ...state, messages: filter ? state.messages.filter((message) => message.empInitials !== filter) : [] });
      return json(res, 200, { ok: true });
    }
    if (pathname === "/api/forms" && req.method === "POST") {
      const input = await body(req);
      const initials = employee ? user.initials : input.empInitials;
      const formIds = ["hr", "payroll", "it", "housing", "medical"];
      if (!formIds.includes(input.formId) || !EMPLOYEES.some((person) => person.initials === initials)) {
        return json(res, 400, { error: "Unknown demo form or employee" });
      }
      const forms = { ...state.forms, [`${initials}_${input.formId}`]: new Date().toISOString() };
      commit({ ...state, forms });
      return json(res, 201, { ok: true });
    }
    if (pathname === "/api/forms" && req.method === "DELETE") {
      const forms = filter
        ? Object.fromEntries(Object.entries(state.forms).filter(([key]) => !key.startsWith(filter + "_")))
        : {};
      commit({ ...state, forms });
      return json(res, 200, { ok: true });
    }
    if (pathname === "/api/missions" && req.method === "POST") {
      if (employee) return json(res, 403, { error: "This action requires the demo HR role" });
      const input = await body(req);
      const satelliteName = typeof input.satellite_name === "string" ? input.satellite_name.trim() : "";
      if (!satelliteName || satelliteName.length > 160) return json(res, 400, { error: "Satellite name is required" });
      const mission = { ...input, satellite_name: satelliteName, empId: input.empId || "ISRO-10101" };
      commit({ ...state, missions: [...state.missions, mission].slice(-500) });
      return json(res, 201, mission);
    }
    return json(res, 404, { error: "API route not found" });
  } catch (error) {
    if (res.headersSent) return res.destroy();
    if (error instanceof URIError) return json(res, 400, { error: "Invalid URL" });
    return json(res, error.status || 500, { error: error.status ? error.message : "Demo server error" });
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`VisionVault fixture portal at http://127.0.0.1:${server.address().port}/login.html`);
});
