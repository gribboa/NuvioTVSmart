// Nuvio Live: what the player does differently for a Live TV channel. Installed once on
// PlayerScreen (see router.js) so no player file has to change; does nothing for other playback.
//  - CH +/- and Up/Down zap through the guide's current group (wrapping round), with a short
//    pause so pressing several times only tunes the last channel.
//  - An info banner (logo, now/next, progress) on start and on every zap; OK shows it.
//  - A quick channel list on Left (or OK while the banner is up) over the playing video.
//  - Right opens the player's own controls (audio, subtitles, ...).
//  - A failing stream is tried once more, then in the other format, before the error shows.
//  - Back returns to the guide on the channel being watched.
// Behaviour follows NuvioPlusIPTV (GPL-3.0): ui/LiveTvPlayerPanel.kt, ui/LiveTvOverlayMode.kt,
// player/LiveTvPlaybackController.kt.
import { Router } from "../../navigation/routerState.js";
import { PlayerController } from "../../../core/player/playerController.js";
import { LiveTvRepository } from "../../../livetv/liveTvRepository.js";
import { LiveTvProfileState, LiveTvSettings } from "../../../livetv/data/liveTvPreferences.js";
import { liveCandidatesFor } from "../../../livetv/liveTvPlayback.js";
import { escapeHtml, t } from "./liveTvScreenShared.js";
import { defaultFormatTime, moveIndex, progressOf } from "./guideModel.js";

const ZAP_SETTLE_MS = 450;
const QUICK_LIST_ROWS = 9;
const KEY = Object.freeze({
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  OK: 13,
  PAGE_UP: 33,
  PAGE_DOWN: 34,
  CHANNEL_UP: 427,
  CHANNEL_DOWN: 428,
  INFO: 457
});

function isLiveTvChannel(screen) {
  return Boolean(screen?.params?.liveTv?.channelKey) && !screen.params.liveTv.catchup;
}

function isLiveTvPlayback(screen) {
  return Boolean(screen?.params?.liveTv?.channelKey);
}

function formatTime(ms) {
  return defaultFormatTime(ms, LiveTvSettings.get().use24HourClock !== false);
}

function logoMarkup(channel, className) {
  return channel?.logo
    ? `<img class="${className}" src="${escapeHtml(channel.logo)}" alt="" onerror="this.style.visibility='hidden'" />`
    : "";
}

function syntheticKey(event, keyCode) {
  return {
    keyCode,
    originalKeyCode: keyCode,
    key: keyCode === KEY.DOWN ? "ArrowDown" : "",
    code: keyCode === KEY.DOWN ? "ArrowDown" : "",
    repeat: false,
    target: event?.target || null,
    preventDefault: () => event?.preventDefault?.(),
    stopPropagation: () => event?.stopPropagation?.(),
    stopImmediatePropagation: () => event?.stopImmediatePropagation?.()
  };
}

function zapList(screen) {
  const keys = screen.params?.liveTv?.zapKeys;
  if (Array.isArray(keys) && keys.length) return keys;
  return LiveTvRepository.state.channels.map((channel) => channel.key);
}

// ---- On-screen display (banner + quick list) ----------------------------------------------

function osdRoot(screen) {
  let root = screen.container?.querySelector("#livetvOsd");
  if (!root && screen.container) {
    root = document.createElement("div");
    root.id = "livetvOsd";
    root.className = "livetv-osd";
    root.innerHTML =
      '<div class="livetv-banner" id="livetvBanner"></div><div class="livetv-quicklist" id="livetvQuickList"></div>';
    screen.container.appendChild(root);
  }
  return root;
}

