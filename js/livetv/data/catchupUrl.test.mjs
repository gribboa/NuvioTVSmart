import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCatchupUrl,
  buildCatchupUrls,
  canPlayCatchup,
  catchupAlternatives,
  fillCatchupTemplate,
  isCatchupAvailable,
  isKnownTimeZone,
  linkForm,
  planCatchup,
  preferForm,
  tsFallback,
  wholeMinutes
} from "./catchupUrl.js";

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 0, 15, 10); // 2026-01-15 10:00 UTC
const STOP = START + HOUR;
const NOW = START + 2 * HOUR;
const S = START / 1000;
const E = STOP / 1000;
const N = NOW / 1000;
const XT_LIVE = "http://iptv.example.test:8080/live/fakeuser/fakepass/1234.ts";
const XT_BASE = "http://iptv.example.test:8080/timeshift/fakeuser/fakepass";

function catchup(type, extra = {}) {
  return { type, source: null, days: 3, correctionHours: 0, ...extra };
}

function build(liveUrl, info, options = {}, start = START, stop = STOP, now = NOW) {
  return buildCatchupUrl(liveUrl, info, start, stop, now, { deviceTimezone: "UTC", ...options });
}

test("isCatchupAvailable / canPlayCatchup edges", () => {
  const info = catchup("default", { days: 3 });
  assert.equal(isCatchupAvailable(null, START, NOW), false);
  assert.equal(isCatchupAvailable(info, NOW, NOW), false); // not started yet
  assert.equal(isCatchupAvailable(info, NOW + 1, NOW), false);
  assert.equal(isCatchupAvailable(info, NOW - 1, NOW), true); // on air: watch from the start
  assert.equal(isCatchupAvailable(info, NOW - 3 * DAY, NOW), true);
  assert.equal(isCatchupAvailable(info, NOW - 3 * DAY - 1, NOW), false);
  // Zero / missing days count as one day.
  assert.equal(isCatchupAvailable({ ...info, days: 0 }, NOW - DAY, NOW), true);
  assert.equal(isCatchupAvailable({ ...info, days: 0 }, NOW - DAY - 1, NOW), false);
  assert.equal(isCatchupAvailable({ type: "xc" }, NOW - HOUR, NOW), true);

  const channel = { url: XT_LIVE, catchup: info, xtream: null };
  assert.equal(canPlayCatchup(channel, { startMs: START, stopMs: STOP }, NOW), true);
  assert.equal(
    canPlayCatchup({ ...channel, catchup: null }, { startMs: START, stopMs: STOP }, NOW),
    false
  );
  assert.equal(canPlayCatchup(channel, { startMs: NOW + MIN, stopMs: NOW + HOUR }, NOW), false);
  assert.equal(canPlayCatchup(channel, null, NOW), false);
  assert.equal(canPlayCatchup(null, { startMs: START }, NOW), false);
  assert.equal(canPlayCatchup(channel, { startMs: NaN }, NOW), false);
});

test("default: template sources, relative templates, and the no-source guesses", () => {
  assert.equal(
    build(
      "http://tv.example.test/ch1.m3u8",
      catchup("default", { source: "HTTP://archive.example.test/ch1?s={utc}&e={utcend}" })
    ),
    `HTTP://archive.example.test/ch1?s=${S}&e=${E}`
  );
  assert.equal(
    build(
      "http://tv.example.test/ch1.m3u8",
      catchup("default", { source: "?utc={start}&dur={duration}" })
    ),
    `http://tv.example.test/ch1.m3u8?utc=${S}&dur=3600`
  );
  // No source on an Xtream-style link: Xtream /timeshift/ links.
  assert.equal(
    build(XT_LIVE, catchup("default", { source: "  " })),
    `${XT_BASE}/60/2026-01-15:10-00/1234.ts`
  );
  // No source on anything else: ?utc=&lutc=.
  assert.equal(
    build("http://tv.example.test/ch1.m3u8", catchup("default")),
    `http://tv.example.test/ch1.m3u8?utc=${S}&lutc=${N}`
  );
  // A missing type counts as default.
  assert.equal(
    build("http://tv.example.test/ch1.m3u8", { days: 1 }),
    `http://tv.example.test/ch1.m3u8?utc=${S}&lutc=${N}`
  );
});

