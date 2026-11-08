import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alternateLiveFormat,
  fetchXtreamAccount,
  fetchXtreamLive,
  mapXtreamAccount,
  mapXtreamLive,
  preferredXtreamFormat,
  xtreamAccountProblem,
  xtreamEpgUrl,
  xtreamLiveStreamUrl,
  xtreamPlayerApiUrl
} from "./xtreamClient.js";

const source = {
  id: "src_x",
  server: "http://iptv.example.test:8080/get.php?username=demo&password=secret",
  username: " demo ",
  password: "secret"
};
const oddSource = {
  id: "src_y",
  server: "line.example.test",
  username: "d e+mo@x",
  password: "p&ss=w/rd!*~"
};

test("player_api, xmltv and live links use the clean server and encode the login", () => {
  assert.equal(
    xtreamPlayerApiUrl(source),
    "http://iptv.example.test:8080/player_api.php?username=demo&password=secret"
  );
  assert.equal(
    xtreamPlayerApiUrl(source, "get_live_streams", { category_id: 5, skip: null }),
    "http://iptv.example.test:8080/player_api.php?username=demo&password=secret&action=get_live_streams&category_id=5"
  );
  assert.equal(
    xtreamPlayerApiUrl(oddSource),
    "http://line.example.test/player_api.php?username=d+e%2Bmo%40x&password=p%26ss%3Dw%2Frd%21*%7E"
  );
  assert.equal(
    xtreamEpgUrl(source),
    "http://iptv.example.test:8080/xmltv.php?username=demo&password=secret"
  );
  assert.equal(
    xtreamLiveStreamUrl(source, 42, "ts"),
    "http://iptv.example.test:8080/live/demo/secret/42.ts"
  );
  assert.equal(
    xtreamLiveStreamUrl(oddSource, "7", "m3u8"),
    "http://line.example.test/live/d+e%2Bmo%40x/p%26ss%3Dw%2Frd%21*%7E/7.m3u8"
  );
  assert.equal(
    xtreamLiveStreamUrl(source, 1, "weird"),
    "http://iptv.example.test:8080/live/demo/secret/1.ts"
  );
});

test("alternateLiveFormat flips ts and m3u8", () => {
  assert.equal(alternateLiveFormat("ts"), "m3u8");
  assert.equal(alternateLiveFormat("m3u8"), "ts");
  assert.equal(alternateLiveFormat("M3U8"), "ts");
});

test("mapXtreamAccount reads user_info and server_info", () => {
  const account = mapXtreamAccount({
    user_info: {
      username: "demo",
      auth: 1,
      status: "Active",
      exp_date: "1893456000",
      max_connections: "2",
      active_cons: 1,
      allowed_output_formats: ["M3U8", "ts", "rtmp", "ts"]
    },
    server_info: { timezone: "Europe/London", url: "iptv.example.test" }
  });
  assert.deepEqual(account, {
    status: "Active",
    expiresAtMs: 1893456000000,
    maxConnections: 2,
    activeConnections: 1,
    serverTimezone: "Europe/London",
    allowedFormats: ["m3u8", "ts", "rtmp"],
    preferredFormat: "ts"
  });
});

test("mapXtreamAccount: no expiry, junk numbers, HLS-only accounts", () => {
  const account = mapXtreamAccount({
    user_info: {
      exp_date: null,
      max_connections: "unlimited",
      allowed_output_formats: ["m3u8"]
    }
  });
  assert.equal(account.expiresAtMs, 0);
  assert.equal(account.maxConnections, 0);
  assert.equal(account.serverTimezone, "");
  assert.equal(account.preferredFormat, "m3u8");
  assert.equal(mapXtreamAccount({ user_info: { exp_date: "0" } }).expiresAtMs, 0);
  assert.equal(mapXtreamAccount(null).status, "");
  assert.equal(preferredXtreamFormat([]), "ts");
  assert.equal(preferredXtreamFormat(["rtmp"]), "ts");
  assert.equal(preferredXtreamFormat(["m3u8", "ts"]), "ts");
});

test("xtreamAccountProblem flags disabled and expired accounts", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(xtreamAccountProblem({ status: "Active", expiresAtMs: now + 1 }, now), null);
  assert.equal(xtreamAccountProblem({ status: "", expiresAtMs: 0 }, now), null);
  assert.equal(xtreamAccountProblem({ status: "Banned", expiresAtMs: 0 }, now), "disabled");
  assert.equal(xtreamAccountProblem({ status: "active", expiresAtMs: now - 1 }, now), "expired");
});

