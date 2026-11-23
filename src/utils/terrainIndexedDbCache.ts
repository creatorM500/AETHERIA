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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
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
      const tx = db.transaction(STORE_NAME, 'readwrite');
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
          store.delete(key);
          resolve(null);
          return;
        }
        rec.lastAccessedAt = now;
        store.put(rec);
        resolve(rec.payload);
      };
      req.onerror = () => resolve(null);
    } catch {
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
    // Ignore storage quota or private mode restrictions
  }
}
