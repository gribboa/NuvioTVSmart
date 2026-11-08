// Nuvio Live: M3U / M3U8 (extended) playlist parser.
// Ported from NuvioPlusIPTV (GPL-3.0), app/src/main/java/com/nuvio/tv/livetv/data/M3uParser.kt
// (plus the channel numbering, grouping and keying from LiveTvRepository.buildChannels).

import { tidyLink } from "../model.js";

const UNCATEGORISED_KEY = "uncategorised";
const UNCATEGORISED_TITLE = "Uncategorised";

// Playlist-wide catch-up defaults a #EXTM3U line may set (TiviMate supports this).
const HEADER_CATCHUP_KEYS = [
  "catchup",
  "catchup-type",
  "catchup-source",
  "catchup-days",
  "catchup-correction",
  "tvg-rec",
  "timeshift"
];
const HEADER_EPG_KEYS = ["url-tvg", "x-tvg-url", "tvg-url"];
const KODI_HEADER_PROPS = ["stream_headers", "manifest_headers", "common_headers"];

// Many providers' "m3u_plus" links also list every movie and episode: not TV channels.
const VOD_PATH = /\/(movie|movies|series|vod)\//i;
const VOD_EXT = /\.(mp4|mkv|avi|mov|wmv|m4v|webm|flv)(\?|$)/i;

const INTEGER = /^[+-]?\d+$/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** Whether a playlist link is a movie or an episode rather than a live channel. */
export function isVodLink(url) {
  return VOD_PATH.test(url) || VOD_EXT.test(url);
}

/** A short stable hash (FNV-1a, 32 bit) as 8 hex digits. */
export function fnv1aHex(text) {
  let hash = 0x811c9dc5;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `0000000${(hash >>> 0).toString(16)}`.slice(-8);
}

function isKeyChar(code) {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 45 || // -
    code === 95 // _
  );
}

function isSpace(code) {
  return code === 32 || code === 9;
}

/** Index of the first comma outside double quotes (where the display name starts), or -1. */
function titleCommaIndex(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    if (code === 34) inQuotes = !inQuotes;
    else if (code === 44 && !inQuotes) return i;
  }
  return -1;
}

/**
 * key="value" and key=value attributes in line[0, end), lower-cased keys. Like the Kotlin
 * regexes: a quoted value wins over an unquoted one; the last quoted value and the first
 * unquoted value of a key are kept. A single linear scan (no regex backtracking).
 */
export function parseAttributes(line, end = line.length) {
  const quoted = Object.create(null);
  const unquoted = Object.create(null);
  let i = 0;
  while (i < end) {
    if (!isKeyChar(line.charCodeAt(i))) {
      i += 1;
      continue;
    }
    let keyEnd = i + 1;
    while (keyEnd < end && isKeyChar(line.charCodeAt(keyEnd))) keyEnd += 1;
    let k = keyEnd;
    while (k < end && isSpace(line.charCodeAt(k))) k += 1;
    if (k >= end || line.charCodeAt(k) !== 61) {
      i = keyEnd;
      continue;
    }
    k += 1;
    while (k < end && isSpace(line.charCodeAt(k))) k += 1;
    const key = line.slice(i, keyEnd).toLowerCase();
    if (k < end && line.charCodeAt(k) === 34) {
      const close = line.indexOf('"', k + 1);
      if (close < 0 || close >= end) {
        i = keyEnd;
        continue;
      }
      quoted[key] = line.slice(k + 1, close);
      i = close + 1;
      continue;
    }
    let valueEnd = k;
    while (valueEnd < end) {
      const code = line.charCodeAt(valueEnd);
      if (code === 32 || code === 9 || code === 34 || code === 44) break;
      valueEnd += 1;
    }
    if (valueEnd > k && key !== "extinf" && !(key in unquoted)) {
      let value = line.slice(k, valueEnd);
      // tvg-logo='http://…': single quotes aren't real quoting in M3U, but are common enough.
      if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
        value = value.slice(1, -1);
      }
      unquoted[key] = value;
    }
    i = Math.max(valueEnd, keyEnd);
  }
  const out = Object.create(null);
  Object.keys(unquoted).forEach((key) => {
    out[key] = unquoted[key];
  });
  Object.keys(quoted).forEach((key) => {
    out[key] = quoted[key];
  });
  return out;
}

function afterColon(line) {
  const colon = line.indexOf(":");
  return colon < 0 ? "" : line.slice(colon + 1);
}

function decodeFormValue(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch (_) {
    return value;
  }
}