async function showBanner(screen, channelKey = screen.params?.liveTv?.channelKey) {
  const root = osdRoot(screen);
  const banner = root?.querySelector("#livetvBanner");
  const channel = LiveTvRepository.getChannel(channelKey);
  if (!banner || !channel) return;
  const state = screen.liveTvOsd;
  clearTimeout(state.bannerTimer);
  const render = (now, next) => {
    const nowMs = Date.now();
    banner.innerHTML = `
      <div class="livetv-banner-channel">
        ${logoMarkup(channel, "livetv-banner-logo")}
        <div>
          <div class="livetv-banner-name">${escapeHtml(channel.number ? `${channel.number}  ${channel.name}` : channel.name)}</div>
          <div class="livetv-banner-group">${escapeHtml(channel.group || "")}</div>
        </div>
        <div class="livetv-banner-clock">${escapeHtml(formatTime(nowMs))}</div>
      </div>
      <div class="livetv-banner-now">
        ${
          now
            ? `<span class="livetv-banner-time">${escapeHtml(`${formatTime(now.startMs)} – ${formatTime(now.stopMs)}`)}</span>
               <span class="livetv-banner-title">${escapeHtml(now.title)}</span>
               ${now.episode ? `<span class="livetv-banner-episode">${escapeHtml(now.episode)}</span>` : ""}`
            : `<span class="livetv-banner-title">${escapeHtml(t("livetv_no_info"))}</span>`
        }
      </div>
      ${now ? `<div class="livetv-progress"><div style="width:${progressOf(now, nowMs) * 100}%"></div></div>` : ""}
      ${now?.description ? `<p class="livetv-banner-description">${escapeHtml(now.description)}</p>` : ""}
      ${next ? `<div class="livetv-banner-next">${escapeHtml(t("livetv_next", { time: formatTime(next.startMs), title: next.title }))}</div>` : ""}
    `;
  };
  render(null, null);
  // The banner stands in for the player's own controls on a live channel.
  if (screen.controlsVisible) {
    try {
      screen.setControlsVisible?.(false);
    } catch (_) {
      // Controls aren't mounted yet.
    }
  }
  root.classList.add("banner-visible");
  state.bannerVisible = true;
  state.bannerTimer = setTimeout(
    () => hideBanner(screen),
    Math.max(2, Number(LiveTvSettings.get().infoBannerSeconds) || 5) * 1000
  );
  const { now, next } = await LiveTvRepository.getNowNext(channel.key);
  if (
    screen.liveTvOsd === state &&
    state.bannerVisible &&
    (state.bannerKey || channel.key) === channel.key
  ) {
    render(now, next);
  }
}

function hideBanner(screen) {
  const state = screen.liveTvOsd;
  if (!state) return;
  clearTimeout(state.bannerTimer);
  state.bannerVisible = false;
  screen.container?.querySelector("#livetvOsd")?.classList.remove("banner-visible");
}

function renderQuickList(screen) {
  const state = screen.liveTvOsd;
  const node = osdRoot(screen)?.querySelector("#livetvQuickList");
  if (!node || !state?.quickList) return;
  const keys = zapList(screen);
  const { index } = state.quickList;
  const top = Math.max(
    0,
    Math.min(index - Math.floor(QUICK_LIST_ROWS / 2), keys.length - QUICK_LIST_ROWS)
  );
  const playing = screen.params?.liveTv?.channelKey;
  const rows = keys.slice(top, top + QUICK_LIST_ROWS).map((key, offset) => {
    const channel = LiveTvRepository.getChannel(key);
    if (!channel) return "";
    const nowTitle = state.quickList.nowTitles.get(key);
    return `
      <div class="livetv-quick-row${top + offset === index ? " focused" : ""}${key === playing ? " playing" : ""}">
        <span class="livetv-chan-number">${escapeHtml(channel.number || "")}</span>
        ${logoMarkup(channel, "livetv-chan-logo")}
        <div class="livetv-quick-text">
          <span class="livetv-quick-name">${escapeHtml(channel.name)}</span>
          <span class="livetv-quick-now">${escapeHtml(nowTitle || "")}</span>
        </div>
      </div>`;
  });
  node.innerHTML = `<div class="livetv-quick-title">${escapeHtml(t("livetv_quick_list_title"))}</div>${rows.join("")}`;
  // Fill in what's on for the rows shown.
  keys.slice(top, top + QUICK_LIST_ROWS).forEach((key) => {
    if (state.quickList.nowTitles.has(key)) return;
    state.quickList.nowTitles.set(key, "");
    void LiveTvRepository.getNowNext(key).then(({ now }) => {
      if (screen.liveTvOsd !== state || !state.quickList) return;
      state.quickList.nowTitles.set(key, now?.title || "");
      renderQuickList(screen);
    });
  });
}

function openQuickList(screen) {
  const state = screen.liveTvOsd;
  const keys = zapList(screen);
  hideBanner(screen);
  state.quickList = {
    index: Math.max(0, keys.indexOf(screen.params.liveTv.channelKey)),
    nowTitles: state.quickList?.nowTitles || new Map()
  };
  osdRoot(screen)?.classList.add("quicklist-visible");
  renderQuickList(screen);
}

function closeQuickList(screen) {
  const state = screen.liveTvOsd;
  if (!state?.quickList) return false;
  state.quickList = null;
  screen.container?.querySelector("#livetvOsd")?.classList.remove("quicklist-visible");
  return true;
}

