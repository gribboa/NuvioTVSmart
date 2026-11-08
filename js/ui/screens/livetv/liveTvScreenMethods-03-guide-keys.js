// Nuvio Live: moving around the guide with the SolarCell remote.
// Up/Down: channels. Left/Right: programmes in time (Left at the start goes to the channel
// column, then the sidebar). OK on a live programme: play it in the preview, OK again: full screen
// (straight to full screen with the preview off). OK on the past: catch-up; on the future: when it
// starts. Long-press OK: favourite. CH +/-: a page of channels. Back: full screen for the channel in
// the preview; with no preview, the channel column, then the sidebar.
// Behaviour follows NuvioPlusIPTV (GPL-3.0), ui/LiveTvGuideScreen.kt.
import { LiveTvRepository } from "../../../livetv/liveTvRepository.js";
import { LiveTvProfileState, LiveTvSettings } from "../../../livetv/data/liveTvPreferences.js";
import { canPlayCatchup } from "../../../livetv/data/catchupUrl.js";
import { playCatchup, playLiveChannel } from "../../../livetv/liveTvPlayback.js";
import { t } from "./liveTvScreenShared.js";
import {
  GUIDE_SPAN_MS,
  MINUTE_MS,
  SLOT_MS,
  floorToSlot,
  moveIndex,
  programmeAt,
  scrollTopFor,
  stepFocus,
  viewForFocus
} from "./guideModel.js";

const VISIBLE_ROWS = 7;
const HOLD_MS = 650;
const HOUR_MS = 60 * MINUTE_MS;
const KEY = Object.freeze({
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  OK: 13,
  PAGE_UP: 33,
  PAGE_DOWN: 34,
  CHANNEL_UP: 427,
  CHANNEL_DOWN: 428
});

