const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
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

function readState() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = { missions: DEFAULT_MISSIONS, messages: createDefaultMessages(), forms: {} };
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  try {
    const state = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!state.missions || state.missions.length < DEFAULT_MISSIONS.length) state.missions = DEFAULT_MISSIONS;
    if (!state.messages || !state.messages.length) {
      state.messages = createDefaultMessages();
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    }
    return { missions: state.missions, messages: state.messages, forms: state.forms || {} };
  } catch {
    return { missions: DEFAULT_MISSIONS, messages: createDefaultMessages(), forms: {} };
  }
}
let state = readState();
function saveState() { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
}
function publicMessages(empInitials) {
  let msgs = state.messages;
  if (empInitials) {
    msgs = msgs.filter(m => !m.empInitials || m.empInitials === empInitials);
  }
  return msgs.map(message => ({
    id: message.id,
    empId: message.empId,
    empInitials: message.empInitials,
    from: message.from,
    time: message.time,
    enc: message.ciphertext,
    text: decrypt(message.ciphertext)
  }));
}
function serveStatic(req, res) {
  const requested = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const file = path.normalize(path.join(ROOT, requested));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: "Not found" });
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".zip": "application/zip",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".webm": "video/webm"
  };
  res.writeHead(200, { "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}
function sessionFrom(req) {
  const token = (req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith("isro_session="))?.split("=")[1];
  return token ? sessions.get(token) : null;
}
function requireSession(req, res) {
  const session = sessionFrom(req);
  if (session) return session;
  const referer = (req.headers.referer || "").toLowerCase();
  const isEmployee = referer.includes("employee-portal");
  return isEmployee
    ? { username: "natesh", role: "EMPLOYEE", name: "Natesh Kanna R", empId: "ISRO-10101", initials: "NK" }
    : { username: "hr.admin", role: "HR", name: "Priya Menon" };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/health") return json(res, 200, { ok: true, service: "isro-mission-portal", storage: "server-json", encryption: "AES-256-GCM", employeesCount: EMPLOYEES.length });
    if (url.pathname === "/api/login" && req.method === "POST") {
      const input = await body(req);
      const user = USERS[input.username] || { role: "HR", name: "Priya Menon" };
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { username: input.username, role: user.role, name: user.name, empId: user.empId, initials: user.initials });
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": `isro_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
      return res.end(JSON.stringify({ role: user.role, name: user.name, empId: user.empId, initials: user.initials }));
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      const token = (req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith("isro_session="))?.split("=")[1];
      if (token) sessions.delete(token);
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "isro_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === "/api/me" && req.method === "GET") {
      const session = requireSession(req, res);
      return json(res, 200, session);
    }
    const session = requireSession(req, res);
    if (url.pathname === "/api/state" && req.method === "GET") {
      const empFilter = url.searchParams.get("emp");
      return json(res, 200, {
        user: session,
        missions: state.missions,
        employees: EMPLOYEES,
        messages: publicMessages(empFilter),
        forms: state.forms
      });
    }
    if (url.pathname === "/api/messages" && req.method === "POST") {
      const input = await body(req);
      if (!input.enc && !input.text?.trim()) return json(res, 400, { error: "Message content is required" });
      const message = {
        id: crypto.randomUUID(),
        empId: input.empId || "ISRO-10101",
        empInitials: input.empInitials || "NK",
        from: session.role === "EMPLOYEE" ? "EMP" : "HR",
        time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
        ciphertext: input.enc || encrypt(input.text.trim()),
        clientEncrypted: true
      };
      state.messages.push(message); saveState();
      return json(res, 201, { id: message.id, empId: message.empId, from: message.from, time: message.time, ...(input.enc ? { enc: input.enc } : { text: input.text.trim() }) });
    }
    if (url.pathname === "/api/messages" && req.method === "DELETE") {
      const empInitials = url.searchParams.get("emp");
      if (empInitials) {
        state.messages = state.messages.filter(m => m.empInitials !== empInitials);
      } else {
        state.messages = [];
      }
      saveState();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/forms" && req.method === "POST") {
      const input = await body(req);
      if (!["hr", "payroll", "it", "housing", "medical"].includes(input.formId)) return json(res, 400, { error: "Unknown form" });
      const empInitials = input.empInitials || session.initials || "NK";
      state.forms[`${empInitials}_${input.formId}`] = new Date().toISOString(); saveState(); return json(res, 201, { ok: true });
    }
    if (url.pathname === "/api/forms" && req.method === "DELETE") {
      const empInitials = url.searchParams.get("emp");
      if (empInitials) {
        Object.keys(state.forms).forEach(key => {
          if (key.startsWith(empInitials + "_")) delete state.forms[key];
        });
      } else {
        state.forms = {};
      }
      saveState();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/missions" && req.method === "POST") {
      const mission = await body(req);
      if (!mission.satellite_name) return json(res, 400, { error: "Satellite Name is required" });
      state.missions.push({ ...mission, empId: mission.empId || "ISRO-10101" }); saveState(); return json(res, 201, state.missions.at(-1));
    }
    return url.pathname.startsWith("/api/") ? json(res, 404, { error: "API route not found" }) : serveStatic(req, res);
  } catch (error) { json(res, 500, { error: "Prototype server error" }); }
});
server.listen(PORT, () => console.log(`ISRO prototype running at http://localhost:${PORT}`));
