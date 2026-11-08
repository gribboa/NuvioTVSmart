import assert from "node:assert/strict";
import { test } from "node:test";
import {
  XmltvStreamParser,
  cleanEpisode,
  decodeXmlEntities,
  formatEpisodeNumber,
  parseXmltvTime
} from "./xmltvParser.js";

const HOUR = 3600000;
const BASE = Date.UTC(2026, 0, 15, 0, 0, 0); // 2026-01-15 00:00 UTC

function parseChunks(chunks, window = {}) {
  const channels = [];
  const programmes = [];
  const parser = new XmltvStreamParser({
    windowStartMs: window.start,
    windowEndMs: window.end,
    onChannel: (c) => channels.push(c),
    onProgramme: (p) => programmes.push(p)
  });
  for (const chunk of chunks) parser.push(chunk);
  const stats = parser.end();
  return { channels, programmes, stats, parser };
}

function parseAll(text, window) {
  return parseChunks([text], window);
}

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="fake">
  <!-- a comment with <programme start="x" channel="ghost"> inside -->
  <channel id="one.test">
    <display-name lang="en">One &amp; Only</display-name>
    <display-name>1</display-name>
    <display-name>   </display-name>
    <icon src="http://img.example.test/one.png?a=1&amp;b=2"/>
  </channel>
  <channel id='two.test'><display-name><![CDATA[Two <Tw&o>]]></display-name></channel>
  <programme start="20260115100000 +0000" stop="20260115110000 +0000" channel="one.test">
    <title lang="en">  Morning &quot;News&quot; &#38; &#x41;  </title>
    <sub-title>Part&nbsp;1</sub-title>
    <desc><![CDATA[A <b>bold</b> & raw story]]> continues &lt;here&gt;</desc>
    <category>News</category>
    <category>Current affairs</category>
    <episode-num system="dd_progid">EP012345678</episode-num>
    <episode-num system="xmltv_ns">1.4.0/1</episode-num>
    <icon src="http://img.example.test/news.jpg" />
    <date>1999</date>
    <credits><director>Dee Rector</director><actor role="x">Ann Actor</actor><writer>W</writer></credits>
  </programme>
  <programme start="20260115110000 +0100" stop="20260115120000 +0100" channel="two.test">
    <title>Film (1984)</title>
    <episode-num system="xmltv_ns">0.2.</episode-num>
    <episode-num system="onscreen">Ep. 3</episode-num>
    <date>20260115</date>
  </programme>
  <programme start="20260115120000" stop="20260115130000" channel="two.test"/>
