// Nuvio Live: catch-up (archive) links for the common provider formats.
// Ported from NuvioPlusIPTV (GPL-3.0), app/src/main/java/com/nuvio/tv/livetv/data/CatchupUrlBuilder.kt.
//
// Types: default / append (template in catchup-source), shift, flussonic and xtream codes.
// Times in links are whole seconds since 1970 unless a format says otherwise; Xtream /timeshift/
// links name a local time in the server's own time zone.
import { cleanXtreamServer } from "../model.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Ask for up to this long past a show's end: shows that run over keep playing. */
export const CATCHUP_CONTINUE_MS = 3 * 60 * 60 * 1000;

// http://host:port/(live/)?user/pass/id(.ext)(?query)
const XTREAM_LIVE =
  /^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/([0-9]+)(\.[a-z0-9]+)?(\?.*)?$/i;
const FLUSSONIC = /^(https?:\/\/[^/]+)\/(.*)\/([^/?]*)(\?.*)?$/;
const TIMESHIFT_LINK =
  /^(https?:\/\/[^/]+)\/timeshift\/([^/]+)\/([^/]+)\/([0-9]+)\/([0-9-]+:[0-9-]+)\/([0-9]+)(\.[a-z0-9]+)?$/i;
const TIMESHIFT_PATH = /\/timeshift\/[^/]+\/[^/]+\/([0-9]+)\/([0-9-]+:[0-9-]+)\/[0-9]+/i;
const STAMP = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2}):([0-9]{1,2})-([0-9]{1,2})$/;

function isBlank(text) {
  return text == null || !String(text).trim();
}

function pathOf(url) {
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function floorMod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

// --- Time zones -------------------------------------------------------------------------------

const formatters = new Map();

function zoneFormatter(zone) {
  if (formatters.has(zone)) return formatters.get(zone);
  let formatter = null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch (_) {
    formatter = null; // unknown zone
  }
  formatters.set(zone, formatter);
  return formatter;
}

/** Whether this device knows the IANA time zone [name] ("Europe/London"). */
export function isKnownTimeZone(name) {
  return !isBlank(name) && zoneFormatter(String(name).trim()) !== null;
}

/**
 * The wall-clock fields of [ms] in [zone]: an IANA name (an unknown one counts as UTC, as on
 * Android), or null / "" for this device's own clock.
 */
function wallClock(ms, zone) {
  const date = new Date(ms);
  if (!zone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds()
    };
  }
  const formatter = zoneFormatter(zone);
  if (formatter) {
    // en-US: "MM/DD/YYYY, HH:mm:ss" (format() rather than formatToParts() for older TVs).
    const n = formatter.format(date).match(/[0-9]+/g);
    if (n && n.length >= 6) {
      return {
        year: Number(n[2]),
        month: Number(n[0]),
        day: Number(n[1]),
        hour: Number(n[3]) % 24,
        minute: Number(n[4]),
        second: Number(n[5])
      };
    }
  }
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds()
  };
}

function zoneOffsetMs(ms, zone) {
  const w = wallClock(ms, zone);
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - wholeSecond;
}

/** Epoch ms of a wall-clock time in [zone] (see wallClock for what [zone] can be). */
function wallClockToMs(year, month, day, hour, minute, zone) {
  if (!zone) return new Date(year, month - 1, day, hour, minute).getTime();
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMs(guess, zone);
  return guess - zoneOffsetMs(first, zone);
}

/** "yyyy-MM-dd:HH-mm", the time format of Xtream /timeshift/ links. */
function formatStamp(ms, zone) {
  const w = wallClock(ms, zone);
  return `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}:${pad(w.hour, 2)}-${pad(w.minute, 2)}`;
}

function parseStamp(stamp, zone) {
  const m = STAMP.exec(stamp);
  if (!m) return null;
  const ms = wallClockToMs(+m[1], +m[2], +m[3], +m[4], +m[5], zone);
  return Number.isFinite(ms) ? ms : null;
}

/** The zone Xtream times are written in: the server's if known, else this device's clock. */
function serverZone(serverTimezone, deviceTimezone) {
  return isBlank(serverTimezone) ? deviceTimezone || null : String(serverTimezone).trim();
}

