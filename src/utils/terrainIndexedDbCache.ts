import type { TerrainChunkPayload } from '../shared/types.ts';

const DB_NAME = 'aetheria-terrain-cache-v1';
const STORE_NAME = 'terrain_chunks';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHED_CHUNKS = 180;

interface StoredChunkRecord {
  key: string;
  payload: TerrainChunkPayload;
  cachedAt: number;
  lastAccessedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function openTerrainDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('lastAccessedAt', 'lastAccessedAt', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        resolve(null);
      };
      req.onblocked = () => {
        dbPromise = null;
        resolve(null);
      };
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });
  return dbPromise;
}

export async function getPersistedTerrainChunk(key: string): Promise<TerrainChunkPayload | null> {
  const db = await openTerrainDb();
  if (!db) return null;

  return new Promise<TerrainChunkPayload | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const rec = req.result as StoredChunkRecord | undefined;
        if (!rec) {
          resolve(null);
          return;
        }
        const now = Date.now();
        if (now - rec.cachedAt > CACHE_TTL_MS) {
          try {
            const delTx = db.transaction(STORE_NAME, 'readwrite');
            delTx.objectStore(STORE_NAME).delete(key);
          } catch {
            // Ignore cleanup failure
          }
          resolve(null);
          return;
        }
        if (now - rec.lastAccessedAt > TOUCH_INTERVAL_MS) {
          try {
            const touchTx = db.transaction(STORE_NAME, 'readwrite');
            touchTx.objectStore(STORE_NAME).put({ ...rec, lastAccessedAt: now });
          } catch {
            // Ignore non-critical LRU timestamp update
          }
        }
        resolve(rec.payload);
      };
      req.onerror = () => resolve(null);
    } catch {
      dbPromise = null;
      resolve(null);
    }
  });
}

export async function putPersistedTerrainChunk(
  key: string,
  payload: TerrainChunkPayload
): Promise<void> {
  const db = await openTerrainDb();
  if (!db) return;

  try {
    const now = Date.now();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record: StoredChunkRecord = {
      key,
      payload,
      cachedAt: now,
      lastAccessedAt: now,
    };
    store.put(record);

    const countReq = store.count();
    countReq.onsuccess = () => {
      const excess = countReq.result - MAX_CACHED_CHUNKS;
      if (excess <= 0) return;
      const idx = store.index('lastAccessedAt');
      let deleted = 0;
      const cursorReq = idx.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && deleted < excess) {
          cursor.delete();
          deleted += 1;
          cursor.continue();
        }
      };
    };
  } catch {
    dbPromise = null;
  }
}