export function createLiveTvScreenMethods03() {
  return {
    /** Earliest time focus may go back to on a channel: its catch-up window, or now. */
    guideMinMs(channel) {
      const now = Date.now();
      const live = programmeAt(this.channelProgrammes(channel?.key), now);
      const floor = live ? Math.min(live.startMs, floorToSlot(now)) : floorToSlot(now);
      if (!channel?.catchup) return floor;
      const days = Math.max(1, Number(channel.catchup.days) || 1);
      const pastHours = LiveTvSettings.get().guidePastHours;
      return Math.min(floor, now - Math.min(days * 24, pastHours) * HOUR_MS);
    },

    guideMaxMs() {
      return Date.now() + Math.max(1, LiveTvSettings.get().guideFutureDays) * 24 * HOUR_MS;
    },

    consumeGuideBack() {
      const guide = this.guide;
      if (!guide) return false;
      if (this.previewActive()) {
        void this.watchPreviewFullScreen();
        return true;
      }
      if (guide.zone === "grid" && guide.column === "programme") {
        guide.column = "channel";
        guide.viewStartMs = floorToSlot(Date.now());
        this.updateGuide({ preview: false });
        return true;
      }
      void this.focusSidebarNode();
      this.updateGuide({ preview: false });
      return true;
    },

    async onGuideKeyDown(event, code) {
      const guide = this.guide;
      if (!guide) return;
      if ([37, 38, 39, 40, 13, 33, 34, 427, 428].includes(code)) event?.preventDefault?.();
      if (guide.zone === "tabs") {
        await this.onTabsKey(code);
        return;
      }
      switch (code) {
        case KEY.UP:
          if (guide.rowIndex === 0) {
            guide.zone = "tabs";
            guide.tabFocusIndex = guide.tabIndex;
            this.updateGuide({ preview: false });
          } else {
            this.moveGuideRow(-1);
          }
          return;
        case KEY.DOWN:
          this.moveGuideRow(1);
          return;
        case KEY.PAGE_UP:
        case KEY.CHANNEL_UP:
          this.moveGuideRow(-VISIBLE_ROWS);
          return;
        case KEY.PAGE_DOWN:
        case KEY.CHANNEL_DOWN:
          this.moveGuideRow(VISIBLE_ROWS);
          return;
        case KEY.RIGHT:
          this.moveGuideTime(1);
          return;
        case KEY.LEFT:
          if (guide.column === "channel") {
            await this.focusSidebarNode();
            this.updateGuide({ preview: false });
            return;
          }
          this.moveGuideTime(-1);
          return;
        case KEY.OK:
          if (event?.repeat) return;
          // Long-press OK toggles the favourite; a short press acts on key up.
          clearTimeout(guide.holdTimer);
          guide.holdFired = false;
          guide.okDown = true;
          guide.holdTimer = setTimeout(() => {
            if (this.guide !== guide || !guide.okDown) return;
            guide.holdFired = true;
            this.toggleFocusedFavourite();
          }, HOLD_MS);
          return;
        default:
      }
    },

    onGuideKeyUp(event) {
      const guide = this.guide;
      if (!guide || Number(event?.keyCode || 0) !== KEY.OK || !guide.okDown) return;
      guide.okDown = false;
      clearTimeout(guide.holdTimer);
      if (guide.holdFired) {
        guide.holdFired = false;
        return;
      }
      if (guide.zone === "grid") void this.activateGuideFocus();
    },

    async onTabsKey(code) {
      const guide = this.guide;
      const count = guide.tabs.length + 1; // the providers item at the end
      const index = guide.tabFocusIndex ?? guide.tabIndex;
      if (code === KEY.LEFT) {
        if (index === 0) {
          await this.focusSidebarNode();
          this.updateGuide({ preview: false });
          return;
        }
        this.selectGuideTab(index - 1);
      } else if (code === KEY.RIGHT) {
        this.selectGuideTab(Math.min(count - 1, index + 1));
      } else if (code === KEY.DOWN) {
        if (index >= guide.tabs.length) return;
        guide.zone = "grid";
        this.updateGuide({ preview: true });
      } else if (code === KEY.OK) {
        if (index >= guide.tabs.length) this.openSources();
        else {
          guide.zone = "grid";
          this.updateGuide({ preview: true });
        }
      }
    },

    /** Focusing a tab shows its channels at once (the providers item only on OK). */
    selectGuideTab(index) {
      const guide = this.guide;
      guide.tabFocusIndex = index;
      if (index < guide.tabs.length && index !== guide.tabIndex) {
        guide.tabIndex = index;
        guide.rowIndex = 0;
        guide.topRow = 0;
        guide.column = "channel";
        const tab = guide.tabs[index];
        if (!tab.id.startsWith("__")) LiveTvProfileState.setLastGroup(tab.id);
      }
      this.updateGuide({ preview: false });
    },

    moveGuideRow(delta) {
      const guide = this.guide;
      const keys = this.tabChannelKeys();
      if (!keys.length) return;
      const next = moveIndex(guide.rowIndex, delta, keys.length);
      if (next === guide.rowIndex) return;
      guide.rowIndex = next;
      guide.topRow = scrollTopFor(next, guide.topRow, VISIBLE_ROWS, keys.length);
      if (guide.column === "programme") {
        // Keep the time; a channel without catch-up can't show the past.
        const channel = this.focusedChannel();
        guide.focusMs = Math.max(guide.focusMs, this.guideMinMs(channel));
      }
      this.updateGuide({ preview: true });
    },

    moveGuideTime(direction) {
      const guide = this.guide;
      const channel = this.focusedChannel();
      if (!channel) return;
      const now = Date.now();
      if (guide.column === "channel") {
        if (direction < 0) return;
        guide.column = "programme";
        guide.focusMs = now;
        guide.viewStartMs = viewForFocus(floorToSlot(now), now);
        this.updateGuide({ preview: false });
        return;
      }
      const programmes = this.channelProgrammes(channel.key);
      const next = stepFocus(programmes, guide.focusMs, direction, {
        minMs: this.guideMinMs(channel),
        maxMs: this.guideMaxMs()
      });
      if (next == null) {
        if (direction < 0) {
          guide.column = "channel";
          guide.viewStartMs = floorToSlot(now);
          this.updateGuide({ preview: false });
        }
        return;
      }
      guide.focusMs = next;
      const cell = programmeAt(programmes, next);
      guide.viewStartMs = viewForFocus(guide.viewStartMs, next, {
        spanMs: GUIDE_SPAN_MS,
        minMs: floorToSlot(this.guideMinMs(channel)) - SLOT_MS,
        cell
      });
      this.updateGuide({ preview: false });
    },

    zapKeysForPlayer() {
      return this.tabChannelKeys().slice();
    },

    /** OK in the grid: preview or watch live, play catch-up, or say when a future programme starts. */
    async activateGuideFocus() {
      const guide = this.guide;
      const channel = this.focusedChannel();
      if (!channel) return;
      const tabId = guide.tabs[guide.tabIndex]?.id || "";
      const now = Date.now();
      const programme = guide.column === "programme" ? this.focusedProgramme() : null;
      if (programme && programme.stopMs <= now) {
        if (canPlayCatchup(channel, programme, now)) {
          const started = await playCatchup(channel, programme, { tabId });
          if (!started) this.showGuideToast(t("livetv_hint_no_catchup"));
        } else {
          this.showGuideToast(t("livetv_hint_no_catchup"));
        }
        return;
      }
      if (programme && programme.startMs > now) {
        this.showGuideToast(
          t("livetv_starts_at", { time: new Date(programme.startMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) })
        );
        return;
      }
      const previewOn = LiveTvSettings.get().showPreview;
      if (previewOn && channel.key !== guide.previewKey) {
        this.previewChannel(channel);
        return;
      }
      if (previewOn && (await this.watchPreviewFullScreen())) return;
      const { now: current } = await LiveTvRepository.getNowNext(channel.key, now);
      await playLiveChannel(channel, {
        zapKeys: this.zapKeysForPlayer(),
        tabId,
        nowTitle: current?.title || ""
      });
    },

    toggleFocusedFavourite() {
      const channel = this.focusedChannel();
      if (!channel) return;
      const favourite = LiveTvProfileState.toggleFavourite(channel.key);
      this.guide.pendingChannelKey = channel.key;
      this.rebuildTabs();
      this.updateGuide({ preview: false });
      this.showGuideToast(t(favourite ? "livetv_favourite_added" : "livetv_favourite_removed", { name: channel.name }));
    }
  };
}