/** The User-Agent from "User-Agent=…&Referer=…" (Kodi pipe headers / KODIPROP headers), or null. */
function userAgentFromPairs(text) {
  let found = null;
  text.split("&").forEach((part) => {
    const equals = part.indexOf("=");
    const key = (equals < 0 ? part : part.slice(0, equals)).trim().toLowerCase();
    if (key === "user-agent") found = decodeFormValue(equals < 0 ? "" : part.slice(equals + 1));
  });
  return found;
}

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/** The first of these attributes that is set and not blank. */
function firstPresent(attrs, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    if (present(attrs[keys[i]])) return attrs[keys[i]];
  }
  return undefined;
}

function toInt(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return INTEGER.test(text) ? parseInt(text, 10) : null;
}

function catchupFrom(attrs) {
  const rawType = firstPresent(attrs, ["catchup", "catchup-type"]);
  const type = present(rawType) ? String(rawType).trim().toLowerCase() : null;
  const days = toInt(firstPresent(attrs, ["catchup-days", "tvg-rec", "timeshift"]));
  if (type === null && !(days > 0)) return null;
  const correctionText = String(attrs["catchup-correction"] || "")
    .trim()
    .replace(",", ".");
  return {
    type: type || "default",
    source: present(attrs["catchup-source"]) ? attrs["catchup-source"] : null,
    days: days === null ? 1 : days,
    correctionHours: NUMBER.test(correctionText) ? parseFloat(correctionText) : 0
  };
}

