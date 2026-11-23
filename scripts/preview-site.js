"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "../dist/site");
const port = Number(process.env.PORT || 8080);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".zip": "application/zip",
};

if (!fs.existsSync(path.join(root, "index.html"))) {
  console.error("Run npm run build before starting the preview.");
  process.exit(1);
}

const server = http.createServer((request, response) => {
  const respond = (status) => { response.writeHead(status).end(); };
  if (request.method !== "GET" && request.method !== "HEAD") return respond(405);
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    return respond(400);
  }
  const file = path.resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(root + path.sep)) return respond(404);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return respond(404);
  const stream = fs.createReadStream(file);
  stream.once("error", () => respond(404));
  stream.once("open", () => {
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(file)] || "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") {
      stream.destroy();
      response.end();
    } else {
      stream.pipe(response);
    }
  });
});
server.listen(port, "127.0.0.1", () => {
  console.log(`VisionVault preview at http://127.0.0.1:${server.address().port}`);
});
