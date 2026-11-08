// Nuvio Live: watching live TV counts as activity for the screensavers.
// Upstream's Ambient Mode (Nuvio's own screensaver) treats every route but the player as idle, so
// it covered the guide's preview after its timeout; and on Tizen it gives the screen back to
// Samsung's screensaver on the player route. While a channel plays, in the guide's preview or full
// screen (catch-up too, unless paused), this keeps both away. Like NuvioPlusIPTV's KeepScreenAwake.
import { AmbientMode } from "../ui/ambient/ambientMode.js";
import { Router } from "../ui/navigation/routerState.js";
import { isLivePreviewPlaying } from "./liveTvPlayback.js";

const now = () => globalThis.performance?.now?.() ?? Date.now();

export function isLiveTvWatching() {
  const route = Router.getCurrent?.();
  if (route === "liveTv") return isLivePreviewPlaying();
  if (route === "player") {
    const screen = Router.getCurrentScreen?.();
    return Boolean(screen?.params?.liveTv?.channelKey) && !screen.paused;
  }
  return false;
}

/** Wraps Ambient Mode's once-a-second check; `isWatching` is replaceable for tests. */
export function installLiveKeepAwake(ambient = AmbientMode, isWatching = isLiveTvWatching) {
  if (!ambient || ambient.__liveTvKeepAwake || typeof ambient.tick !== "function") return;
  ambient.__liveTvKeepAwake = true;
  const originalTick = ambient.tick;
  ambient.tick = function liveTvKeepAwakeTick(...args) {
    let watching = false;
    try {
      watching = isWatching();
    } catch (_) {
      watching = false;
    }
    if (!watching) return originalTick.apply(this, args);
    // As if a key had just been pressed: the idle timeout starts again once playback stops.
    this.lastInteraction = now();
    if (this.showing) this.dismiss?.();
    this.setTizenScreenSaverBlocked?.(true);
    return undefined;
  };
}
