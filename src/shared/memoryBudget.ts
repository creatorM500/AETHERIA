import { clamp } from './geo.ts';

export const HARD_MEMORY_CEILING_MB = 500;
export const CLIENT_SOFT_PRUNE_MB = 300;
export const CLIENT_HARD_PRUNE_MB = 420;
export const SERVER_SOFT_PRUNE_MB = 310;
export const SERVER_HARD_PRUNE_MB = 420;

export type MemoryPressureLevel = 'normal' | 'soft' | 'critical';

export interface MemoryBudgetEvaluation {
  usedMb: number;
  ceilingMb: number;
  headroomMb: number;
  pressure: MemoryPressureLevel;
  pruneFraction: number;
  dropIdleLayers: boolean;
}

export interface ClientFootprintInput {
  jsHeapMb?: number | null;
  terrainChunks: number;
  regionalTextures: number;
  cachedCanvases: number;
  windActive: boolean;
  radarActive: boolean;
  seismicActive: boolean;
  hasPlanetDem: boolean;
  baseTexturePx?: number;
}

/**
 * Evaluates current RSS or client estimated footprint against soft & hard thresholds
 * to keep total RAM consumption safely below the 500 MB operational ceiling.
 */
export function evaluateMemoryBudget(
  usedMb: number,
  softLimitMb: number,
  hardLimitMb: number,
  ceilingMb = HARD_MEMORY_CEILING_MB
): MemoryBudgetEvaluation {
  const safeUsed = Number.isFinite(usedMb) && usedMb > 0 ? usedMb : 0;
  const safeCeiling = Math.max(hardLimitMb + 16, ceilingMb);
  const headroomMb = Number(Math.max(0, safeCeiling - safeUsed).toFixed(1));

  if (safeUsed >= hardLimitMb) {
    return {
      usedMb: Number(safeUsed.toFixed(1)),
      ceilingMb: safeCeiling,
      headroomMb,
      pressure: 'critical',
      pruneFraction: 0.85,
      dropIdleLayers: true,
    };
  }

  if (safeUsed >= softLimitMb) {
    const span = Math.max(1, hardLimitMb - softLimitMb);
    const ratio = clamp((safeUsed - softLimitMb) / span, 0, 1);
    return {
      usedMb: Number(safeUsed.toFixed(1)),
      ceilingMb: safeCeiling,
      headroomMb,
      pressure: 'soft',
      pruneFraction: Number((0.35 + ratio * 0.35).toFixed(3)),
      dropIdleLayers: true,
    };
  }

  return {
    usedMb: Number(safeUsed.toFixed(1)),
    ceilingMb: safeCeiling,
    headroomMb,
    pressure: 'normal',
    pruneFraction: 0,
    dropIdleLayers: false,
  };
}

/**
 * Estimates total client RAM + GPU texture/buffer footprint (in MB) across JS heap,
 * planetary/regional WebGL textures, offscreen canvases, terrain chunks, and active layers.
 */
export function estimateClientFootprintMb(input: ClientFootprintInput): number {
  const basePx = input.baseTexturePx ?? 2048;
  // Base globe albedo + nightLights + cloud + bump/roughness (JS canvas + GPU RGBA upload)
  const baseGlobeMb = ((basePx * (basePx / 2) * 4 * 2) / (1024 * 1024)) * 3.1;
  const demMb = input.hasPlanetDem ? 1.8 : 0.4;
  // Each active terrain chunk holds ~2.6 MB (512px Canvas+Texture + DEM/building VBOs)
  const terrainMb = Math.max(0, input.terrainChunks) * 2.6;
  // Each regional tile texture (~256x256 RGBA + mipmaps + optional offscreen canvas) ~ 0.65 MB
  const regionalMb = Math.max(0, input.regionalTextures) * 0.65;
  // Cached planetary/chunk canvases (2048x1024 ~ 8 MB, 512x512 ~ 1 MB; conservative blend ~ 4.2 MB)
  const canvasCacheMb = Math.max(0, input.cachedCanvases) * 4.2;
  const layersMb =
    (input.windActive ? 6.5 : 0.1) +
    (input.radarActive ? 4.5 : 0.1) +
    (input.seismicActive ? 3.5 : 0.1);

  const syntheticTotalMb = baseGlobeMb + demMb + terrainMb + regionalMb + canvasCacheMb + layersMb;
  const heapMb =
    typeof input.jsHeapMb === 'number' && Number.isFinite(input.jsHeapMb) && input.jsHeapMb > 0
      ? input.jsHeapMb
      : 48;

  // JS heap tracks active typed arrays/objects; offscreen canvases + GPU textures live outside V8 heap
  return Number((heapMb + baseGlobeMb * 0.6 + terrainMb * 0.72 + regionalMb + canvasCacheMb + layersMb * 0.5).toFixed(1));
}

/**
 * Computes how many entries should be evicted from a cache while respecting minKeep.
 */
export function computePruneEvictionCount(
  totalEntries: number,
  pruneFraction: number,
  minKeep = 0
): number {
  if (totalEntries <= minKeep || pruneFraction <= 0) return 0;
  const safeFrac = clamp(pruneFraction, 0, 1);
  const maxEvictable = Math.max(0, totalEntries - Math.max(0, minKeep));
  return Math.min(maxEvictable, Math.max(1, Math.ceil(totalEntries * safeFrac)));
}

