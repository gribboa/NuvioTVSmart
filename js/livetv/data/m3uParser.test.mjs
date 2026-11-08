import assert from "node:assert/strict";
import { test } from "node:test";
import { fnv1aHex, isVodLink, parseAttributes, parseM3u } from "./m3uParser.js";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const BOM = String.fromCharCode(0xfeff);

function playlist(lines, eol = LF) {
  return lines.join(eol);
}

test("parseAttributes reads quoted and unquoted values", () => {
  const attrs = parseAttributes(
    '#EXTINF:-1 tvg-id="news.test" tvg-chno=7 Group-Title = "World News" tvg-logo=\'http://img.example.test/a.png\''
  );
  assert.equal(attrs["tvg-id"], "news.test");
  assert.equal(attrs["tvg-chno"], "7");
  assert.equal(attrs["group-title"], "World News");
  assert.equal(attrs["tvg-logo"], "http://img.example.test/a.png");
  assert.equal(attrs.extinf, undefined);
});

test("parseAttributes: quoted wins over unquoted, last quoted and first unquoted kept", () => {
  const attrs = parseAttributes('a=one a="two" b=first b=second c="x" c="y"');
  assert.equal(attrs.a, "two");
  assert.equal(attrs.b, "first");
  assert.equal(attrs.c, "y");
});

test("parseAttributes ignores an unclosed quote and empty values", () => {
  const attrs = parseAttributes('tvg-id=, tvg-name="Broken group-title=Kids');
  assert.equal(attrs["tvg-id"], undefined);
  assert.equal(attrs["tvg-name"], undefined);
  assert.equal(attrs["group-title"], "Kids");
});

test("parses a basic playlist with names, attributes and url-tvg list", () => {
  const text = playlist([
    '#EXTM3U url-tvg="http://epg.example.test/a.xml, http://epg.example.test/b.xml.gz" x-tvg-url="http://epg.example.test/a.xml,ftp://nope.test/c.xml"',
    '#EXTINF:-1 tvg-id="one.test" tvg-name="One HD" tvg-logo="http://img.example.test/1.png" group-title="News" tvg-chno="101",One, the first',
    "http://stream.example.test/live/1.ts",
    '#EXTINF:-1 tvg-name="Two Fallback" group-title="Sport;Extra",',
    "http://stream.example.test/live/2.m3u8"
  ]);
  const { channels, groups, epgUrls } = parseM3u(text, { sourceId: "src_a" });
  assert.deepEqual(epgUrls, ["http://epg.example.test/a.xml", "http://epg.example.test/b.xml.gz"]);
  assert.equal(channels.length, 2);
  const [one, two] = channels;
  assert.equal(one.name, "One, the first");
  assert.equal(one.tvgId, "one.test");
  assert.equal(one.tvgName, "One HD");
  assert.equal(one.logo, "http://img.example.test/1.png");
  assert.equal(one.number, 101);
  assert.equal(one.key, "src_a:one.test");
  assert.equal(one.groupId, "src_a:news");
  assert.equal(one.group, "News");
  assert.equal(one.url, "http://stream.example.test/live/1.ts");
  assert.equal(one.userAgent, "");
  assert.equal(one.catchup, null);
  assert.equal(one.xtream, null);
  assert.equal(two.name, "Two Fallback");
  assert.equal(two.tvgId, "");
  assert.equal(two.logo, "");
  assert.equal(two.number, 2);
  assert.equal(two.group, "Sport");
  assert.equal(two.key, `src_a:${fnv1aHex("http://stream.example.test/live/2.m3u8")}`);
  assert.deepEqual(groups, [
    { id: "src_a:news", title: "News", sourceId: "src_a", order: 0 },
    { id: "src_a:sport", title: "Sport", sourceId: "src_a", order: 1 }
  ]);
});

test("commas and quotes inside attribute values don't end the attributes", () => {
  const text = playlist([
    '#EXTINF:-1 tvg-name="Comma, Inc" group-title="A, B",Real Name',
    "http://stream.example.test/1"
  ]);
  const [channel] = parseM3u(text, { sourceId: "s" }).channels;
  assert.equal(channel.name, "Real Name");
  assert.equal(channel.tvgName, "Comma, Inc");
  assert.equal(channel.group, "A, B");
});

test("a title with = signs doesn't add attributes", () => {
  const text = playlist([
    '#EXTINF:-1 group-title="Kids",Show tvg-id=fake',
    "http://s.example.test/1"
  ]);
  const [channel] = parseM3u(text, { sourceId: "s" }).channels;
  assert.equal(channel.name, "Show tvg-id=fake");
  assert.equal(channel.tvgId, "");
});

