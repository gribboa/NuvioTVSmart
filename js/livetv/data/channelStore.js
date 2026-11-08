// Nuvio Live: channels and groups per source, cached in IndexedDB so the guide shows at once on
// launch while the playlists refresh in the background.
// Ported from NuvioPlusIPTV (GPL-3.0), app/src/main/java/com/nuvio/tv/livetv/data/LiveTvChannelStore.kt.
import { LIVE_TV_STORES, LiveTvDb } from "./liveTvDb.js";

function sortGroups(groups, sourceOrder) {
  return groups.slice().sort((a, b) => {
    const source = (sourceOrder.get(a.sourceId) ?? 999) - (sourceOrder.get(b.sourceId) ?? 999);
    return source || (a.order || 0) - (b.order || 0);
  });
}

export const LiveTvChannelStore = {
  /** Replaces one source's channels and groups. */
  async saveSource(sourceId, { channels = [], groups = [] } = {}) {
    await LiveTvDb.deleteByIndex(LIVE_TV_STORES.CHANNELS, "sourceId", sourceId);
    await LiveTvDb.deleteByIndex(LIVE_TV_STORES.GROUPS, "sourceId", sourceId);
    await LiveTvDb.putMany(
      LIVE_TV_STORES.CHANNELS,
      channels.map((channel, index) => ({ ...channel, sourceId, order: index }))
    );
    await LiveTvDb.putMany(
      LIVE_TV_STORES.GROUPS,
      groups.map((group, index) => ({ ...group, sourceId, order: group.order ?? index }))
    );
  },

  async removeSource(sourceId) {
    await LiveTvDb.deleteByIndex(LIVE_TV_STORES.CHANNELS, "sourceId", sourceId);
    await LiveTvDb.deleteByIndex(LIVE_TV_STORES.GROUPS, "sourceId", sourceId);
  },

  /**
   * Every cached channel and group, in source order (as listed in Settings), then the playlist's
   * own order. Channels of sources that no longer exist are left out.
   */
  async loadAll(sourceIds = []) {
    const sourceOrder = new Map(sourceIds.map((id, index) => [id, index]));
    const [channels, groups] = await Promise.all([
      LiveTvDb.getAll(LIVE_TV_STORES.CHANNELS),
      LiveTvDb.getAll(LIVE_TV_STORES.GROUPS)
    ]);
    const known = (item) => sourceOrder.has(item.sourceId);
    return {
      channels: channels.filter(known).sort((a, b) => {
        const source = sourceOrder.get(a.sourceId) - sourceOrder.get(b.sourceId);
        return source || (a.order || 0) - (b.order || 0);
      }),
      groups: sortGroups(groups.filter(known), sourceOrder)
    };
  }
};
