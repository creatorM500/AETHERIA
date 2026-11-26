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
