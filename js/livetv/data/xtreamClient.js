// Nuvio Live: Xtream Codes API client (player_api.php links, account info, live channels).
// Ported from NuvioPlusIPTV (GPL-3.0), app/src/main/java/com/nuvio/tv/livetv/data/LiveTvRepository.kt
// (downloadXtream, writeXtreamPlaylist, accountOf) and model/LiveTvModels.kt (PlaylistSource).
// Credentials are never logged, and error messages never include a link.

import { cleanXtreamServer } from "../model.js";

export const XTREAM_FORMATS = Object.freeze({ TS: "ts", HLS: "m3u8" });

const UNCATEGORISED_KEY = "uncategorised";
const UNCATEGORISED_TITLE = "Uncategorised";
const INTEGER = /^[+-]?\d+$/;
const STREAM_ID = /^\d+$/;

/**
 * Like Java's URLEncoder.encode(…, "UTF-8"), which the Kotlin app uses for the username and
 * password both in query strings and in /live/ paths: space becomes "+", and only
 * A-Z a-z 0-9 . - * _ are left as they are.
 */
function formEncode(value) {
  return encodeURIComponent(String(value === undefined || value === null ? "" : value).trim())
    .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

function credentialsQuery(source) {
  return `username=${formEncode(source.username)}&password=${formEncode(source.password)}`;
}

/** The server's base link (scheme://host:port), whatever was pasted. */
export function xtreamBase(source) {
  return cleanXtreamServer(source && source.server);
}

/** ${base}/player_api.php?username=…&password=…[&action=…][&key=value…] */
export function xtreamPlayerApiUrl(source, action, params) {
  let url = `${xtreamBase(source)}/player_api.php?${credentialsQuery(source)}`;
  if (action) url += `&action=${formEncode(action)}`;
  if (params) {
    Object.keys(params).forEach((key) => {
      const value = params[key];
      if (value === undefined || value === null) return;
      url += `&${formEncode(key)}=${formEncode(value)}`;
    });
  }
  return url;
}

/** The provider's guide (XMLTV) link. */
export function xtreamEpgUrl(source) {
  return `${xtreamBase(source)}/xmltv.php?${credentialsQuery(source)}`;
}

/** "ts" or "m3u8" (anything else counts as "ts"). */
function normalizeFormat(format) {
  return String(format || "").toLowerCase() === XTREAM_FORMATS.HLS
    ? XTREAM_FORMATS.HLS
    : XTREAM_FORMATS.TS;
}

/** ${base}/live/${user}/${pass}/${id}.ts (or .m3u8). */
export function xtreamLiveStreamUrl(source, streamId, format) {
  const user = formEncode(source.username);
  const pass = formEncode(source.password);
  return `${xtreamBase(source)}/live/${user}/${pass}/${String(streamId).trim()}.${normalizeFormat(format)}`;
}

/** The other live format: "ts" <-> "m3u8". */
export function alternateLiveFormat(format) {
  return normalizeFormat(format) === XTREAM_FORMATS.HLS ? XTREAM_FORMATS.TS : XTREAM_FORMATS.HLS;
}

function toInt(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return INTEGER.test(text) ? parseInt(text, 10) : null;
}

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The format to ask for on "auto": .ts unless the account only allows HLS (some panels turn .ts
 * off; asking for it then fails on every channel).
 */
export function preferredXtreamFormat(allowedFormats) {
  const allowed = allowedFormats || [];
  return allowed.length &&
    allowed.indexOf(XTREAM_FORMATS.TS) < 0 &&
    allowed.indexOf(XTREAM_FORMATS.HLS) >= 0
    ? XTREAM_FORMATS.HLS
    : XTREAM_FORMATS.TS;
}

/** player_api.php (no action) response -> the account details worth keeping. */
export function mapXtreamAccount(json) {
  const userInfo = isObject(json) && isObject(json.user_info) ? json.user_info : {};
  const serverInfo = isObject(json) && isObject(json.server_info) ? json.server_info : {};
  const expSeconds = toInt(userInfo.exp_date);
  const allowedFormats = [];
  (Array.isArray(userInfo.allowed_output_formats) ? userInfo.allowed_output_formats : []).forEach(
    (format) => {
      const value = text(format).toLowerCase();
      if (value && allowedFormats.indexOf(value) < 0) allowedFormats.push(value);
    }
  );
  return {
    status: text(userInfo.status),
    expiresAtMs: expSeconds !== null && expSeconds > 0 ? expSeconds * 1000 : 0,
    maxConnections: toInt(userInfo.max_connections) || 0,
    activeConnections: toInt(userInfo.active_cons) || 0,
    serverTimezone: text(serverInfo.timezone),
    allowedFormats,
    preferredFormat: preferredXtreamFormat(allowedFormats)
  };
}

/**
 * Why the Kotlin app refused to load an account it could log in to: "disabled" (status other
 * than Active), "expired", or null.
 */
export function xtreamAccountProblem(account, nowMs = Date.now()) {
  if (!account) return null;
  if (account.status && account.status.toLowerCase() !== "active") return "disabled";
  if (account.expiresAtMs > 0 && account.expiresAtMs < nowMs) return "expired";
  return null;
}

/** Most panels send a list; some send the items keyed by number ({"0": {...}, "1": {...}}). */
function listOf(json) {
  if (Array.isArray(json)) return json;
  if (isObject(json)) return Object.keys(json).map((key) => json[key]);
  return [];
}

function hasArchive(stream) {
  const value = stream.tv_archive;
  return value === true || text(value) === "1";
}

/**
 * get_live_categories + get_live_streams responses -> { groups, channels } for one source.
 * Groups keep the provider's category order (only categories with channels); channels in an
 * unknown category go to "Uncategorised", last.
 */
export function mapXtreamLive(categoriesJson, streamsJson, { sourceId, source, format } = {}) {
  const sid = String(sourceId || (source && source.id) || "");
  const ext = normalizeFormat(format);

  const categoryOrder = [];
  const categories = Object.create(null);
  listOf(categoriesJson).forEach((category) => {
    if (!isObject(category)) return;
    const id = text(category.category_id);
    if (!id || categories[id]) return;
    categories[id] = {
      id: `${sid}:${id}`,
      title: text(category.category_name) || `Category ${id}`,
      sourceId: sid,
      order: categoryOrder.length
    };
    categoryOrder.push(id);
  });

  const used = Object.create(null);
  const usedKeys = Object.create(null);
  let uncategorised = null;
  const channels = [];
  listOf(streamsJson).forEach((stream) => {
    if (!isObject(stream)) return;
    const streamId = text(stream.stream_id);
    if (!STREAM_ID.test(streamId)) return;
    const key = `${sid}:x${streamId}`;
    // The same stream listed twice: the first one is kept.
    if (usedKeys[key]) return;
    usedKeys[key] = true;

    let categoryId = text(stream.category_id);
    if (!categoryId && Array.isArray(stream.category_ids) && stream.category_ids.length) {
      categoryId = text(stream.category_ids[0]);
    }
    let group = categories[categoryId];
    if (!group) {
      if (!uncategorised) {
        uncategorised = {
          id: `${sid}:${UNCATEGORISED_KEY}`,
          title: UNCATEGORISED_TITLE,
          sourceId: sid,
          order: categoryOrder.length
        };
      }
      group = uncategorised;
    }
    used[group.id] = true;

    const num = toInt(stream.num);
    const name =
      text(stream.name)
        .replace(/[\r\n]+/g, " ")
        .trim() || `Channel ${streamId}`;
    let catchup = null;
    if (hasArchive(stream)) {
      const days = toInt(stream.tv_archive_duration);
      catchup = { type: "xtream", source: null, days: days > 0 ? days : 1, correctionHours: 0 };
    }
    channels.push({
      key,
      sourceId: sid,
      name,
      tvgId: text(stream.epg_channel_id),
      tvgName: name,
      logo: text(stream.stream_icon),
      groupId: group.id,
      group: group.title,
      number: num !== null && num > 0 ? num : channels.length + 1,
      url: xtreamLiveStreamUrl(source || {}, streamId, ext),
      userAgent: "",
      catchup,
      xtream: { streamId: parseInt(streamId, 10) }
    });
  });

  const groups = categoryOrder.map((id) => categories[id]).filter((group) => used[group.id]);
  if (uncategorised) groups.push(uncategorised);
  return { groups, channels };
}

/** An Error with a code: "auth", "http", "parse" or "network". */
function xtreamError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function isAbort(error, signal) {
  return (signal && signal.aborted) || (error && error.name === "AbortError");
}

/** GET a player_api.php link as JSON. Errors never mention the link (it has the password). */
async function getJson(url, { fetchImpl, signal, userAgent, what }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const init = { method: "GET", signal };
  if (userAgent) init.headers = { "User-Agent": userAgent };
  let response;
  try {
    response = await doFetch(url, init);
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    throw xtreamError("network", `Xtream ${what}: could not reach the server`);
  }
  const status = Number(response.status) || 0;
  if (status === 401 || status === 403) {
    throw xtreamError("auth", `Xtream ${what}: the provider refused the login (HTTP ${status})`, {
      status
    });
  }
  if (!response.ok) {
    throw xtreamError("http", `Xtream ${what}: HTTP ${status}`, { status });
  }
  let body;
  try {
    body = await response.text();
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    throw xtreamError("network", `Xtream ${what}: the connection dropped`);
  }
  try {
    return JSON.parse(body);
  } catch (_) {
    throw xtreamError("parse", `Xtream ${what}: the server did not send JSON`);
  }
}

/** Logs in (player_api.php without an action) and returns mapXtreamAccount(…). */
export async function fetchXtreamAccount(source, { fetchImpl, signal, userAgent } = {}) {
  const json = await getJson(xtreamPlayerApiUrl(source), {
    fetchImpl,
    signal,
    userAgent,
    what: "account"
  });
  if (!isObject(json) || !("user_info" in json)) {
    throw xtreamError("parse", "Xtream account: not an Xtream API response");
  }
  if (isObject(json.user_info) && text(json.user_info.auth) === "0") {
    throw xtreamError("auth", "Xtream account: login failed, check the username and password");
  }
  return mapXtreamAccount(json);
}

/**
 * Categories and live streams (fetched together) -> mapXtreamLive(…). Like the Kotlin app, a
 * failed category list is not fatal: the channels then all land in "Uncategorised".
 */
export async function fetchXtreamLive(source, { fetchImpl, signal, userAgent, format } = {}) {
  const options = { fetchImpl, signal, userAgent };
  const categoriesRequest = getJson(xtreamPlayerApiUrl(source, "get_live_categories"), {
    ...options,
    what: "categories"
  }).catch((error) => {
    if (isAbort(error, signal)) throw error;
    return [];
  });
  const streamsRequest = getJson(xtreamPlayerApiUrl(source, "get_live_streams"), {
    ...options,
    what: "live streams"
  });
  const results = await Promise.all([categoriesRequest, streamsRequest]);
  const streams = results[1];
  if (!Array.isArray(streams) && !isObject(streams)) {
    throw xtreamError("parse", "Xtream live streams: not a list of channels");
  }
  return mapXtreamLive(results[0], streams, { sourceId: source.id, source, format });
}
