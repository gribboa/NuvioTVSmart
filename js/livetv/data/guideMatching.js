// Nuvio Live: which guide (XMLTV) channel belongs to which playlist channel.
// Ported from NuvioPlusIPTV (GPL-3.0), app/src/main/java/com/nuvio/tv/livetv/data/LiveTvRepository.kt
// (normalize, idName and the tvg-id / name matching in the guide load).

const QUALITY_TOKENS = /\b(fhd|uhd|hd|sd|4k|8k|hevc|h265|h264|1080p|720p|backup|raw)\b/g;
const PREFIX_TOKEN = /^[a-z]{2,3}\s*[:|]\s*/;
const BRACKETED = /\[.*?\]|\(.*?\)/g;
const COUNTRY_END = /(\.(com|co|net|tv))?\.[a-z]{2}$/i;
// Everything that isn't a letter or digit in ASCII; letters of other alphabets are kept.
const NOT_LETTER_OR_DIGIT = /[\s!-/:-@[-`{-~]/g;

/** "UK: BBC One HD" and "bbc one (backup)" both become "bbcone". */
export function normalizeChannelName(name) {
  let value = String(name || "")
    .toLowerCase()
    .trim();
  value = value.replace(PREFIX_TOKEN, "");
  value = value.replace(BRACKETED, " ");
  value = value.replace(QUALITY_TOKENS, " ");
  return value.replace(NOT_LETTER_OR_DIGIT, "");
}

/** A guide or tvg-id read as a name: "GloboSP.br" -> "globosp". */
export function idName(id) {
  return normalizeChannelName(
    String(id || "")
      .trim()
      .replace(COUNTRY_END, "")
  );
}

export const MATCH = Object.freeze({ ID: 2, NAME: 1 });

/** Lookup tables built once per guide load from the playlist channels. */
export function buildChannelMatchIndex(channels) {
  const byTvgId = new Map();
  const byName = new Map();
  const add = (map, key, channel) => {
    if (!key) return;
    const list = map.get(key) || [];
    if (!list.includes(channel.key)) list.push(channel.key);
    map.set(key, list);
  };
  channels.forEach((channel) => {
    if (channel.tvgId) add(byTvgId, channel.tvgId.toLowerCase(), channel);
    add(byName, normalizeChannelName(channel.tvgName), channel);
    add(byName, normalizeChannelName(channel.name), channel);
    const fromId = channel.tvgId ? idName(channel.tvgId) : "";
    if (fromId.length >= 3) add(byName, fromId, channel);
  });
  return { byTvgId, byName };
}

/**
 * The playlist channels a guide channel belongs to: [{ channelKey, quality }], where a tvg-id
 * match (MATCH.ID) beats a name match (MATCH.NAME).
 */
export function matchGuideChannel(index, xmltvId, names = []) {
  const found = new Map();
  (index.byTvgId.get(String(xmltvId || "").toLowerCase()) || []).forEach((key) =>
    found.set(key, MATCH.ID)
  );
  const nameKeys = new Set(
    [...names.map(normalizeChannelName), normalizeChannelName(xmltvId), idName(xmltvId)].filter(
      Boolean
    )
  );
  nameKeys.forEach((nameKey) => {
    (index.byName.get(nameKey) || []).forEach((key) => {
      if (!found.has(key)) found.set(key, MATCH.NAME);
    });
  });
  return Array.from(found, ([channelKey, quality]) => ({ channelKey, quality }));
}

/**
 * Keeps the best guide per playlist channel across several guides: a better match wins, then the
 * earlier guide (lower guideOrder). `best` maps channelKey -> { guideId, quality, guideOrder }.
 */
export function offerGuideMatch(best, channelKey, guideId, quality, guideOrder) {
  const current = best.get(channelKey);
  if (
    !current ||
    quality > current.quality ||
    (quality === current.quality && guideOrder < current.guideOrder)
  ) {
    best.set(channelKey, { guideId, quality, guideOrder });
  }
}
