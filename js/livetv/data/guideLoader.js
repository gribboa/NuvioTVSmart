// Nuvio Live: downloads one XMLTV guide and stores the programmes of the channels it matches.
// Streamed end to end (download -> gunzip when the file is gzipped -> incremental parser ->
// IndexedDB in batches), so a large guide never sits in memory, and the parse yields to the UI
// between chunks. (The plan suggested a Web Worker; chunked parsing on the main thread keeps the
// build simple and is quick enough for a few hundred channels on Tizen 9.)
import pako from "pako";
import { liveFetch } from "./liveTvHttp.js";
import { XmltvStreamParser } from "./xmltvParser.js";
import { LiveTvEpgStore, guideIdFor, programmeRecord } from "./epgStore.js";
import { matchGuideChannel } from "./guideMatching.js";

const WRITE_BATCH = 1500;

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isGzip(bytes) {
  return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Turns a byte stream into text chunks, gunzipping on the fly when the first bytes say gzip.
 * Returns { push(bytes), end() } feeding `onText(text)`.
 */
function createTextPipe(onText) {
  const decoder = new TextDecoder("utf-8");
  let inflator = null;
  let decided = false;
  let failed = null;
  const decode = (bytes, stream = true) => {
    const text = decoder.decode(bytes, { stream });
    if (text) onText(text);
  };
  return {
    push(bytes) {
      if (!decided) {
        decided = true;
        if (isGzip(bytes)) {
          // windowBits 15 + 32: zlib or gzip header, detected automatically.
          inflator = new pako.Inflate({ windowBits: 47 });
          inflator.onData = (chunk) => decode(chunk);
          inflator.onEnd = (status) => {
            if (status !== 0) failed = new Error(inflator.msg || "gunzip failed");
          };
        }
      }
      if (inflator) {
        inflator.push(bytes, false);
        if (inflator.err) failed = new Error(inflator.msg || "gunzip failed");
      } else {
        decode(bytes);
      }
      if (failed) throw failed;
    },
    end() {
      if (inflator && !inflator.ended) inflator.push(new Uint8Array(0), true);
      if (failed) throw failed;
      decode(new Uint8Array(0), false);
    }
  };
}

async function* readBody(response) {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) yield value;
    }
  }
  yield new Uint8Array(await response.arrayBuffer());
}

/**
 * Loads one guide. `matchIndex` comes from buildChannelMatchIndex(channels); `onMatch(guideId,
 * matches)` is called for each guide channel that belongs to playlist channels. Resolves to
 * { channels, programmes } counts. Throws with code "http" / "network" / "parse".
 */
export async function loadGuide({
  url,
  userAgent = "",
  guideKey,
  windowStartMs,
  windowEndMs,
  matchIndex,
  onMatch,
  onProgress,
  signal
}) {
  const response = await liveFetch(url, { userAgent, signal });
  const upstreamStatus = Number(response.headers?.get?.("x-upstream-status") || response.status);
  if (!response.ok || upstreamStatus >= 400) {
    const error = new Error(`http ${upstreamStatus}`);
    error.code = "http";
    throw error;
  }

  const wanted = new Map();
  const seen = new Set();
  let batch = [];
  let stored = 0;
  let matchedChannels = 0;
  let cleared = false;

  const consider = (id, names) => {
    if (seen.has(id)) return wanted.has(id);
    seen.add(id);
    const matches = matchGuideChannel(matchIndex, id, names);
    if (!matches.length) return false;
    wanted.set(id, matches);
    matchedChannels += 1;
    onMatch?.(guideIdFor(guideKey, id), matches);
    return true;
  };

  const parser = new XmltvStreamParser({
    windowStartMs,
    windowEndMs,
    onChannel: ({ id, names }) => consider(id, names || []),
    onProgramme: (programme) => {
      // Guides usually list channels first; a programme of an unlisted channel is matched by id.
      if (!consider(programme.channelId, [])) return;
      batch.push(programmeRecord(guideKey, programme));
    }
  });

  const flush = async () => {
    if (!batch.length) return;
    if (!cleared) {
      // Only now: a guide that fails before its first programme keeps the old listings.
      await LiveTvEpgStore.clearGuide(guideKey);
      cleared = true;
    }
    const records = batch;
    batch = [];
    stored += records.length;
    await LiveTvEpgStore.writeProgrammes(records);
  };

  const pipe = createTextPipe((text) => parser.push(text));
  let bytesRead = 0;
  try {
    for await (const bytes of readBody(response)) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      bytesRead += bytes.length;
      pipe.push(bytes);
      if (batch.length >= WRITE_BATCH) await flush();
      onProgress?.({ bytesRead, programmes: stored + batch.length, channels: matchedChannels });
      await yieldToUi();
    }
    pipe.end();
    parser.end();
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (!error.code) error.code = error instanceof TypeError ? "network" : "parse";
    throw error;
  }
  await flush();
  if (!cleared && seen.size === 0) {
    const error = new Error("not a guide");
    error.code = "parse";
    throw error;
  }
  return { channels: matchedChannels, programmes: stored };
}
