// Nuvio Live: the "Favourite channels" row on Home (this profile's favourites, with what's on
// now). Installed once on HomeScreen (see router.js) so no Home file has to change:
//  - the row goes on top of the catalogue rows and is left out of the hero;
//  - OK on a channel plays it (Back returns to Home), hold does nothing;
//  - hidden when there are no favourites or the setting is off.
// Idea from NuvioPlusIPTV (GPL-3.0), home/LiveTvHomeRow.kt.
import { LiveTvRepository } from "../../../livetv/liveTvRepository.js";
import { LiveTvSourceStore } from "../../../livetv/data/sourceStore.js";
import { LiveTvProfileState, LiveTvSettings } from "../../../livetv/data/liveTvPreferences.js";
import { playLiveChannel } from "../../../livetv/liveTvPlayback.js";
import { TAB } from "./guideModel.js";
import { t } from "./liveTvScreenShared.js";

export const LIVE_TV_HOME_ROW_KEY = "livetv_favourites";
export const LIVE_TV_ITEM_TYPE = "livetv";
const NOW_REFRESH_MS = 5 * 60 * 1000;

const nowTitles = new Map();
let nowTitlesAt = 0;

function isLiveRow(row) {
  return row?.rowKind === LIVE_TV_ITEM_TYPE;
}

function withoutLiveRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => !isLiveRow(row));
}

function favouriteChannels() {
  if (!LiveTvSettings.get().showFavouritesRowOnHome) return [];
  return LiveTvProfileState.get()
    .favourites.map((key) => LiveTvRepository.getChannel(key))
    .filter(Boolean);
}

/** The Home row, or null when there's nothing to show. */
export function buildFavouriteChannelsRow() {
  const channels = favouriteChannels();
  if (!channels.length) return null;
  return {
    homeCatalogKey: LIVE_TV_HOME_ROW_KEY,
    homeCatalogDisableKey: LIVE_TV_HOME_ROW_KEY,
    rowKind: LIVE_TV_ITEM_TYPE,
    catalogName: t("livetv_home_row_title"),
    // Home adds " - <type>" to row titles unless the title already ends with it.
    type: "channels",
    result: {
      status: "success",
      data: {
        items: channels.map((channel) => ({
          id: channel.key,
          type: LIVE_TV_ITEM_TYPE,
          name: channel.name,
          poster: channel.logo || "",
          releaseInfo: nowTitles.get(channel.key) || ""
        }))
      }
    }
  };
}

async function refreshNowTitles(force = false) {
  if (!force && Date.now() - nowTitlesAt < NOW_REFRESH_MS) return false;
  nowTitlesAt = Date.now();
  const channels = favouriteChannels();
  await Promise.all(
    channels.map((channel) =>
      LiveTvRepository.getNowNext(channel.key)
        .then(({ now }) => nowTitles.set(channel.key, now?.title || ""))
        .catch(() => {})
    )
  );
  return true;
}

/** Puts the current row into Home's rows and repaints in the background. */
function applyRow(screen) {
  if (!Array.isArray(screen?.rows)) return;
  const row = buildFavouriteChannelsRow();
  const before = JSON.stringify(screen.rows.find(isLiveRow)?.result?.data?.items || null);
  const after = JSON.stringify(row?.result?.data?.items || null);
  if (before === after) return;
  screen.rows = row ? [row, ...withoutLiveRows(screen.rows)] : withoutLiveRows(screen.rows);
  try {
    screen.requestBackgroundRender?.();
  } catch (error) {
    console.warn("Live TV Home row render failed", error);
  }
}

async function loadForHome(screen) {
  if (!LiveTvSourceStore.list().length) return;
  try {
    await LiveTvRepository.init();
    await refreshNowTitles(true);
  } catch (error) {
    console.warn("Live TV Home row failed to load", error);
    return;
  }
  applyRow(screen);
}

export function installLiveHomeHooks(HomeScreen) {
  if (!HomeScreen || HomeScreen.__liveTvHooksInstalled) return;
  HomeScreen.__liveTvHooksInstalled = true;
  const original = {
    mount: HomeScreen.mount,
    sortAndFilterRows: HomeScreen.sortAndFilterRows,
    collectHeroCandidates: HomeScreen.collectHeroCandidates,
    pickHeroItem: HomeScreen.pickHeroItem,
    openDetailFromNode: HomeScreen.openDetailFromNode,
    openHoldMenuForNode: HomeScreen.openHoldMenuForNode
  };

  HomeScreen.mount = async function liveTvHomeMount(...args) {
    const result = await original.mount.apply(this, args);
    void loadForHome(this);
    return result;
  };

  HomeScreen.sortAndFilterRows = function liveTvSortAndFilterRows(rows, ...rest) {
    const sorted = original.sortAndFilterRows.call(this, withoutLiveRows(rows), ...rest);
    const row = buildFavouriteChannelsRow();
    return row ? [row, ...sorted] : sorted;
  };

  if (original.collectHeroCandidates) {
    HomeScreen.collectHeroCandidates = function liveTvHeroCandidates(rows, ...rest) {
      return original.collectHeroCandidates.call(this, withoutLiveRows(rows), ...rest);
    };
  }

  if (original.pickHeroItem) {
    HomeScreen.pickHeroItem = function liveTvPickHero(rows, ...rest) {
      return original.pickHeroItem.call(this, withoutLiveRows(rows), ...rest);
    };
  }

  HomeScreen.openDetailFromNode = function liveTvOpenFromHome(node, ...rest) {
    if (node?.dataset?.itemType !== LIVE_TV_ITEM_TYPE) {
      return original.openDetailFromNode.call(this, node, ...rest);
    }
    const channel = LiveTvRepository.getChannel(String(node.dataset.itemId || ""));
    if (!channel) return undefined;
    void playLiveChannel(channel, {
      zapKeys: LiveTvProfileState.get().favourites,
      tabId: TAB.FAVOURITES,
      nowTitle: nowTitles.get(channel.key) || "",
      returnRoute: "home"
    });
    return undefined;
  };

  if (original.openHoldMenuForNode) {
    HomeScreen.openHoldMenuForNode = function liveTvHoldOnHome(node, ...rest) {
      if (node?.dataset?.itemType === LIVE_TV_ITEM_TYPE) return undefined;
      return original.openHoldMenuForNode.call(this, node, ...rest);
    };
  }
}
