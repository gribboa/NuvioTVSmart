// Nuvio Live: guide programmes in IndexedDB, indexed by [guideId, start] so the guide reads only
// the rows and hours it shows. guideId = `${guideKey}|${xmltv channel id}`, where guideKey names
// the guide a programme came from (an Xtream source's xmltv.php, or an XMLTV link).
// Ported from NuvioPlusIPTV (GPL-3.0), app/src/main/java/com/nuvio/tv/livetv/data/EpgDatabase.kt.
import { LIVE_TV_STORES, LiveTvDb, keyRange } from "./liveTvDb.js";

const MAX_PROGRAMME_MS = 24 * 60 * 60 * 1000;

export function guideIdFor(guideKey, xmltvChannelId) {
  return `${guideKey}|${xmltvChannelId}`;
}

export function programmeRecord(guideKey, programme) {
  const guideId = guideIdFor(guideKey, programme.channelId);
  return {
    id: `${guideId}|${programme.startMs}`,
    guideKey,
    guideId,
    startMs: programme.startMs,
    stopMs: programme.stopMs,
    title: programme.title || "",
    subTitle: programme.subTitle || "",
    description: programme.description || "",
    category: programme.category || "",
    episode: programme.episode || "",
    icon: programme.icon || "",
    year: programme.year || null
  };
}

export const LiveTvEpgStore = {
  /** Removes one guide's programmes (before it is loaded again, or when its source goes). */
  async clearGuide(guideKey) {
    await LiveTvDb.deleteByIndex(LIVE_TV_STORES.PROGRAMMES, "guideKey", guideKey);
  },

  async writeProgrammes(records) {
    if (records.length) await LiveTvDb.putMany(LIVE_TV_STORES.PROGRAMMES, records);
  },

  /** Programmes of one guide channel overlapping [fromMs, toMs), oldest first. */
  async getProgrammes(guideId, fromMs, toMs) {
    const range = keyRange([guideId, fromMs - MAX_PROGRAMME_MS], [guideId, toMs]);
    const records = range
      ? await LiveTvDb.getAllByIndex(LIVE_TV_STORES.PROGRAMMES, "guideStart", range)
      : (await LiveTvDb.getAll(LIVE_TV_STORES.PROGRAMMES)).filter(
          (record) => record.guideId === guideId && record.startMs < toMs
        );
    return records
      .filter((record) => record.stopMs > fromMs && record.startMs < toMs)
      .sort((a, b) => a.startMs - b.startMs);
  },

  /** Drops programmes that ended before `beforeMs` (older than the catch-up window). */
  async prune(beforeMs) {
    const range =
      typeof IDBKeyRange !== "undefined" ? IDBKeyRange.upperBound(beforeMs, true) : null;
    if (range) await LiveTvDb.deleteByIndex(LIVE_TV_STORES.PROGRAMMES, "stopMs", range);
  },

  async getMeta(key) {
    return (await LiveTvDb.get(LIVE_TV_STORES.META, key))?.value ?? null;
  },

  async setMeta(key, value) {
    await LiveTvDb.put(LIVE_TV_STORES.META, { key, value });
  }
};
