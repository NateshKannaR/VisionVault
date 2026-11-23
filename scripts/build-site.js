"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { zipSync } = require("fflate");

const repo = path.resolve(__dirname, "..");
const extension = path.join(repo, "extension");
const dist = path.join(repo, "dist", "site");
const publicRoot = path.join(repo, "public");
const portalRoot = path.join(repo, "isro-panel");
const imagesDir = path.join(repo, "images");
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

// Copy static site files
for (const name of ["index.html", "assets/site.css", "assets/site.js"]) {
  if (fs.existsSync(path.join(publicRoot, name))) {
    fs.copyFileSync(path.join(publicRoot, name), path.join(dist, name));
  }
}
for (const name of ["icon32.png", "prompt-scrubber.js"]) {
  if (fs.existsSync(path.join(extension, name))) {
    fs.copyFileSync(path.join(extension, name), path.join(dist, "assets", name));
  }
}

// Copy portals & demo pages to dist
const portalPages = [
  "employee-portal.html",
  "hr-portal.html",
  "login.html",
  "isro-intranet-demo.html",
  "demo-page.html",
];
for (const page of portalPages) {
  const src = path.join(repo, page);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(dist, page));
    // Also support clean URL routes /<page>/ without .html
    const baseName = page.replace(/\.html$/, "");
    if (baseName !== "index" && baseName !== "demo-page") {
      fs.mkdirSync(path.join(dist, baseName), { recursive: true });
      fs.copyFileSync(src, path.join(dist, baseName, "index.html"));
    }
  }
}

// Copy mock-apps directory if present
const mockAppsDir = path.join(repo, "mock-apps");
if (fs.existsSync(mockAppsDir)) {
  fs.cpSync(mockAppsDir, path.join(dist, "mock-apps"), { recursive: true });
}

// Copy images
if (fs.existsSync(imagesDir)) {
  fs.mkdirSync(path.join(dist, "images"), { recursive: true });
  for (const file of fs.readdirSync(imagesDir)) {
    if (!file.startsWith(".")) {
      fs.copyFileSync(path.join(imagesDir, file), path.join(dist, "images", file));
    }
  }
}

// Generate chromium & firefox zip packages
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
  fs.cpSync(dist, publicRoot, { recursive: true });
  for (const name of ["index.html", "assets", "downloads", "login.html", "login"]) {
    fs.cpSync(path.join(dist, name), path.join(portalRoot, name), { recursive: true });
  }
  console.log("Updated the checked-in site in public and isro-panel.");
}
