// Nuvio Live: starting playback. Live channels and catch-up go through the app's PlayerScreen
// (AVPlay / hls.js, its proxy for headers, its error handling); the guide's small preview drives
// PlayerController directly with a display rectangle.
// Retry/fallback rules follow NuvioPlusIPTV (GPL-3.0), player/LiveTvPlaybackController.kt:
// the account's stream format first, then the other one (Xtream .ts <-> .m3u8).
import { Router } from "../ui/navigation/routerState.js";
import { PlayerController } from "../core/player/playerController.js";
import { Platform } from "../platform/index.js";
import { LiveTvRepository } from "./liveTvRepository.js";
import { LiveTvProfileState, LiveTvSettings } from "./data/liveTvPreferences.js";
import { buildCatchupUrls } from "./data/catchupUrl.js";

export const LIVE_TV_ROUTE = "liveTv";

function mimeTypeFor(url) {
  const path = String(url || "")
    .split("?")[0]
    .toLowerCase();
  if (path.endsWith(".m3u8") || /output_format=(hls|m3u8)/i.test(url)) return "application/x-mpegURL";
  if (path.endsWith(".ts") || /output_format=mpegts/i.test(url)) return "video/mp2t";
  if (path.endsWith(".mpd")) return "application/dash+xml";
  if (path.endsWith(".mp4")) return "video/mp4";
  return "";
}

/** PlayerScreen stream candidates for a list of links (the User-Agent travels with each). */
export function toStreamCandidates(urls, { title = "", userAgent = "", idPrefix = "live" } = {}) {
  return urls.map((url, index) => ({
    id: `${idPrefix}:${index}`,
    url,
    title: title || "Live",
    name: title || "Live",
    mimeType: mimeTypeFor(url),
    behaviorHints: userAgent ? { proxyHeaders: { request: { "User-Agent": userAgent } } } : {}
  }));
}

export function liveCandidatesFor(channel) {
  return toStreamCandidates(LiveTvRepository.streamCandidates(channel), {
    title: channel?.name,
    userAgent: LiveTvRepository.userAgentFor(channel),
    idPrefix: `live:${channel?.key}`
  });
}

/**
 * Plays a channel full screen. `zapKeys` is the list CH up/down moves through (the guide's
 * current tab); Back returns to the guide on that channel.
 */
export async function playLiveChannel(channel, { zapKeys = [], tabId = "", nowTitle = "", returnRoute = LIVE_TV_ROUTE } = {}) {
  if (!channel) return;
  // The channel the preview is already playing carries on full screen without reconnecting.
  const handedOverUrl = handOverPreview(channel);
  if (!handedOverUrl) stopLivePreview();
  const links = liveCandidatesFor(channel);
  if (!links.length) return;
  const playing = links.find((candidate) => candidate.url === handedOverUrl);
  const candidates = playing ? [playing, ...links.filter((candidate) => candidate !== playing)] : links;
  LiveTvProfileState.setLastChannel(channel.key);
  await Router.navigate("player", {
    // No itemId/videoId: a channel must never be scrobbled, saved as progress or looked up
    // in addons.
    itemType: "channel",
    playerTitle: channel.name,
    playerSubtitle: nowTitle,
    playerLogoUrl: channel.logo || "",
    streamCandidates: candidates,
    preferredStreamId: candidates[0].id,
    liveTv: { channelKey: channel.key, zapKeys, tabId },
    returnRouteOnBack: returnRoute,
    returnRouteParams: returnRoute === LIVE_TV_ROUTE ? { focusChannelKey: channel.key, tabId } : {}
  });
}

