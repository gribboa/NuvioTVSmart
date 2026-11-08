// Nuvio Live: loads and refreshes the IPTV sources, their channels and the guide, and answers
// "what's on" for the UI. Cached channels show at once; playlists and guides refresh in the
// background when they're older than the settings allow, or on demand.
// Behaviour follows NuvioPlusIPTV (GPL-3.0): data/LiveTvRepository.kt and ui/LiveTvViewModel.kt.
import { LiveTvSourceStore } from "./data/sourceStore.js";
import { LiveTvChannelStore } from "./data/channelStore.js";
import { LiveTvEpgStore } from "./data/epgStore.js";
import { LiveTvSettings } from "./data/liveTvPreferences.js";
import { liveFetchFor, loopbackServiceUrl } from "./data/liveTvHttp.js";
import { parseM3u } from "./data/m3uParser.js";
import {
  alternateLiveFormat,
  fetchXtreamAccount,
  fetchXtreamLive,
  xtreamAccountProblem,
  xtreamEpgUrl,
  xtreamLiveStreamUrl
} from "./data/xtreamClient.js";
import { loadGuide } from "./data/guideLoader.js";
import { buildChannelMatchIndex, offerGuideMatch } from "./data/guideMatching.js";
import { LIVE_TV_SOURCE_TYPE } from "./model.js";

const HOUR_MS = 60 * 60 * 1000;
const GUIDE_MAP_KEY = "guideMap";
const GUIDE_STATUS_KEY = "guideStatus";
const ACCOUNTS_KEY = "accounts";
const M3U_GUIDES_KEY = "m3uGuides";
const PROGRAMME_CACHE_LIMIT = 400;

const listeners = new Set();
const state = {
  initialized: false,
  sources: [],
  channels: [],
  groups: [],
  byKey: new Map(),
  // sourceId -> { serverTimezone, preferredFormat, expiresAtMs, status, ... }
  accounts: {},
  // sourceId -> list of guide links named by the playlist (url-tvg)
  m3uGuides: {},
  // channelKey -> guideId
  guideMap: {},
  refreshingSources: new Set(),
  sourceErrors: {},
  guide: { loading: false, updatedAt: 0, error: "", progress: null, channels: 0, programmes: 0 }
};
// guideId -> { fromMs, toMs, programmes }
const programmeCache = new Map();
let initPromise = null;
let guideRun = null;

function emit(reason) {
  listeners.forEach((listener) => {
    try {
      listener(state, reason);
    } catch (error) {
      console.warn("Live TV listener failed", error);
    }
  });
}

export const TEST_PATTERN_SOURCE_ID = "livetv-test";

/** The built-in test pattern channel (Settings: "Test pattern channel"), first in the list. */
function withTestPattern(channels, groups) {
  const real = channels.filter((channel) => channel.sourceId !== TEST_PATTERN_SOURCE_ID);
  const realGroups = groups.filter((group) => group.sourceId !== TEST_PATTERN_SOURCE_ID);
  if (!LiveTvSettings.get().showTestPattern) return { channels: real, groups: realGroups };
  const group = {
    id: `${TEST_PATTERN_SOURCE_ID}:test`,
    title: "Test",
    sourceId: TEST_PATTERN_SOURCE_ID,
    order: 0
  };
  const channel = {
    key: `${TEST_PATTERN_SOURCE_ID}:pattern`,
    sourceId: TEST_PATTERN_SOURCE_ID,
    name: "Test pattern",
    tvgId: "",
    tvgName: "",
    logo: "",
    groupId: group.id,
    group: group.title,
    number: 0,
    url: loopbackServiceUrl("/livetv-test-pattern.mp4"),
    userAgent: "",
    catchup: null,
    xtream: null,
    testPattern: true
  };
  return { channels: [channel, ...real], groups: [group, ...realGroups] };
}

function setChannels(allChannels, allGroups) {
  const { channels, groups } = withTestPattern(allChannels, allGroups);
  state.channels = channels;
  state.groups = groups;
  state.byKey = new Map(channels.map((channel) => [channel.key, channel]));
}

async function reloadChannelsFromStore() {
  const { channels, groups } = await LiveTvChannelStore.loadAll(state.sources.map((s) => s.id));
  setChannels(channels, groups);
}