test("group fallback: #EXTGRP, then Uncategorised; groups merge case-insensitively", () => {
  const text = playlist([
    "#EXTINF:-1,No Group",
    "http://s.example.test/1",
    "#EXTINF:-1,From EXTGRP",
    "#EXTGRP:Movies",
    "http://s.example.test/2",
    '#EXTINF:-1 group-title="  ",Blank Group',
    "http://s.example.test/3",
    '#EXTINF:-1 group-title="MOVIES",Upper',
    "http://s.example.test/4",
    "#EXTGRP:Lost",
    "#EXTINF:-1,EXTGRP before EXTINF is reset",
    "http://s.example.test/5"
  ]);
  const { channels, groups } = parseM3u(text, { sourceId: "s" });
  assert.deepEqual(
    channels.map((c) => [c.groupId, c.group]),
    [
      ["s:uncategorised", "Uncategorised"],
      ["s:movies", "Movies"],
      ["s:uncategorised", "Uncategorised"],
      ["s:movies", "Movies"],
      ["s:uncategorised", "Uncategorised"]
    ]
  );
  assert.deepEqual(
    groups.map((g) => [g.title, g.order]),
    [
      ["Uncategorised", 0],
      ["Movies", 1]
    ]
  );
});

test("catch-up attributes, aliases and playlist-wide defaults", () => {
  const text = playlist([
    '#EXTM3U catchup="shift" catchup-days="3"',
    "#EXTINF:-1,Inherits",
    "http://s.example.test/1",
    '#EXTINF:-1 catchup="Flussonic" catchup-days="7" catchup-source="?utc={utc}&lutc={lutc}" catchup-correction="-1,5",Own',
    "http://s.example.test/2",
    "http://s.example.test/3"
  ]);
  const [inherits, own] = parseM3u(text, { sourceId: "s" }).channels;
  assert.deepEqual(inherits.catchup, { type: "shift", source: null, days: 3, correctionHours: 0 });
  assert.deepEqual(own.catchup, {
    type: "flussonic",
    source: "?utc={utc}&lutc={lutc}",
    days: 7,
    correctionHours: -1.5
  });
  const aliasText = playlist([
    '#EXTINF:-1 catchup-type="Append" timeshift="2" catchup-source="&s={utc}",Alias',
    "http://s.example.test/3"
  ]);
  const [alias] = parseM3u(aliasText, { sourceId: "s" }).channels;
  assert.deepEqual(alias.catchup, {
    type: "append",
    source: "&s={utc}",
    days: 2,
    correctionHours: 0
  });
});

test("catch-up: days alone means default type; nothing set means null", () => {
  const text = playlist([
    '#EXTINF:-1 tvg-rec="5",Rec',
    "http://s.example.test/1",
    '#EXTINF:-1 catchup="default",Type only',
    "http://s.example.test/2",
    '#EXTINF:-1 catchup-days="0",Zero',
    "http://s.example.test/3"
  ]);
  const [rec, typeOnly, zero] = parseM3u(text, { sourceId: "s" }).channels;
  assert.deepEqual(rec.catchup, { type: "default", source: null, days: 5, correctionHours: 0 });
  assert.deepEqual(typeOnly.catchup, {
    type: "default",
    source: null,
    days: 1,
    correctionHours: 0
  });
  assert.equal(zero.catchup, null);
});

test("user agent from #EXTVLCOPT, #EXTHTTP, pipe headers and attributes; referrer dropped", () => {
  const text = playlist([
    "#EXTVLCOPT:http-user-agent=VLC Before/1.0",
    "#EXTINF:-1,Before",
    "#EXTVLCOPT:http-referrer=http://ref.example.test/",
    "http://s.example.test/1",
    "#EXTINF:-1,No header carried over",
    "http://s.example.test/2",
    "#EXTINF:-1,Pipe",
    "http://s.example.test/3.m3u8|User-Agent=Pipe%20Agent&Referer=http://ref.example.test",
    '#EXTINF:-1 http-user-agent="Attr Agent",Attr',
    "#EXTVLCOPT:http-user-agent=Loses",
    "http://s.example.test/4",
    '#EXTHTTP:{"user-agent":"Http Agent","Referer":"x"}',
    "#EXTINF:-1,ExtHttp",
    "http://s.example.test/5",
    "#EXTINF:-1,Kodi",
    "#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha",
    "#KODIPROP:inputstream.adaptive.license_key=https://license.example.test/wv",
    "#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=Kodi+Agent&Referer=y",
    "http://s.example.test/6.mpd"
  ]);
  const channels = parseM3u(text, { sourceId: "s" }).channels;
  assert.deepEqual(
    channels.map((c) => [c.name, c.userAgent, c.url]),
    [
      ["Before", "VLC Before/1.0", "http://s.example.test/1"],
      ["No header carried over", "", "http://s.example.test/2"],
      ["Pipe", "Pipe Agent", "http://s.example.test/3.m3u8"],
      ["Attr", "Attr Agent", "http://s.example.test/4"],
      ["ExtHttp", "Http Agent", "http://s.example.test/5"],
      ["Kodi", "Kodi Agent", "http://s.example.test/6.mpd"]
    ]
  );
  assert.ok(channels.every((c) => !("drm" in c) && !("headers" in c)));
});