/** Plays a past programme from the provider's catch-up (seekable, not live). */
export async function playCatchup(channel, programme, { tabId = "" } = {}) {
  const source = LiveTvRepository.sourceFor(channel);
  if (!channel || !programme || !source) return false;
  const urls = buildCatchupUrls({
    channel,
    programme,
    nowMs: Date.now(),
    serverTimezone: LiveTvRepository.account(source.id)?.serverTimezone || source.serverTimezone || "",
    source
  });
  if (!urls.length) return false;
  stopLivePreview();
  const candidates = toStreamCandidates(urls, {
    title: programme.title,
    userAgent: LiveTvRepository.userAgentFor(channel),
    idPrefix: `catchup:${channel.key}:${programme.startMs}`
  });
  await Router.navigate("player", {
    itemType: "catchup",
    playerTitle: programme.title || channel.name,
    playerSubtitle: channel.name,
    playerLogoUrl: channel.logo || "",
    streamCandidates: candidates,
    preferredStreamId: candidates[0].id,
    liveTv: { channelKey: channel.key, catchup: true, tabId },
    returnRouteOnBack: LIVE_TV_ROUTE,
    returnRouteParams: { focusChannelKey: channel.key, tabId }
  });
  return true;
}

// ---- Guide preview ----------------------------------------------------------------------------

let preview = null;

function previewElements() {
  return {
    screen: document.getElementById("player"),
    video: document.getElementById("videoPlayer"),
    avplay: document.getElementById("avPlayerObject")
  };
}

/** CSS pixels -> the 1920x1080 coordinates AVPlay's display rectangle uses. */
function toAvPlayRect(rect) {
  const scaleX = 1920 / Math.max(1, window.innerWidth || 1920);
  const scaleY = 1080 / Math.max(1, window.innerHeight || 1080);
  return {
    x: Math.round(rect.left * scaleX),
    y: Math.round(rect.top * scaleY),
    width: Math.round(rect.width * scaleX),
    height: Math.round(rect.height * scaleY)
  };
}

function placeVideoLayer(rect) {
  const { screen, video, avplay } = previewElements();
  if (!screen) return;
  // The player screen sits under the guide as a transparent layer; only the video shows,
  // through a transparent hole in the guide.
  screen.classList.add("livetv-preview-layer");
  screen.style.display = "block";
  [video, avplay].forEach((node) => {
    if (!node) return;
    node.style.position = "fixed";
    node.style.left = `${rect.left}px`;
    node.style.top = `${rect.top}px`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
  });
}

function clearVideoLayer() {
  const { screen, video, avplay } = previewElements();
  if (!screen) return;
  screen.classList.remove("livetv-preview-layer");
  [video, avplay].forEach((node) => {
    if (!node) return;
    ["position", "left", "top", "width", "height", "visibility"].forEach((property) => {
      node.style[property] = "";
    });
  });
  // A handed-over stream keeps showing while the player screen opens.
  if (handover) return;
  if (!Router.getCurrent || Router.getCurrent() !== "player") screen.style.display = "none";
}

// ---- Preview -> full screen, same stream -------------------------------------------------------

// Set while the player screen opens on the stream the preview was playing: { url, timer }.
let handover = null;
const HANDOVER_TIMEOUT_MS = 8000;
const ADOPTABLE_STATES = ["PLAYING", "PAUSED", "READY"];

/**
 * If the preview is playing `channel` on AVPlay, lets go of it without stopping it, so the player
 * screen can take the running session over (see adoptPreviewSession). Returns the link that is
 * playing, or "" when the player has to start the channel itself.
 */
function handOverPreview(channel) {
  if (!Platform.isTizen() || !preview?.playing || preview.channelKey !== channel?.key) return "";
  if (!PlayerController.isUsingAvPlay?.()) return "";
  const url = String(PlayerController.currentPlaybackUrl || "").trim();
  if (!url) return "";
  preview = null;
  restoreDisplayMethod();
  installHandoverHook();
  clearTimeout(handover?.timer);
  handover = {
    url,
    timer: setTimeout(() => {
      handover = null;
    }, HANDOVER_TIMEOUT_MS)
  };
  const { screen, avplay } = previewElements();
  screen?.classList.remove("livetv-preview-layer");
  if (avplay) avplay.style.visibility = "";
  return url;
}

