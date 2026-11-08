// The keep-awake wrapper around Ambient Mode's tick, with the app's imports stubbed out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function loadModule() {
  const source = await readFile(new URL("./liveTvKeepAwake.js", import.meta.url), "utf8");
  const body = source
    .replace(/\r\n/g, "\n")
    .replace(/^import .*$/gm, "")
    .concat(
      "\nexport const __stubs = { AmbientMode: null, Router: {}, isLivePreviewPlaying: () => false };\n"
    );
  // The stripped module refers to these names; give them module-level bindings.
  const wired = `const AmbientMode = null; const Router = {}; const isLivePreviewPlaying = () => false;\n${body}`;
  return import(`data:text/javascript,${encodeURIComponent(wired)}`);
}

function fakeAmbient() {
  return {
    ticks: 0,
    lastInteraction: 0,
    showing: true,
    dismissed: 0,
    blocked: null,
    tick() {
      this.ticks += 1;
    },
    dismiss() {
      this.dismissed += 1;
      this.showing = false;
    },
    setTizenScreenSaverBlocked(value) {
      this.blocked = value;
    }
  };
}

test("while live TV plays, the screensaver stays away and its idle timer restarts", async () => {
  const { installLiveKeepAwake } = await loadModule();
  const ambient = fakeAmbient();
  installLiveKeepAwake(ambient, () => true);
  ambient.tick();
  assert.equal(ambient.ticks, 0);
  assert.equal(ambient.dismissed, 1);
  assert.equal(ambient.blocked, true);
  assert.ok(ambient.lastInteraction > 0);
});

test("otherwise Ambient Mode runs as usual", async () => {
  const { installLiveKeepAwake } = await loadModule();
  const ambient = fakeAmbient();
  installLiveKeepAwake(ambient, () => false);
  ambient.tick();
  assert.equal(ambient.ticks, 1);
  assert.equal(ambient.dismissed, 0);
});

test("installs once, and a failing check falls back to the usual tick", async () => {
  const { installLiveKeepAwake } = await loadModule();
  const ambient = fakeAmbient();
  installLiveKeepAwake(ambient, () => {
    throw new Error("boom");
  });
  const wrapped = ambient.tick;
  installLiveKeepAwake(ambient, () => true);
  assert.equal(ambient.tick, wrapped);
  ambient.tick();
  assert.equal(ambient.ticks, 1);
});