test("append adds the filled source to the live link", () => {
  assert.equal(
    build(
      "http://tv.example.test/ch1.m3u8?token=t",
      catchup("append", { source: "&utc={utc}&lutc={lutc}" })
    ),
    `http://tv.example.test/ch1.m3u8?token=t&utc=${S}&lutc=${N}`
  );
  assert.equal(build("http://tv.example.test/ch1.m3u8", catchup("append")), null);
});

test("shift / timeshift add utc and lutc", () => {
  assert.equal(
    build("http://tv.example.test/ch1.m3u8", catchup("shift", { source: "x" })),
    `http://tv.example.test/ch1.m3u8?utc=${S}&lutc=${N}`
  );
  assert.equal(
    build("http://tv.example.test/ch1.m3u8?a=1", catchup("timeshift", { source: "x" })),
    `http://tv.example.test/ch1.m3u8?a=1&utc=${S}&lutc=${N}`
  );
  // Without a source an Xtream-style link still gets the Xtream form.
  assert.equal(build(XT_LIVE, catchup("shift")), `${XT_BASE}/60/2026-01-15:10-00/1234.ts`);
  // With a source it is a plain shift even on an Xtream-style link.
  assert.equal(build(XT_LIVE, catchup("shift", { source: "x" })), `${XT_LIVE}?utc=${S}&lutc=${N}`);
});

test("flussonic: HLS index links and TS timeshift_abs links", () => {
  for (const type of ["flussonic", "flussonic-hls", "flussonic-ts", "fs"]) {
    assert.equal(
      build("http://fl.example.test/channel1/index.m3u8?token=abc", catchup(type)),
      `http://fl.example.test/channel1/index-${S}-3600.m3u8?token=abc`
    );
  }
  assert.equal(
    build("http://fl.example.test/channel1/mono.m3u8", catchup("flussonic")),
    `http://fl.example.test/channel1/mono-${S}-3600.m3u8`
  );
  assert.equal(
    build("https://fl.example.test/group/channel1/", catchup("flussonic")),
    `https://fl.example.test/group/channel1/index-${S}-3600.m3u8`
  );
  assert.equal(
    build("http://fl.example.test/channel1/mpegts?token=abc", catchup("flussonic")),
    `http://fl.example.test/channel1/timeshift_abs-${S}.ts?token=abc`
  );
  assert.equal(build("http://fl.example.test/channel1", catchup("flussonic")), null);
  // Shorter than a minute: still asks for a minute.
  assert.equal(
    build("http://fl.example.test/c/index.m3u8", catchup("flussonic"), {}, START, START + 5000),
    `http://fl.example.test/c/index-${S}-60.m3u8`
  );
});

test("xtream: server time zone, HLS preference, extensions and query", () => {
  const info = catchup("xc");
  assert.equal(
    build(XT_LIVE, info, { serverTimezone: "Europe/London" }),
    `${XT_BASE}/60/2026-01-15:10-00/1234.ts`
  );
  assert.equal(
    build(XT_LIVE, catchup("xtream"), { serverTimezone: "Europe/Berlin", preferHls: true }),
    `${XT_BASE}/60/2026-01-15:11-00/1234.m3u8`
  );
  assert.equal(
    build("http://iptv.example.test/fakeuser/fakepass/77?x=1", info, {
      serverTimezone: "Asia/Tokyo"
    }),
    "http://iptv.example.test/timeshift/fakeuser/fakepass/60/2026-01-15:19-00/77.ts?x=1"
  );
  assert.equal(
    build("https://iptv.example.test/live/u/p/5.m3u8", info, { serverTimezone: "UTC" }),
    "https://iptv.example.test/timeshift/u/p/60/2026-01-15:10-00/5.m3u8"
  );
  // Unknown zone: UTC (as Android does). No zone: this device's clock.
  assert.equal(
    build(XT_LIVE, info, { serverTimezone: "Mars/Olympus_Mons" }),
    `${XT_BASE}/60/2026-01-15:10-00/1234.ts`
  );
  assert.equal(
    build(XT_LIVE, info, { serverTimezone: "", deviceTimezone: "America/Sao_Paulo" }),
    `${XT_BASE}/60/2026-01-15:07-00/1234.ts`
  );
  // Seconds are dropped (whole minutes), the window is at least one minute.
  assert.equal(
    build(XT_LIVE, info, { serverTimezone: "UTC" }, START + 45000, START + 75000),
    `${XT_BASE}/1/2026-01-15:10-00/1234.ts`
  );
  assert.equal(build("http://tv.example.test/ch1.m3u8", info), null);
  assert.equal(isKnownTimeZone("America/New_York"), true);
  assert.equal(isKnownTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isKnownTimeZone(""), false);
});

