// Nuvio Live: helpers shared by the Live TV screen's method modules.
import { I18n } from "../../../i18n/index.js";

export const ROUTE = "liveTv";
export const VIEW = Object.freeze({
  GUIDE: "guide",
  SOURCES: "sources",
  PHONE: "phone",
  MANUAL: "manual"
});

export function t(key, params = {}) {
  return I18n.t(key, params, { fallback: key });
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function selectorValue(value) {
  const raw = String(value || "");
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(raw)
    : raw.replace(/["\\]/g, "\\$&");
}

export function scrollIntoNearestView(node) {
  try {
    node?.scrollIntoView?.({ behavior: "auto", block: "nearest", inline: "nearest" });
  } catch (_) {
    node?.scrollIntoView?.();
  }
}

/** Why the guide has nothing to show, or "" when it's fine (shown in the guide and settings). */
export function guideProblem(guide) {
  if (!guide || guide.loading) return "";
  if (guide.error) {
    if (guide.error === "http" && guide.errorStatus) {
      return t("livetv_guide_failed_http", { status: guide.errorStatus });
    }
    if (guide.error === "network") return t("livetv_guide_failed_network");
    if (guide.error === "parse") return t("livetv_guide_failed_parse");
    return t("livetv_guide_failed");
  }
  if (guide.updatedAt && !guide.channels) {
    return guide.guideChannels
      ? t("livetv_guide_no_matches", { count: Number(guide.guideChannels).toLocaleString() })
      : t("livetv_guide_empty");
  }
  return "";
}
