// Nuvio Live: Live TV settings, shown under the providers (Live TV > Providers & settings, also
// reached from Settings > Live TV).
// Options follow NuvioPlusIPTV (GPL-3.0), ui/LiveTvSettingsScreen.kt; only the ones that matter
// on this app are kept.
import { LiveTvRepository } from "../../../livetv/liveTvRepository.js";
import { LiveTvSettings } from "../../../livetv/data/liveTvPreferences.js";
import { LiveTvSourceStore } from "../../../livetv/data/sourceStore.js";
import { escapeHtml, t } from "./liveTvScreenShared.js";

// User-Agent presets for providers that block unknown players (typing one on a TV is no fun).
export const USER_AGENT_PRESETS = Object.freeze([
  { id: "", labelKey: "livetv_ua_default" },
  { id: "VLC/3.0.20 LibVLC/3.0.20", label: "VLC" },
  { id: "TiviMate/5.1.6 (Android 12)", label: "TiviMate" },
  { id: "IPTVSmartersPlayer", label: "IPTV Smarters" },
  {
    id: "Mozilla/5.0 (Linux; Android 12; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    label: "Android TV browser"
  }
]);

const CYCLES = Object.freeze({
  guideFutureDays: [1, 2, 3, 5, 7],
  guideRefreshHours: [6, 12, 24, 48],
  guidePastHours: [24, 48, 72, 168]
});

function userAgentLabel(value) {
  const preset = USER_AGENT_PRESETS.find((item) => item.id === String(value || ""));
  if (!preset) return t("livetv_ua_custom");
  return preset.labelKey ? t(preset.labelKey) : preset.label;
}

function settingRow({ action, key, title, value, focusKey, extra = "" }) {
  return `
    <button type="button" class="livetv-setting focusable" data-action="${action}" data-setting="${escapeHtml(key)}" data-focus-key="${escapeHtml(focusKey)}" ${extra}>
      <span class="livetv-setting-title">${escapeHtml(title)}</span>
      <span class="livetv-setting-value">${escapeHtml(value)}</span>
    </button>`;
}

export function createLiveTvScreenMethods04() {
  return {
    renderLiveTvSettings() {
      const settings = LiveTvSettings.get();
      const onOff = (value) => t(value ? "livetv_on" : "livetv_off");
      const hidden = new Set(settings.hiddenGroups || []);
      const groups = LiveTvRepository.state.groups;
      const sources = LiveTvSourceStore.list();
      const userAgents = sources
        .map((source) =>
          settingRow({
            action: "cycleUserAgent",
            key: source.id,
            title: t("livetv_setting_user_agent", { name: source.name }),
            value: userAgentLabel(source.userAgent),
            focusKey: `ua:${source.id}`,
            extra: `data-source-id="${escapeHtml(source.id)}"`
          })
        )
        .join("");
      const groupChips = groups
        .map(
          (group) =>
            `<button type="button" class="livetv-chip focusable${hidden.has(group.id) ? " livetv-chip-off" : ""}" data-action="toggleGroup" data-group-id="${escapeHtml(group.id)}" data-focus-key="group:${escapeHtml(group.id)}">${escapeHtml(group.title)}</button>`
        )
        .join("");
      return `
        <section class="livetv-settings">
          <h2 class="livetv-section-title">${escapeHtml(t("livetv_settings_title"))}</h2>
          <div class="livetv-settings-list">
            ${settingRow({ action: "refreshGuide", key: "", title: t("livetv_setting_refresh_guide"), value: "", focusKey: "refreshGuide" })}
            <p class="livetv-source-status" id="livetvSettingsGuideStatus"></p>
            ${settingRow({ action: "toggleSetting", key: "showPreview", title: t("livetv_setting_preview"), value: onOff(settings.showPreview), focusKey: "set:showPreview" })}
            ${settingRow({ action: "toggleSetting", key: "showFavouritesRowOnHome", title: t("livetv_setting_home_row"), value: onOff(settings.showFavouritesRowOnHome), focusKey: "set:showFavouritesRowOnHome" })}
            ${settingRow({ action: "toggleSetting", key: "use24HourClock", title: t("livetv_setting_24h"), value: onOff(settings.use24HourClock), focusKey: "set:use24HourClock" })}
            ${settingRow({ action: "cycleSetting", key: "guideFutureDays", title: t("livetv_setting_days_ahead"), value: t("livetv_days", { count: settings.guideFutureDays }), focusKey: "set:guideFutureDays" })}
            ${settingRow({ action: "cycleSetting", key: "guidePastHours", title: t("livetv_setting_days_back"), value: t("livetv_days", { count: Math.round(settings.guidePastHours / 24) }), focusKey: "set:guidePastHours" })}
            ${settingRow({ action: "cycleSetting", key: "guideRefreshHours", title: t("livetv_setting_refresh_every"), value: t("livetv_hours", { count: settings.guideRefreshHours }), focusKey: "set:guideRefreshHours" })}
            ${userAgents}
          </div>
          ${
            groups.length
              ? `<h3 class="livetv-subsection-title">${escapeHtml(t("livetv_setting_groups"))}</h3>
                 <p class="livetv-empty">${escapeHtml(t("livetv_setting_groups_hint"))}</p>
                 <div class="livetv-chips">${groupChips}</div>`
              : ""
          }
        </section>
      `;
    },

    updateGuideStatusLineInSettings() {
      const node = this.container?.querySelector("#livetvSettingsGuideStatus");
      if (!node) return;
      const { guide } = LiveTvRepository.state;
      if (guide.loading) {
        const count = guide.progress?.programmes || 0;
        node.textContent = count ? t("livetv_guide_loading_count", { count: count.toLocaleString() }) : t("livetv_guide_loading");
      } else if (guide.updatedAt) {
        node.textContent = t("livetv_guide_status", {
          when: new Date(guide.updatedAt).toLocaleString(),
          channels: guide.channels || 0,
          programmes: (guide.programmes || 0).toLocaleString()
        });
      } else {
        node.textContent = guide.error ? t("livetv_guide_failed") : "";
      }
    },

    activateSettingsNode(node, action) {
      const key = String(node?.dataset?.setting || "");
      const settings = LiveTvSettings.get();
      if (action === "toggleSetting" && key) {
        LiveTvSettings.set({ [key]: !settings[key] });
      } else if (action === "cycleSetting" && CYCLES[key]) {
        const values = CYCLES[key];
        const index = values.indexOf(settings[key]);
        LiveTvSettings.set({ [key]: values[(index + 1) % values.length] });
      } else if (action === "toggleGroup") {
        const id = String(node.dataset.groupId || "");
        const hidden = new Set(settings.hiddenGroups || []);
        if (hidden.has(id)) hidden.delete(id);
        else hidden.add(id);
        LiveTvSettings.set({ hiddenGroups: Array.from(hidden) });
      } else if (action === "cycleUserAgent") {
        const source = LiveTvSourceStore.get(String(node.dataset.sourceId || ""));
        if (!source) return;
        const index = USER_AGENT_PRESETS.findIndex((item) => item.id === String(source.userAgent || ""));
        const next = USER_AGENT_PRESETS[(index + 1) % USER_AGENT_PRESETS.length];
        LiveTvSourceStore.save({ ...source, userAgent: next.id });
      } else {
        return;
      }
      this.pendingFocusKey = String(node.dataset.focusKey || "");
      this.render();
    }
  };
}