/** Makes the running AVPlay session the player screen's: full screen, and "playing" events. */
function adoptPreviewSession(controller, url, options = {}) {
  if (!Platform.isTizen() || !controller.isUsingAvPlay?.()) return false;
  if (String(controller.currentPlaybackUrl || "").trim() !== url) return false;
  const avplay = controller.getAvPlay?.();
  let state = "";
  try {
    state = String(avplay?.getState?.() || "").toUpperCase();
  } catch (_) {
    return false;
  }
  if (!ADOPTABLE_STATES.includes(state)) return false;
  // What play() would have recorded; the AVPlay listener and play token stay as they are, so the
  // session keeps reporting time to the player screen.
  controller.currentItemType = options.itemType || controller.currentItemType;
  controller.currentItemTitle = options.title || null;
  controller.currentPlaybackHeaders = { ...(options.requestHeaders || {}) };
  controller.playbackSessionActive = true;
  controller.avplayDisplayRect = null;
  try {
    controller.setAvPlayDisplayRect();
  } catch (_) {
    // The tick timer re-applies the rectangle.
  }
  ["loadedmetadata", "loadeddata", "canplay", "avplaytrackschanged", "playing"].forEach((name) =>
    controller.emitVideoEvent?.(name, { playbackEngine: controller.playbackEngine })
  );
  if (state !== "PLAYING") {
    try {
      avplay.play();
    } catch (_) {
      // Already starting.
    }
  }
  return true;
}

function installHandoverHook() {
  if (PlayerController.__liveTvHandoverHook) return;
  const original = PlayerController.play;
  if (typeof original !== "function") return;
  PlayerController.__liveTvHandoverHook = true;
  PlayerController.play = function liveTvPlay(url, options = {}, ...rest) {
    const pending = handover;
    if (pending) {
      clearTimeout(pending.timer);
      handover = null;
      if (pending.url === String(url || "").trim() && adoptPreviewSession(this, pending.url, options)) {
        return Promise.resolve();
      }
    }
    return original.call(this, url, options, ...rest);
  };
}

/**
 * Shows `channel` playing in `element`'s rectangle. Resolves once playback was requested; a
 * failing stream just leaves the preview's placeholder visible.
 */
export async function startLivePreview(channel, element) {
  if (!channel || !element) return;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const token = {};
  if (preview?.channelKey === channel.key) return;
  if (keptSession) {
    if (keptSession.channelKey === channel.key && adoptKeptSession(channel, element)) return;
    // Another channel: the playback below replaces the kept stream.
    dropKeptSession();
  }
  stopLivePreview({ keepLayer: true });
  preview = { channelKey: channel.key, token };
  const candidates = liveCandidatesFor(channel);
  if (!candidates.length) return;
  placeVideoLayer(rect);
  for (const candidate of candidates) {
    if (preview?.token !== token) return;
    try {
      const userAgent = candidate.behaviorHints?.proxyHeaders?.request?.["User-Agent"];
      // Stored and applied when AVPlay opens the stream; HTML engines are sized through the
      // video element instead.
      if (Platform.isTizen()) applyPreviewRect(rect);
      await PlayerController.play(candidate.url, {
        itemType: "channel",
        mediaSourceType: candidate.mimeType || null,
        requestHeaders: userAgent ? { "User-Agent": userAgent } : {}
      });
      if (preview?.token !== token) return;
      // Only the engine that plays shows: hls.js draws into the video element, AVPlay into its
      // object (an empty black video element on top would hide it).
      const { video, avplay } = previewElements();
      const usingAvPlay = Boolean(PlayerController.isUsingAvPlay?.());
      if (video) video.style.visibility = usingAvPlay ? "hidden" : "";
      if (avplay) avplay.style.visibility = "hidden";
      if (usingAvPlay) revealWhenPlaying(element, token);
      preview.playing = true;
      return;
    } catch (_) {
      console.warn("Live TV preview failed", candidate.mimeType || "stream");
    }
  }
}