// --- Availability -----------------------------------------------------------------------------

/** Whether a show that started at [programStartMs] can still be replayed (port of isAvailable). */
export function isCatchupAvailable(catchup, programStartMs, nowMs) {
  if (!catchup) return false;
  if (!(programStartMs < nowMs)) return false;
  const days = Math.max(1, Math.trunc(Number(catchup.days)) || 0);
  return nowMs - programStartMs <= days * DAY_MS;
}

/**
 * Whether [programme] on [channel] can be played from the archive: the channel has catch-up,
 * the show has started (ended, or watch-from-the-beginning) and is within the archive's days.
 */
export function canPlayCatchup(channel, programme, nowMs = Date.now()) {
  if (!channel || !programme || !Number.isFinite(programme.startMs)) return false;
  return isCatchupAvailable(channel.catchup, programme.startMs, nowMs);
}

// --- Templates --------------------------------------------------------------------------------

/** {utc:YmdHMS} style formats: Y m d H M S are date parts (UTC), anything else is kept. */
function formatPattern(pattern, epochSec) {
  const w = wallClock(epochSec * 1000, "UTC");
  let out = "";
  for (const c of pattern) {
    if (c === "Y") out += pad(w.year, 4);
    else if (c === "m") out += pad(w.month, 2);
    else if (c === "d") out += pad(w.day, 2);
    else if (c === "H") out += pad(w.hour, 2);
    else if (c === "M") out += pad(w.minute, 2);
    else if (c === "S") out += pad(w.second, 2);
    else out += c;
  }
  return out;
}

