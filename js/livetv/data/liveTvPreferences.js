// Nuvio Live: settings (shared, this TV only) and per-profile state (favourites, last channel and
// group). Small values, so LocalStore; nothing here is synced to the Nuvio account.
// Defaults follow NuvioPlusIPTV's LiveTvSettings (GPL-3.0), model/LiveTvModels.kt.
import { LocalStore } from "../../core/storage/localStore.js";
import { ProfileManager } from "../../core/profile/profileManager.js";

const SETTINGS_KEY = "liveTvSettings";
const PROFILE_KEY_PREFIX = "liveTvProfile:";
const MAX_RECENT = 12;

export const LIVE_TV_SETTING_DEFAULTS = Object.freeze({
  // Guide window: how far back (catch-up) and ahead programmes are kept.
  guidePastHours: 48,
  guideFutureDays: 3,
  // Refresh on launch when older than this.
  guideRefreshHours: 12,
  playlistRefreshHours: 24,
  // Extra XMLTV links, used for every source.
  extraGuideUrls: [],
  // Group ids hidden from the guide's tabs.
  hiddenGroups: [],
  // Seconds the channel banner stays up after zapping.
  infoBannerSeconds: 5,
  showFavouritesRowOnHome: true,
  // Preview the focused channel in the guide.
  showPreview: true,
  // A built-in "Test pattern" channel (rulers and coloured edges) for checking the picture.
  showTestPattern: false,
  use24HourClock: true
});

const settingsListeners = new Set();

export const LiveTvSettings = {
  get() {
    const stored = LocalStore.get(SETTINGS_KEY, {});
    return { ...LIVE_TV_SETTING_DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
  },

  set(patch) {
    const next = { ...this.get(), ...patch };
    LocalStore.set(SETTINGS_KEY, next);
    settingsListeners.forEach((listener) => listener(next));
    return next;
  },

  subscribe(listener) {
    settingsListeners.add(listener);
    return () => settingsListeners.delete(listener);
  }
};

function profileKey() {
  return `${PROFILE_KEY_PREFIX}${ProfileManager.getActiveProfileId() || "default"}`;
}

function readProfileState() {
  const stored = LocalStore.get(profileKey(), {});
  return {
    favourites: Array.isArray(stored?.favourites) ? stored.favourites : [],
    recent: Array.isArray(stored?.recent) ? stored.recent : [],
    lastChannelKey: String(stored?.lastChannelKey || ""),
    previousChannelKey: String(stored?.previousChannelKey || ""),
    lastGroupId: String(stored?.lastGroupId || "")
  };
}

const profileListeners = new Set();

function writeProfileState(next) {
  LocalStore.set(profileKey(), next);
  profileListeners.forEach((listener) => listener(next));
  return next;
}

export const LiveTvProfileState = {
  get() {
    return readProfileState();
  },

  isFavourite(channelKey) {
    return readProfileState().favourites.includes(channelKey);
  },

  /** Adds or removes a favourite; returns whether it is now a favourite. */
  toggleFavourite(channelKey) {
    const state = readProfileState();
    const favourite = !state.favourites.includes(channelKey);
    state.favourites = favourite
      ? [...state.favourites, channelKey]
      : state.favourites.filter((key) => key !== channelKey);
    writeProfileState(state);
    return favourite;
  },

  /** Remembers the channel being watched (and the one before it, for "previous channel"). */
  setLastChannel(channelKey) {
    const state = readProfileState();
    if (!channelKey || state.lastChannelKey === channelKey) return;
    state.previousChannelKey = state.lastChannelKey;
    state.lastChannelKey = channelKey;
    state.recent = [channelKey, ...state.recent.filter((key) => key !== channelKey)].slice(
      0,
      MAX_RECENT
    );
    writeProfileState(state);
  },

  setLastGroup(groupId) {
    const state = readProfileState();
    if (state.lastGroupId === groupId) return;
    state.lastGroupId = String(groupId || "");
    writeProfileState(state);
  },

  subscribe(listener) {
    profileListeners.add(listener);
    return () => profileListeners.delete(listener);
  }
};
