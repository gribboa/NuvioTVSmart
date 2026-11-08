// Nuvio Live: the Live TV section. For now (Phase 1) it lists the IPTV sources and adds one
// from a phone via a QR code; the guide replaces the list in a later phase.
import { Router } from "../../navigation/routerState.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { Environment } from "../../../platform/environment.js";
import { Platform } from "../../../platform/index.js";
import { LayoutPreferences } from "../../../data/local/layoutPreferences.js";
import { QrCodeGenerator } from "../../../core/qr/qrCodeGenerator.js";
import { I18n } from "../../../i18n/index.js";
import {
  activateLegacySidebarAction,
  bindRootSidebarEvents,
  focusWithoutAutoScroll,
  getRootSidebarNodes,
  getRootSidebarSelectedNode,
  getSidebarProfileState,
  isRootSidebarNode,
  isSelectedSidebarAction,
  renderRootSidebar,
  setLegacySidebarExpanded,
  setModernSidebarExpanded
} from "../../components/sidebarNavigation.js";
import { LiveTvSourceStore } from "../../../livetv/data/sourceStore.js";
import { LIVE_TV_SOURCE_TYPE, maskSecret, sourceFromSubmission } from "../../../livetv/model.js";
import {
  LiveTvPhoneSetupError,
  openLiveTvPhoneSetup
} from "../../../livetv/setup/phoneSetupSession.js";

const ROUTE = "liveTv";
const VIEW = Object.freeze({ SOURCES: "sources", PHONE: "phone", MANUAL: "manual" });
// Samsung's on-screen keyboard sends these when it closes (Done / Cancel).
const TIZEN_IME_DONE = 65376;
const TIZEN_IME_CANCEL = 65385;
const MANUAL_FIELDS = Object.freeze({
  [LIVE_TV_SOURCE_TYPE.XTREAM]: [
    { field: "server", labelKey: "livetv_phone_server", hintKey: "livetv_phone_server_hint" },
    { field: "username", labelKey: "livetv_phone_username" },
    { field: "password", labelKey: "livetv_phone_password", type: "password" },
    { field: "name", labelKey: "livetv_phone_name" }
  ],
  [LIVE_TV_SOURCE_TYPE.M3U]: [
    { field: "url", labelKey: "livetv_phone_playlist_url" },
    { field: "epgUrl", labelKey: "livetv_phone_epg_url", hintKey: "livetv_phone_epg_hint" },
    { field: "name", labelKey: "livetv_phone_name" }
  ]
});

