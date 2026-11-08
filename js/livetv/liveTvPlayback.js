// Nuvio Live: starting playback. Live channels and catch-up go through the app's PlayerScreen
// (AVPlay / hls.js, its proxy for headers, its error handling); the guide's small preview drives
// PlayerController directly with a display rectangle.
// Retry/fallback rules follow NuvioPlusIPTV (GPL-3.0), player/LiveTvPlaybackController.kt:
// the account's stream format first, then the other one (Xtream .ts <-> .m3u8).
import { Router } from "../ui/navigation/routerState.js";
import { PlayerController } from "../core/player/playerController.js";
import { Platform } from "../platform/index.js";
import { LiveTvRepository } from "./liveTvRepository.js";
import { LiveTvProfileState } from "./data/liveTvPreferences.js";
import { buildCatchupUrls } from "./data/catchupUrl.js";

export const LIVE_TV_ROUTE = "liveTv";

function mimeTypeFor(url) {
  const path = String(url || "")
    .split("?")[0]
    .toLowerCase();
  if (path.endsWith(".m3u8") || /output_format=(hls|m3u8)/i.test(url)) return "application/x-mpegURL";
  if (path.endsWith(".ts") || /output_format=mpegts/i.test(url)) return "video/mp2t";
  if (path.endsWith(".mpd")) return "application/dash+xml";
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
  stopLivePreview();
  const candidates = liveCandidatesFor(channel);
  if (!candidates.length) return;
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
  if (!Router.getCurrent || Router.getCurrent() !== "player") screen.style.display = "none";
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
  stopLivePreview({ keepLayer: true });
  preview = { channelKey: channel.key, token };
  const candidates = liveCandidatesFor(channel);
  if (!candidates.length) return;
  placeVideoLayer(rect);
  for (const candidate of candidates) {
    if (preview?.token !== token) return;
    try {
      const userAgent = candidate.behaviorHints?.proxyHeaders?.request?.["User-Agent"];
      if (Platform.isTizen()) {
        // Stored and applied when AVPlay opens the stream (it ignores changes while playing).
        // PlayerScreen sets full screen again when it mounts.
        try {
          PlayerController.setAvPlayDisplayRect?.(toAvPlayRect(rect), "PLAYER_DISPLAY_MODE_FULL_SCREEN");
        } catch (_) {
          // HTML engines are sized through the video element instead.
        }
      }
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
      if (avplay) avplay.style.visibility = usingAvPlay ? "" : "hidden";
      preview.playing = true;
      return;
    } catch (error) {
      console.warn("Live TV preview failed", candidate.mimeType || "stream");
    }
  }
}

export function stopLivePreview({ keepLayer = false } = {}) {
  if (!preview) {
    if (!keepLayer) clearVideoLayer();
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
  if (!keepLayer) clearVideoLayer();
}

export function livePreviewChannelKey() {
  return preview?.channelKey || "";
}
