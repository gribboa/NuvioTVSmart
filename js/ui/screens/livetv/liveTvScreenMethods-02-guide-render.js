// Nuvio Live: the guide view of the Live TV screen (layout, data, preview).
// Layout follows NuvioPlusIPTV (GPL-3.0), ui/LiveTvGuideScreen.kt and ui/GuideRowStrip.kt:
// preview and programme details on top, group tabs, then channel column + time grid.
import { LiveTvRepository } from "../../../livetv/liveTvRepository.js";
import { LiveTvProfileState, LiveTvSettings } from "../../../livetv/data/liveTvPreferences.js";
import { canPlayCatchup } from "../../../livetv/data/catchupUrl.js";
import { startLivePreview, stopLivePreview } from "../../../livetv/liveTvPlayback.js";
import { escapeHtml, t } from "./liveTvScreenShared.js";
import {
  GUIDE_SPAN_MS,
  MINUTE_MS,
  TAB,
  buildTabs,
  defaultFormatTime,
  floorToSlot,
  programmeAt,
  progressOf,
  rowCells,
  rulerMarks
} from "./guideModel.js";
import { formatWhen } from "./liveTvScreenMethods-01-sources.js";

const VISIBLE_ROWS = 7;
const PREVIEW_DELAY_MS = 600;
const TICK_MS = 30 * 1000;
const READ_BEFORE_MS = 3 * 60 * MINUTE_MS;
const READ_AFTER_MS = 6 * 60 * MINUTE_MS;
const MANAGE_TAB_ID = "__manage";