function divisorOf(text) {
  const n = parseInt(text, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function replaceAll(text, search, value) {
  return text.split(search).join(value);
}

/**
 * Fills a catch-up template (catchup-source). [start], [end] and [now] are epoch seconds,
 * [duration] seconds. Supports {utc} {start} {timestamp} {utcend} {end} {lutc} {now}
 * {duration} {offset} (each also as ${...}), {duration:N} and {offset:N} (divided by N),
 * {utc:Y-m-d:H-M} style formats (UTC) on utc/start/utcend/end/lutc/now/timestamp, and bare
 * {Y} {m} {d} {H} {M} {S}: the show's start on this device's clock ([deviceTimezone] if given).
 */
export function fillCatchupTemplate(template, start, end, now, duration, deviceTimezone = null) {
  let out = String(template);
  out = out.replace(
    /\$?\{(utc|start|utcend|end|lutc|now|timestamp):([^}]+)\}/g,
    (_, key, pattern) => {
      let epoch = start;
      if (key === "utcend" || key === "end") epoch = end;
      else if (key === "lutc" || key === "now" || key === "timestamp") epoch = now;
      return formatPattern(pattern, epoch);
    }
  );
  out = out.replace(/\$?\{duration:([0-9]+)\}/g, (_, d) =>
    String(Math.trunc(duration / divisorOf(d)))
  );
  out = out.replace(/\$?\{offset:([0-9]+)\}/g, (_, d) =>
    String(Math.trunc((now - start) / divisorOf(d)))
  );
  const simple = [
    ["utc", start],
    ["start", start],
    ["timestamp", now],
    ["utcend", end],
    ["end", end],
    ["lutc", now],
    ["now", now],
    ["duration", duration],
    ["offset", now - start]
  ];
  for (const [key, value] of simple) {
    out = replaceAll(out, "$" + "{" + key + "}", String(value));
    out = replaceAll(out, "{" + key + "}", String(value));
  }
  const w = wallClock(start * 1000, deviceTimezone || null);
  out = replaceAll(out, "{Y}", pad(w.year, 4));
  out = replaceAll(out, "{m}", pad(w.month, 2));
  out = replaceAll(out, "{d}", pad(w.day, 2));
  out = replaceAll(out, "{H}", pad(w.hour, 2));
  out = replaceAll(out, "{M}", pad(w.minute, 2));
  out = replaceAll(out, "{S}", pad(w.second, 2));
  return out;
}

// --- Link builders ----------------------------------------------------------------------------

function shiftLink(url, start, now) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}utc=${start}&lutc=${now}`;
}

function flussonicLink(url, start, duration) {
  const m = FLUSSONIC.exec(url);
  if (!m) return null;
  const [, host, stream, file] = m;
  const query = m[4] || "";
  if (file.endsWith(".m3u8") || !file) {
    const base = file.replace(/\.m3u8$/, "") || "index";
    return `${host}/${stream}/${base}-${start}-${duration}.m3u8${query}`;
  }
  return `${host}/${stream}/timeshift_abs-${start}.ts${query}`;
}

function xtreamLink(url, startMs, duration, preferHls, serverTimezone, deviceTimezone) {
  const m = XTREAM_LIVE.exec(url);
  if (!m) return null;
  const [, host, user, pass, id] = m;
  const query = m[6] || "";
  // HLS (.m3u8) replays come with a length, so the seek bar and skipping work properly.
  const ext = preferHls ? ".m3u8" : m[5] || ".ts";
  const minutes = Math.max(1, Math.trunc(duration / 60));
  const stamp = formatStamp(startMs, serverZone(serverTimezone, deviceTimezone));
  return `${host}/timeshift/${user}/${pass}/${minutes}/${stamp}/${id}${ext}${query}`;
}

/**
 * The catch-up link for [startMs, stopMs) on a channel whose live link is [liveUrl], or null.
 * options: preferHls (Xtream: .m3u8 instead of .ts), serverTimezone (Xtream: the server's IANA
 * zone, catch-up times are in server time), deviceTimezone (this device's clock; for tests).
 */
export function buildCatchupUrl(
  liveUrl,
  catchup,
  startMs,
  stopMs,
  nowMs = Date.now(),
  options = {}
) {
  if (!liveUrl || !catchup) return null;
  const { preferHls = false, serverTimezone = null, deviceTimezone = null } = options;
  // "catchup-correction": the playlist's own time fix for this channel, in hours.
  const correctionMs = Math.trunc((Number(catchup.correctionHours) || 0) * 3600000);
  const startMsC = startMs + correctionMs;
  const start = Math.trunc(startMsC / 1000);
  const end = Math.trunc((stopMs + correctionMs) / 1000);
  const now = Math.trunc(nowMs / 1000);
  const duration = Math.max(60, end - start);
  const source = catchup.source == null ? null : String(catchup.source);
  const fill = (template) =>
    fillCatchupTemplate(template, start, end, now, duration, deviceTimezone);
  // Xtream-style links (server/user/pass/id) whose playlist doesn't say which kind of catch-up:
  // they use Xtream's /timeshift/ links, like TiviMate assumes.
  const xtreamGuess = () =>
    xtreamLink(liveUrl, startMsC, duration, preferHls, serverTimezone, deviceTimezone);
  const type = String(catchup.type || "default")
    .trim()
    .toLowerCase();
  switch (type) {
    case "append":
      return source === null ? null : liveUrl + fill(source);
    case "default":
      if (isBlank(source)) return xtreamGuess() || shiftLink(liveUrl, start, now);
      if (/^http/i.test(source)) return fill(source);
      return liveUrl + fill(source);
    case "shift":
    case "timeshift":
      if (isBlank(source)) return xtreamGuess() || shiftLink(liveUrl, start, now);
      return shiftLink(liveUrl, start, now);
    case "flussonic":
    case "flussonic-hls":
    case "flussonic-ts":
    case "fs":
      return flussonicLink(liveUrl, start, duration);
    case "xc":
    case "xtream":
      return xtreamGuess();
    default:
      return source === null ? null : fill(source);
  }
}

/** The TS version of an Xtream HLS catch-up link, for panels that don't offer HLS. */
export function tsFallback(url) {
  const path = pathOf(url);
  if (!path.includes("/timeshift/") || !/\.m3u8$/i.test(path)) return null;
  return path.slice(0, -".m3u8".length) + ".ts" + url.slice(path.length);
}

/**
 * Other ways to ask for the same catch-up, tried in turn if [url] fails, because Xtream panels
 * differ: TS instead of HLS, only the part aired so far (a show still on air), just the show
 * (without the extra time after it), the older timeshift.php form, and the time written in the
 * other clock (this device's instead of the server's, or UTC when the server's is not known).
 * options: showMinutes, airedMinutes, deviceTimezone.
 */
export function catchupAlternatives(url, serverTimezone, options = {}) {
  const { showMinutes = null, airedMinutes = null, deviceTimezone = null } = options;
  const path = pathOf(url);
  const query = url.slice(path.length);
  const m = TIMESHIFT_LINK.exec(path);
  if (!m) {
    const ts = tsFallback(url);
    return ts ? [ts] : [];
  }
  const [, host, user, pass, minutes, stamp, id] = m;
  const ext = m[7] || "";
  const isHls = ext.toLowerCase() === ".m3u8";
  const sameExt = ext || ".ts";
  const otherExt = isHls ? ".ts" : ".m3u8";
  const base = `${host}/timeshift/${user}/${pass}`;
  const total = parseInt(minutes, 10) || 0;
  const out = new Set();
  out.add(`${base}/${minutes}/${stamp}/${id}${otherExt}${query}`);
  // A show still on air: only the part that has aired so far (in both forms). Before the other
  // forms, so a refusal doesn't end with the "other clock" link.
  if (airedMinutes != null) {
    const aired = Math.max(1, Math.trunc(airedMinutes));
    if (aired < total) {
      out.add(`${base}/${aired}/${stamp}/${id}${sameExt}${query}`);
      out.add(`${base}/${aired}/${stamp}/${id}${otherExt}${query}`);
    }
  }
  // Just the show, without the extra time after it (in both forms).
  if (showMinutes != null) {
    const short = Math.max(1, Math.trunc(showMinutes));
    if (short < total) {
      out.add(`${base}/${short}/${stamp}/${id}${sameExt}${query}`);
      out.add(`${base}/${short}/${stamp}/${id}${otherExt}${query}`);
    }
  }
  // timeshift.php form (some panels only answer this).
  out.add(
    `${host}/streaming/timeshift.php?username=${user}&password=${pass}&stream=${id}` +
      `&start=${stamp}&duration=${minutes}`
  );
  // Same request with the time written in the other clock (server vs device).
  const known = !isBlank(serverTimezone);
  const startMs = parseStamp(stamp, known ? String(serverTimezone).trim() : deviceTimezone || null);
  if (startMs !== null) {
    const other = formatStamp(startMs, known ? deviceTimezone || null : "UTC");
    if (other !== stamp) out.add(`${base}/${minutes}/${other}/${id}${sameExt}${query}`);
  }
  out.delete(url);
  return [...out];
}

/**
 * Xtream replay links name a whole minute (9:10, never 9:10:45): the replay really starts at the
 * start of that minute.
 */
export function wholeMinutes(url) {
  const path = pathOf(url);
  return TIMESHIFT_PATH.test(path) || /timeshift\.php$/i.test(path);
}

/**
 * Which kind of link [url] is, next to the first link tried ([primary]): "php", or "hls" / "ts",
 * plus "+clock" when the time is in the other clock and "+short" when it asks for a shorter
 * window. Remembered per provider so the next replay goes straight to the kind that worked.
 */
export function linkForm(url, primary) {
  const path = pathOf(url);
  if (/timeshift\.php$/i.test(path)) return "php";
  const ext = /\.m3u8$/i.test(path) ? "hls" : "ts";
  const m = TIMESHIFT_PATH.exec(path);
  const pm = TIMESHIFT_PATH.exec(pathOf(primary));
  const clock = m && pm && m[2] !== pm[2] ? "+clock" : "";
  const short = m && pm && (parseInt(m[1], 10) || 0) < (parseInt(pm[1], 10) || 0) ? "+short" : "";
  return ext + clock + short;
}

/**
 * [primary] and its [alternatives] in the order to try them: the kind of link that worked last
 * time on this provider ([form], from linkForm) first.
 */
export function preferForm(primary, alternatives, form) {
  const all = [primary, ...(alternatives || [])];
  if (!form) return all;
  // HLS switched off for this provider (it failed there): don't go back to it.
  if (form.startsWith("hls") && !/\.m3u8$/i.test(pathOf(primary))) return all;
  const pick =
    all.find((u) => linkForm(u, primary) === form) ||
    all.find((u) => linkForm(u, primary) === form.replace("+short", ""));
  if (!pick) return all;
  return [pick, ...all.filter((u) => u !== pick)];
}

// --- Whole plan -------------------------------------------------------------------------------

function pathPart(value) {
  const text = String(value);
  return /[/?#]/.test(text) ? encodeURIComponent(text) : text;
}

/**
 * The live link catch-up links are made from: for an Xtream account, rebuilt from the account
 * (server/live/user/pass/streamId.ext), otherwise the channel's own link.
 */
function catchupLiveUrl(channel, source) {
  const streamId = channel.xtream && channel.xtream.streamId;
  if (
    source &&
    source.type === "xtream" &&
    streamId != null &&
    String(streamId) !== "" &&
    !isBlank(source.server) &&
    !isBlank(source.username) &&
    !isBlank(source.password)
  ) {
    const own = XTREAM_LIVE.exec(String(channel.url || ""));
    const ext = (own && own[5]) || ".ts";
    const server = cleanXtreamServer(source.server);
    return `${server}/live/${pathPart(source.username)}/${pathPart(source.password)}/${streamId}${ext}`;
  }
  return String(channel.url || "");
}

/**
 * Everything needed to play [programme] from the archive, or null when it can't be:
 * { urls (in the order to try), primaryUrl, startMs (where playback should begin), leadMs (how
 * far before startMs a whole-minute Xtream replay really begins; skip it once playing) }.
 *
 * Asks for more than the show itself: up to CATCHUP_CONTINUE_MS past its end (but not past what
 * has aired), so shows that run over keep playing and the next show follows on.
 * offsetMs: start this far into the show. shiftMs: the guide's time shift minus the catch-up
 * shift (Android's epgOffset - catchupShift), taken off the asked-for times. lastForm: the
 * linkForm that worked last time on this provider.
 */
export function planCatchup({
  channel,
  programme,
  nowMs = Date.now(),
  serverTimezone = null,
  source = null,
  preferHls = false,
  offsetMs = 0,
  shiftMs = 0,
  lastForm = null,
  deviceTimezone = null
} = {}) {
  if (!canPlayCatchup(channel, programme, nowMs)) return null;
  const catchup = channel.catchup;
  const liveUrl = catchupLiveUrl(channel, source);
  if (!liveUrl) return null;
  const start = programme.startMs + Math.max(0, Number(offsetMs) || 0);
  const stop = Number.isFinite(programme.stopMs) ? programme.stopMs : start;
  const windowStop = Math.max(stop, Math.min(nowMs - 30000, stop + CATCHUP_CONTINUE_MS));
  const shift = Number(shiftMs) || 0;
  const url = buildCatchupUrl(liveUrl, catchup, start - shift, windowStop - shift, nowMs, {
    preferHls,
    serverTimezone,
    deviceTimezone
  });
  if (!url) return null;
  const correctionMs = Math.trunc((Number(catchup.correctionHours) || 0) * 3600000);
  const leadMs = wholeMinutes(url) ? floorMod(start - shift + correctionMs, 60000) : 0;
  const from = start - leadMs;
  const alternatives = catchupAlternatives(url, serverTimezone, {
    showMinutes: Math.trunc((stop - from) / 60000),
    airedMinutes: nowMs < stop ? Math.trunc((nowMs - from) / 60000) : null,
    deviceTimezone
  });
  return {
    urls: preferForm(url, alternatives, lastForm),
    primaryUrl: url,
    startMs: start,
    leadMs
  };
}

/**
 * Candidate catch-up links for [programme] on [channel], the preferred one first ([] when it
 * can't be replayed). channel = { url, catchup: { type, source, days, correctionHours } | null,
 * xtream: { streamId } | null }; programme = { startMs, stopMs, title }; source = the playlist
 * ({ type: "xtream" | "m3u", server, username, password }). See planCatchup for more options.
 */
export function buildCatchupUrls(options = {}) {
  const plan = planCatchup(options);
  return plan ? plan.urls : [];
}