const categories = [
  { category_id: "10", category_name: "News", parent_id: 0 },
  { category_id: 20, category_name: " Sport " },
  { category_id: "30", category_name: "Empty" }
];
const streams = [
  {
    num: 5,
    name: " Sport One\n",
    stream_id: 1001,
    stream_icon: "http://img.example.test/s1.png",
    epg_channel_id: "sport1.test",
    category_id: "20",
    tv_archive: 1,
    tv_archive_duration: "7"
  },
  {
    num: "0",
    name: "News 24",
    stream_id: "1002",
    stream_icon: "",
    epg_channel_id: null,
    category_id: "10",
    tv_archive: "1",
    tv_archive_duration: 0
  },
  { num: 9, name: "Lost", stream_id: 1003, category_id: "99", tv_archive: 0 },
  { name: "No id", category_id: "10" },
  { num: 6, name: "Duplicate", stream_id: 1001, category_id: "10" },
  { stream_id: 1004, category_ids: [10] }
];

test("mapXtreamLive maps groups, channels, numbers and catch-up", () => {
  const { groups, channels } = mapXtreamLive(categories, streams, {
    sourceId: "src_x",
    source,
    format: "m3u8"
  });
  assert.deepEqual(groups, [
    { id: "src_x:10", title: "News", sourceId: "src_x", order: 0 },
    { id: "src_x:20", title: "Sport", sourceId: "src_x", order: 1 },
    { id: "src_x:uncategorised", title: "Uncategorised", sourceId: "src_x", order: 3 }
  ]);
  assert.equal(channels.length, 4);
  assert.deepEqual(channels[0], {
    key: "src_x:x1001",
    sourceId: "src_x",
    name: "Sport One",
    tvgId: "sport1.test",
    tvgName: "Sport One",
    logo: "http://img.example.test/s1.png",
    groupId: "src_x:20",
    group: "Sport",
    number: 5,
    url: "http://iptv.example.test:8080/live/demo/secret/1001.m3u8",
    userAgent: "",
    catchup: { type: "xtream", source: null, days: 7, correctionHours: 0 },
    xtream: { streamId: 1001 }
  });
  const [, news, lost, nameless] = channels;
  assert.equal(news.number, 2);
  assert.equal(news.tvgId, "");
  assert.equal(news.logo, "");
  assert.deepEqual(news.catchup, { type: "xtream", source: null, days: 1, correctionHours: 0 });
  assert.equal(lost.groupId, "src_x:uncategorised");
  assert.equal(lost.group, "Uncategorised");
  assert.equal(lost.catchup, null);
  assert.equal(nameless.name, "Channel 1004");
  assert.equal(nameless.groupId, "src_x:10");
  assert.equal(nameless.number, 4);
});

test("mapXtreamLive accepts keyed objects and missing categories", () => {
  const keyed = { 0: streams[0], 1: streams[2], junk: 5 };
  const { groups, channels } = mapXtreamLive(null, keyed, { sourceId: "s", source });
  assert.deepEqual(
    channels.map((c) => [c.key, c.groupId, c.url.slice(-7)]),
    [
      ["s:x1001", "s:uncategorised", "1001.ts"],
      ["s:x1003", "s:uncategorised", "1003.ts"]
    ]
  );
  assert.deepEqual(
    groups.map((g) => [g.id, g.order]),
    [["s:uncategorised", 0]]
  );
});

/** A fake fetch: answers by action, records what it was asked. */
function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const action = new URL(url).searchParams.get("action") || "";
    const route = routes[action];
    if (route instanceof Error) throw route;
    if (typeof route === "function") return route();
    const { status = 200, body = "" } = route || { status: 404 };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body))
    };
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.ok(!error.message.includes("secret"), "message must not contain the password");
    assert.ok(!error.message.includes("http"), "message must not contain a link");
    return true;
  });
}

test("fetchXtreamAccount: success, user agent only when set", async () => {
  const calls = [];
  const fetchImpl = fakeFetch(
    {
      "": {
        body: {
          user_info: { auth: 1, status: "Active", exp_date: "1893456000" },
          server_info: { timezone: "UTC" }
        }
      }
    },
    calls
  );
  const account = await fetchXtreamAccount(source, { fetchImpl });
  assert.equal(account.serverTimezone, "UTC");
  assert.equal(account.expiresAtMs, 1893456000000);
  assert.equal(calls[0].init.headers, undefined);
  await fetchXtreamAccount(source, { fetchImpl, userAgent: "Nuvio/1.0" });
  assert.deepEqual(calls[1].init.headers, { "User-Agent": "Nuvio/1.0" });
  assert.equal(
    calls[0].url,
    "http://iptv.example.test:8080/player_api.php?username=demo&password=secret"
  );
});

