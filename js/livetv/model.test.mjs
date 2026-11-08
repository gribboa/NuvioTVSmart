import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanXtreamServer,
  createPlaylistSource,
  credentialsFromLink,
  maskSecret,
  sourceFromSubmission,
  tidyLink
} from "./model.js";

test("tidyLink swaps lookalike dashes and drops pasted spaces", () => {
  assert.equal(
    tidyLink(" http://my\u2013host.test/list\u200B.m3u \n"),
    "http://my-host.test/list.m3u"
  );
  assert.equal(tidyLink("http://a.test/\u00A0b"), "http://a.test/b");
});

test("cleanXtreamServer keeps only scheme, host and port", () => {
  assert.equal(
    cleanXtreamServer("http://iptv.example.test:8080/get.php?username=a&password=b"),
    "http://iptv.example.test:8080"
  );
  assert.equal(cleanXtreamServer("iptv.example.test:2095/"), "http://iptv.example.test:2095");
  assert.equal(
    cleanXtreamServer("HTTPS://Line.Example.Test/player_api.php"),
    "https://line.example.test"
  );
  assert.equal(cleanXtreamServer("http://my\u2014host.test:80/c/"), "http://my-host.test");
  assert.equal(cleanXtreamServer("http://h\u00E9st.test"), "http://h-st.test");
  assert.equal(cleanXtreamServer("   "), "");
});

test("credentialsFromLink reads username and password from a pasted get.php link", () => {
  assert.deepEqual(
    credentialsFromLink("http://h.test/get.php?username=me%40x&password=p+w%26d&type=m3u_plus"),
    {
      username: "me@x",
      password: "p w&d"
    }
  );
  assert.deepEqual(credentialsFromLink("http://h.test/get.php?USERNAME=a&Password=b"), {
    username: "a",
    password: "b"
  });
  assert.equal(credentialsFromLink("http://h.test/get.php?username=a"), null);
  assert.equal(credentialsFromLink("http://h.test"), null);
});

test("sourceFromSubmission builds an Xtream source from separate fields", () => {
  const { source, error } = sourceFromSubmission({
    type: "xtream",
    name: "",
    server: "iptv.example.test:8080",
    username: " demo ",
    password: "secret"
  });
  assert.equal(error, undefined);
  assert.equal(source.type, "xtream");
  assert.equal(source.server, "http://iptv.example.test:8080");
  assert.equal(source.username, "demo");
  assert.equal(source.password, "secret");
  assert.equal(source.name, "iptv.example.test");
  assert.match(source.id, /^src_[0-9a-f]{16}$/);
});

test("sourceFromSubmission takes the login from a pasted link", () => {
  const { source } = sourceFromSubmission({
    type: "xtream",
    name: "My TV",
    server: "http://line.example.test/get.php?username=u1&password=p1&type=m3u_plus&output=ts"
  });
  assert.equal(source.server, "http://line.example.test");
  assert.equal(source.username, "u1");
  assert.equal(source.password, "p1");
  assert.equal(source.name, "My TV");
});

test("sourceFromSubmission explains what is missing", () => {
  assert.deepEqual(
    sourceFromSubmission({ type: "xtream", server: "", username: "a", password: "b" }),
    {
      error: "missing_server"
    }
  );
  assert.deepEqual(sourceFromSubmission({ type: "xtream", server: "http://h.test" }), {
    error: "missing_login"
  });
  assert.deepEqual(sourceFromSubmission({ type: "m3u", url: "list.m3u" }), {
    error: "invalid_url"
  });
  assert.deepEqual(sourceFromSubmission({ type: "m3u", url: "http://h.test/a.m3u", epgUrl: "x" }), {
    error: "invalid_epg_url"
  });
  assert.deepEqual(sourceFromSubmission({ type: "vod" }), { error: "invalid_type" });
});

test("sourceFromSubmission builds an M3U source with its guide link", () => {
  const { source } = sourceFromSubmission({
    type: "m3u",
    url: "http://h.test/a.m3u",
    epgUrl: "https://h.test/epg.xml.gz"
  });
  assert.equal(source.type, "m3u");
  assert.equal(source.url, "http://h.test/a.m3u");
  assert.equal(source.epgUrl, "https://h.test/epg.xml.gz");
  assert.equal(source.useEmbeddedEpg, true);
  assert.equal(source.name, "h.test");
});

test("createPlaylistSource keeps a stored source as it was", () => {
  const stored = createPlaylistSource({
    id: "src_1",
    type: "xtream",
    name: "A",
    server: "http://h.test:1",
    username: "u",
    password: "p",
    addedAt: 5,
    channelCount: 300
  });
  assert.deepEqual(createPlaylistSource(stored), stored);
});

test("maskSecret hides the password", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret("ab"), "••••••");
  assert.equal(maskSecret("a".repeat(40)), "••••••••••••");
});