test("xtream: America/New_York across both DST changes", () => {
  const info = catchup("xc", { days: 7 });
  const zone = { serverTimezone: "America/New_York" };
  const at = (iso) => {
    const ms = Date.parse(iso);
    return build(XT_LIVE, info, zone, ms, ms + HOUR, ms + 2 * HOUR);
  };
  // Spring forward, 2026-03-08 02:00 EST -> 03:00 EDT.
  assert.equal(at("2026-03-08T06:30:00Z"), `${XT_BASE}/60/2026-03-08:01-30/1234.ts`);
  assert.equal(at("2026-03-08T07:30:00Z"), `${XT_BASE}/60/2026-03-08:03-30/1234.ts`);
  // Fall back, 2026-11-01 02:00 EDT -> 01:00 EST: two different instants, same wall time.
  assert.equal(at("2026-11-01T05:30:00Z"), `${XT_BASE}/60/2026-11-01:01-30/1234.ts`);
  assert.equal(at("2026-11-01T06:30:00Z"), `${XT_BASE}/60/2026-11-01:01-30/1234.ts`);
  assert.equal(at("2026-11-01T07:30:00Z"), `${XT_BASE}/60/2026-11-01:02-30/1234.ts`);
});

test("catchup-correction shifts every time by its hours", () => {
  assert.equal(
    build("http://tv.example.test/ch1", catchup("shift", { source: "x", correctionHours: 1 })),
    `http://tv.example.test/ch1?utc=${S + 3600}&lutc=${N}`
  );
  assert.equal(
    build(
      "http://tv.example.test/ch1",
      catchup("default", { source: "/a/{utc}-{utcend}-{duration}", correctionHours: -0.5 })
    ),
    `http://tv.example.test/ch1/a/${S - 1800}-${E - 1800}-3600`
  );
  assert.equal(
    build(XT_LIVE, catchup("xc", { correctionHours: 2 }), { serverTimezone: "UTC" }),
    `${XT_BASE}/60/2026-01-15:12-00/1234.ts`
  );
});

test("other types use the source as a full template, or give nothing", () => {
  assert.equal(
    build("http://tv.example.test/ch1", catchup("vod", { source: "http://a.example.test/{utc}" })),
    `http://a.example.test/${S}`
  );
  assert.equal(build("http://tv.example.test/ch1", catchup("vod")), null);
  assert.equal(buildCatchupUrl("", catchup("shift"), START, STOP, NOW), null);
  assert.equal(buildCatchupUrl(XT_LIVE, null, START, STOP, NOW), null);
});