</tv>
`;

test("parseXmltvTime handles offsets, missing seconds and missing offset (UTC)", () => {
  const utc = Date.UTC(2026, 0, 15, 10, 30, 15);
  assert.equal(parseXmltvTime("20260115103015 +0000"), utc);
  assert.equal(parseXmltvTime("20260115113015 +0100"), utc);
  assert.equal(parseXmltvTime("20260115053015 -0500"), utc);
  assert.equal(parseXmltvTime("20260115160015 +0530"), utc);
  assert.equal(parseXmltvTime("20260115160015 +05:30"), utc);
  assert.equal(parseXmltvTime("20260115103015"), utc);
  assert.equal(parseXmltvTime("  20260115103015Z "), utc);
  assert.equal(parseXmltvTime("202601151030 +0000"), Date.UTC(2026, 0, 15, 10, 30));
  assert.equal(parseXmltvTime("202601151030"), Date.UTC(2026, 0, 15, 10, 30));
  assert.equal(parseXmltvTime("20240229235959 +0000"), Date.UTC(2024, 1, 29, 23, 59, 59));
  assert.equal(parseXmltvTime("19691231230000 +0000"), Date.UTC(1969, 11, 31, 23));
  assert.ok(Number.isNaN(parseXmltvTime("2026011510")));
  assert.ok(Number.isNaN(parseXmltvTime("20261315103015 +0000")));
  assert.ok(Number.isNaN(parseXmltvTime("20260100103015 +0000")));
  assert.ok(Number.isNaN(parseXmltvTime("")));
  assert.ok(Number.isNaN(parseXmltvTime(null)));
  assert.ok(Number.isNaN(parseXmltvTime(undefined)));
});

test("formatEpisodeNumber follows the Android formatting", () => {
  assert.equal(formatEpisodeNumber("xmltv_ns", "1.4.0/1"), "S2 E5");
  assert.equal(formatEpisodeNumber("xmltv_ns", " 0 . 0 . "), "S1 E1");
  assert.equal(formatEpisodeNumber("xmltv_ns", "2/5.11/20."), "S3 E12");
  assert.equal(formatEpisodeNumber("xmltv_ns", ".4."), "E5");
  assert.equal(formatEpisodeNumber("xmltv_ns", "3.."), null);
  assert.equal(formatEpisodeNumber("xmltv_ns", "2025.608."), null);
  assert.equal(formatEpisodeNumber("xmltv_ns", ""), null);
  assert.equal(formatEpisodeNumber("onscreen", "S01E05"), "S01E05");
  assert.equal(formatEpisodeNumber(null, " Part One "), "Part One");
  assert.equal(formatEpisodeNumber("dd_progid", "EP0123.0001"), null);
  assert.equal(formatEpisodeNumber("thetvdb.com", "12345"), null);
  assert.equal(formatEpisodeNumber("onscreen", "609178259"), null);
  assert.equal(formatEpisodeNumber("onscreen", "S2026E609"), null);
  assert.equal(formatEpisodeNumber("onscreen", "Season 2026 Episode 1"), null);
});

test("cleanEpisode keeps labels and drops ids", () => {
  assert.equal(cleanEpisode("Ep. 12"), "Ep. 12");
  assert.equal(cleanEpisode("1x05"), "1x05");
  assert.equal(cleanEpisode("Finale"), "Finale");
  assert.equal(cleanEpisode("12345"), null);
  assert.equal(cleanEpisode("1234"), "1234");
  assert.equal(cleanEpisode("EP012345678"), null);
  assert.equal(cleanEpisode("Season 3, Episode 4"), "Season 3, Episode 4");
  assert.equal(cleanEpisode("A very long episode label indeed"), null);
  assert.equal(cleanEpisode("   "), null);
  assert.equal(cleanEpisode(null), null);
});

test("decodeXmlEntities decodes named and numeric entities and leaves broken ones", () => {
  assert.equal(
    decodeXmlEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;"),
    "a & b <c> \"d\" 'e'"
  );
  assert.equal(
    decodeXmlEntities("&#65;&#x42;&#X43;&#128512;"),
    "ABC" + String.fromCodePoint(128512)
  );
  assert.equal(
    decodeXmlEntities("Tom & Jerry; &bogus; &#xZZ; &#0; &"),
    "Tom & Jerry; &bogus; &#xZZ; &#0; &"
  );
  assert.equal(decodeXmlEntities("no entities"), "no entities");
  assert.equal(decodeXmlEntities("&nbsp;"), String.fromCharCode(0xa0));
});

test("reads channels and programmes with entities, CDATA, episodes, credits and year", () => {
  const { channels, programmes, stats, parser } = parseAll(SAMPLE);
  assert.deepEqual(channels, [
    {
      id: "one.test",
      names: ["One & Only", "1"],
      icon: "http://img.example.test/one.png?a=1&b=2"
    },
    { id: "two.test", names: ["Two <Tw&o>"], icon: null }
  ]);
  assert.equal(programmes.length, 3);
  assert.deepEqual(programmes[0], {
    channelId: "one.test",
    startMs: Date.UTC(2026, 0, 15, 10),
    stopMs: Date.UTC(2026, 0, 15, 11),
    title: 'Morning "News" & A',
    subTitle: "Part" + String.fromCharCode(0xa0) + "1",
    description: "A <b>bold</b> & raw story continues <here>",
    category: "News",
    episode: "S2 E5",
    icon: "http://img.example.test/news.jpg",
    year: 1999,
    people: ["Dee Rector", "Ann Actor"]
  });
  // Onscreen wins over xmltv_ns; a broadcast date is not a release year, "(1984)" in the title is.
  assert.equal(programmes[1].episode, "Ep. 3");
  assert.equal(programmes[1].year, 1984);
  assert.equal(programmes[1].startMs, Date.UTC(2026, 0, 15, 10));
  assert.equal(programmes[1].subTitle, null);
  assert.equal(programmes[1].description, null);
  assert.equal(programmes[1].category, null);
  // A self-closing programme has no title.
  assert.equal(programmes[2].title, "No information");
  assert.equal(programmes[2].startMs, Date.UTC(2026, 0, 15, 12));
  assert.deepEqual(programmes[2].people, []);
  assert.deepEqual(stats, { channels: 2, programmes: 3, skipped: 0 });
  assert.deepEqual([...parser.programmeChannelIds], ["one.test", "two.test"]);
});

test("same result whatever position the text is split at", () => {
  const expected = parseAll(SAMPLE);
  for (let i = 0; i <= SAMPLE.length; i++) {
    const got = parseChunks([SAMPLE.slice(0, i), SAMPLE.slice(i)]);
    assert.deepEqual(got.channels, expected.channels, `split at ${i}`);
    assert.deepEqual(got.programmes, expected.programmes, `split at ${i}`);
  }
  for (let i = 0; i <= SAMPLE.length; i += 7) {
    for (let j = i; j <= SAMPLE.length; j += 11) {
      const got = parseChunks([SAMPLE.slice(0, i), SAMPLE.slice(i, j), SAMPLE.slice(j)]);
      assert.deepEqual(got.programmes, expected.programmes, `split at ${i}/${j}`);
      assert.deepEqual(got.channels, expected.channels, `split at ${i}/${j}`);
    }
  }
  const single = parseChunks(SAMPLE.split(""));
  assert.deepEqual(single.programmes, expected.programmes);
  assert.deepEqual(single.channels, expected.channels);
});

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function syntheticGuide(channelCount, perChannel, extras = true) {
  const parts = ['<?xml version="1.0"?>\n<tv>\n'];
  for (let c = 0; c < channelCount; c++) {
    parts.push(
      `<channel id="ch${c}.test"><display-name>Channel ${c} &amp; Co</display-name>` +
        `<icon src="http://img.example.test/${c}.png"/></channel>\n`
    );
  }
  for (let c = 0; c < channelCount; c++) {
    for (let i = 0; i < perChannel; i++) {
      const start = new Date(BASE + i * HOUR);
      const stop = new Date(BASE + (i + 1) * HOUR);
      const stamp = (d) =>
        d.toISOString().slice(0, 19).replace(/[-T:]/g, "") + (extras && i % 2 ? " +0000" : "");
      parts.push(
        `<programme start="${stamp(start)}" stop="${stamp(stop)}" channel="ch${c}.test">` +
          `<title lang="en">Show ${i % 50} &amp; friends</title>` +
          (extras
            ? `<desc><![CDATA[Episode ${i} of a <long> running series on channel ${c}.]]></desc>` +
              `<category>Cat ${i % 7}</category>` +
              `<episode-num system="xmltv_ns">${i % 5}.${i % 20}.</episode-num>`
            : "") +
          `</programme>\n`
      );
    }
  }
  parts.push("</tv>\n");
  return parts.join("");
}

test("random chunk splits of a larger guide give the same result", () => {
  const doc = syntheticGuide(12, 40);
  const expected = parseAll(doc);
  assert.equal(expected.programmes.length, 480);
  assert.equal(expected.channels.length, 12);
  const random = randomGenerator(42);
  for (let round = 0; round < 25; round++) {
    const chunks = [];
    let p = 0;
    const maxChunk = round < 10 ? 16 : 4096;
    while (p < doc.length) {
      const size = 1 + Math.floor(random() * maxChunk);
      chunks.push(doc.slice(p, p + size));
      p += size;
    }
    const got = parseChunks(chunks);
    assert.deepEqual(got.channels, expected.channels, `round ${round}`);
    assert.deepEqual(got.programmes, expected.programmes, `round ${round}`);
  }
});

test("only programmes overlapping [windowStart, windowEnd) are emitted", () => {
  const prog = (start, stop, title) =>
    `<programme start="${start} +0000" stop="${stop} +0000" channel="c.test"><title>${title}</title></programme>`;
  const doc =
    "<tv>" +
    prog("20260115080000", "20260115090000", "ends before") +
    prog("20260115090000", "20260115100000", "ends at window start") +
    prog("20260115093000", "20260115103000", "straddles start") +
    prog("20260115110000", "20260115120000", "inside") +
    prog("20260115113000", "20260115123000", "straddles end") +
    prog("20260115120000", "20260115130000", "starts at window end") +
    prog("20260115130000", "20260115140000", "after") +
    '<programme start="garbage" stop="20260115110000" channel="c.test"><title>bad</title></programme>' +
    '<programme start="20260115110000" stop="20260115120000"><title>no channel</title></programme>' +
    "</tv>";
  const { programmes, stats, parser } = parseAll(doc, {
    start: Date.UTC(2026, 0, 15, 10),
    end: Date.UTC(2026, 0, 15, 12)
  });
  assert.deepEqual(
    programmes.map((p) => p.title),
    ["straddles start", "inside", "straddles end"]
  );
  assert.equal(stats.skipped, 6);
  assert.deepEqual([...parser.programmeChannelIds], ["c.test"]);
});

test("window respects time zone offsets", () => {
  const doc =
    '<tv><programme start="20260115120000 +0200" stop="20260115130000 +0200" channel="c">' +
    "<title>Ten UTC</title></programme></tv>";
  const window = { start: Date.UTC(2026, 0, 15, 10), end: Date.UTC(2026, 0, 15, 10, 30) };
  assert.equal(parseAll(doc, window).programmes.length, 1);
  const later = { start: Date.UTC(2026, 0, 15, 11), end: Date.UTC(2026, 0, 15, 12) };
  assert.equal(parseAll(doc, later).programmes.length, 0);
});

test("unclosed programmes end at the next programme; unclosed children end with the parent", () => {
  const doc =
    '<tv><programme start="20260115100000" stop="20260115110000" channel="a">' +
    "<title>First</title><desc>Never closed" +
    '<programme start="20260115110000" stop="20260115120000" channel="a">' +
    "<title>Second</title><category>Drama</programme>" +
    '<programme start="20260115120000" stop="20260115130000" channel="a"><title>Third</title>';
  const { programmes } = parseAll(doc);
  assert.deepEqual(
    programmes.map((p) => [p.title, p.description, p.category]),
    [
      ["First", "Never closed", null],
      ["Second", null, "Drama"],
      ["Third", null, null]
    ]
  );
});

test("stray ampersands, bare '<' and HTML entities do not stop the guide", () => {
  const doc =
    '<tv><programme start="20260115100000" stop="20260115110000" channel="a">' +
    "<title>Tom & Jerry &hellip; 1 < 2 &unknown;</title></programme>" +
    '<programme start="20260115110000" stop="20260115120000" channel="a"><title>Next</title></programme></tv>';
  const { programmes } = parseAll(doc);
  assert.deepEqual(
    programmes.map((p) => p.title),
    ["Tom & Jerry " + String.fromCharCode(0x2026) + " 1 < 2 &unknown;", "Next"]
  );
});

test("long descriptions are cut at 800 characters and people at 12", () => {
  const actors = Array.from({ length: 15 }, (_, i) => `<actor>Actor ${i}</actor>`).join("");
  const doc =
    '<tv><programme start="20260115100000" stop="20260115110000" channel="a">' +
    `<desc>${"x".repeat(799)} ${"y".repeat(50)}</desc><credits>${actors}</credits></programme></tv>`;
  const [p] = parseAll(doc).programmes;
  assert.equal(p.description, "x".repeat(799) + String.fromCharCode(0x2026));
  assert.equal(p.people.length, 12);
  assert.equal(p.people[11], "Actor 11");
});

test("year comes from a bare <date> year, else (YYYY) in the title or description", () => {
  const prog = (inner) =>
    `<programme start="20260115100000" stop="20260115110000" channel="a">${inner}</programme>`;
  const doc =
    "<tv>" +
    prog("<title>A</title><date>2001</date>") +
    prog("<title>B</title><date>1850</date>") +
    prog("<title>C</title><desc>Remake of the (1959) classic</desc>") +
    prog("<title>D 1990</title>") +
    "</tv>";
  assert.deepEqual(
    parseAll(doc).programmes.map((p) => p.year),
    [2001, null, 1959, null]
  );
});

test("only the unread tail is kept in memory", () => {
  const doc = syntheticGuide(4, 50);
  const parser = new XmltvStreamParser({ onProgramme: () => {} });
  let max = 0;
  for (let p = 0; p < doc.length; p += 8192) {
    parser.push(doc.slice(p, p + 8192));
    max = Math.max(max, parser.bufferedLength);
  }
  assert.ok(max < 8192 + 4096, `buffered ${max}`);
  assert.equal(parser.end().programmes, 200);
  assert.equal(parser.bufferedLength, 0);
});

test("50,000 programmes parse in well under 5 seconds", () => {
  const doc = syntheticGuide(100, 500);
  let count = 0;
  let last = null;
  const startedAt = Date.now();
  const parser = new XmltvStreamParser({
    windowStartMs: BASE,
    windowEndMs: BASE + 1000 * HOUR,
    onChannel: () => {},
    onProgramme: (p) => {
      count++;
      last = p;
    }
  });
  const chunkSize = 64 * 1024;
  for (let p = 0; p < doc.length; p += chunkSize) parser.push(doc.slice(p, p + chunkSize));
  parser.end();
  const elapsed = Date.now() - startedAt;
  assert.equal(count, 50000);
  assert.equal(last.channelId, "ch99.test");
  assert.equal(last.episode, "S5 E20");
  assert.ok(elapsed < 5000, `took ${elapsed} ms for ${(doc.length / 1048576).toFixed(1)} MB`);
});
