// Nuvio Live: the Live TV entry in Settings; opens Live TV's providers & settings.
import { Router } from "../../navigation/routerState.js";
import { I18n } from "../../../i18n/index.js";
import { LiveTvSourceStore } from "../../../livetv/data/sourceStore.js";
import { SECTION_META } from "./settingsScreenHelpers-03-clamp-subtitle-text-opacity.js";

function t(key, params = {}) {
  return I18n.t(key, params, { fallback: key });
}

export function renderLiveTvSection() {
  const sources = LiveTvSourceStore.list();
  this.actionMap.set("liveTv:open", () => Router.navigate("liveTv", { view: "sources" }));
  const row = this.renderActionRow({
    focusKey: "liveTv:open",
    title: t("livetv_manage_sources"),
    subtitle: sources.length
      ? sources.map((source) => source.name).join(", ")
      : t("livetv_settings_no_providers"),
    leadingIcon: "live_tv"
  });
  return `
      ${this.renderSectionHeader(SECTION_META.find((item) => item.id === "liveTv"))}
      <div class="settings-group-card">
        <div class="settings-stack">${row}</div>
      </div>
    `;
}
