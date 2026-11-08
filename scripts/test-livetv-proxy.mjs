// Nuvio Live: the loopback pass-through for IPTV requests (services/livetv-proxy.cjs).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

const require = createRequire(import.meta.url);
const { createPluginHttpServer } = require("../services/plugin-http.cjs");

let upstream;
let plugin;
let upstreamBase;
let pluginBase;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

before(async () => {
  upstream = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/ua" });
      response.end();
    } else if (request.url === "/ua") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(String(request.headers["user-agent"] || "none"));
    } else if (request.url === "/big") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(Buffer.alloc(8 * 1024 * 1024, 7));
    } else {
      response.writeHead(404);
      response.end("missing");
    }
  });
  upstreamBase = `http://127.0.0.1:${await listen(upstream)}`;
  plugin = createPluginHttpServer({ port: 0, logger: null });
  pluginBase = `http://127.0.0.1:${await listen(plugin)}`;
});

after(async () => {
  await new Promise((resolve) => upstream.close(resolve));
  await new Promise((resolve) => plugin.close(resolve));
});

const proxied = (path, ua = "") =>
  fetch(
    `${pluginBase}/livetv-proxy?url=${encodeURIComponent(upstreamBase + path)}${ua ? `&ua=${encodeURIComponent(ua)}` : ""}`
  );

test("passes the body through with CORS and the chosen User-Agent", async () => {
  const response = await proxied("/ua", "TestAgent/1.0");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(await response.text(), "TestAgent/1.0");
});

test("follows redirects", async () => {
  const response = await proxied("/redirect", "Agent/2");
  assert.equal(await response.text(), "Agent/2");
});

test("streams large bodies beyond the plugin fetch limit", async () => {
  const response = await proxied("/big");
  assert.equal((await response.arrayBuffer()).byteLength, 8 * 1024 * 1024);
});

test("keeps the provider's status", async () => {
  const response = await proxied("/nothing");
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-upstream-status"), "404");
});

test("rejects non-http links", async () => {
  const response = await fetch(
    `${pluginBase}/livetv-proxy?url=${encodeURIComponent("file:///etc/passwd")}`
  );
  assert.equal(response.status, 400);
});

test("serves the test pattern video, with byte ranges", async () => {
  const { size } = await import("node:fs").then((fs) =>
    fs.statSync(new URL("../services/livetv-test-pattern.mp4", import.meta.url))
  );
  const whole = await fetch(`${pluginBase}/livetv-test-pattern.mp4`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal((await whole.arrayBuffer()).byteLength, size);

  const part = await fetch(`${pluginBase}/livetv-test-pattern.mp4`, {
    headers: { Range: "bytes=10-19" }
  });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 10-19/${size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 10);

  const tail = await fetch(`${pluginBase}/livetv-test-pattern.mp4`, {
    headers: { Range: "bytes=-5" }
  });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 5);

  const beyond = await fetch(`${pluginBase}/livetv-test-pattern.mp4`, {
    headers: { Range: `bytes=${size + 10}-` }
  });
  assert.equal(beyond.status, 416);
});