function initials(name) {
  return String(name || "?")
    .replace(/^[a-z]{2,3}\s*[:|]\s*/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

function formatTime(ms) {
  return defaultFormatTime(ms, LiveTvSettings.get().use24HourClock !== false);
}

function logoMarkup(channel, className) {
  return channel?.logo
    ? `<img class="${className}" src="${escapeHtml(channel.logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
    : `<span class="${className} ${className}-initials">${escapeHtml(initials(channel?.name))}</span>`;
}

export function createLiveTvScreenMethods02() {
  return {
    // ---- State ------------------------------------------------------------------------------

    ensureGuideState() {
      if (this.guide) return this.guide;
      const now = Date.now();
      const profile = LiveTvProfileState.get();
      this.guide = {
        tabs: [],
        tabIndex: 0,
        rowIndex: 0,
        topRow: 0,
        zone: "grid",
        column: "channel",
        viewStartMs: floorToSlot(now),
        focusMs: now,
        programmes: new Map(),
        loading: new Set(),
        previewKey: "",
        previewTimer: null,
        tickTimer: null,
        toastTimer: null,
        holdTimer: null,
        holdFired: false,
        pendingChannelKey: String(this.params?.focusChannelKey || profile.lastChannelKey || ""),
        pendingTabId: String(this.params?.tabId || profile.lastGroupId || "")
      };
      return this.guide;
    },

    teardownGuide() {
      const guide = this.guide;
      if (!guide) return;
      clearTimeout(guide.previewTimer);
      clearInterval(guide.tickTimer);
      clearTimeout(guide.toastTimer);
      clearTimeout(guide.holdTimer);
      stopLivePreview();
      this.guide = null;
    },

    /** Rebuilds the tabs (channels, favourites or settings changed), keeping the focused channel. */
    rebuildTabs() {
      const guide = this.ensureGuideState();
      const { channels, groups } = LiveTvRepository.state;
      const profile = LiveTvProfileState.get();
      const settings = LiveTvSettings.get();
      const focusedKey = this.focusedChannelKey();
      const currentTabId = guide.tabs[guide.tabIndex]?.id || guide.pendingTabId;
      guide.tabs = buildTabs({
        channels,
        groups,
        favourites: profile.favourites,
        recent: profile.recent,
        hiddenGroups: settings.hiddenGroups,
        labels: {
          favourites: t("livetv_tab_favourites"),
          recent: t("livetv_tab_recent"),
          all: t("livetv_tab_all")
        }
      });
      let tabIndex = guide.tabs.findIndex((tab) => tab.id === currentTabId);
      if (tabIndex < 0) tabIndex = guide.tabs.findIndex((tab) => tab.id === TAB.ALL);
      guide.tabIndex = Math.max(0, tabIndex);
      guide.pendingTabId = "";
      const wantedKey = guide.pendingChannelKey || focusedKey;
      guide.pendingChannelKey = "";
      const keys = this.tabChannelKeys();
      const rowIndex = wantedKey ? keys.indexOf(wantedKey) : -1;
      guide.rowIndex = rowIndex >= 0 ? rowIndex : Math.min(guide.rowIndex, Math.max(0, keys.length - 1));
      guide.topRow = Math.max(0, Math.min(guide.rowIndex - 2, Math.max(0, keys.length - VISIBLE_ROWS)));
    },

    tabChannelKeys() {
      const guide = this.guide;
      return guide?.tabs[guide.tabIndex]?.channelKeys || [];
    },

    focusedChannelKey() {
      const guide = this.guide;
      if (!guide) return "";
      return this.tabChannelKeys()[guide.rowIndex] || "";
    },

    focusedChannel() {
      return LiveTvRepository.getChannel(this.focusedChannelKey());
    },

    channelProgrammes(channelKey) {
      return this.guide?.programmes.get(channelKey)?.list || [];
    },

    /** The programme focused in the grid (null in the channel column or on a gap). */
    focusedProgramme() {
      const guide = this.guide;
      if (!guide) return null;
      const list = this.channelProgrammes(this.focusedChannelKey());
      return programmeAt(list, guide.column === "channel" ? Date.now() : guide.focusMs);
    },

    viewEndMs() {
      return this.guide.viewStartMs + GUIDE_SPAN_MS;
    },

    // ---- Layout -----------------------------------------------------------------------------

    renderGuide() {
      this.ensureGuideState();
      this.rebuildTabs();
      return `
        <div class="livetv-guide">
          <section class="livetv-guide-top">
            <div class="livetv-preview" id="livetvPreview">
              <div class="livetv-preview-placeholder" id="livetvPreviewPlaceholder"></div>
            </div>
            <div class="livetv-details" id="livetvDetails"></div>
          </section>
          <div class="livetv-guide-bar">
            <div class="livetv-tabs" id="livetvTabs"></div>
            <div class="livetv-guide-status" id="livetvGuideStatus"></div>
          </div>
          <section class="livetv-grid">
            <div class="livetv-ruler">
              <div class="livetv-ruler-corner" id="livetvClock"></div>
              <div class="livetv-ruler-track" id="livetvRuler"></div>
            </div>
            <div class="livetv-rows" id="livetvRows"></div>
          </section>
          <div class="livetv-toast" id="livetvToast" role="status"></div>
        </div>
      `;
    },

    afterGuideRender() {
      const guide = this.ensureGuideState();
      clearInterval(guide.tickTimer);
      guide.tickTimer = setInterval(() => this.onGuideTick(), TICK_MS);
      this.updateGuide({ preview: true });
      if (this.focusZone !== "sidebar") this.focusGuide();
    },

    /** Moves keyboard focus off the sidebar into the guide (the guide draws its own focus). */
    focusGuide() {
      this.focusZone = "content";
      this.container?.querySelectorAll(".focusable.focused").forEach((node) => node.classList.remove("focused"));
      try {
        document.activeElement?.blur?.();
      } catch (_) {
        // Nothing focused.
      }
      this.updateGuide({ preview: true });
    },

    onGuideFocusLeft() {
      if (this.guide) this.updateGuide({ preview: false });
    },

    onGuideTick() {
      if (!this.isMounted() || !this.guide) return;
      const now = Date.now();
      const guide = this.guide;
      // Keep "now" in view while the user isn't browsing elsewhere.
      if (guide.column === "channel" && now >= this.viewEndMs() - 30 * MINUTE_MS) {
        guide.viewStartMs = floorToSlot(now);
      }
      this.updateGuide({ preview: false });
    },

    onGuideDataChanged(reason) {
      if (!this.container) return;
      if (!this.showsGuide()) {
        this.render();
        return;
      }
      if (!this.container.querySelector(".livetv-guide")) {
        this.render();
        return;
      }
      if (reason === "guideProgress" || reason === "refreshing") {
        this.updateGuideStatusLine();
        return;
      }
      if (reason === "guide") this.guide?.programmes.clear();
      this.rebuildTabs();
      this.updateGuide({ preview: false });
    },

    /** Redraws every part of the guide from state. */
    updateGuide({ preview = false } = {}) {
      if (!this.guide || !this.container?.querySelector(".livetv-guide")) return;
      this.updateTabs();
      this.updateRuler();
      this.updateRows();
      this.updateDetails();
      this.updateGuideStatusLine();
      this.loadVisibleProgrammes();
      if (preview) this.schedulePreview();
    },

    updateTabs() {
      const guide = this.guide;
      const node = this.container.querySelector("#livetvTabs");
      if (!node) return;
      const focusTabs = this.focusZone !== "sidebar" && guide.zone === "tabs";
      const tabs = [...guide.tabs, { id: MANAGE_TAB_ID, title: t("livetv_manage_sources"), channelKeys: [] }];
      node.innerHTML = tabs
        .map((tab, index) => {
          const selected = index === guide.tabIndex;
          const focused = focusTabs && (guide.tabFocusIndex ?? guide.tabIndex) === index;
          return `<span class="livetv-tab${selected ? " selected" : ""}${focused ? " focused" : ""}${tab.id === MANAGE_TAB_ID ? " livetv-tab-manage" : ""}" data-tab-index="${index}">${escapeHtml(tab.title)}</span>`;
        })
        .join("");
      const active = node.querySelector(".focused") || node.querySelector(".selected");
      if (active) {
        const left = active.offsetLeft - node.clientWidth / 2 + active.offsetWidth / 2;
        node.scrollLeft = Math.max(0, left);
      }
    },

    updateRuler() {
      const guide = this.guide;
      const ruler = this.container.querySelector("#livetvRuler");
      const clock = this.container.querySelector("#livetvClock");
      const now = Date.now();
      if (clock) clock.textContent = formatTime(now);
      if (!ruler) return;
      const start = guide.viewStartMs;
      const marks = rulerMarks(start, GUIDE_SPAN_MS, formatTime)
        .map(
          (mark) =>
            `<span class="livetv-ruler-mark" style="left:${((mark.ms - start) / GUIDE_SPAN_MS) * 100}%">${escapeHtml(mark.label)}</span>`
        )
        .join("");
      const nowLeft = ((now - start) / GUIDE_SPAN_MS) * 100;
      const nowMarker = nowLeft >= 0 && nowLeft <= 100 ? `<span class="livetv-ruler-now" style="left:${nowLeft}%"></span>` : "";
      ruler.innerHTML = marks + nowMarker;
    },

    updateRows() {
      const guide = this.guide;
      const rowsNode = this.container.querySelector("#livetvRows");
      if (!rowsNode) return;
      const keys = this.tabChannelKeys();
      if (!keys.length) {
        rowsNode.innerHTML = `<p class="livetv-empty livetv-grid-empty">${escapeHtml(
          guide.tabs[guide.tabIndex]?.id === TAB.FAVOURITES ? t("livetv_no_favourites") : t("livetv_no_channels_in_group")
        )}</p>`;
        return;
      }
      const now = Date.now();
      const start = guide.viewStartMs;
      const end = this.viewEndMs();
      const nowLeft = ((now - start) / GUIDE_SPAN_MS) * 100;
      const favourites = new Set(LiveTvProfileState.get().favourites);
      const gridFocused = this.focusZone !== "sidebar" && guide.zone === "grid";
      const rows = [];
      for (let index = guide.topRow; index < Math.min(keys.length, guide.topRow + VISIBLE_ROWS); index += 1) {
        const channel = LiveTvRepository.getChannel(keys[index]);
        if (!channel) continue;
        const focusedRow = gridFocused && index === guide.rowIndex;
        const channelFocused = focusedRow && guide.column === "channel";
        const programmes = this.channelProgrammes(channel.key);
        const hasData = guide.programmes.has(channel.key);
        const cells = rowCells(programmes, start, end)
          .map((cell) => {
            const programme = cell.programme;
            const focused = focusedRow && guide.column === "programme" && cell.startMs <= guide.focusMs && cell.stopMs > guide.focusMs;
            const live = programme && programme.startMs <= now && programme.stopMs > now;
            const past = programme && programme.stopMs <= now;
            const catchup = past && canPlayCatchup(channel, programme, now);
            const title = programme ? programme.title : hasData || !LiveTvRepository.hasGuide(channel.key) ? t("livetv_no_info") : "";
            const time =
              programme && cell.width > 0.18 ? `<span class="livetv-cell-time">${escapeHtml(formatTime(programme.startMs))}</span>` : "";
            const classes = [
              "livetv-cell",
              focused ? "focused" : "",
              live ? "live" : "",
              past ? "past" : "",
              catchup ? "catchup" : "",
              programme ? "" : "empty"
            ]
              .filter(Boolean)
              .join(" ");
            return `<div class="${classes}" style="left:${cell.left * 100}%;width:${cell.width * 100}%"><span class="livetv-cell-title">${escapeHtml(title)}</span>${time}</div>`;
          })
          .join("");
        const nowLine = nowLeft >= 0 && nowLeft <= 100 ? `<div class="livetv-row-now" style="left:${nowLeft}%"></div>` : "";
        rows.push(`
          <div class="livetv-row${focusedRow ? " focused-row" : ""}">
            <div class="livetv-chan${channelFocused ? " focused" : ""}">
              <span class="livetv-chan-number">${escapeHtml(channel.number || "")}</span>
              ${logoMarkup(channel, "livetv-chan-logo")}
              <span class="livetv-chan-name">${escapeHtml(channel.name)}</span>
              ${favourites.has(channel.key) ? '<span class="livetv-chan-fav material-icons" aria-hidden="true">star</span>' : ""}
            </div>
            <div class="livetv-progs">${cells}${nowLine}</div>
          </div>
        `);
      }
      rowsNode.innerHTML = rows.join("");
    },

    updateDetails() {
      const node = this.container.querySelector("#livetvDetails");
      const placeholder = this.container.querySelector("#livetvPreviewPlaceholder");
      const channel = this.focusedChannel();
      if (placeholder) {
        placeholder.innerHTML = channel
          ? `${logoMarkup(channel, "livetv-preview-logo")}<span class="livetv-preview-name">${escapeHtml(channel.name)}</span>`
          : "";
      }
      if (!node) return;
      if (!channel) {
        node.innerHTML = "";
        return;
      }
      const now = Date.now();
      const programme = this.focusedProgramme();
      const header = `
        <div class="livetv-details-channel">
          ${logoMarkup(channel, "livetv-details-logo")}
          <span>${escapeHtml(channel.number ? `${channel.number}  ${channel.name}` : channel.name)}</span>
        </div>`;
      if (!programme) {
        node.innerHTML = `${header}<h2 class="livetv-details-title">${escapeHtml(
          LiveTvRepository.hasGuide(channel.key) ? t("livetv_no_info") : t("livetv_no_guide_for_channel")
        )}</h2><p class="livetv-details-hint">${escapeHtml(t("livetv_hint_ok_watch"))}</p>`;
        return;
      }
      const live = programme.startMs <= now && programme.stopMs > now;
      const past = programme.stopMs <= now;
      const catchup = past && canPlayCatchup(channel, programme, now);
      const minutes = Math.round((programme.stopMs - programme.startMs) / MINUTE_MS);
      const day =
        new Date(programme.startMs).toDateString() !== new Date(now).toDateString()
          ? `${new Date(programme.startMs).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · `
          : "";
      const badge = live
        ? `<span class="livetv-badge livetv-badge-live">${escapeHtml(t("livetv_live_now"))}</span>`
        : catchup
          ? `<span class="livetv-badge livetv-badge-catchup">${escapeHtml(t("livetv_catchup"))}</span>`
          : "";
      const hint = live
        ? t("livetv_hint_ok_watch")
        : catchup
          ? t("livetv_hint_ok_catchup")
          : past
            ? t("livetv_hint_no_catchup")
            : t("livetv_starts_at", { time: formatTime(programme.startMs) });
      const meta = [
        `${day}${formatTime(programme.startMs)} – ${formatTime(programme.stopMs)}`,
        t("livetv_minutes", { minutes }),
        programme.episode,
        programme.category,
        programme.year
      ]
        .filter(Boolean)
        .map((part) => escapeHtml(part))
        .join(" · ");
      const progress = live ? `<div class="livetv-progress"><div style="width:${progressOf(programme, now) * 100}%"></div></div>` : "";
      node.innerHTML = `
        ${header}
        <h2 class="livetv-details-title">${badge}${escapeHtml(programme.title)}</h2>
        ${programme.subTitle ? `<p class="livetv-details-subtitle">${escapeHtml(programme.subTitle)}</p>` : ""}
        <p class="livetv-details-meta">${meta}</p>
        ${progress}
        <p class="livetv-details-description">${escapeHtml(programme.description || "")}</p>
        <p class="livetv-details-hint">${escapeHtml(hint)}</p>
      `;
    },

    updateGuideStatusLine() {
      const node = this.container?.querySelector("#livetvGuideStatus");
      if (!node) return;
      const { guide } = LiveTvRepository.state;
      if (LiveTvRepository.isRefreshing()) {
        node.textContent = t("livetv_loading_channels");
      } else if (guide.loading) {
        const count = guide.progress?.programmes || 0;
        node.textContent = count ? t("livetv_guide_loading_count", { count: count.toLocaleString() }) : t("livetv_guide_loading");
      } else if (guide.error && !guide.updatedAt) {
        node.textContent = t("livetv_guide_failed");
      } else if (guide.updatedAt) {
        node.textContent = t("livetv_guide_updated", { when: formatWhen(guide.updatedAt) });
      } else {
        node.textContent = "";
      }
    },

    showGuideToast(message) {
      const node = this.container?.querySelector("#livetvToast");
      if (!node || !this.guide) return;
      node.textContent = message;
      node.classList.add("visible");
      clearTimeout(this.guide.toastTimer);
      this.guide.toastTimer = setTimeout(() => node.classList.remove("visible"), 2500);
    },

    // ---- Data -------------------------------------------------------------------------------

    /** Reads programmes for the rows in (and just around) view, then redraws. */
    loadVisibleProgrammes() {
      const guide = this.guide;
      if (!guide) return;
      const keys = this.tabChannelKeys();
      const from = guide.viewStartMs;
      const to = this.viewEndMs();
      const first = Math.max(0, guide.topRow - 3);
      const last = Math.min(keys.length, guide.topRow + VISIBLE_ROWS + 3);
      const wanted = keys.slice(first, last).filter((key) => {
        const entry = guide.programmes.get(key);
        return !guide.loading.has(key) && !(entry && entry.fromMs <= from && entry.toMs >= to);
      });
      if (!wanted.length) return;
      const readFrom = from - READ_BEFORE_MS;
      const readTo = to + READ_AFTER_MS;
      wanted.forEach((key) => guide.loading.add(key));
      void Promise.all(
        wanted.map((key) =>
          LiveTvRepository.getProgrammes(key, readFrom, readTo)
            .then((list) => guide.programmes.set(key, { fromMs: readFrom, toMs: readTo, list }))
            .catch(() => guide.programmes.set(key, { fromMs: readFrom, toMs: readTo, list: [] }))
            .finally(() => guide.loading.delete(key))
        )
      ).then(() => {
        if (this.guide !== guide || !this.isMounted()) return;
        this.updateRows();
        this.updateDetails();
      });
    },

    // ---- Preview ----------------------------------------------------------------------------

    /** Plays the focused channel in the preview once focus has rested on it. */
    schedulePreview() {
      const guide = this.guide;
      if (!guide) return;
      clearTimeout(guide.previewTimer);
      if (!LiveTvSettings.get().showPreview) return;
      const key = this.focusedChannelKey();
      if (!key || key === guide.previewKey) return;
      guide.previewTimer = setTimeout(() => {
        if (this.guide !== guide || !this.isMounted()) return;
        const channel = LiveTvRepository.getChannel(this.focusedChannelKey());
        const element = this.container?.querySelector("#livetvPreview");
        if (!channel || !element) return;
        guide.previewKey = channel.key;
        void startLivePreview(channel, element);
      }, PREVIEW_DELAY_MS);
    }
  };
}
