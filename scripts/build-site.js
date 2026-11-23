"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { zipSync } = require("fflate");

const repo = path.resolve(__dirname, "..");
const extension = path.join(repo, "extension");
const dist = path.join(repo, "dist", "site");
const publicRoot = path.join(repo, "public");
const date = new Date(2000, 0, 1);

function browserFiles(directory, relative = "") {
  const files = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    const name = relative + entry.name;
    if (entry.isDirectory()) {
      Object.assign(files, browserFiles(absolute, name + "/"));
    } else if (!/\.(?:md|py)$|^manifest\.firefox\.json$/.test(name)) {
      files[name] = fs.readFileSync(absolute);
    }
  }
  return files;
}

const files = browserFiles(extension);
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
fs.mkdirSync(path.join(dist, "downloads"), { recursive: true });
for (const name of ["index.html", "assets/site.css", "assets/site.js"]) {
  fs.copyFileSync(path.join(publicRoot, name), path.join(dist, name));
}
for (const name of ["icon32.png", "prompt-scrubber.js"]) {
  fs.copyFileSync(path.join(extension, name), path.join(dist, "assets", name));
}

const hashes = [];
for (const browser of ["chromium", "firefox"]) {
  const manifest = browser === "firefox" ? "manifest.firefox.json" : "manifest.json";
  const archive = zipSync({
    ...files,
    "manifest.json": fs.readFileSync(path.join(extension, manifest)),
  }, { level: 6, mtime: date });
  const filename = `visionvault-${browser}.zip`;
  fs.writeFileSync(path.join(dist, "downloads", filename), archive);
  hashes.push(createHash("sha256").update(archive).digest("hex") + "  " + filename);
}
fs.writeFileSync(path.join(dist, "downloads", "SHA256SUMS"), hashes.join("\n") + "\n");
console.log("Built static site and Chromium/Firefox packages in dist/site.");

if (process.argv.includes("--update-public")) {
  for (const directory of ["assets", "downloads"]) {
    fs.cpSync(path.join(dist, directory), path.join(publicRoot, directory), { recursive: true });
  }
  console.log("Updated the checked-in Vercel site in public.");
}
