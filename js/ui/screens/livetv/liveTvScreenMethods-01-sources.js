// Nuvio Live: the providers view of the Live TV screen (list, add from a phone, type on the TV).
/* eslint-disable no-unused-vars */
import * as shared from "./liveTvScreenShared.js";
import { Platform } from "../../../platform/index.js";
import { QrCodeGenerator } from "../../../core/qr/qrCodeGenerator.js";
import { LiveTvSourceStore } from "../../../livetv/data/sourceStore.js";
import { LiveTvRepository } from "../../../livetv/liveTvRepository.js";
import { LIVE_TV_SOURCE_TYPE, maskSecret, sourceFromSubmission } from "../../../livetv/model.js";
import { LiveTvPhoneSetupError, openLiveTvPhoneSetup } from "../../../livetv/setup/phoneSetupSession.js";

const { VIEW, t, escapeHtml } = shared;
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

function formatWhen(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  return date.toDateString() === today.toDateString() ? time : `${date.getDate()}/${date.getMonth() + 1} ${time}`;
}

function sourceStatusText(source) {
  if (LiveTvRepository.isRefreshing(source.id)) return t("livetv_source_loading");
  const error = LiveTvRepository.state.sourceErrors[source.id] || source.lastError;
  if (error) return t(`livetv_source_error_${error}`);
  if (!source.lastUpdatedMs) return t("livetv_source_not_loaded");
  const account = LiveTvRepository.account(source.id);
  const expiry =
    account?.expiresAtMs > 0 ? ` · ${t("livetv_source_expires", { date: new Date(account.expiresAtMs).toLocaleDateString() })}` : "";
  return `${t("livetv_source_loaded", { count: source.channelCount, when: formatWhen(source.lastUpdatedMs) })}${expiry}`;
}

export { formatWhen };

export function createLiveTvScreenMethods01() {
  return {
    renderSources() {
      const sources = LiveTvSourceStore.list();
      const notice = this.notice ? `<p class="livetv-notice" role="status">${escapeHtml(this.notice)}</p>` : "";
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
              <p class="livetv-source-status" data-source-status="${escapeHtml(source.id)}">${escapeHtml(sourceStatusText(source))}</p>
              <div class="livetv-actions">
                <button type="button" class="livetv-button focusable" data-action="refreshSource"
                  data-source-id="${escapeHtml(source.id)}" data-focus-key="refresh:${escapeHtml(source.id)}">
                  ${escapeHtml(t("livetv_source_refresh"))}
                </button>
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
      const empty = sources.length ? "" : `<p class="livetv-empty">${escapeHtml(t("livetv_no_sources"))}</p>`;
      return `
        <div class="livetv-sources">
          ${notice}
          ${empty}
          ${
            LiveTvRepository.state.channels.length
              ? `<div class="livetv-actions"><button type="button" class="livetv-button livetv-button-primary focusable" data-action="openGuide" data-focus-key="openGuide">${escapeHtml(t("livetv_open_guide"))}</button></div>`
              : ""
          }
          <div class="livetv-actions">
            <button type="button" class="livetv-button livetv-button-primary focusable" data-action="addFromPhone" data-focus-key="addFromPhone">
              ${escapeHtml(t("livetv_add_from_phone"))}
            </button>
            <button type="button" class="livetv-button focusable" data-action="addOnTv" data-focus-key="addOnTv">
              ${escapeHtml(t("livetv_add_on_tv"))}
            </button>
          </div>
          ${cards}
          ${sources.length ? this.renderLiveTvSettings() : ""}
        </div>
      `;
    },

    /** Updates the providers' status lines in place (refresh and guide progress). */
    updateSourcesStatus() {
      LiveTvSourceStore.list().forEach((source) => {
        const node = this.container?.querySelector(`[data-source-status="${shared.selectorValue(source.id)}"]`);
        if (node) node.textContent = sourceStatusText(source);
      });
      this.updateGuideStatusLineInSettings?.();
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
          const label = t(type === LIVE_TV_SOURCE_TYPE.XTREAM ? "livetv_phone_tab_xtream" : "livetv_phone_tab_m3u");
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
      this.container?.querySelectorAll("input.livetv-input").forEach((input) => this.captureManualField(input));
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
      void LiveTvRepository.refreshSource(source.id).then(() => LiveTvRepository.refreshGuide());
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

    removeSource(id) {
      if (!id) return;
      if (this.confirmRemoveId !== id) {
        this.confirmRemoveId = id;
        this.pendingFocusKey = `remove:${id}`;
        this.render();
        return;
      }
      const source = LiveTvSourceStore.get(id);
      void LiveTvRepository.removeSource(id);
      this.confirmRemoveId = "";
      this.notice = source ? t("livetv_source_removed", { name: source.name }) : "";
      this.pendingFocusKey = "addFromPhone";
      this.render();
    },

    async openPhoneSetup() {
      this.closePhoneSetup();
      const mountToken = this.mountToken;
      const attempt = {};
      this.phone = attempt;
      this.view = VIEW.PHONE;
      this.notice = "";
      this.pendingFocusKey = "cancelPhone";
      this.render();
      const stillCurrent = () => mountToken === this.mountToken && this.phone === attempt && this.isMounted();
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
      void LiveTvRepository.refreshSource(source.id).then(() => LiveTvRepository.refreshGuide());
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
}