function trimmedOrEmpty(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

/** One raw playlist entry from its #EXTINF line, link line and pending header lines. */
function buildEntry(info, extGroup, urlLine, pendingUserAgent, headerCatchup) {
  const comma = titleCommaIndex(info);
  // The channel's own attributes win over the playlist-wide catch-up defaults.
  const attrs = Object.assign(
    Object.create(null),
    headerCatchup,
    parseAttributes(info, comma < 0 ? info.length : comma)
  );
  const title = comma < 0 ? "" : info.slice(comma + 1).trim();
  const name = (title || trimmedOrEmpty(attrs["tvg-name"]) || "Channel").trim();

  let userAgent = pendingUserAgent;
  let url = urlLine;
  const pipe = urlLine.indexOf("|");
  if (pipe > 0) {
    url = urlLine.slice(0, pipe);
    const fromPipe = userAgentFromPairs(urlLine.slice(pipe + 1));
    if (fromPipe !== null) userAgent = fromPipe;
  }
  if (attrs["user-agent"] !== undefined) userAgent = attrs["user-agent"];
  if (attrs["http-user-agent"] !== undefined) userAgent = attrs["http-user-agent"];

  const groupRaw = trimmedOrEmpty(attrs["group-title"]) || extGroup || "";
  return {
    name,
    tvgId: trimmedOrEmpty(attrs["tvg-id"]),
    tvgName: trimmedOrEmpty(attrs["tvg-name"]),
    logo: trimmedOrEmpty(firstPresent(attrs, ["tvg-logo", "logo"])),
    group: groupRaw.split(";")[0].trim(),
    chno: toInt(firstPresent(attrs, ["tvg-chno", "channel-number", "tvg-num"])),
    url: url.trim(),
    userAgent: userAgent ? String(userAgent).trim() : "",
    catchup: catchupFrom(attrs)
  };
}

/**
 * Parses a playlist's text into channels and groups for one source.
 * Returns { channels, groups, epgUrls }. Movies/episodes ("m3u_plus" lists) are left out unless
 * skipVod is false. #KODIPROP DRM lines are ignored (the channel is kept).
 */
export function parseM3u(text, { sourceId, skipVod = true } = {}) {
  const sid = String(sourceId || "");
  const lines = String(text || "").split(/\r\n|\n|\r/);
  const epgUrls = [];
  const entries = [];
  const headerCatchup = Object.create(null);

  let pendingInfo = null;
  let pendingGroup = null;
  // Header lines (#EXTVLCOPT, #EXTHTTP, #KODIPROP) can come before or after #EXTINF; they are
  // cleared once the entry's link is read.
  let pendingUserAgent = "";
  let pendingProps = Object.create(null);

  for (let n = 0; n < lines.length; n += 1) {
    let line = lines[n].trim();
    if (line.charCodeAt(0) === 0xfeff) line = line.slice(1).trim();
    if (!line) continue;
    if (line.charCodeAt(0) === 35) {
      // "#"
      const upper = line.slice(0, 11).toUpperCase();
      if (upper.startsWith("#EXTM3U")) {
        const attrs = parseAttributes(line);
        HEADER_CATCHUP_KEYS.forEach((key) => {
          if (present(attrs[key])) headerCatchup[key] = attrs[key];
        });
        HEADER_EPG_KEYS.forEach((key) => {
          if (attrs[key] === undefined) return;
          attrs[key].split(",").forEach((part) => {
            const link = tidyLink(part);
            if (/^https?:\/\//i.test(link) && epgUrls.indexOf(link) < 0) epgUrls.push(link);
          });
        });
      } else if (upper.startsWith("#EXTINF")) {
        pendingInfo = line;
        pendingGroup = null;
      } else if (upper.startsWith("#EXTGRP:")) {
        pendingGroup = afterColon(line).trim() || null;
      } else if (upper.startsWith("#EXTVLCOPT:")) {
        const option = afterColon(line);
        const equals = option.indexOf("=");
        const key = (equals < 0 ? option : option.slice(0, equals)).trim().toLowerCase();
        if (key === "http-user-agent") pendingUserAgent = option.slice(equals + 1).trim();
      } else if (upper.startsWith("#KODIPROP:")) {
        // DRM is not supported; only the request headers are read.
        const prop = afterColon(line);
        const equals = prop.indexOf("=");
        const key = (equals < 0 ? prop : prop.slice(0, equals))
          .trim()
          .toLowerCase()
          .replace(/^inputstream\.adaptive\./, "")
          .replace(/^inputstream\./, "");
        if (KODI_HEADER_PROPS.indexOf(key) >= 0 && equals >= 0) {
          pendingProps[key] = prop.slice(equals + 1).trim();
        }
      } else if (upper.startsWith("#EXTHTTP:")) {
        // TiviMate-style request headers: #EXTHTTP:{"User-Agent":"…","Referer":"…"}
        try {
          const headers = JSON.parse(afterColon(line));
          if (headers && typeof headers === "object") {
            Object.keys(headers).forEach((key) => {
              if (key.toLowerCase() === "user-agent") pendingUserAgent = String(headers[key]);
            });
          }
        } catch (_) {}
      }
      continue;
    }
    if (pendingInfo !== null) {
      let userAgent = pendingUserAgent;
      KODI_HEADER_PROPS.forEach((key) => {
        if (!pendingProps[key]) return;
        const fromProp = userAgentFromPairs(pendingProps[key]);
        if (fromProp !== null) userAgent = fromProp;
      });
      const entry = buildEntry(pendingInfo, pendingGroup, line, userAgent, headerCatchup);
      if (!skipVod || !isVodLink(entry.url)) entries.push(entry);
    }
    pendingInfo = null;
    pendingGroup = null;
    pendingUserAgent = "";
    pendingProps = Object.create(null);
  }

  return { ...buildChannels(entries, sid), epgUrls };
}

function buildChannels(entries, sourceId) {
  const tvgIdCounts = Object.create(null);
  entries.forEach((entry) => {
    if (entry.tvgId) tvgIdCounts[entry.tvgId] = (tvgIdCounts[entry.tvgId] || 0) + 1;
  });

  const groups = [];
  const groupsByKey = Object.create(null);
  const usedKeys = Object.create(null);
  const channels = new Array(entries.length);

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const groupKey = entry.group.toLowerCase() || UNCATEGORISED_KEY;
    let group = groupsByKey[groupKey];
    if (!group) {
      group = {
        id: `${sourceId}:${groupKey}`,
        title: entry.group || UNCATEGORISED_TITLE,
        sourceId,
        order: groups.length
      };
      groupsByKey[groupKey] = group;
      groups.push(group);
    }

    // tvg-id when only one channel has it, else a hash of the link; a channel listed twice (same
    // link) gets "#2", "#3"… so keys stay unique.
    const baseKey = `${sourceId}:${
      entry.tvgId && tvgIdCounts[entry.tvgId] === 1 ? entry.tvgId : fnv1aHex(entry.url)
    }`;
    let key = baseKey;
    for (let copy = 2; usedKeys[key]; copy += 1) key = `${baseKey}#${copy}`;
    usedKeys[key] = true;

    channels[i] = {
      key,
      sourceId,
      name: entry.name,
      tvgId: entry.tvgId,
      tvgName: entry.tvgName,
      logo: entry.logo,
      groupId: group.id,
      group: group.title,
      number: entry.chno !== null && entry.chno > 0 ? entry.chno : i + 1,
      url: entry.url,
      userAgent: entry.userAgent,
      catchup: entry.catchup,
      xtream: null
    };
  }
  return { channels, groups };
}
