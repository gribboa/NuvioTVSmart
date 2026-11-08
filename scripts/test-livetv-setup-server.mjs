// Nuvio Live: the phone setup server (services/livetv-setup.cjs) and its loopback control route.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const setup = require("../services/livetv-setup.cjs");
const { createPluginHttpServer } = require("../services/plugin-http.cjs");

const newToken = () => randomBytes(32).toString("hex");
const xtream = {
  type: "xtream",
  name: "Test provider",
  server: "http://iptv.example.test:8080",
  username: "demo-user",
  password: "demo-pass"
};

async function startSession(token = newToken()) {
  const session = await setup.start({ token, labels: { title: "Add a provider", send: "Send" } });
  return { token, session, base: `http://127.0.0.1:${session.port}/${token}/` };
}

function post(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

test("serves the phone page only under the session token", async () => {
  const { token, session, base } = await startSession();
  try {
    assert.ok(session.port >= 2712 && session.port <= 2715);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Add a provider/);
    assert.match(html, new RegExp(`nonce="${token}"`));
    assert.equal(page.headers.get("cache-control"), "no-store");

    assert.equal((await fetch(`http://127.0.0.1:${session.port}/`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${session.port}/${newToken()}/`)).status, 404);
  } finally {
    setup.stop(token);
  }
});

test("keeps a valid submission until the app reads it", async () => {
  const { token, base } = await startSession();
  try {
    assert.deepEqual(setup.read(token), { revision: 0, submission: null });
    const response = await post(`${base}api/submit`, xtream);
    assert.equal(response.status, 200);
    assert.deepEqual(setup.read(token), { revision: 1, submission: xtream });
    assert.equal(setup.read(newToken()), null);
  } finally {
    setup.stop(token);
  }
});

test("rejects incomplete details, other origins and oversized bodies", async () => {
  const { token, base } = await startSession();
  try {
    const cases = [
      [{ type: "xtream", server: "", username: "a", password: "b" }, "missing_server"],
      [{ type: "xtream", server: "http://h.test", username: "a", password: "" }, "missing_login"],
      [{ type: "m3u", url: "ftp://h.test/list.m3u" }, "invalid_url"],
      [{ type: "m3u", url: "http://h.test/list.m3u", epgUrl: "guide.xml" }, "invalid_epg_url"],
      [{ type: "vod" }, "invalid_type"]
    ];
    for (const [body, error] of cases) {
      const response = await post(`${base}api/submit`, body);
      assert.equal(response.status, 400, error);
      assert.deepEqual(await response.json(), { error });
    }
    const foreign = await post(`${base}api/submit`, xtream, { Origin: "http://evil.test" });
    assert.equal(foreign.status, 403);
    const big = await post(
      `${base}api/submit`,
      JSON.stringify({ ...xtream, name: "x".repeat(20000) })
    );
    assert.equal(big.status, 413);
    assert.equal(setup.read(token).submission, null);
  } finally {
    setup.stop(token);
  }
});

test("accepts a pasted get.php link instead of username and password", () => {
  const { submission, error } = setup.readSubmission({
    type: "xtream",
    server: "http://h.test:80/get.php?username=u1&password=p1&type=m3u_plus"
  });
  assert.equal(error, undefined);
  assert.equal(submission.server, "http://h.test:80/get.php?username=u1&password=p1&type=m3u_plus");
});

test("accepts M3U with an optional guide link", () => {
  assert.deepEqual(setup.readSubmission({ type: "m3u", url: " http://h.test/a.m3u ", name: "" }), {
    submission: { type: "m3u", name: "", url: "http://h.test/a.m3u", epgUrl: "" }
  });
});

test("stop closes the listener and forgets the details", async () => {
  const { token, session, base } = await startSession();
  await post(`${base}api/submit`, xtream);
  assert.equal(setup.stop(newToken()), false);
  assert.equal(setup.stop(token), true);
  assert.equal(setup.read(token), null);
  await assert.rejects(fetch(`http://127.0.0.1:${session.port}/${token}/`));
});

test("rejects a malformed token", async () => {
  await assert.rejects(setup.start({ token: "short" }));
});

test("the plugin service controls the session over loopback", async () => {
  const pluginServer = createPluginHttpServer({ port: 0, logger: null });
  await new Promise((resolve) => pluginServer.listen(0, "127.0.0.1", resolve));
  const control = (body) =>
    post(`http://127.0.0.1:${pluginServer.address().port}/livetv-setup`, body).then(async (r) => ({
      status: r.status,
      body: await r.json()
    }));
  const token = newToken();
  try {
    const started = await control({ action: "start", token, labels: {} });
    assert.equal(started.status, 200);
    assert.equal(started.body.returnValue, true);
    assert.ok(started.body.port >= 2712);

    await post(`http://127.0.0.1:${started.body.port}/${token}/api/submit`, xtream);
    const read = await control({ action: "read", token });
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.submission, xtream);

    assert.deepEqual((await control({ action: "stop", token })).body, { returnValue: true });
    assert.equal((await control({ action: "read", token })).status, 410);
  } finally {
    setup.stop(token);
    await new Promise((resolve) => pluginServer.close(resolve));
  }
});