/**
 * Selects oldest unprotected LRU keys to evict so at most `keepCount` remain.
 */
export function selectLruEvictionKeys<T extends { lastUsedMs?: number }>(
  entries: ReadonlyArray<readonly [string, T]>,
  keepCount: number,
  isProtected?: (key: string, val: T) => boolean
): string[] {
  const safeKeep = Math.max(0, Math.floor(keepCount));
  if (entries.length <= safeKeep) return [];

  const targetEvict = entries.length - safeKeep;
  const candidates = entries
    .filter(([key, val]) => !(isProtected?.(key, val) ?? false))
    .slice()
    .sort((a, b) => (a[1].lastUsedMs ?? 0) - (b[1].lastUsedMs ?? 0));

  const victims: string[] = [];
  for (let i = 0; i < candidates.length && victims.length < targetEvict; i++) {
    victims.push(candidates[i][0]);
  }
  return victims;
}

export interface TerrainChunkEvictionCandidate {
  key: string;
  tier: 1 | 2;
  tx: number;
  ty: number;
  isCoreTile: boolean;
  dist2: number;
  lastUsedMs: number;
  desired: boolean;
  hasVectorMeshes: boolean;
}

export interface TerrainChunkEvictionPlan {
  stripVectorMeshKeys: string[];
  evictKeys: string[];
}

const Z12_TILE_COUNT = 4096;

export function getCoveringTier2Key(tx14: number, ty14: number): string {
  const parentTx12 = ((Math.floor(tx14 / 4) % Z12_TILE_COUNT) + Z12_TILE_COUNT) % Z12_TILE_COUNT;
  const parentTy12 = clamp(Math.floor(ty14 / 4), 0, Z12_TILE_COUNT - 1);
  return `12/${parentTx12}/${parentTy12}`;
}

/**
 * Plans terrain chunk memory eviction without ever punching voids inside the active
 * Terreno 3D grid:
 * 1) Always evict non-desired (off-viewport) chunks oldest-first.
 * 2) When outer downgrade is permitted under critical pressure, strip building/road
 *    sub-meshes on farthest non-core Tier-1 tiles first before dropping ground tiles.
 * 3) Only evict farthest non-core desired Tier-1 tiles if their covering Tier-2 (z=12)
 *    horizon chunk is already loaded underneath so the Tier-1 mask reveals terrain cleanly.
 *    Desired Tier-2 horizon chunks and core Tier-1 chunks are never evicted.
 */
export function planTerrainChunkEviction(
  chunks: ReadonlyArray<TerrainChunkEvictionCandidate>,
  keepMaxChunks: number,
  allowDowngradeOuterTier1 = false
): TerrainChunkEvictionPlan {
  const safeKeep = Math.max(0, Math.floor(keepMaxChunks));
  const evictKeys: string[] = [];
  const stripVectorMeshKeys: string[] = [];

  if (chunks.length <= safeKeep) {
    return { stripVectorMeshKeys, evictKeys };
  }

  let remaining = chunks.length;
  const evictedSet = new Set<string>();

  // Pass 1: Evict stale off-viewport chunks first (oldest lastUsedMs first)
  const offViewport = chunks
    .filter((c) => !c.desired)
    .slice()
    .sort((a, b) => a.lastUsedMs - b.lastUsedMs);

  for (const c of offViewport) {
    if (remaining <= safeKeep) break;
    evictKeys.push(c.key);
    evictedSet.add(c.key);
    remaining -= 1;
  }

  if (remaining <= safeKeep || !allowDowngradeOuterTier1) {
    return { stripVectorMeshKeys, evictKeys };
  }

  // Pass 2: Strip heavy building/road meshes on farthest outer non-core Tier-1 chunks
  const outerWithBuildings = chunks
    .filter((c) => !evictedSet.has(c.key) && c.tier === 1 && !c.isCoreTile && c.hasVectorMeshes)
    .slice()
    .sort((a, b) => b.dist2 - a.dist2 || a.lastUsedMs - b.lastUsedMs);

  for (const c of outerWithBuildings) {
    stripVectorMeshKeys.push(c.key);
  }

  // Pass 3: Under critical pressure, only evict outer non-core Tier-1 chunks that have a
  // loaded Tier-2 chunk directly underneath (never evict desired Tier-2 or core Tier-1).
  const loadedTier2Keys = new Set<string>();
  for (const c of chunks) {
    if (!evictedSet.has(c.key) && c.tier === 2) {
      loadedTier2Keys.add(c.key);
    }
  }

  const coveredOuterTier1 = chunks
    .filter(
      (c) =>
        !evictedSet.has(c.key) &&
        c.tier === 1 &&
        !c.isCoreTile &&
        loadedTier2Keys.has(getCoveringTier2Key(c.tx, c.ty))
    )
    .slice()
    .sort((a, b) => b.dist2 - a.dist2 || a.lastUsedMs - b.lastUsedMs);

  for (const c of coveredOuterTier1) {
    if (remaining <= safeKeep) break;
    evictKeys.push(c.key);
    evictedSet.add(c.key);
    remaining -= 1;
  }

  return { stripVectorMeshKeys, evictKeys };
}

