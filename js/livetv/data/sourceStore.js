// Nuvio Live: IPTV sources. Shared by every profile (favourites and last channel are per profile).
// Kept on this TV only; never synced to the Nuvio account.
import { LocalStore } from "../../core/storage/localStore.js";
import { createPlaylistSource } from "../model.js";

const STORAGE_KEY = "liveTvSources";
const listeners = new Set();

function readAll() {
  const stored = LocalStore.get(STORAGE_KEY, []);
  return Array.isArray(stored) ? stored.map((entry) => createPlaylistSource(entry)) : [];
}

function writeAll(sources) {
  LocalStore.set(STORAGE_KEY, sources);
  listeners.forEach((listener) => {
    try {
      listener(sources);
    } catch (error) {
      console.warn("Live TV source listener failed", error);
    }
  });
}

export const LiveTvSourceStore = {
  list() {
    return readAll();
  },

  get(id) {
    return readAll().find((source) => source.id === id) || null;
  },

  /** Adds a source, or replaces the one with the same id. */
  save(source) {
    const next = createPlaylistSource(source);
    const sources = readAll();
    const index = sources.findIndex((entry) => entry.id === next.id);
    if (index >= 0) sources[index] = next;
    else sources.push(next);
    writeAll(sources);
    return next;
  },

  remove(id) {
    const sources = readAll();
    const next = sources.filter((source) => source.id !== id);
    if (next.length !== sources.length) writeAll(next);
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
};
