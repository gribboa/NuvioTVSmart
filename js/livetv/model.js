// Nuvio Live data model.
// Ported from NuvioPlusIPTV (GPL-3.0), app/src/main/java/com/nuvio/tv/livetv/model/LiveTvModels.kt
// (PlaylistSource and its companion helpers). Only what the web app uses is kept.

export const LIVE_TV_SOURCE_TYPE = Object.freeze({
  XTREAM: "xtream",
  M3U: "m3u"
});

// Dashes that only look like "-" (the longer dashes a phone keyboard or a chat app swaps in, the
// non-breaking hyphen) and invisible characters that come along with a paste.
const LOOKALIKE_DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const INVISIBLE_OR_SPACE = /[\u200B-\u200D\u2060\uFEFF\u00A0\s]/g;

/** A typed or pasted link made safe: lookalike dashes become "-", invisible characters and spaces go. */
export function tidyLink(raw) {
  return String(raw || "")
    .replace(LOOKALIKE_DASHES, "-")
    .replace(INVISIBLE_OR_SPACE, "");
}

/** Just scheme://host:port, even if a full link (get.php?..., player_api.php, /c/) was pasted. */
export function cleanXtreamServer(raw) {
  const text = String(raw || "").trim();
  const schemeLength = (text.match(/^[a-zA-Z]+:\/\//) || [""])[0].length;
  const slash = text.indexOf("/", schemeLength);
  const hostEnd = slash < 0 ? text.length : slash;
  // Whatever odd non-ASCII character the keyboard typed into the host name becomes a hyphen.
  const hostPart = text
    .slice(schemeLength, hostEnd)
    .replace(INVISIBLE_OR_SPACE, "")
    .replace(/[^\t-~]/g, "-");
  let link = tidyLink(text.slice(0, schemeLength) + hostPart + text.slice(hostEnd));
  if (!link) return link;
  if (!/^https?:\/\//i.test(link)) link = `http://${link}`;
  try {
    const url = new URL(link);
    if (!url.hostname) return link.replace(/\/+$/, "");
    return `${url.protocol.toLowerCase()}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch (_) {
    return link.replace(/\/+$/, "");
  }
}

function decodeQueryValue(value) {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, " "));
  } catch (_) {
    return String(value || "");
  }
}

/** Username and password from a pasted link like ".../get.php?username=a&password=b", or null. */
export function credentialsFromLink(raw) {
  const text = String(raw || "");
  const queryStart = text.indexOf("?");
  if (queryStart < 0) return null;
  const params = {};
  text
    .slice(queryStart + 1)
    .split("&")
    .forEach((pair) => {
      const equals = pair.indexOf("=");
      const key = (equals < 0 ? pair : pair.slice(0, equals)).toLowerCase();
      params[key] = decodeQueryValue(equals < 0 ? "" : pair.slice(equals + 1));
    });
  const username = String(params.username || "");
  const password = String(params.password || "");
  return username.trim() && password.trim() ? { username, password } : null;
}

export function createSourceId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `src_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function hostLabel(link) {
  try {
    return new URL(link).hostname || "";
  } catch (_) {
    return "";
  }
}

/**
 * A playlist source (shared by every profile). Xtream sources keep server/username/password;
 * M3U sources keep the playlist link and an optional guide (XMLTV) link.
 */
export function createPlaylistSource(fields = {}) {
  const type =
    fields.type === LIVE_TV_SOURCE_TYPE.M3U ? LIVE_TV_SOURCE_TYPE.M3U : LIVE_TV_SOURCE_TYPE.XTREAM;
  const base = {
    id: String(fields.id || createSourceId()),
    type,
    enabled: fields.enabled !== false,
    userAgent: String(fields.userAgent || ""),
    addedAt: Number(fields.addedAt || Date.now()),
    lastUpdatedMs: Number(fields.lastUpdatedMs || 0),
    lastError: fields.lastError ? String(fields.lastError) : null,
    channelCount: Number(fields.channelCount || 0)
  };
  if (type === LIVE_TV_SOURCE_TYPE.XTREAM) {
    const server = cleanXtreamServer(fields.server);
    return {
      ...base,
      name: String(fields.name || "").trim() || hostLabel(server) || "Xtream",
      server,
      username: String(fields.username || "").trim(),
      password: String(fields.password || "").trim(),
      // Xtream: the server's time zone (from its account info), used for catch-up times.
      serverTimezone: String(fields.serverTimezone || "")
    };
  }
  const url = tidyLink(fields.url);
  return {
    ...base,
    name: String(fields.name || "").trim() || hostLabel(url) || "M3U",
    url,
    epgUrl: tidyLink(fields.epgUrl),
    // Also load the guide link the playlist names in its header (url-tvg / x-tvg-url).
    useEmbeddedEpg: fields.useEmbeddedEpg !== false
  };
}

/**
 * What the phone (or the on-screen form) sent, checked and turned into a source.
 * Returns { source } or { error } where error is an i18n key suffix.
 */
export function sourceFromSubmission(submission = {}) {
  if (submission.type === LIVE_TV_SOURCE_TYPE.XTREAM) {
    const rawServer = String(submission.server || "");
    const fromLink = credentialsFromLink(rawServer);
    const username = String(submission.username || "").trim() || fromLink?.username || "";
    const password = String(submission.password || "").trim() || fromLink?.password || "";
    const server = cleanXtreamServer(rawServer);
    if (!server || !hostLabel(server)) return { error: "missing_server" };
    if (!username || !password) return { error: "missing_login" };
    return {
      source: createPlaylistSource({
        type: LIVE_TV_SOURCE_TYPE.XTREAM,
        name: submission.name,
        server,
        username,
        password
      })
    };
  }
  if (submission.type === LIVE_TV_SOURCE_TYPE.M3U) {
    const url = tidyLink(submission.url);
    const epgUrl = tidyLink(submission.epgUrl);
    if (!/^https?:\/\/[^/]+/i.test(url)) return { error: "invalid_url" };
    if (epgUrl && !/^https?:\/\/[^/]+/i.test(epgUrl)) return { error: "invalid_epg_url" };
    return {
      source: createPlaylistSource({
        type: LIVE_TV_SOURCE_TYPE.M3U,
        name: submission.name,
        url,
        epgUrl
      })
    };
  }
  return { error: "invalid_type" };
}

/** The password shown as dots, keeping its length roughly visible. */
export function maskSecret(value) {
  const length = String(value || "").length;
  return length ? "•".repeat(Math.min(Math.max(length, 6), 12)) : "";
}