test("template placeholders", () => {
  const start = Date.UTC(2026, 0, 15, 22, 5, 9) / 1000;
  const end = start + 5400;
  const now = start + 7200;
  const fill = (t, zone = "UTC") => fillCatchupTemplate(t, start, end, now, 5400, zone);
  assert.equal(
    fill(
      "{utc}|${utc}|{start}|${start}|{utcend}|{end}|${end}|{lutc}|{now}|{timestamp}|${timestamp}"
    ),
    [start, start, start, start, end, end, end, now, now, now, now].join("|")
  );
  assert.equal(fill("{duration}|${duration}|{offset}|${offset}"), "5400|5400|7200|7200");
  assert.equal(fill("{duration:60}|${duration:3600}|{offset:60}|{duration:0}"), "90|1|120|5400");
  assert.equal(fill("{utc:Y-m-d H:M:S}"), "2026-01-15 22:05:09");
  assert.equal(fill("${start:YmdHMS}|{utcend:Y/m/d-H.M}"), "20260115220509|2026/01/15-23.35");
  assert.equal(fill("{lutc:YmdH}|{now:H}|{timestamp:Y}|{end:d}"), "2026011600|00|2026|15");
  assert.equal(fill("{utc:Ymd T HM}"), "20260115 T 2205"); // other letters are kept
  // Bare {Y}{m}{d}{H}{M}{S}: the start on this device's clock.
  assert.equal(fill("{Y}{m}{d}{H}{M}{S}", "UTC"), "20260115220509");
  assert.equal(fill("{Y}-{m}-{d} {H}:{M}:{S}", "Asia/Tokyo"), "2026-01-16 07:05:09");
  assert.equal(fill("/{unknown}/{utc:}"), "/{unknown}/{utc:}");
});

test("alternatives for an Xtream HLS link: TS, aired part, show only, php, other clock", () => {
  const url = `${XT_BASE}/240/2026-01-15:10-00/1234.m3u8?t=1`;
  assert.deepEqual(
    catchupAlternatives(url, "Europe/Berlin", {
      showMinutes: 60,
      airedMinutes: 30,
      deviceTimezone: "UTC"
    }),
    [
      `${XT_BASE}/240/2026-01-15:10-00/1234.ts?t=1`,
      `${XT_BASE}/30/2026-01-15:10-00/1234.m3u8?t=1`,
      `${XT_BASE}/30/2026-01-15:10-00/1234.ts?t=1`,
      `${XT_BASE}/60/2026-01-15:10-00/1234.m3u8?t=1`,
      `${XT_BASE}/60/2026-01-15:10-00/1234.ts?t=1`,
      "http://iptv.example.test:8080/streaming/timeshift.php?username=fakeuser&password=fakepass" +
        "&stream=1234&start=2026-01-15:10-00&duration=240",
      `${XT_BASE}/240/2026-01-15:09-00/1234.m3u8?t=1`
    ]
  );
});

test("alternatives: TS link, windows not shorter, and clocks", () => {
  const url = `${XT_BASE}/60/2026-01-15:10-00/1234.ts`;
  const php =
    "http://iptv.example.test:8080/streaming/timeshift.php?username=fakeuser&password=fakepass" +
    "&stream=1234&start=2026-01-15:10-00&duration=60";
  // Same clock on both sides (server UTC, device UTC): no "other clock" link.
  assert.deepEqual(
    catchupAlternatives(url, "UTC", { showMinutes: 60, airedMinutes: 90, deviceTimezone: "UTC" }),
    [`${XT_BASE}/60/2026-01-15:10-00/1234.m3u8`, php]
  );
  // No server zone: the link was written on this device's clock; the other clock is UTC.
  assert.deepEqual(catchupAlternatives(url, null, { deviceTimezone: "Asia/Tokyo" }), [
    `${XT_BASE}/60/2026-01-15:10-00/1234.m3u8`,
    php,
    `${XT_BASE}/60/2026-01-15:01-00/1234.ts`
  ]);
  // Server in New York (EST, UTC-5), device in UTC.
  assert.deepEqual(
    catchupAlternatives(url, "America/New_York", { deviceTimezone: "UTC" }).at(-1),
    `${XT_BASE}/60/2026-01-15:15-00/1234.ts`
  );
  // Not a /timeshift/ link: only the TS fallback of an HLS link, if any.
  assert.deepEqual(catchupAlternatives("http://tv.example.test/ch1?utc=1", "UTC"), []);
});

