// Nuvio Live: network requests to IPTV providers. Tries the request directly first (the TV app
// isn't held to CORS); when that fails, or when the source wants its own User-Agent (which a web
// page can't set), it goes through the loopback pass-through in the TV's plugin service
// (services/livetv-proxy.cjs).
import { Platform } from "../../platform/index.js";
import { PluginServiceClient } from "../../platform/pluginServiceClient.js";

export class LiveTvServiceError extends Error {
  constructor(code) {
    super(code);
    this.name = "LiveTvServiceError";
    this.code = code;
  }
}

/** The loopback port of this app's plugin service (2711 on Tizen). */
export async function resolveLiveTvServicePort() {
  // Desktop development only: a plugin-http.cjs started by hand (see docs/LIVE_TV.md).
  const devPort = Number(globalThis.__NUVIO_LIVETV_SETUP_PORT__ || 0);
  if (devPort) return devPort;
  let health;
  try {
    health = await PluginServiceClient.ensureReady();
  } catch (_) {
    throw new LiveTvServiceError("service");
  }
  const port = Number(health?.port || (Platform.isWebOS() ? 2721 : 2711));
  if (![2711, 2721].includes(port)) throw new LiveTvServiceError("service");
  return port;
}

/** A link served by this app's plugin service, for AVPlay (which can't wait for a port lookup). */
export function loopbackServiceUrl(path) {
  const port =
    Number(globalThis.__NUVIO_LIVETV_SETUP_PORT__ || 0) || (Platform.isWebOS() ? 2721 : 2711);
  return `http://127.0.0.1:${port}${path}`;
}

export function proxiedUrl(port, url, userAgent = "") {
  const ua = userAgent ? `&ua=${encodeURIComponent(userAgent)}` : "";
  return `http://127.0.0.1:${port}/livetv-proxy?url=${encodeURIComponent(url)}${ua}`;
}

let directBlocked = false;

/**
 * fetch() for provider links. Resolves to a Response (check .ok); rejects with an Error whose
 * code is "network" when neither way reaches the provider.
 */
export async function liveFetch(url, { userAgent = "", signal } = {}) {
  if (!userAgent && !directBlocked) {
    try {
      return await fetch(url, { signal, credentials: "omit", cache: "no-store" });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Probably CORS (desktop browsers); use the pass-through from now on.
      directBlocked = !Platform.isTizen();
    }
  }
  let port;
  try {
    port = await resolveLiveTvServicePort();
  } catch (_) {
    const error = new Error("network");
    error.code = "network";
    throw error;
  }
  try {
    return await fetch(proxiedUrl(port, url, userAgent), { signal, cache: "no-store" });
  } catch (error) {
    if (signal?.aborted) throw error;
    const wrapped = new Error("network");
    wrapped.code = "network";
    throw wrapped;
  }
}

/** A fetch-compatible function for one source (used by the Xtream client). */
export function liveFetchFor(source) {
  const userAgent = String(source?.userAgent || "").trim();
  return (url, options = {}) => liveFetch(url, { userAgent, signal: options.signal });
}