// After the first frame: the rectangle once more, in case the firmware moved it while starting.
const PREVIEW_RECT_REAPPLY_MS = [0, 1000, 3000];
// Shown this long after AVPlay reports playback (time for the rectangle to take effect).
const PREVIEW_REVEAL_DELAY_MS = 250;
// Shown anyway after this long, so a stream that never reports progress still appears.
const PREVIEW_REVEAL_FALLBACK_MS = 10000;
// "Full screen" makes some Samsung firmware (2025 The Frame, Tizen 9) ignore the rectangle and draw
// the whole screen, so the box only showed a part of the picture. This mode keeps to the rectangle
// (the box is 16:9, so it fills it).
const PREVIEW_DISPLAY_METHOD = "PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO";
let displayMethodBeforePreview = null;

/** Gives AVPlay the preview's rectangle (stored, and applied now when AVPlay's state allows). */
function applyPreviewRect(rect) {
  if (displayMethodBeforePreview === null) {
    displayMethodBeforePreview = PlayerController.avplayDisplayMethod || "PLAYER_DISPLAY_MODE_FULL_SCREEN";
  }
  installRectHook();
  try {
    PlayerController.setAvPlayDisplayRect?.(toAvPlayRect(rect), PREVIEW_DISPLAY_METHOD);
  } catch (_) {
    // AVPlay isn't in a state that takes a rectangle; it's applied when the stream opens.
  }
}

/** setDisplayRect straight to AVPlay with the stored rectangle, when its state allows it. */
function reassertPreviewRect() {
  const target = PlayerController.avplayDisplayRect;
  const avplay = PlayerController.isUsingAvPlay?.() ? PlayerController.getAvPlay?.() : null;
  if (!avplay || !target) return;
  try {
    const state = String(avplay.getState?.() || "").toUpperCase();
    if (["IDLE", "READY", "PLAYING", "PAUSED"].includes(state)) {
      avplay.setDisplayRect(target.x, target.y, target.width, target.height);
    }
  } catch (_) {
    // The player's own call already did what it can.
  }
}

/**
 * The player applies the rectangle and then the display method, at open, when prepared and while
 * starting. On the 2025 Frame setting the method puts the picture back to full screen, so while
 * the preview is on, every one of those calls ends with the rectangle once more.
 */
function installRectHook() {
  if (PlayerController.__liveTvPreviewRectHook) return;
  const original = PlayerController.setAvPlayDisplayRect;
  if (typeof original !== "function") return;
  PlayerController.__liveTvPreviewRectHook = true;
  PlayerController.setAvPlayDisplayRect = function liveTvPreviewRect(...args) {
    const result = original.apply(this, args);
    if (preview && displayMethodBeforePreview !== null && Platform.isTizen()) reassertPreviewRect();
    return result;
  };
}

/**
 * AVPlay's object is the hole the picture shows through; it stays hidden until the stream is
 * playing in its rectangle, so the first, full-screen frames never show in the box.
 */
function revealWhenPlaying(element, token) {
  const { video } = previewElements();
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    video?.removeEventListener("timeupdate", onProgress);
    clearTimeout(fallbackTimer);
    PREVIEW_RECT_REAPPLY_MS.forEach((delayMs) =>
      setTimeout(() => {
        if (preview?.token !== token || !element.isConnected) return;
        const rect = element.getBoundingClientRect();
        if (rect.width && rect.height) applyPreviewRect(rect);
      }, delayMs)
    );
    setTimeout(() => {
      if (preview?.token !== token) return;
      const { avplay } = previewElements();
      if (avplay) avplay.style.visibility = "";
    }, PREVIEW_REVEAL_DELAY_MS);
  };
  const onProgress = () => {
    if (preview?.token !== token) {
      video?.removeEventListener("timeupdate", onProgress);
      return;
    }
    reveal();
  };
  video?.addEventListener("timeupdate", onProgress);
  const fallbackTimer = setTimeout(() => {
    if (preview?.token === token) reveal();
  }, PREVIEW_REVEAL_FALLBACK_MS);
}

function restoreDisplayMethod() {
  if (displayMethodBeforePreview === null) return;
  PlayerController.avplayDisplayMethod = displayMethodBeforePreview;
  displayMethodBeforePreview = null;
}

