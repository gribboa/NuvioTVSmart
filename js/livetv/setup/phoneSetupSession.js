// Nuvio Live: add a provider from a phone. Asks the TV's plugin service (loopback only) to open
// the setup page on the home network (services/livetv-setup.cjs), then polls it for what the
// phone sent. Same flow as js/ui/screens/settings/customPosterPhoneConfig.js.
import { Platform } from "../../platform/index.js";
import { LiveTvServiceError, resolveLiveTvServicePort } from "../data/liveTvHttp.js";
import { I18n } from "../../i18n/index.js";

const POLL_MS = 1000;
const CONTROL_TIMEOUT_MS = 10000;
const PHONE_PAGE_LABEL_KEYS = [
  "title",
  "subtitle",
  "tab_xtream",
  "tab_m3u",
  "name",
  "server",
  "server_hint",
  "username",
  "password",
  "show_password",
  "playlist_url",
  "epg_url",
  "epg_hint",
  "send",
  "sending",
  "sent",
  "error_missing_server",
  "error_missing_login",
  "error_invalid_url",
  "error_invalid_epg_url",
  "error_too_long",
  "error_invalid_type",
  "error_connection"
];

export class LiveTvPhoneSetupError extends Error {
  constructor(code) {
    super(code);
    this.name = "LiveTvPhoneSetupError";
    // "service" (no plugin service), "other_service" (official Nuvio's service holds the port),
    // "network" (no home network address), "start" (couldn't listen), "expired".
    this.code = code;
  }
}

// 12 characters from an alphabet without look-alikes (no 0/o, 1/l/i): about 59 bits, plenty for a
// page that lives for at most 10 minutes on the home network, and still short enough to type.
const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const TOKEN_LENGTH = 12;

export function createSetupToken() {
  const limit = 256 - (256 % TOKEN_ALPHABET.length);
  let token = "";
  while (token.length < TOKEN_LENGTH) {
    const bytes = new Uint8Array(TOKEN_LENGTH * 2);
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // Skip the top few values so every character is equally likely.
      if (byte < limit && token.length < TOKEN_LENGTH)
        token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
    }
  }
  return token;
}

function isLanAddress(address) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address || "") && !/^127\./.test(address);
}

function fallbackTvAddress() {
  if (!Platform.isTizen()) return "";
  try {
    return String(globalThis.webapis?.network?.getIp?.() || "");
  } catch (_) {
    return "";
  }
}

/**
 * Opens a phone setup session. Resolves to { url, stop() }; onSubmission(submission) is called
 * each time the phone sends details, onClosed() when the session ends on its own (timeout, the
 * service went away). The session stays open until stop() is called.
 */
export async function openLiveTvPhoneSetup({ onSubmission, onClosed } = {}) {
  const token = createSetupToken();
  let port;
  try {
    port = await resolveLiveTvServicePort();
  } catch (error) {
    throw new LiveTvPhoneSetupError(error instanceof LiveTvServiceError ? error.code : "service");
  }
  const control = async (action, extra = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/livetv-setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, token, ...extra }),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.returnValue === false) {
        // 404: the service on the shared port doesn't know this route, so it is official Nuvio's
        // (both apps use 2711 and only one can hold it).
        const code =
          response.status === 410 ? "expired" : response.status === 404 ? "other_service" : "start";
        throw new LiveTvPhoneSetupError(code);
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  };

  const labels = Object.fromEntries(
    PHONE_PAGE_LABEL_KEYS.map((key) => [key, I18n.t(`livetv_phone_${key}`)])
  );
  let session;
  try {
    session = await control("start", { labels });
  } catch (error) {
    throw error instanceof LiveTvPhoneSetupError ? error : new LiveTvPhoneSetupError("start");
  }

  let closed = false;
  let timer = null;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    void control("stop").catch(() => {});
  };

  const address = isLanAddress(session.address) ? session.address : fallbackTvAddress();
  if (!isLanAddress(address)) {
    stop();
    throw new LiveTvPhoneSetupError("network");
  }

  let revision = 0;
  const poll = async () => {
    if (closed) return;
    try {
      const state = await control("read");
      if (closed) return;
      if (state.revision > revision && state.submission) {
        revision = state.revision;
        onSubmission?.(state.submission);
      }
    } catch (_) {
      if (closed) return;
      closed = true;
      onClosed?.();
      return;
    }
    if (!closed) timer = setTimeout(poll, POLL_MS);
  };
  timer = setTimeout(poll, POLL_MS);

  return { url: `http://${address}:${session.port}/${token}/`, stop };
}