function handleQuickListKey(screen, code) {
  const state = screen.liveTvOsd;
  const keys = zapList(screen);
  if (code === KEY.UP || code === KEY.DOWN) {
    state.quickList.index = moveIndex(
      state.quickList.index,
      code === KEY.UP ? -1 : 1,
      keys.length,
      { wrap: true }
    );
    renderQuickList(screen);
  } else if (
    code === KEY.PAGE_UP ||
    code === KEY.CHANNEL_UP ||
    code === KEY.PAGE_DOWN ||
    code === KEY.CHANNEL_DOWN
  ) {
    const delta =
      code === KEY.PAGE_UP || code === KEY.CHANNEL_UP ? -QUICK_LIST_ROWS : QUICK_LIST_ROWS;
    state.quickList.index = moveIndex(state.quickList.index, delta, keys.length);
    renderQuickList(screen);
  } else if (code === KEY.OK) {
    const key = keys[state.quickList.index];
    closeQuickList(screen);
    if (key && key !== screen.params.liveTv.channelKey) void tuneTo(screen, key);
  } else if (code === KEY.LEFT || code === KEY.RIGHT) {
    closeQuickList(screen);
  }
  return true;
}

// ---- Zapping ------------------------------------------------------------------------------

function zapBy(screen, delta) {
  const state = screen.liveTvOsd;
  const keys = zapList(screen);
  if (!keys.length) return;
  const from = state.pendingKey || screen.params.liveTv.channelKey;
  const index = keys.indexOf(from);
  const nextKey = keys[moveIndex(index < 0 ? 0 : index, delta, keys.length, { wrap: true })];
  if (!nextKey) return;
  state.pendingKey = nextKey;
  state.bannerKey = nextKey;
  void showBanner(screen, nextKey);
  clearTimeout(state.zapTimer);
  state.zapTimer = setTimeout(() => {
    state.pendingKey = "";
    void tuneTo(screen, nextKey);
  }, ZAP_SETTLE_MS);
}

/** Switches the playing channel in place (no route change, so it's quick). */
async function tuneTo(screen, channelKey) {
  const channel = LiveTvRepository.getChannel(channelKey);
  if (!channel || !isLiveTvChannel(screen)) return;
  const candidates = liveCandidatesFor(channel);
  if (!candidates.length) return;
  const state = screen.liveTvOsd;
  state.tried = new Set();
  state.retried = false;
  state.bannerKey = channel.key;
  const { now } = await LiveTvRepository.getNowNext(channel.key);
  screen.params = {
    ...screen.params,
    playerTitle: channel.name,
    playerSubtitle: now?.title || "",
    playerLogoUrl: channel.logo || "",
    streamCandidates: candidates,
    preferredStreamId: candidates[0].id,
    liveTv: { ...screen.params.liveTv, channelKey: channel.key },
    returnRouteParams:
      screen.params.returnRouteOnBack === "liveTv"
        ? { ...(screen.params.returnRouteParams || {}), focusChannelKey: channel.key }
        : screen.params.returnRouteParams || {}
  };
  screen.streamCandidates =
    typeof screen.normalizeStreamCandidates === "function"
      ? screen.normalizeStreamCandidates(candidates)
      : candidates;
  LiveTvProfileState.setLastChannel(channel.key);
  try {
    screen.clearStartupError?.();
  } catch (_) {
    // No error was showing.
  }
  try {
    screen.refreshLoadingOverlayPresentation?.();
  } catch (_) {
    // The loading overlay isn't mounted yet.
  }
  void showBanner(screen, channel.key);
  await screen.playStreamCandidate(screen.streamCandidates[0], {
    mountToken: screen.playerMountToken
  });
}

/** Before the player gives up: retry once, then the other stream format. */
function tryLiveFallback(screen) {
  const state = screen.liveTvOsd;
  if (!state) return false;
  const current = screen.getCurrentStreamCandidate?.() || screen.streamCandidates?.[0];
  const currentUrl = current?.url || screen.activePlaybackUrl || "";
  if (!state.retried && currentUrl) {
    state.retried = true;
    state.tried.add(currentUrl);
    void screen.playStreamCandidate(current, { mountToken: screen.playerMountToken });
    return true;
  }
  if (currentUrl) state.tried.add(currentUrl);
  const next = (screen.streamCandidates || []).find((candidate) => !state.tried.has(candidate.url));
  if (!next) return false;
  state.tried.add(next.url);
  void screen.playStreamCandidate(next, { mountToken: screen.playerMountToken });
  return true;
}

// ---- Install ------------------------------------------------------------------------------