export function stopLivePreview({ keepLayer = false } = {}) {
  if (!preview) {
    if (!keepLayer) {
      restoreDisplayMethod();
      clearVideoLayer();
    }
    return;
  }
  preview = null;
  try {
    PlayerController.stop();
  } catch (_) {
    // Nothing was playing.
  }
  // Forget the preview's small rectangle so the next playback starts full screen.
  PlayerController.avplayDisplayRect = null;
  if (!keepLayer) {
    restoreDisplayMethod();
    clearVideoLayer();
  }
}

export function livePreviewChannelKey() {
  return preview?.channelKey || "";
}

// ---- Full screen -> preview, same stream -------------------------------------------------------

// The stream a channel was playing full screen when Back went to the guide: { url, channelKey,
// timer }. The guide's preview takes it over instead of opening the channel again.
let keptSession = null;
const KEPT_SESSION_TIMEOUT_MS = 5000;

function avPlayState() {
  try {
    return String(PlayerController.getAvPlay?.()?.getState?.() || "").toUpperCase();
  } catch (_) {
    return "";
  }
}

/**
 * Called on Back from a live channel to the guide: keeps AVPlay playing (the player screen's
 * cleanup would stop it) for the guide's preview to take over. Returns false when it can't (not
 * Tizen, preview off, AVPlay not playing); the caller then stops playback as usual.
 */
export function keepLiveSessionForGuide(channelKey) {
  if (!Platform.isTizen() || !channelKey || !LiveTvSettings.get().showPreview) return false;
  if (!PlayerController.isUsingAvPlay?.() || !ADOPTABLE_STATES.includes(avPlayState())) return false;
  const url = String(PlayerController.currentPlaybackUrl || "").trim();
  if (!url) return false;
  installStopHook();
  clearTimeout(keptSession?.timer);
  keptSession = {
    url,
    channelKey,
    // Nobody took it over (Back went somewhere else, or the guide didn't preview it): stop it.
    timer: setTimeout(() => dropKeptSession({ stop: true }), KEPT_SESSION_TIMEOUT_MS)
  };
  return true;
}

/** The channel whose full-screen stream is waiting for the guide's preview, or "". */
export function keptSessionChannelKey() {
  return keptSession?.channelKey || "";
}

function dropKeptSession({ stop = false } = {}) {
  const kept = keptSession;
  if (!kept) return;
  clearTimeout(kept.timer);
  keptSession = null;
  const stillOurs =
    !preview &&
    String(PlayerController.currentPlaybackUrl || "").trim() === kept.url &&
    (!Router.getCurrent || Router.getCurrent() !== "player");
  if (stop && stillOurs) {
    try {
      PlayerController.stop();
    } catch (_) {
      // Already stopped.
    }
  }
}

/** Shows the kept full-screen stream in the preview box (see keepLiveSessionForGuide). */
function adoptKeptSession(channel, element) {
  const kept = keptSession;
  const rect = element.getBoundingClientRect();
  const usable =
    kept &&
    rect.width &&
    rect.height &&
    PlayerController.isUsingAvPlay?.() &&
    String(PlayerController.currentPlaybackUrl || "").trim() === kept.url &&
    ADOPTABLE_STATES.includes(avPlayState());
  if (!usable) return false;
  clearTimeout(kept.timer);
  keptSession = null;
  const token = {};
  preview = { channelKey: channel.key, token, playing: true };
  const { video, avplay } = previewElements();
  // Hidden until AVPlay has moved the picture into the box (see revealWhenPlaying).
  if (avplay) avplay.style.visibility = "hidden";
  placeVideoLayer(rect);
  if (video) video.style.visibility = "hidden";
  applyPreviewRect(rect);
  revealWhenPlaying(element, token);
  return true;
}

/** While a full-screen stream waits for the guide, the player screen's cleanup must not stop it. */
function installStopHook() {
  if (PlayerController.__liveTvKeepSessionHook) return;
  const original = PlayerController.stop;
  if (typeof original !== "function") return;
  PlayerController.__liveTvKeepSessionHook = true;
  PlayerController.stop = function liveTvStop(...args) {
    if (keptSession) return undefined;
    return original.apply(this, args);
  };
}