function stale(updatedAt, hours) {
  return !updatedAt || Date.now() - updatedAt > Math.max(1, Number(hours) || 1) * HOUR_MS;
}

function errorCode(error) {
  return String(error?.code || (error?.name === "AbortError" ? "aborted" : "network"));
}

async function refreshXtreamSource(source) {
  const fetchImpl = liveFetchFor(source);
  const account = await fetchXtreamAccount(source, { fetchImpl });
  state.accounts[source.id] = { ...account, checkedAt: Date.now() };
  await LiveTvEpgStore.setMeta(ACCOUNTS_KEY, state.accounts);
  const problem = xtreamAccountProblem(account);
  if (problem) {
    const error = new Error(problem);
    error.code = problem;
    throw error;
  }
  return fetchXtreamLive(source, {
    fetchImpl,
    format: account.preferredFormat || "ts"
  });
}

async function refreshM3uSource(source) {
  const response = await liveFetchFor(source)(source.url);
  const upstream = Number(response.headers?.get?.("x-upstream-status") || response.status);
  if (!response.ok || upstream >= 400) {
    const error = new Error(`http ${upstream}`);
    error.code = upstream === 401 || upstream === 403 ? "auth" : "http";
    throw error;
  }
  const text = await response.text();
  const parsed = parseM3u(text, { sourceId: source.id });
  if (!parsed.channels.length) {
    const error = new Error("empty playlist");
    error.code = "parse";
    throw error;
  }
  state.m3uGuides[source.id] = parsed.epgUrls || [];
  await LiveTvEpgStore.setMeta(M3U_GUIDES_KEY, state.m3uGuides);
  return parsed;
}