test("keys: tvg-id when unique, link hash otherwise, suffixed when repeated", () => {
  const text = playlist([
    '#EXTINF:-1 tvg-id="dup.test",Dup A',
    "http://s.example.test/a",
    '#EXTINF:-1 tvg-id="dup.test",Dup B',
    "http://s.example.test/b",
    '#EXTINF:-1 tvg-id="solo.test",Solo',
    "http://s.example.test/c",
    "#EXTINF:-1,Same link 1",
    "http://s.example.test/same",
    "#EXTINF:-1,Same link 2",
    "http://s.example.test/same"
  ]);
  const first = parseM3u(text, { sourceId: "s1" }).channels.map((c) => c.key);
  const again = parseM3u(text, { sourceId: "s1" }).channels.map((c) => c.key);
  const other = parseM3u(text, { sourceId: "s2" }).channels.map((c) => c.key);
  assert.deepEqual(first, again);
  assert.equal(new Set(first).size, first.length);
  assert.ok(first.every((key, i) => !other.includes(key) && other[i].startsWith("s2:")));
  const sameHash = fnv1aHex("http://s.example.test/same");
  assert.deepEqual(first, [
    `s1:${fnv1aHex("http://s.example.test/a")}`,
    `s1:${fnv1aHex("http://s.example.test/b")}`,
    "s1:solo.test",
    `s1:${sameHash}`,
    `s1:${sameHash}#2`
  ]);
});

test("fnv1aHex is the standard 32-bit FNV-1a", () => {
  assert.equal(fnv1aHex(""), "811c9dc5");
  assert.equal(fnv1aHex("a"), "e40c292c");
  assert.equal(fnv1aHex("foobar"), "bf9cf968");
});

test("CRLF, lone CR, BOM, blank lines and a missing #EXTM3U", () => {
  const lines = [
    `${BOM}#EXTINF:-1 tvg-chno="x",First`,
    "",
    "   ",
    "http://s.example.test/1",
    "#EXTINF:-1 tvg-chno=0,Second",
    "http://s.example.test/2  "
  ];
  for (const eol of [CR + LF, CR, LF]) {
    const { channels, epgUrls } = parseM3u(playlist(lines, eol), { sourceId: "s" });
    assert.deepEqual(epgUrls, []);
    assert.deepEqual(
      channels.map((c) => [c.name, c.url, c.number]),
      [
        ["First", "http://s.example.test/1", 1],
        ["Second", "http://s.example.test/2", 2]
      ]
    );
  }
  const withBomHeader = parseM3u(
    `${BOM}#EXTM3U url-tvg="http://epg.example.test/g.xml"${CR}${LF}`,
    {
      sourceId: "s"
    }
  );
  assert.deepEqual(withBomHeader.epgUrls, ["http://epg.example.test/g.xml"]);
});

test("links without #EXTINF, unknown # lines and VOD entries are skipped", () => {
  const text = playlist([
    "#EXTM3U",
    "http://s.example.test/orphan",
    "#EXTINF:-1,Live",
    "#SOMETHING-ELSE:1",
    "http://s.example.test/live/u/p/1.ts",
    "#EXTINF:-1,Movie",
    "http://s.example.test/movie/u/p/2.mkv",
    "#EXTINF:-1,Episode",
    "http://s.example.test/series/u/p/3.mp4"
  ]);
  assert.deepEqual(
    parseM3u(text, { sourceId: "s" }).channels.map((c) => c.name),
    ["Live"]
  );
  assert.equal(parseM3u(text, { sourceId: "s", skipVod: false }).channels.length, 3);
  assert.equal(isVodLink("http://s.example.test/a.mp4?token=1"), true);
  assert.equal(isVodLink("http://s.example.test/live/a.m3u8"), false);
});

test("handles a 5,000-channel playlist quickly", () => {
  const lines = ['#EXTM3U url-tvg="http://epg.example.test/g.xml"'];
  for (let i = 0; i < 5000; i += 1) {
    lines.push(
      `#EXTINF:-1 tvg-id="c${i}.test" tvg-name="Channel ${i}" tvg-logo="http://img.example.test/${i}.png" group-title="Group ${i % 40}" catchup="default" catchup-days="3",Channel ${i}`
    );
    lines.push(`http://s.example.test/live/demo/secret/${i}.ts`);
  }
  const started = Date.now();
  const { channels, groups } = parseM3u(lines.join(LF), { sourceId: "big" });
  const elapsed = Date.now() - started;
  assert.equal(channels.length, 5000);
  assert.equal(groups.length, 40);
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
});

test("empty and junk input", () => {
  assert.deepEqual(parseM3u("", { sourceId: "s" }), { channels: [], groups: [], epgUrls: [] });
  assert.deepEqual(parseM3u(null, { sourceId: "s" }).channels, []);
  assert.deepEqual(parseM3u("<html>nope</html>", { sourceId: "s" }).channels, []);
});