test("fetchXtreamAccount error codes", async () => {
  const respond = (status, body) => fakeFetch({ "": { status, body } });
  await rejectsWithCode(
    fetchXtreamAccount(source, { fetchImpl: respond(200, { user_info: { auth: 0 } }) }),
    "auth"
  );
  await rejectsWithCode(fetchXtreamAccount(source, { fetchImpl: respond(401, "") }), "auth");
  await rejectsWithCode(fetchXtreamAccount(source, { fetchImpl: respond(403, "") }), "auth");
  await rejectsWithCode(fetchXtreamAccount(source, { fetchImpl: respond(502, "") }), "http");
  await rejectsWithCode(
    fetchXtreamAccount(source, { fetchImpl: respond(200, "<html>panel</html>") }),
    "parse"
  );
  await rejectsWithCode(
    fetchXtreamAccount(source, { fetchImpl: respond(200, { hello: 1 }) }),
    "parse"
  );
  await rejectsWithCode(
    fetchXtreamAccount(source, {
      fetchImpl: fakeFetch({ "": new TypeError("Failed to fetch http://x/?password=secret") })
    }),
    "network"
  );
  const error = await fetchXtreamAccount(source, { fetchImpl: respond(502, "") }).catch((e) => e);
  assert.equal(error.status, 502);
});

test("fetchXtreamAccount passes an abort through unchanged", async () => {
  const controller = new AbortController();
  controller.abort();
  const abortError = new DOMException("Aborted", "AbortError");
  await assert.rejects(
    fetchXtreamAccount(source, {
      signal: controller.signal,
      fetchImpl: fakeFetch({ "": abortError })
    }),
    (error) => error === abortError
  );
});

test("fetchXtreamLive fetches categories and streams together", async () => {
  const calls = [];
  let pending = 0;
  let maxPending = 0;
  const slow = (body) => async () => {
    pending += 1;
    maxPending = Math.max(maxPending, pending);
    await new Promise((resolve) => setTimeout(resolve, 5));
    pending -= 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const fetchImpl = fakeFetch(
    { get_live_categories: slow(categories), get_live_streams: slow(streams) },
    calls
  );
  const { groups, channels } = await fetchXtreamLive(source, { fetchImpl, format: "ts" });
  assert.equal(maxPending, 2);
  assert.equal(calls.length, 2);
  assert.equal(groups.length, 3);
  assert.equal(channels[0].key, "src_x:x1001");
  assert.equal(channels[0].url, "http://iptv.example.test:8080/live/demo/secret/1001.ts");
});

test("fetchXtreamLive: categories failing is not fatal, streams failing is", async () => {
  const live = await fetchXtreamLive(source, {
    fetchImpl: fakeFetch({
      get_live_categories: { status: 500 },
      get_live_streams: { body: streams }
    })
  });
  assert.ok(live.channels.every((c) => c.groupId === "src_x:uncategorised"));

  await rejectsWithCode(
    fetchXtreamLive(source, {
      fetchImpl: fakeFetch({ get_live_categories: { body: [] }, get_live_streams: { status: 403 } })
    }),
    "auth"
  );
  await rejectsWithCode(
    fetchXtreamLive(source, {
      fetchImpl: fakeFetch({ get_live_categories: { body: [] }, get_live_streams: { status: 500 } })
    }),
    "http"
  );
  await rejectsWithCode(
    fetchXtreamLive(source, {
      fetchImpl: fakeFetch({
        get_live_categories: { body: [] },
        get_live_streams: { body: "oops" }
      })
    }),
    "parse"
  );
  await rejectsWithCode(
    fetchXtreamLive(source, {
      fetchImpl: fakeFetch({ get_live_categories: { body: [] }, get_live_streams: { body: 42 } })
    }),
    "parse"
  );
  await rejectsWithCode(
    fetchXtreamLive(source, {
      fetchImpl: fakeFetch({
        get_live_categories: { body: [] },
        get_live_streams: new TypeError("offline")
      })
    }),
    "network"
  );
});