export const LiveTvRepository = {
  state,

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Loads the cache once; refreshes stale sources and guide in the background. */
  init() {
    if (!initPromise) {
      initPromise = (async () => {
        state.sources = LiveTvSourceStore.list();
        const [accounts, m3uGuides, guideMap, guideStatus] = await Promise.all([
          LiveTvEpgStore.getMeta(ACCOUNTS_KEY),
          LiveTvEpgStore.getMeta(M3U_GUIDES_KEY),
          LiveTvEpgStore.getMeta(GUIDE_MAP_KEY),
          LiveTvEpgStore.getMeta(GUIDE_STATUS_KEY)
        ]);
        state.accounts = accounts || {};
        state.m3uGuides = m3uGuides || {};
        state.guideMap = guideMap || {};
        state.guide = { ...state.guide, ...(guideStatus || {}), loading: false, progress: null };
        await reloadChannelsFromStore();
        state.initialized = true;
        emit("init");
        LiveTvSourceStore.subscribe(() => {
          state.sources = LiveTvSourceStore.list();
          void reloadChannelsFromStore().then(() => emit("sources"));
        });
        let showTestPattern = LiveTvSettings.get().showTestPattern;
        LiveTvSettings.subscribe((settings) => {
          if (settings.showTestPattern === showTestPattern) return;
          showTestPattern = settings.showTestPattern;
          setChannels(state.channels, state.groups);
          emit("sources");
        });
        void this.refreshIfStale();
      })().catch((error) => {
        initPromise = null;
        throw error;
      });
    }
    return initPromise;
  },

  async refreshIfStale() {
    const settings = LiveTvSettings.get();
    const staleSources = state.sources.filter(
      (source) =>
        source.enabled &&
        (stale(source.lastUpdatedMs, settings.playlistRefreshHours) ||
          !state.channels.some((channel) => channel.sourceId === source.id))
    );
    for (const source of staleSources) await this.refreshSource(source.id);
    if (state.sources.length && stale(state.guide.updatedAt, settings.guideRefreshHours)) {
      await this.refreshGuide();
    }
  },

  isRefreshing(sourceId) {
    return sourceId ? state.refreshingSources.has(sourceId) : state.refreshingSources.size > 0;
  },

  /** Reloads one source's playlist. Resolves to { ok, error? }. */
  async refreshSource(sourceId) {
    const source = LiveTvSourceStore.get(sourceId);
    if (!source || state.refreshingSources.has(sourceId)) return { ok: false, error: "busy" };
    state.refreshingSources.add(sourceId);
    emit("refreshing");
    try {
      const { channels, groups } =
        source.type === LIVE_TV_SOURCE_TYPE.XTREAM
          ? await refreshXtreamSource(source)
          : await refreshM3uSource(source);
      await LiveTvChannelStore.saveSource(source.id, { channels, groups });
      delete state.sourceErrors[source.id];
      LiveTvSourceStore.save({
        ...source,
        lastUpdatedMs: Date.now(),
        lastError: null,
        channelCount: channels.length,
        serverTimezone: state.accounts[source.id]?.serverTimezone || source.serverTimezone || ""
      });
      await reloadChannelsFromStore();
      return { ok: true, channels: channels.length };
    } catch (error) {
      const code = errorCode(error);
      console.warn("Live TV source refresh failed", code);
      state.sourceErrors[source.id] = code;
      LiveTvSourceStore.save({ ...source, lastError: code });
      return { ok: false, error: code };
    } finally {
      state.refreshingSources.delete(sourceId);
      emit("refreshed");
    }
  },

  async refreshAll() {
    for (const source of state.sources.filter((s) => s.enabled))
      await this.refreshSource(source.id);
    await this.refreshGuide();
  },

  async removeSource(sourceId) {
    LiveTvSourceStore.remove(sourceId);
    await LiveTvChannelStore.removeSource(sourceId);
    await LiveTvEpgStore.clearGuide(`x:${sourceId}`);
    await LiveTvEpgStore.clearGuide(`m:${sourceId}`);
    delete state.accounts[sourceId];
    delete state.m3uGuides[sourceId];
    await LiveTvEpgStore.setMeta(ACCOUNTS_KEY, state.accounts);
    state.sources = LiveTvSourceStore.list();
    await reloadChannelsFromStore();
    emit("sources");
  },

  /** The guides to read, in priority order. */
  guideTargets() {
    const targets = [];
    state.sources
      .filter((source) => source.enabled)
      .forEach((source) => {
        const userAgent = String(source.userAgent || "");
        if (source.type === LIVE_TV_SOURCE_TYPE.XTREAM) {
          targets.push({ guideKey: `x:${source.id}`, url: xtreamEpgUrl(source), userAgent });
          return;
        }
        const links = [
          source.epgUrl,
          ...(source.useEmbeddedEpg ? state.m3uGuides[source.id] || [] : [])
        ]
          .map((link) => String(link || "").trim())
          .filter(Boolean);
        Array.from(new Set(links)).forEach((url, index) =>
          targets.push({
            guideKey: index ? `m:${source.id}:${index}` : `m:${source.id}`,
            url,
            userAgent
          })
        );
      });
    (LiveTvSettings.get().extraGuideUrls || []).forEach((url, index) => {
      if (url) targets.push({ guideKey: `e:${index}`, url: String(url), userAgent: "" });
    });
    return targets;
  },

  /** Reads every guide again. Only one run at a time. */
  refreshGuide() {
    if (guideRun) return guideRun;
    guideRun = (async () => {
      const settings = LiveTvSettings.get();
      const now = Date.now();
      const windowStartMs = now - Math.max(1, settings.guidePastHours) * HOUR_MS;
      const windowEndMs = now + Math.max(1, settings.guideFutureDays) * 24 * HOUR_MS;
      const matchIndex = buildChannelMatchIndex(state.channels);
      const best = new Map();
      const targets = this.guideTargets();
      const errors = [];
      let programmes = 0;
      let guideChannels = 0;
      state.guide = {
        ...state.guide,
        loading: true,
        error: "",
        progress: { done: 0, total: targets.length }
      };
      emit("guide");
      for (let order = 0; order < targets.length; order += 1) {
        const target = targets[order];
        try {
          const result = await loadGuide({
            ...target,
            windowStartMs,
            windowEndMs,
            matchIndex,
            onMatch: (guideId, matches) =>
              matches.forEach(({ channelKey, quality }) =>
                offerGuideMatch(best, channelKey, guideId, quality, order)
              ),
            onProgress: (progress) => {
              state.guide.progress = { done: order, total: targets.length, ...progress };
              emit("guideProgress");
            }
          });
          programmes += result.programmes;
          guideChannels += result.guideChannels || 0;
        } catch (error) {
          console.warn("Live TV guide failed", errorCode(error), error?.status || "");
          errors.push({ code: errorCode(error), status: Number(error?.status || 0) });
        }
      }
      const guideMap = {};
      best.forEach((value, channelKey) => {
        guideMap[channelKey] = value.guideId;
      });
      // Keep the old mapping for channels a failed guide would have covered.
      state.guideMap = errors.length ? { ...state.guideMap, ...guideMap } : guideMap;
      programmeCache.clear();
      await LiveTvEpgStore.setMeta(GUIDE_MAP_KEY, state.guideMap);
      await LiveTvEpgStore.prune(windowStartMs);
      state.guide = {
        loading: false,
        updatedAt:
          errors.length === targets.length && targets.length ? state.guide.updatedAt : Date.now(),
        error: errors[0]?.code || "",
        errorStatus: errors[0]?.status || 0,
        progress: null,
        channels: Object.keys(state.guideMap).length,
        guideChannels,
        programmes
      };
      await LiveTvEpgStore.setMeta(GUIDE_STATUS_KEY, {
        updatedAt: state.guide.updatedAt,
        error: state.guide.error,
        errorStatus: state.guide.errorStatus,
        channels: state.guide.channels,
        guideChannels,
        programmes
      });
      emit("guide");
    })().finally(() => {
      guideRun = null;
    });
    return guideRun;
  },

  getChannel(channelKey) {
    return state.byKey.get(channelKey) || null;
  },

  hasGuide(channelKey) {
    return Boolean(state.guideMap[channelKey]);
  },

  /** Programmes of a channel overlapping [fromMs, toMs), from a small cache. */
  async getProgrammes(channelKey, fromMs, toMs) {
    const guideId = state.guideMap[channelKey];
    if (!guideId) return [];
    const cached = programmeCache.get(guideId);
    if (cached && cached.fromMs <= fromMs && cached.toMs >= toMs) {
      return cached.programmes.filter((p) => p.stopMs > fromMs && p.startMs < toMs);
    }
    // Read a wider window than asked so scrolling the guide doesn't hit the database each time.
    const readFrom = fromMs - 6 * HOUR_MS;
    const readTo = toMs + 12 * HOUR_MS;
    const programmes = await LiveTvEpgStore.getProgrammes(guideId, readFrom, readTo);
    if (programmeCache.size >= PROGRAMME_CACHE_LIMIT) {
      programmeCache.delete(programmeCache.keys().next().value);
    }
    programmeCache.set(guideId, { fromMs: readFrom, toMs: readTo, programmes });
    return programmes.filter((p) => p.stopMs > fromMs && p.startMs < toMs);
  },

  /** { now, next } programmes of a channel (either can be null). */
  async getNowNext(channelKey, atMs = Date.now()) {
    const programmes = await this.getProgrammes(channelKey, atMs, atMs + 12 * HOUR_MS);
    const now = programmes.find((p) => p.startMs <= atMs && p.stopMs > atMs) || null;
    const next = programmes.find((p) => p.startMs >= (now ? now.stopMs : atMs)) || null;
    return { now, next };
  },

  sourceFor(channel) {
    return channel ? LiveTvSourceStore.get(channel.sourceId) : null;
  },

  account(sourceId) {
    return state.accounts[sourceId] || null;
  },

  /** The User-Agent to play a channel with: the playlist's own, else the source's. */
  userAgentFor(channel) {
    return String(channel?.userAgent || this.sourceFor(channel)?.userAgent || "").trim();
  },

  /** Links to try for a live channel, best first (Xtream: the account's format, then the other). */
  streamCandidates(channel) {
    if (!channel) return [];
    const source = this.sourceFor(channel);
    if (source?.type === LIVE_TV_SOURCE_TYPE.XTREAM && channel.xtream?.streamId != null) {
      const preferred = state.accounts[source.id]?.preferredFormat || "ts";
      return [
        xtreamLiveStreamUrl(source, channel.xtream.streamId, preferred),
        xtreamLiveStreamUrl(source, channel.xtream.streamId, alternateLiveFormat(preferred))
      ];
    }
    return channel.url ? [channel.url] : [];
  }
};