test("tsFallback, wholeMinutes and linkForm", () => {
  assert.equal(
    tsFallback(`${XT_BASE}/60/2026-01-15:10-00/1234.m3u8?t=1`),
    `${XT_BASE}/60/2026-01-15:10-00/1234.ts?t=1`
  );
  assert.equal(tsFallback(`${XT_BASE}/60/2026-01-15:10-00/1234.ts`), null);
  assert.equal(tsFallback("http://tv.example.test/ch1.m3u8"), null);

  assert.equal(wholeMinutes(`${XT_BASE}/60/2026-01-15:10-00/1234.ts`), true);
  assert.equal(wholeMinutes("http://iptv.example.test/streaming/timeshift.php?start=x"), true);
  assert.equal(wholeMinutes(`http://tv.example.test/ch1.m3u8?utc=${S}`), false);

  const primary = `${XT_BASE}/120/2026-01-15:10-00/1234.m3u8`;
  assert.equal(linkForm(primary, primary), "hls");
  assert.equal(linkForm(`${XT_BASE}/120/2026-01-15:10-00/1234.ts`, primary), "ts");
  assert.equal(linkForm(`${XT_BASE}/60/2026-01-15:10-00/1234.ts`, primary), "ts+short");
  assert.equal(linkForm(`${XT_BASE}/120/2026-01-15:05-00/1234.m3u8`, primary), "hls+clock");
  assert.equal(linkForm(`${XT_BASE}/30/2026-01-15:05-00/1234.ts`, primary), "ts+clock+short");
  assert.equal(
    linkForm("http://iptv.example.test/streaming/timeshift.php?username=a", primary),
    "php"
  );
});

test("preferForm puts the kind that worked last time first", () => {
  const primary = `${XT_BASE}/120/2026-01-15:10-00/1234.m3u8`;
  const alts = catchupAlternatives(primary, "UTC", { showMinutes: 60, deviceTimezone: "UTC" });
  const php = alts.find((u) => u.includes("timeshift.php"));
  assert.deepEqual(preferForm(primary, alts, null), [primary, ...alts]);
  assert.deepEqual(preferForm(primary, alts, "php"), [
    php,
    primary,
    ...alts.filter((u) => u !== php)
  ]);
  const shortTs = `${XT_BASE}/60/2026-01-15:10-00/1234.ts`;
  assert.equal(preferForm(primary, alts, "ts+short")[0], shortTs);
  // "+short" not on offer this time: the same kind without it.
  const noShort = catchupAlternatives(primary, "UTC", { deviceTimezone: "UTC" });
  assert.equal(
    preferForm(primary, noShort, "ts+short")[0],
    `${XT_BASE}/120/2026-01-15:10-00/1234.ts`
  );
  // HLS worked last time but this primary is TS (HLS switched off): order unchanged.
  const tsPrimary = `${XT_BASE}/120/2026-01-15:10-00/1234.ts`;
  const tsAlts = catchupAlternatives(tsPrimary, "UTC", { deviceTimezone: "UTC" });
  assert.deepEqual(preferForm(tsPrimary, tsAlts, "hls"), [tsPrimary, ...tsAlts]);
  assert.deepEqual(preferForm(primary, alts, "nothing-like-this"), [primary, ...alts]);
});

test("buildCatchupUrls: Xtream account, whole-minute lead and the 3 hour follow-on window", () => {
  const channel = {
    url: "http://old.example.test/live/olduser/oldpass/1234.m3u8",
    catchup: catchup("xc", { days: 2 }),
    xtream: { streamId: 1234 }
  };
  const programme = { startMs: START + 30000, stopMs: STOP, title: "Fake Show" };
  const source = {
    type: "xtream",
    server: "iptv.example.test:8080/",
    username: "fakeuser",
    password: "fake/pass"
  };
  const base = "http://iptv.example.test:8080/timeshift/fakeuser/fake%2Fpass";
  const plan = planCatchup({
    channel,
    programme,
    nowMs: NOW,
    serverTimezone: "Europe/London",
    source,
    deviceTimezone: "UTC"
  });
  // Up to 30 s before now: 10:00:30 -> 11:59:30 is 119 minutes.
  assert.equal(plan.primaryUrl, `${base}/119/2026-01-15:10-00/1234.m3u8`);
  assert.equal(plan.leadMs, 30000);
  assert.equal(plan.startMs, START + 30000);
  assert.deepEqual(plan.urls, [
    `${base}/119/2026-01-15:10-00/1234.m3u8`,
    `${base}/119/2026-01-15:10-00/1234.ts`,
    `${base}/60/2026-01-15:10-00/1234.m3u8`,
    `${base}/60/2026-01-15:10-00/1234.ts`,
    "http://iptv.example.test:8080/streaming/timeshift.php?username=fakeuser" +
      "&password=fake%2Fpass&stream=1234&start=2026-01-15:10-00&duration=119"
  ]);
  assert.deepEqual(
    buildCatchupUrls({
      channel,
      programme,
      nowMs: NOW,
      serverTimezone: "Europe/London",
      source,
      deviceTimezone: "UTC"
    }),
    plan.urls
  );
  // Long ago: capped at 3 hours past the end.
  const old = buildCatchupUrls({
    channel,
    programme: { startMs: START, stopMs: STOP },
    nowMs: START + DAY,
    serverTimezone: "UTC",
    source,
    deviceTimezone: "UTC",
    lastForm: "ts"
  });
  assert.equal(old[0], `${base}/240/2026-01-15:10-00/1234.ts`);
  // Too old, or not started: nothing.
  assert.deepEqual(buildCatchupUrls({ channel, programme, nowMs: START + 3 * DAY, source }), []);
  assert.deepEqual(
    buildCatchupUrls({
      channel,
      programme: { startMs: NOW + MIN, stopMs: NOW + HOUR },
      nowMs: NOW
    }),
    []
  );
});

