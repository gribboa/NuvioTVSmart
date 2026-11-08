// Nuvio Live: the IndexedDB database for channels and guide data. Small settings stay in
// LocalStore; everything that grows with the playlist or the guide lives here.
// Falls back to memory (this session only) when IndexedDB isn't available.

const DATABASE_NAME = "nuvio_livetv";
const DATABASE_VERSION = 1;

export const LIVE_TV_STORES = Object.freeze({
  CHANNELS: "channels",
  GROUPS: "groups",
  PROGRAMMES: "programmes",
  META: "meta"
});

let databasePromise = null;
const memory = {
  channels: new Map(),
  groups: new Map(),
  programmes: new Map(),
  meta: new Map()
};

function canUseIndexedDb() {
  return typeof globalThis.indexedDB !== "undefined";
}

function openDatabase() {
  if (!canUseIndexedDb()) return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    let request;
    try {
      request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (_) {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LIVE_TV_STORES.CHANNELS)) {
        const store = database.createObjectStore(LIVE_TV_STORES.CHANNELS, { keyPath: "key" });
        store.createIndex("sourceId", "sourceId");
      }
      if (!database.objectStoreNames.contains(LIVE_TV_STORES.GROUPS)) {
        const store = database.createObjectStore(LIVE_TV_STORES.GROUPS, { keyPath: "id" });
        store.createIndex("sourceId", "sourceId");
      }
      if (!database.objectStoreNames.contains(LIVE_TV_STORES.PROGRAMMES)) {
        // id = `${guideId}|${startMs}`; guideId = `${guideKey}|${xmltv channel id}`.
        const store = database.createObjectStore(LIVE_TV_STORES.PROGRAMMES, { keyPath: "id" });
        store.createIndex("guideStart", ["guideId", "startMs"]);
        store.createIndex("guideKey", "guideKey");
        store.createIndex("stopMs", "stopMs");
      }
      if (!database.objectStoreNames.contains(LIVE_TV_STORES.META)) {
        database.createObjectStore(LIVE_TV_STORES.META, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted"));
  });
}

function memoryKey(storeName, value) {
  if (storeName === LIVE_TV_STORES.CHANNELS) return value.key;
  if (storeName === LIVE_TV_STORES.GROUPS || storeName === LIVE_TV_STORES.PROGRAMMES)
    return value.id;
  return value.key;
}

export const LiveTvDb = {
  isPersistent() {
    return openDatabase().then(Boolean);
  },

  async get(storeName, key) {
    const database = await openDatabase();
    if (!database) return memory[storeName].get(key) || null;
    const transaction = database.transaction(storeName, "readonly");
    return (await requestToPromise(transaction.objectStore(storeName).get(key))) || null;
  },

  async put(storeName, value) {
    return this.putMany(storeName, [value]);
  },

  /** Writes in chunks so one huge transaction doesn't stall the TV. */
  async putMany(storeName, values, { chunkSize = 2000 } = {}) {
    const database = await openDatabase();
    if (!database) {
      values.forEach((value) => memory[storeName].set(memoryKey(storeName, value), value));
      return;
    }
    for (let index = 0; index < values.length; index += chunkSize) {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      values.slice(index, index + chunkSize).forEach((value) => store.put(value));
      await transactionDone(transaction);
    }
  },

  async getAll(storeName) {
    const database = await openDatabase();
    if (!database) return Array.from(memory[storeName].values());
    const transaction = database.transaction(storeName, "readonly");
    return requestToPromise(transaction.objectStore(storeName).getAll());
  },

  async getAllByIndex(storeName, indexName, query) {
    const database = await openDatabase();
    if (!database) {
      return Array.from(memory[storeName].values()).filter((value) =>
        matchesMemoryQuery(storeName, indexName, value, query)
      );
    }
    const transaction = database.transaction(storeName, "readonly");
    return requestToPromise(transaction.objectStore(storeName).index(indexName).getAll(query));
  },

  async deleteByIndex(storeName, indexName, query) {
    const database = await openDatabase();
    if (!database) {
      Array.from(memory[storeName].entries()).forEach(([key, value]) => {
        if (matchesMemoryQuery(storeName, indexName, value, query)) memory[storeName].delete(key);
      });
      return;
    }
    const transaction = database.transaction(storeName, "readwrite");
    const request = transaction.objectStore(storeName).index(indexName).openKeyCursor(query);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      transaction.objectStore(storeName).delete(cursor.primaryKey);
      cursor.continue();
    };
    await transactionDone(transaction);
  },

  async delete(storeName, key) {
    const database = await openDatabase();
    if (!database) {
      memory[storeName].delete(key);
      return;
    }
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(key);
    await transactionDone(transaction);
  },

  async clear(storeName) {
    const database = await openDatabase();
    if (!database) {
      memory[storeName].clear();
      return;
    }
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).clear();
    await transactionDone(transaction);
  }
};

// Memory fallback for the few index queries the stores use (exact values and key ranges).
function matchesMemoryQuery(storeName, indexName, value, query) {
  let indexValue;
  if (indexName === "guideStart") indexValue = [value.guideId, value.startMs];
  else indexValue = value[indexName];
  if (query == null) return true;
  if (typeof IDBKeyRange !== "undefined" && query instanceof IDBKeyRange) {
    return query.includes(indexValue);
  }
  return indexValue === query;
}

export function keyRange(lower, upper) {
  return typeof IDBKeyRange !== "undefined" ? IDBKeyRange.bound(lower, upper) : null;
}