function t(key, params = {}) {
  return I18n.t(key, params, { fallback: key });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function selectorValue(value) {
  const raw = String(value || "");
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(raw)
    : raw.replace(/["\\]/g, "\\$&");
}

function scrollIntoNearestView(node) {
  try {
    node?.scrollIntoView?.({ behavior: "auto", block: "nearest", inline: "nearest" });
  } catch (_) {
    node?.scrollIntoView?.();
  }
}

function sourceDetailRows(source) {
  if (source.type === LIVE_TV_SOURCE_TYPE.XTREAM) {
    return [
      [t("livetv_source_server"), source.server],
      [t("livetv_source_username"), source.username],
      [t("livetv_source_password"), maskSecret(source.password)]
    ];
  }
  return [
    [t("livetv_source_playlist"), source.url],
    [t("livetv_source_guide"), source.epgUrl || t("livetv_source_guide_from_playlist")]
  ];
}

export const LiveTvScreen = {
  async mount() {
    this.container = document.getElementById(ROUTE);
    ScreenUtils.show(this.container);
    this.mountToken = (this.mountToken || 0) + 1;
    const mountToken = this.mountToken;
    this.layoutPrefs = LayoutPreferences.get();
    this.sidebarExpanded = false;
    this.focusZone = "content";
    this.view = VIEW.SOURCES;
    this.phone = null;
    this.manual = null;
    this.notice = "";
    this.confirmRemoveId = "";
    this.pendingFocusKey = "";
    this.bindInputs();
    try {
      this.sidebarProfile = await getSidebarProfileState({ cacheOnly: true });
    } catch (_) {
      this.sidebarProfile = null;
    }
    if (mountToken !== this.mountToken) return;
    this.render();
    void getSidebarProfileState()
      .then((profile) => {
        if (profile && mountToken === this.mountToken) this.sidebarProfile = profile;
      })
      .catch(() => {});
  },

  cleanup() {
    this.mountToken = (this.mountToken || 0) + 1;
    this.closePhoneSetup();
    this.manual = null;
    ScreenUtils.hide(this.container);
  },

  isMounted() {
    return Boolean(this.container) && Router.getCurrent() === ROUTE;
  },

  // ---- Rendering ---------------------------------------------------------------------------

  render() {
    if (!this.container) return;
    this.container.innerHTML = `
      <div class="home-shell livetv-shell">
        ${renderRootSidebar({
          selectedRoute: ROUTE,
          profile: this.sidebarProfile,
          layout: this.layoutPrefs,
          expanded: Boolean(this.sidebarExpanded)
        })}
        <main class="home-main livetv-main">
          <header class="livetv-header">
            <h1 class="livetv-title">${escapeHtml(t("livetv_title"))}</h1>
          </header>
          ${this.renderView()}
        </main>
      </div>
    `;
    ScreenUtils.indexFocusables(this.container);
    bindRootSidebarEvents(this.container, {
      currentRoute: ROUTE,
      onSelectedAction: () => this.focusMainNode(),
      onExpandSidebar: () => this.focusSidebarNode()
    });
    this.bindClicks();
    this.restoreFocus();
  },

  renderView() {
    if (this.view === VIEW.PHONE) return this.renderPhoneSetup();
    if (this.view === VIEW.MANUAL) return this.renderManualEntry();
    return this.renderSources();
  },

  renderSources() {
    const sources = LiveTvSourceStore.list();
    const notice = this.notice
      ? `<p class="livetv-notice" role="status">${escapeHtml(this.notice)}</p>`
      : "";
    const cards = sources
      .map((source) => {
        const confirming = this.confirmRemoveId === source.id;
        const rows = sourceDetailRows(source)
          .map(
            ([label, value]) =>
              `<div class="livetv-source-row"><span class="livetv-source-label">${escapeHtml(label)}</span><span class="livetv-source-value">${escapeHtml(value)}</span></div>`
          )
          .join("");
        return `
          <section class="livetv-source-card" data-source-id="${escapeHtml(source.id)}">
            <div class="livetv-source-heading">
              <span class="livetv-source-name">${escapeHtml(source.name)}</span>
              <span class="livetv-source-type">${escapeHtml(source.type === LIVE_TV_SOURCE_TYPE.XTREAM ? "Xtream" : "M3U")}</span>
            </div>
            ${rows}
            <div class="livetv-actions">
              <button type="button" class="livetv-button focusable${confirming ? " livetv-button-danger" : ""}"
                data-action="removeSource" data-source-id="${escapeHtml(source.id)}"
                data-focus-key="remove:${escapeHtml(source.id)}">
                ${escapeHtml(confirming ? t("livetv_source_remove_confirm") : t("livetv_source_remove"))}
              </button>
            </div>
          </section>
        `;
      })
      .join("");
    const empty = sources.length
      ? ""
      : `<p class="livetv-empty">${escapeHtml(t("livetv_no_sources"))}</p>`;
    return `
      <div class="livetv-sources">
        ${notice}
        ${empty}
        <div class="livetv-actions">
          <button type="button" class="livetv-button livetv-button-primary focusable" data-action="addFromPhone" data-focus-key="addFromPhone">
            ${escapeHtml(t("livetv_add_from_phone"))}
          </button>
          <button type="button" class="livetv-button focusable" data-action="addOnTv" data-focus-key="addOnTv">
            ${escapeHtml(t("livetv_add_on_tv"))}
          </button>
        </div>
        ${cards}
      </div>
    `;
  },

  renderPhoneSetup() {
    const phone = this.phone || {};
    const status = phone.error
      ? `<p class="livetv-phone-status livetv-phone-status-error" role="status">${escapeHtml(phone.error)}</p>`
      : `<p class="livetv-phone-status" role="status">${escapeHtml(phone.url ? t("livetv_phone_waiting") : t("livetv_phone_starting"))}</p>`;
    const qr = phone.qrDataUrl
      ? `<img class="livetv-phone-qr" src="${escapeHtml(phone.qrDataUrl)}" alt="${escapeHtml(t("livetv_phone_qr_alt"))}" />`
      : `<div class="livetv-phone-qr livetv-phone-qr-placeholder"></div>`;
    const retry = phone.canRetry
      ? `<button type="button" class="livetv-button livetv-button-primary focusable" data-action="retryPhone" data-focus-key="retryPhone">${escapeHtml(t("livetv_phone_try_again"))}</button>`
      : "";
    return `
      <div class="livetv-phone">
        ${qr}
        <div class="livetv-phone-text">
          <h2 class="livetv-phone-title">${escapeHtml(t("livetv_phone_tv_title"))}</h2>
          <ol class="livetv-phone-steps">
            <li>${escapeHtml(t("livetv_phone_step_scan"))}</li>
            <li>${escapeHtml(t("livetv_phone_step_fill"))}</li>
            <li>${escapeHtml(t("livetv_phone_step_send"))}</li>
          </ol>
          ${phone.url ? `<p class="livetv-phone-url">${escapeHtml(t("livetv_phone_or_open"))}<br><span>${escapeHtml(phone.url)}</span></p>` : ""}
          ${status}
          <div class="livetv-actions">
            ${retry}
            <button type="button" class="livetv-button focusable" data-action="addOnTv" data-focus-key="addOnTv">${escapeHtml(t("livetv_add_on_tv"))}</button>
            <button type="button" class="livetv-button focusable" data-action="cancelPhone" data-focus-key="cancelPhone">${escapeHtml(t("livetv_phone_cancel"))}</button>
          </div>
        </div>
      </div>
    `;
  },

  renderManualEntry() {
    const manual = this.manual;
    const tabs = [LIVE_TV_SOURCE_TYPE.XTREAM, LIVE_TV_SOURCE_TYPE.M3U]
      .map((type) => {
        const selected = manual.type === type;
        const label = t(
          type === LIVE_TV_SOURCE_TYPE.XTREAM ? "livetv_phone_tab_xtream" : "livetv_phone_tab_m3u"
        );
        return `<button type="button" class="livetv-button focusable${selected ? " livetv-button-selected" : ""}" data-action="manualType" data-type="${type}" data-focus-key="type:${type}" aria-pressed="${selected}">${escapeHtml(label)}</button>`;
      })
      .join("");
    const fields = MANUAL_FIELDS[manual.type]
      .map(
        ({ field, labelKey, hintKey, type }) => `
          <label class="livetv-field">
            <span class="livetv-field-label">${escapeHtml(t(labelKey))}</span>
            <input class="livetv-input focusable" type="${type || "text"}" data-field="${field}" data-focus-key="field:${field}"
              value="${escapeHtml(manual.values[field] || "")}" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" />
            ${hintKey ? `<span class="livetv-field-hint">${escapeHtml(t(hintKey))}</span>` : ""}
          </label>`
      )
      .join("");
    const error = manual.error
      ? `<p class="livetv-phone-status livetv-phone-status-error" role="status">${escapeHtml(manual.error)}</p>`
      : "";
    return `
      <div class="livetv-manual">
        <h2 class="livetv-phone-title">${escapeHtml(t("livetv_manual_title"))}</h2>
        <div class="livetv-actions">${tabs}</div>
        ${fields}
        ${error}
        <div class="livetv-actions livetv-manual-actions">
          <button type="button" class="livetv-button livetv-button-primary focusable" data-action="manualSave" data-focus-key="manualSave">${escapeHtml(t("livetv_manual_save"))}</button>
          <button type="button" class="livetv-button focusable" data-action="manualCancel" data-focus-key="manualCancel">${escapeHtml(t("livetv_phone_cancel"))}</button>
        </div>
      </div>
    `;
  },

  bindInputs() {
    if (!this.container || this.container.__liveTvInputsBound) return;
    this.container.__liveTvInputsBound = true;
    this.container.addEventListener("input", (event) => {
      const input = event.target?.closest?.("input.livetv-input");
      if (input) this.captureManualField(input);
    });
  },

  captureManualField(input) {
    const field = String(input?.dataset?.field || "");
    if (this.manual && field) this.manual.values[field] = String(input.value || "");
  },

  bindClicks() {
    this.container.querySelectorAll(".livetv-main .focusable:not(input)").forEach((node) => {
      node.onclick = (event) => {
        event?.preventDefault?.();
        this.setFocusedNode(node);
        void this.activateNode(node);
      };
    });
  },

  // ---- Focus -------------------------------------------------------------------------------

  mainNodes() {
    return Array.from(this.container?.querySelectorAll(".livetv-main .focusable") || []);
  },

  restoreFocus() {
    if (this.focusZone === "sidebar") {
      void this.focusSidebarNode();
      return;
    }
    const key = this.pendingFocusKey;
    this.pendingFocusKey = "";
    const target =
      (key &&
        this.container.querySelector(`.livetv-main [data-focus-key="${selectorValue(key)}"]`)) ||
      this.mainNodes()[0] ||
      null;
    if (target) this.setFocusedNode(target);
    else void this.focusSidebarNode();
  },

  setFocusedNode(target) {
    this.container?.querySelectorAll(".focusable.focused").forEach((node) => {
      if (node !== target) node.classList.remove("focused");
    });
    target.classList.add("focused");
    focusWithoutAutoScroll(target);
    const sidebarFocused = isRootSidebarNode(target);
    this.focusZone = sidebarFocused ? "sidebar" : "content";
    if (!this.layoutPrefs?.modernSidebar) setLegacySidebarExpanded(this.container, sidebarFocused);
    if (!sidebarFocused) scrollIntoNearestView(target);
    if (
      !sidebarFocused &&
      this.confirmRemoveId &&
      target.dataset.sourceId !== this.confirmRemoveId
    ) {
      // Moving away cancels "press OK again to remove".
      this.confirmRemoveId = "";
      this.pendingFocusKey = target.dataset.focusKey || "";
      this.render();
    }
  },

  async focusSidebarNode() {
    this.focusZone = "sidebar";
    if (this.layoutPrefs?.modernSidebar && !this.sidebarExpanded) {
      this.sidebarExpanded = true;
      setModernSidebarExpanded(this.container, true);
    }
    const target =
      getRootSidebarSelectedNode(this.container, this.layoutPrefs) ||
      getRootSidebarNodes(this.container, this.layoutPrefs)[0] ||
      null;
    if (target) this.setFocusedNode(target);
  },

  async focusMainNode() {
    this.focusZone = "content";
    if (this.layoutPrefs?.modernSidebar && this.sidebarExpanded) {
      this.sidebarExpanded = false;
      setModernSidebarExpanded(this.container, false);
    }
    const target = this.mainNodes()[0];
    if (target) this.setFocusedNode(target);
  },

  shouldTransferToSidebar(node) {
    const main = this.container?.querySelector(".livetv-main");
    if (!node || !main?.contains(node)) return false;
    return node.getBoundingClientRect().left - main.getBoundingClientRect().left <= 140;
  },

  // ---- Keys --------------------------------------------------------------------------------

  consumeBackRequest() {
    if (this.view === VIEW.PHONE) {
      this.cancelPhoneSetup();
      return true;
    }
    if (this.view === VIEW.MANUAL) {
      this.cancelManualEntry();
      return true;
    }
    if (this.confirmRemoveId) {
      this.confirmRemoveId = "";
      this.render();
      return true;
    }
    if (this.focusZone !== "sidebar") {
      void this.focusSidebarNode();
      return true;
    }
    return false;
  },

  async onKeyDown(event) {
    if (Environment.isBackEvent(event)) return;
    const code = Number(event?.keyCode || 0);
    const current = this.container?.querySelector(".focusable.focused") || document.activeElement;

    if (this.handleTextInputKey(event, code)) return;

    if (current && isRootSidebarNode(current)) {
      if (code === 39) {
        event?.preventDefault?.();
        await this.focusMainNode();
        return;
      }
      if (code === 38 || code === 40) {
        event?.preventDefault?.();
        const nodes = getRootSidebarNodes(this.container, this.layoutPrefs);
        const index = Math.max(0, nodes.indexOf(current));
        const next = nodes[Math.max(0, Math.min(nodes.length - 1, index + (code === 38 ? -1 : 1)))];
        if (next) this.setFocusedNode(next);
        return;
      }
      if (code === 13) {
        event?.preventDefault?.();
        const action = String(current.dataset.action || "");
        activateLegacySidebarAction(action, ROUTE);
        if (isSelectedSidebarAction(action, ROUTE)) await this.focusMainNode();
      }
      return;
    }

    if (code === 37 && this.shouldTransferToSidebar(current)) {
      event?.preventDefault?.();
      await this.focusSidebarNode();
      return;
    }

    if (ScreenUtils.handleDpadNavigation(event, this.container, ".livetv-main .focusable")) {
      const focused = this.mainNodes().find((node) => node === document.activeElement);
      if (focused) this.setFocusedNode(focused);
      return;
    }

    if (code === 13 && current) {
      event?.preventDefault?.();
      await this.activateNode(current);
    }
  },

  // Same handling as the add-repository field in pluginsScreen: while a field is being edited the
  // TV keyboard owns the arrows, and its Done/Cancel keys end editing and move on to the next item.
  handleTextInputKey(event, code) {
    const active = document.activeElement;
    if (!active?.matches?.("input.livetv-input") || !this.container?.contains(active)) return false;
    const nativeCode = Number(event?.originalKeyCode || code);
    if (Platform.isTizen() && (nativeCode === TIZEN_IME_DONE || nativeCode === TIZEN_IME_CANCEL)) {
      event?.preventDefault?.();
      this.captureManualField(active);
      active.blur();
      const nodes = this.mainNodes();
      const next = nodes[nodes.indexOf(active) + 1] || nodes[nodes.length - 1];
      if (next) this.setFocusedNode(next);
      return true;
    }
    if ((Platform.isTizen() || Platform.isWebOS()) && [37, 38, 39, 40].includes(code)) {
      event?.stopPropagation?.();
      return true;
    }
    if (code === 13) {
      // OK on a field (desktop): treat like Done.
      event?.preventDefault?.();
      this.captureManualField(active);
      const nodes = this.mainNodes();
      const next = nodes[nodes.indexOf(active) + 1];
      if (next) this.setFocusedNode(next);
      return true;
    }
    return false;
  },

  async activateNode(node) {
    const action = String(node?.dataset?.action || "");
    if (action === "addFromPhone" || action === "retryPhone") {
      await this.openPhoneSetup();
    } else if (action === "cancelPhone") {
      this.cancelPhoneSetup();
    } else if (action === "addOnTv") {
      this.openManualEntry();
    } else if (action === "manualType") {
      this.setManualType(String(node.dataset.type || ""));
    } else if (action === "manualSave") {
      this.saveManualEntry();
    } else if (action === "manualCancel") {
      this.cancelManualEntry();
    } else if (action === "removeSource") {
      this.removeSource(String(node.dataset.sourceId || ""));
    }
  },

  // ---- Typing the details on the TV (fallback for the phone page) --------------------------

  openManualEntry() {
    this.closePhoneSetup();
    this.manual = { type: LIVE_TV_SOURCE_TYPE.XTREAM, values: {}, error: "" };
    this.view = VIEW.MANUAL;
    this.notice = "";
    this.pendingFocusKey = `type:${LIVE_TV_SOURCE_TYPE.XTREAM}`;
    this.render();
  },

  setManualType(type) {
    if (!this.manual || !MANUAL_FIELDS[type]) return;
    this.manual.type = type;
    this.manual.error = "";
    this.pendingFocusKey = `type:${type}`;
    this.render();
  },

  saveManualEntry() {
    if (!this.manual) return;
    this.container
      ?.querySelectorAll("input.livetv-input")
      .forEach((input) => this.captureManualField(input));
    const { source, error } = sourceFromSubmission({
      type: this.manual.type,
      ...this.manual.values
    });
    if (error) {
      this.manual.error = t(`livetv_phone_error_${error}`);
      this.pendingFocusKey = "manualSave";
      this.render();
      return;
    }
    LiveTvSourceStore.save(source);
    this.manual = null;
    this.view = VIEW.SOURCES;
    this.notice = t("livetv_source_added", { name: source.name });
    this.pendingFocusKey = `remove:${source.id}`;
    this.render();
  },

  cancelManualEntry() {
    this.manual = null;
    this.view = VIEW.SOURCES;
    this.pendingFocusKey = "addOnTv";
    this.render();
  },

  // ---- Sources -----------------------------------------------------------------------------

  removeSource(id) {
    if (!id) return;
    if (this.confirmRemoveId !== id) {
      this.confirmRemoveId = id;
      this.pendingFocusKey = `remove:${id}`;
      this.render();
      return;
    }
    const source = LiveTvSourceStore.get(id);
    LiveTvSourceStore.remove(id);
    this.confirmRemoveId = "";
    this.notice = source ? t("livetv_source_removed", { name: source.name }) : "";
    this.pendingFocusKey = "addFromPhone";
    this.render();
  },

  // ---- Phone setup -------------------------------------------------------------------------

  async openPhoneSetup() {
    this.closePhoneSetup();
    const mountToken = this.mountToken;
    const attempt = {};
    this.phone = attempt;
    this.view = VIEW.PHONE;
    this.notice = "";
    this.pendingFocusKey = "cancelPhone";
    this.render();
    const stillCurrent = () =>
      mountToken === this.mountToken && this.phone === attempt && this.isMounted();
    try {
      const session = await openLiveTvPhoneSetup({
        onSubmission: (submission) => {
          if (stillCurrent()) this.handlePhoneSubmission(submission);
        },
        onClosed: () => {
          if (!stillCurrent()) return;
          attempt.session = null;
          this.showPhoneError(t("livetv_phone_error_expired"));
        }
      });
      if (!stillCurrent()) {
        session.stop();
        return;
      }
      attempt.session = session;
      attempt.url = session.url;
      const canvas = document.createElement("canvas");
      QrCodeGenerator.generate(canvas, session.url, 420);
      attempt.qrDataUrl = canvas.toDataURL("image/png");
      this.pendingFocusKey = "cancelPhone";
      this.render();
    } catch (error) {
      if (!stillCurrent()) return;
      const code = error instanceof LiveTvPhoneSetupError ? error.code : "start";
      console.warn("Live TV phone setup failed", code);
      this.showPhoneError(t(`livetv_phone_error_${code}`));
    }
  },

  showPhoneError(message) {
    if (!this.phone) return;
    this.phone.session?.stop?.();
    this.phone.session = null;
    this.phone.error = message;
    this.phone.canRetry = true;
    this.phone.qrDataUrl = "";
    this.phone.url = "";
    this.pendingFocusKey = "retryPhone";
    this.render();
  },

  handlePhoneSubmission(submission) {
    const { source, error } = sourceFromSubmission(submission);
    if (error) {
      // Keep the page open so the phone can correct it.
      this.phone.error = t(`livetv_phone_error_${error}`);
      this.pendingFocusKey = "cancelPhone";
      this.render();
      return;
    }
    LiveTvSourceStore.save(source);
    this.closePhoneSetup();
    this.view = VIEW.SOURCES;
    this.notice = t("livetv_source_added", { name: source.name });
    this.pendingFocusKey = `remove:${source.id}`;
    this.render();
  },

  cancelPhoneSetup() {
    this.closePhoneSetup();
    this.view = VIEW.SOURCES;
    this.pendingFocusKey = "addFromPhone";
    this.render();
  },

  closePhoneSetup() {
    this.phone?.session?.stop?.();
    this.phone = null;
  }
};
