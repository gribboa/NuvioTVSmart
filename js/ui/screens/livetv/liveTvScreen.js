// Nuvio Live: the Live TV section. The guide (TiviMate-style: preview and programme details on
// top, group tabs, time grid) when there are channels; the providers view otherwise, or when
// opened from Settings.
import { Router } from "../../navigation/routerState.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { Environment } from "../../../platform/environment.js";
import { LayoutPreferences } from "../../../data/local/layoutPreferences.js";
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
import { LiveTvRepository } from "../../../livetv/liveTvRepository.js";
import {
  ROUTE,
  VIEW,
  escapeHtml,
  scrollIntoNearestView,
  selectorValue,
  t
} from "./liveTvScreenShared.js";
import { createLiveTvScreenMethods01 } from "./liveTvScreenMethods-01-sources.js";
import { createLiveTvScreenMethods02 } from "./liveTvScreenMethods-02-guide-render.js";
import { createLiveTvScreenMethods03 } from "./liveTvScreenMethods-03-guide-keys.js";
import { createLiveTvScreenMethods04 } from "./liveTvScreenMethods-04-settings.js";

export const LiveTvScreen = {
  ...createLiveTvScreenMethods01(),
  ...createLiveTvScreenMethods02(),
  ...createLiveTvScreenMethods03(),
  ...createLiveTvScreenMethods04(),

  async mount(params = {}) {
    this.container = document.getElementById(ROUTE);
    ScreenUtils.show(this.container);
    this.mountToken = (this.mountToken || 0) + 1;
    const mountToken = this.mountToken;
    this.params = params || {};
    this.layoutPrefs = LayoutPreferences.get();
    this.sidebarExpanded = false;
    this.focusZone = "content";
    this.phone = null;
    this.manual = null;
    this.notice = "";
    this.confirmRemoveId = "";
    this.pendingFocusKey = "";
    this.bindInputs();
    this.view = params.view === VIEW.SOURCES ? VIEW.SOURCES : VIEW.GUIDE;
    try {
      this.sidebarProfile = await getSidebarProfileState({ cacheOnly: true });
    } catch (_) {
      this.sidebarProfile = null;
    }
    if (mountToken !== this.mountToken) return;
    this.unsubscribeRepository?.();
    this.unsubscribeRepository = LiveTvRepository.subscribe((_, reason) =>
      this.handleRepositoryChange(reason)
    );
    this.render();
    void LiveTvRepository.init()
      .then(() => {
        if (mountToken === this.mountToken) this.handleRepositoryChange("init");
      })
      .catch((error) => console.warn("Live TV failed to load", error));
    void getSidebarProfileState()
      .then((profile) => {
        if (profile && mountToken === this.mountToken) this.sidebarProfile = profile;
      })
      .catch(() => {});
  },

  cleanup() {
    this.mountToken = (this.mountToken || 0) + 1;
    this.unsubscribeRepository?.();
    this.unsubscribeRepository = null;
    this.closePhoneSetup();
    this.teardownGuide?.();
    this.manual = null;
    ScreenUtils.hide(this.container);
  },

  isMounted() {
    return Boolean(this.container) && Router.getCurrent() === ROUTE;
  },

  /** Repository updates: refresh only what changed, keeping focus where it is. */
  handleRepositoryChange(reason) {
    if (!this.isMounted()) return;
    if (this.view === VIEW.GUIDE) {
      this.onGuideDataChanged(reason);
    } else if (this.view === VIEW.SOURCES && reason !== "guideProgress") {
      this.pendingFocusKey = this.currentFocusKey();
      this.render();
    } else if (this.view === VIEW.SOURCES) {
      this.updateSourcesStatus?.();
    }
  },

  /** Whether the guide has anything to show; otherwise the providers view is shown. */
  showsGuide() {
    return this.view === VIEW.GUIDE && LiveTvRepository.state.channels.length > 0;
  },

  // ---- Rendering ---------------------------------------------------------------------------

  render() {
    if (!this.container) return;
    const guide = this.showsGuide();
    this.container.innerHTML = `
      <div class="home-shell livetv-shell${guide ? " livetv-shell-guide" : ""}">
        ${renderRootSidebar({
          selectedRoute: ROUTE,
          profile: this.sidebarProfile,
          layout: this.layoutPrefs,
          expanded: Boolean(this.sidebarExpanded)
        })}
        <main class="home-main livetv-main${guide ? " livetv-main-guide" : ""}">
          ${guide ? this.renderGuide() : this.renderPage()}
        </main>
      </div>
    `;
    ScreenUtils.indexFocusables(this.container);
    bindRootSidebarEvents(this.container, {
      currentRoute: ROUTE,
      onSelectedAction: () => this.focusMainNode(),
      onExpandSidebar: () => this.focusSidebarNode()
    });
    if (guide) {
      this.afterGuideRender();
    } else {
      this.teardownGuide?.();
      this.bindClicks();
      this.restoreFocus();
      this.updateGuideStatusLineInSettings?.();
    }
  },

  renderPage() {
    const title =
      this.view === VIEW.SOURCES || this.view === VIEW.GUIDE
        ? t("livetv_title")
        : t("livetv_title");
    return `
      <header class="livetv-header">
        <h1 class="livetv-title">${escapeHtml(title)}</h1>
      </header>
      ${this.renderView()}
    `;
  },

  renderView() {
    if (this.view === VIEW.PHONE) return this.renderPhoneSetup();
    if (this.view === VIEW.MANUAL) return this.renderManualEntry();
    if (this.view === VIEW.GUIDE) return this.renderGuidePlaceholder();
    return this.renderSources();
  },

  /** The guide view with no channels yet: loading, or the providers view. */
  renderGuidePlaceholder() {
    const { initialized } = LiveTvRepository.state;
    if (!initialized || LiveTvRepository.isRefreshing()) {
      return `<p class="livetv-empty">${escapeHtml(t("livetv_loading_channels"))}</p>${initialized ? this.renderSources() : ""}`;
    }
    return this.renderSources();
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

  // ---- Focus (providers views; the guide manages its own focus) ----------------------------

  mainNodes() {
    return Array.from(this.container?.querySelectorAll(".livetv-main .focusable") || []);
  },

  currentFocusKey() {
    return this.container?.querySelector(".livetv-main .focusable.focused")?.dataset.focusKey || "";
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
    this.onGuideFocusLeft?.();
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
    if (this.showsGuide()) {
      this.focusGuide();
      return;
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
    if (this.focusZone !== "sidebar" && this.showsGuide()) {
      return this.consumeGuideBack();
    }
    if (
      this.view === VIEW.SOURCES &&
      LiveTvRepository.state.channels.length &&
      !this.params?.view
    ) {
      this.openGuide();
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

    if (this.showsGuide()) {
      await this.onGuideKeyDown(event, code);
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

  onKeyUp(event) {
    if (this.showsGuide()) this.onGuideKeyUp(event);
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
    } else if (action === "refreshSource") {
      void LiveTvRepository.refreshSource(String(node.dataset.sourceId || "")).then(() =>
        LiveTvRepository.refreshGuide()
      );
    } else if (action === "refreshGuide") {
      void LiveTvRepository.refreshGuide();
    } else if (action === "openGuide") {
      this.openGuide();
    } else {
      this.activateSettingsNode?.(node, action);
    }
  },

  openGuide() {
    this.view = VIEW.GUIDE;
    this.notice = "";
    this.render();
  },

  openSources() {
    this.teardownGuide?.();
    this.view = VIEW.SOURCES;
    this.pendingFocusKey = "addFromPhone";
    this.render();
  }
};