test("buildCatchupUrls: show still on air, offsets and M3U channels", () => {
  const channel = { url: XT_LIVE, catchup: catchup("xc"), xtream: null };
  // On air: started 10:00, ends 11:00, now 10:40. The window is the whole show (never less),
  // and the part aired so far (40 min) is offered next, in both forms.
  const urls = buildCatchupUrls({
    channel,
    programme: { startMs: START, stopMs: STOP },
    nowMs: START + 40 * MIN,
    serverTimezone: "UTC",
    preferHls: true,
    deviceTimezone: "UTC"
  });
  assert.deepEqual(urls.slice(0, 4), [
    `${XT_BASE}/60/2026-01-15:10-00/1234.m3u8`,
    `${XT_BASE}/60/2026-01-15:10-00/1234.ts`,
    `${XT_BASE}/40/2026-01-15:10-00/1234.m3u8`,
    `${XT_BASE}/40/2026-01-15:10-00/1234.ts`
  ]);
  assert.match(urls[4], /timeshift[.]php/);
  assert.equal(urls.length, 5);
  // Starting 15 min in, with the guide 5 min ahead of the archive (shiftMs).
  const plan = planCatchup({
    channel,
    programme: { startMs: START, stopMs: STOP },
    nowMs: NOW,
    serverTimezone: "UTC",
    offsetMs: 15 * MIN,
    shiftMs: 5 * MIN,
    deviceTimezone: "UTC"
  });
  // 10:10 -> 11:54:30 (now - 30 s, minus the shift): 104 minutes.
  assert.equal(plan.primaryUrl, `${XT_BASE}/104/2026-01-15:10-10/1234.ts`);
  assert.equal(plan.startMs, START + 15 * MIN);
  assert.equal(plan.leadMs, 0);
  // An M3U channel with a template: one link, no lead.
  const m3u = {
    url: "http://tv.example.test/ch1.m3u8",
    catchup: catchup("default", { source: "?utc={utc}&lutc={lutc}" }),
    xtream: null
  };
  const m3uPlan = planCatchup({
    channel: m3u,
    programme: { startMs: START, stopMs: STOP },
    nowMs: NOW
  });
  assert.deepEqual(m3uPlan.urls, [`http://tv.example.test/ch1.m3u8?utc=${S}&lutc=${N}`]);
  assert.equal(m3uPlan.leadMs, 0);
  // An Xtream source without a stream id: the channel's own link is used.
  assert.equal(
    buildCatchupUrls({
      channel,
      programme: { startMs: START, stopMs: STOP },
      nowMs: NOW,
      serverTimezone: "UTC",
      source: { type: "xtream", server: "other.example.test", username: "a", password: "b" },
      deviceTimezone: "UTC"
    })[0],
    `${XT_BASE}/119/2026-01-15:10-00/1234.ts`
  );
});