export function installLivePlayerHooks(PlayerScreen) {
  if (!PlayerScreen || PlayerScreen.__liveTvHooksInstalled) return;
  PlayerScreen.__liveTvHooksInstalled = true;
  const original = {
    mount: PlayerScreen.mount,
    cleanup: PlayerScreen.cleanup,
    onKeyDown: PlayerScreen.onKeyDown,
    consumeBackRequest: PlayerScreen.consumeBackRequest,
    showStartupError: PlayerScreen.showStartupError,
    navigateBackToStreamScreen: PlayerScreen.navigateBackToStreamScreen
  };

  PlayerScreen.mount = async function liveTvMount(...args) {
    this.liveTvOsd = null;
    if (globalThis.__NUVIO_DEBUG_LIVETV__) globalThis.__nuvioPlayerScreen = this;
    const result = await original.mount.apply(this, args);
    if (isLiveTvPlayback(this)) {
      this.liveTvOsd = { tried: new Set(), retried: false, quickList: null, bannerVisible: false };
      if (isLiveTvChannel(this)) void showBanner(this);
    }
    return result;
  };

  PlayerScreen.cleanup = function liveTvCleanup(...args) {
    const state = this.liveTvOsd;
    if (state) {
      clearTimeout(state.bannerTimer);
      clearTimeout(state.zapTimer);
      this.container?.querySelector("#livetvOsd")?.remove();
      this.liveTvOsd = null;
    }
    return original.cleanup.apply(this, args);
  };

  PlayerScreen.onKeyDown = function liveTvKeyDown(event) {
    if (!isLiveTvChannel(this) || !this.liveTvOsd) return original.onKeyDown.call(this, event);
    const code = Number(event?.keyCode || 0);
    const state = this.liveTvOsd;
    if (state.quickList) {
      event?.preventDefault?.();
      return handleQuickListKey(this, code);
    }
    const zapKeys = [KEY.CHANNEL_UP, KEY.CHANNEL_DOWN, KEY.PAGE_UP, KEY.PAGE_DOWN];
    if (zapKeys.includes(code)) {
      event?.preventDefault?.();
      zapBy(this, code === KEY.CHANNEL_UP || code === KEY.PAGE_UP ? 1 : -1);
      return undefined;
    }
    // The player's own controls and dialogs keep their keys. A dead channel's error screen
    // doesn't: zapping and the channel list still work there (OK keeps "Go back").
    if (!this.controlsVisible) state.controlsByUser = false;
    if (this.controlsVisible && !state.controlsByUser) {
      // Controls the player showed by itself (while loading) give way to the live keys.
      try {
        this.setControlsVisible?.(false);
      } catch (_) {
        // Already hidden.
      }
    }
    const playerUiOpen =
      (this.controlsVisible && state.controlsByUser) ||
      this.sourcesPanelVisible ||
      this.subtitleDialogVisible ||
      this.audioDialogVisible ||
      this.speedDialogVisible ||
      this.moreActionsVisible ||
      this.episodePanelVisible ||
      this.subtitleTimingDialogVisible ||
      this.subtitleDelayOverlayVisible ||
      this.partyPanelVisible ||
      this.chaptersPanelVisible;
    if (playerUiOpen) return original.onKeyDown.call(this, event);
    if (code === KEY.OK && this.isStartupErrorVisible?.()) {
      return original.onKeyDown.call(this, event);
    }
    if (code === KEY.UP || code === KEY.DOWN) {
      event?.preventDefault?.();
      zapBy(this, code === KEY.UP ? 1 : -1);
      return undefined;
    }
    if (code === KEY.LEFT) {
      event?.preventDefault?.();
      openQuickList(this);
      return undefined;
    }
    if (code === KEY.OK || code === KEY.INFO) {
      event?.preventDefault?.();
      if (event?.repeat) return undefined;
      if (state.bannerVisible && code === KEY.OK) openQuickList(this);
      else void showBanner(this);
      return undefined;
    }
    if (code === KEY.RIGHT) {
      // The player's own controls (audio, subtitles, sources...).
      hideBanner(this);
      state.controlsByUser = true;
      return original.onKeyDown.call(this, syntheticKey(event, KEY.DOWN));
    }
    return original.onKeyDown.call(this, event);
  };

  PlayerScreen.consumeBackRequest = function liveTvBack(...args) {
    if (this.liveTvOsd) {
      if (closeQuickList(this)) return true;
      if (this.liveTvOsd.bannerVisible) hideBanner(this);
    }
    return original.consumeBackRequest.apply(this, args);
  };

  PlayerScreen.showStartupError = function liveTvStartupError(...args) {
    if (isLiveTvPlayback(this) && tryLiveFallback(this)) return undefined;
    return original.showStartupError.apply(this, args);
  };

  PlayerScreen.navigateBackToStreamScreen = function liveTvBackToGuide(...args) {
    const route = this.params?.returnRouteOnBack;
    if (!route) return original.navigateBackToStreamScreen.apply(this, args);
    if (this.playerBackNavigationInProgress) return "history";
    this.playerBackNavigationInProgress = true;
    try {
      this.stopTrackingBeforeTeardown?.();
    } catch (_) {
      // Nothing to stop for a channel.
    }
    try {
      PlayerController.stop();
    } catch (_) {
      // Route cleanup stops it again.
    }
    const params = this.params?.returnRouteParams || {};
    if (Router.popToExistingRoute?.(route, params, {})) return "history";
    void Router.navigate(route, params, {
      skipStackPush: true,
      replaceHistory: true,
      isBackNavigation: true
    });
    return true;
  };
}
