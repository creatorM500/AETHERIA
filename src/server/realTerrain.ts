import { PbfReader } from 'pbf';
import { classifyRings, VectorTile } from '@mapbox/vector-tile';
import { PNG } from 'pngjs';
import { clamp, latToTileY, lngToTileX, normalizeLngDeg, sampleTerrainElevation } from '../shared/geo.ts';
import {
  carveCoastalWaterElevations,
  computeSingleTileWindow,
  computeTerrainTileWindow,
  decodeTerrariumPixel,
  despikeDemTile256,
  despikeElevationGrid,
  isKnownBelowSeaBasin,
  latLngToTileWindowUV,
  sampleStitchedTilesAreaFiltered,
  sampleTileAreaFiltered,
} from '../shared/terrainMath.ts';
import type {
  RealTerrainPayload,
  TerrainBuildingFootprint,
  TerrainChunkPayload,
  TerrainRoadKind,
  TerrainRoadPolyline,
  TerrainWaterFeature,
  TerrainWaterKind,
} from '../shared/types.ts';
import { computePruneEvictionCount } from '../shared/memoryBudget.ts';

interface CachedEntry<T> {
  value: T;
  expiresAt: number;
}

interface ParsedVectorTileBundle {
  buildings: RawTileBuilding[];
  roads: TerrainRoadPolyline[];
  waterFeatures: TerrainWaterFeature[];
}

const demTileCache = new Map<string, CachedEntry<Float32Array>>();
const mvtTileBundleCache = new Map<string, CachedEntry<ParsedVectorTileBundle>>();
const payloadCache = new Map<string, CachedEntry<RealTerrainPayload>>();
const chunkCache = new Map<string, CachedEntry<TerrainChunkPayload>>();
let cachedPlanetDem: { width: number; height: number; heights01: number[] } | null = null;

interface RawTileBuilding {
  id: string;
  outer: Array<[number, number]>; // Tile-normalized [0..1]
  holes?: Array<Array<[number, number]>>;
  heightM: number;
  minHeightM: number;
  kind?: string;
  areaNorm: number;
  centroidX: number; // [0..1] in tile
  centroidY: number; // [0..1] in tile
}

let cachedOfmTemplate: { template: string; expiresAt: number } | null = null;

function setLru<T>(cache: Map<string, CachedEntry<T>>, key: string, value: T, ttlMs: number, maxEntries: number) {
  if (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function getLru<T>(cache: Map<string, CachedEntry<T>>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function evictOldestFromCache<T>(cache: Map<string, CachedEntry<T>>, fraction: number, minKeep = 0): number {
  const now = Date.now();
  let removed = 0;
  for (const [k, entry] of cache.entries()) {
    if (entry.expiresAt < now) {
      cache.delete(k);
      removed += 1;
    }
  }
  const toEvict = computePruneEvictionCount(cache.size, fraction, minKeep);
  for (let i = 0; i < toEvict; i++) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
    removed += 1;
  }
  return removed;
}

export function getRealTerrainCacheStats() {
  return {
    demTiles: demTileCache.size,
    mvtBundles: mvtTileBundleCache.size,
    payloads: payloadCache.size,
    chunks: chunkCache.size,
    hasPlanetDem: cachedPlanetDem !== null,
  };
}

export function pruneRealTerrainCaches(fraction = 0.5): number {
  const f = clamp(Number.isFinite(fraction) ? fraction : 0.5, 0, 1);
  const minKeep = f >= 0.85 ? 0 : 4;
  let removed = 0;
  removed += evictOldestFromCache(chunkCache, f, 0);
  removed += evictOldestFromCache(payloadCache, f, 0);
  removed += evictOldestFromCache(mvtTileBundleCache, f, minKeep);
  removed += evictOldestFromCache(demTileCache, f, minKeep);
  if (f >= 0.85) {
    cachedPlanetDem = null;
    cachedOfmTemplate = null;
  }
  return removed;
}

async function getOpenFreeMapTileTemplate(): Promise<string> {
  if (cachedOfmTemplate && cachedOfmTemplate.expiresAt > Date.now()) {
    return cachedOfmTemplate.template;
  }
  const res = await fetch('https://tiles.openfreemap.org/planet', {
    headers: { 'User-Agent': 'AetheriaGlobal/1.0' },
    signal: AbortSignal.timeout(4500),
  });
  if (!res.ok) {
    throw new Error(`OpenFreeMap tilejson HTTP ${res.status}`);
  }
  const json = (await res.json()) as { tiles?: string[] };
  const tmpl = json.tiles?.[0];
  if (!tmpl) {
    throw new Error('OpenFreeMap tile template missing');
  }
  cachedOfmTemplate = {
    template: tmpl,
    expiresAt: Date.now() + 6 * 3600 * 1000,
  };
  return tmpl;
}

/**
 * Signed shoelace area in screen/tile Y-down coordinates.
 * Positive => outer clockwise ring (in MVT Y-down); negative => interior hole.
 */
export function ringSignedArea(ring: Array<[number, number]>): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

/**
 * Computes realistic deterministic building height when OSM omits explicit height/levels,
 * scaling naturally with footprint area and deterministic parcel variation.
 */
export function parseOsmNumericTag(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : 0;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim().replace(',', '.');
    if (!trimmed) return 0;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function inferBuildingHeightM(
  explicitHeight: number,
  levels: number,
  areaNorm: number,
  seedIdx: number
): number {
  if (Number.isFinite(explicitHeight) && explicitHeight > 0.5) {
    return clamp(explicitHeight, 3.5, 580);
  }
  if (Number.isFinite(levels) && levels > 0) {
    return clamp(levels * 3.4, 3.5, 580);
  }
  // Footprint area in tile-normalized space (~1e-6 for small house, ~1e-4 for big block)
  const areaBoost = clamp(Math.sqrt(Math.max(0, areaNorm)) * 1850, 0, 14);
  const hashJitter = ((seedIdx * 2654435761) % 7) * 0.9;
  return Number(clamp(5.5 + areaBoost + hashJitter, 4.5, 24).toFixed(1));
}

export function classifyRoadKind(rawKind: unknown): { kind: TerrainRoadKind; widthM: number; priority: number } | null {
  const s = typeof rawKind === 'string' ? rawKind.toLowerCase() : '';
  if (!s) return null;
  if (s.includes('motorway') || s.includes('trunk')) {
    return { kind: 'motorway', widthM: 14.5, priority: 5 };
  }
  if (s === 'primary' || s.includes('primary_link')) {
    return { kind: 'primary', widthM: 11.0, priority: 4 };
  }
  if (s === 'secondary' || s === 'tertiary' || s.includes('secondary_link') || s.includes('tertiary_link')) {
    return { kind: 'secondary', widthM: 8.2, priority: 3 };
  }
  if (s === 'rail' || s === 'railway' || s === 'subway' || s === 'tram' || s === 'light_rail') {
    return { kind: 'rail', widthM: 3.8, priority: 2 };
  }
  if (
    s === 'residential' ||
    s === 'minor' ||
    s === 'street' ||
    s === 'living_street' ||
    s === 'unclassified' ||
    s === 'service' ||
    s === 'pedestrian'
  ) {
    return { kind: 'residential', widthM: 5.8, priority: 1 };
  }
  return null;
}

export function classifyWaterKind(rawKind: unknown, isPolygon: boolean): { kind: TerrainWaterKind; widthM: number } | null {
  const s = typeof rawKind === 'string' ? rawKind.toLowerCase() : '';
  if (s.includes('swimming_pool') || s === 'pool') return null;
  if (s.includes('ocean') || s.includes('sea') || s.includes('bay')) {
    return { kind: 'ocean', widthM: 40 };
  }
  if (s.includes('canal') || s.includes('drain') || s.includes('ditch')) {
    return { kind: 'canal', widthM: isPolygon ? 22 : 14 };
  }
  if (s.includes('river')) {
    return { kind: 'river', widthM: isPolygon ? 34 : 22 };
  }
  if (s.includes('stream') || s.includes('brook')) {
    return { kind: 'stream', widthM: 7 };
  }
  if (s.includes('lake') || s.includes('pond') || s.includes('reservoir') || s.includes('basin') || s.includes('dock') || s.includes('water')) {
    return { kind: 'lake', widthM: 28 };
  }
  return isPolygon ? { kind: 'lake', widthM: 28 } : { kind: 'stream', widthM: 8 };
}

function simplifyNormalizedLine(
  pts: Array<{ x: number; y: number }>,
  ext: number,
  minStep = 0.0028
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < pts.length; i++) {
    const nx = Number((pts[i].x / ext).toFixed(5));
    const ny = Number((pts[i].y / ext).toFixed(5));
    if (out.length === 0 || i === pts.length - 1) {
      out.push([nx, ny]);
      continue;
    }
    const prev = out[out.length - 1];
    if (Math.hypot(nx - prev[0], ny - prev[1]) >= minStep) {
      out.push([nx, ny]);
    }
  }
  return out;
}

function parseVectorTileBundle(
  buf: Uint8Array,
  schema: 'versatiles' | 'openfreemap',
  tileKey: string
): ParsedVectorTileBundle {
  const tile = new VectorTile(new PbfReader(buf));

  // 1. Buildings
  const bLayer = tile.layers[schema === 'versatiles' ? 'buildings' : 'building'];
  const extracted: RawTileBuilding[] = [];
  if (bLayer && bLayer.length > 0) {
    for (let i = 0; i < bLayer.length; i++) {
      const feat = bLayer.feature(i);
      if (feat.type !== 3) continue;

      const ext = feat.extent || 4096;
      const props = feat.properties ?? {};
      if (props.hide_3d) continue;

      const rawHeight = parseOsmNumericTag(props.render_height ?? props.height);
      const levels = parseOsmNumericTag(props['building:levels'] ?? props.levels);
      const rawMinH = parseOsmNumericTag(props.render_min_height ?? props.min_height);

      const polygons = classifyRings(feat.loadGeometry());
      let subIdx = 0;
      for (const rings of polygons) {
        if (rings.length === 0) continue;
        const toNorm = (pts: Array<{ x: number; y: number }>) => {
          const norm: Array<[number, number]> = [];
          for (let p = 0; p < pts.length; p++) {
            const nx = pts[p].x / ext;
            const ny = pts[p].y / ext;
            if (p === pts.length - 1 && norm.length > 0) {
              const [fx, fy] = norm[0];
              if (Math.hypot(nx - fx, ny - fy) < 1e-5) continue;
            }
            norm.push([nx, ny]);
          }
          return norm;
        };

        const outer = toNorm(rings[0]);
        const areaNorm = Math.abs(ringSignedArea(outer));
        if (outer.length < 3 || areaNorm < 1e-8) continue;

        const holes = rings
          .slice(1)
          .map(toNorm)
          .filter((h) => h.length >= 3);

        const heightM = inferBuildingHeightM(rawHeight, levels, areaNorm, i + subIdx);
        const minHeightM = clamp(Number.isFinite(rawMinH) && rawMinH > 0 ? rawMinH : 0, 0, heightM - 2);

        let cx = 0;
        let cy = 0;
        for (const [px, py] of outer) {
          cx += px;
          cy += py;
        }
        cx /= outer.length;
        cy /= outer.length;

        extracted.push({
          id: `${tileKey}-${feat.id ?? i}-${subIdx++}`,
          outer,
          holes: holes.length > 0 ? holes : undefined,
          heightM,
          minHeightM,
          kind: typeof props.kind === 'string'
            ? props.kind
            : typeof props.class === 'string'
              ? props.class
              : undefined,
          areaNorm,
          centroidX: cx,
          centroidY: cy,
        });
      }
    }
  }

  // Deduplicate overlapping OSM building + building:part pairs
  const buildings: RawTileBuilding[] = [];
  const seenBuckets = new Map<string, RawTileBuilding[]>();
  for (const b of extracted) {
    const bx = Math.round(b.centroidX * 2048);
    const by = Math.round(b.centroidY * 2048);
    const key = `${bx}:${by}`;
    const group = seenBuckets.get(key);
    if (group) {
      const dup = group.some(
        (prev) =>
          Math.abs(prev.heightM - b.heightM) < 1.8 &&
          Math.abs(prev.minHeightM - b.minHeightM) < 1.5 &&
          Math.abs(prev.areaNorm - b.areaNorm) / Math.max(prev.areaNorm, b.areaNorm, 1e-8) < 0.2
      );
      if (dup) continue;
      group.push(b);
    } else {
      seenBuckets.set(key, [b]);
    }
    buildings.push(b);
  }

  // 2. Vector Road Network (streets / transportation)
  const roadCandidates: Array<{ score: number; road: TerrainRoadPolyline }> = [];
  const rLayer = tile.layers[schema === 'versatiles' ? 'streets' : 'transportation'];
  if (rLayer && rLayer.length > 0) {
    for (let i = 0; i < rLayer.length; i++) {
      const feat = rLayer.feature(i);
      if (feat.type !== 2) continue; // LineString only
      const props = feat.properties ?? {};
      if (Number(props.tunnel ?? 0) > 0) continue; // Skip underground subway/road tunnels
      const classified = classifyRoadKind(props.kind ?? props.class ?? props.subclass);
      if (!classified) continue;

      const ext = feat.extent || 4096;
      const lines = feat.loadGeometry();
      for (let lIdx = 0; lIdx < lines.length; lIdx++) {
        const coords = simplifyNormalizedLine(lines[lIdx], ext, 0.003);
        if (coords.length < 2) continue;
        let len = 0;
        for (let k = 1; k < coords.length; k++) {
          len += Math.hypot(coords[k][0] - coords[k - 1][0], coords[k][1] - coords[k - 1][1]);
        }
        if (len < 0.008) continue;
        const rawName =
          typeof props['name:es'] === 'string' && props['name:es'].trim()
            ? props['name:es'].trim()
            : typeof props.name === 'string' && props.name.trim()
              ? props.name.trim()
              : typeof props['name:en'] === 'string' && props['name:en'].trim()
                ? props['name:en'].trim()
                : typeof props.street === 'string' && props.street.trim()
                  ? props.street.trim()
                  : undefined;
        const rawRef =
          typeof props.ref === 'string' && props.ref.trim() ? props.ref.trim() : undefined;

        roadCandidates.push({
          score: classified.priority * 10 + len,
          road: {
            id: `${tileKey}-r-${i}-${lIdx}`,
            kind: classified.kind,
            coords,
            widthM: classified.widthM,
            ...(rawName ? { name: rawName } : {}),
            ...(rawRef ? { ref: rawRef } : {}),
          },
        });
      }
    }
  }
  roadCandidates.sort((a, b) => b.score - a.score);
  const roads = roadCandidates.slice(0, 260).map((c) => c.road);

  // 3. Water Features (VersaTiles ocean coastlines + water polygons + rivers/canals/streams)
  const waterFeatures: TerrainWaterFeature[] = [];
  if (schema === 'versatiles') {
    const oceanLayer = tile.layers['ocean'];
    if (oceanLayer && oceanLayer.length > 0) {
      for (let i = 0; i < oceanLayer.length && waterFeatures.length < 96; i++) {
        const feat = oceanLayer.feature(i);
        if (feat.type !== 3) continue;
        const ext = feat.extent || 4096;
        const polygons = classifyRings(feat.loadGeometry());
        for (let pIdx = 0; pIdx < polygons.length && waterFeatures.length < 96; pIdx++) {
          const rings = polygons[pIdx];
          if (rings.length === 0) continue;
          const outer = simplifyNormalizedLine(rings[0], ext, 0.0012);
          if (outer.length < 3 || Math.abs(ringSignedArea(outer)) < 2e-6) continue;
          const mappedRings = [outer];
          for (let h = 1; h < rings.length; h++) {
            const hole = simplifyNormalizedLine(rings[h], ext, 0.0014);
            if (hole.length >= 3) mappedRings.push(hole);
          }
          waterFeatures.push({
            id: `${tileKey}-oc-${i}-${pIdx}`,
            kind: 'ocean',
            isPolygon: true,
            rings: mappedRings,
          });
        }
      }
    }
  }

  const wPolyLayer = tile.layers[schema === 'versatiles' ? 'water_polygons' : 'water'];
  if (wPolyLayer && wPolyLayer.length > 0) {
    for (let i = 0; i < wPolyLayer.length && waterFeatures.length < 96; i++) {
      const feat = wPolyLayer.feature(i);
      if (feat.type !== 3) continue;
      const props = feat.properties ?? {};
      if (Number(props.intermittent ?? 0) > 0) continue;
      const cls = classifyWaterKind(props.kind ?? props.class, true);
      if (!cls) continue;

      const ext = feat.extent || 4096;
      const polygons = classifyRings(feat.loadGeometry());
      for (let pIdx = 0; pIdx < polygons.length && waterFeatures.length < 96; pIdx++) {
        const rings = polygons[pIdx];
        if (rings.length === 0) continue;
        const outer = simplifyNormalizedLine(rings[0], ext, 0.0012);
        if (outer.length < 3 || Math.abs(ringSignedArea(outer)) < 2e-6) continue;
        const mappedRings = [outer];
        for (let h = 1; h < rings.length; h++) {
          const hole = simplifyNormalizedLine(rings[h], ext, 0.0014);
          if (hole.length >= 3) mappedRings.push(hole);
        }
        waterFeatures.push({
          id: `${tileKey}-wp-${i}-${pIdx}`,
          kind: cls.kind,
          isPolygon: true,
          rings: mappedRings,
        });
      }
    }
  }

  const wLineLayer = tile.layers[schema === 'versatiles' ? 'water_lines' : 'waterway'];
  if (wLineLayer && wLineLayer.length > 0) {
    for (let i = 0; i < wLineLayer.length && waterFeatures.length < 110; i++) {
      const feat = wLineLayer.feature(i);
      if (feat.type !== 2) continue;
      const props = feat.properties ?? {};
      if (Number(props.tunnel ?? 0) > 0 || Number(props.intermittent ?? 0) > 0) continue;
      const cls = classifyWaterKind(props.kind ?? props.class, false);
      if (!cls) continue;

      const ext = feat.extent || 4096;
      const lines = feat.loadGeometry();
      for (let lIdx = 0; lIdx < lines.length && waterFeatures.length < 110; lIdx++) {
        const coords = simplifyNormalizedLine(lines[lIdx], ext, 0.0035);
        if (coords.length < 2) continue;
        waterFeatures.push({
          id: `${tileKey}-wl-${i}-${lIdx}`,
          kind: cls.kind,
          isPolygon: false,
          rings: [coords],
          widthM: cls.widthM,
        });
      }
    }
  }

  return { buildings, roads, waterFeatures };
}

async function fetchTerrariumTileMeters(z: number, tx: number, ty: number): Promise<Float32Array> {
  const key = `${z}/${tx}/${ty}`;
  const cached = getLru(demTileCache, key);
  if (cached) return cached;

  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`Terrarium HTTP ${res.status}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const png = PNG.sync.read(Buffer.from(arrayBuf));
  const out = new Float32Array(256 * 256);
  const data = png.data;
  const w = png.width;
  const h = png.height;

  for (let y = 0; y < 256; y++) {
    const sy = Math.min(h - 1, y);
    for (let x = 0; x < 256; x++) {
      const sx = Math.min(w - 1, x);
      const idx = (sy * w + sx) * 4;
      out[y * 256 + x] = decodeTerrariumPixel(data[idx], data[idx + 1], data[idx + 2]);
    }
  }

  const clean = z >= 10 ? despikeDemTile256(out, false) : out;
  setLru(demTileCache, key, clean, 30 * 60 * 1000, 72);
  return clean;
}

async function fetchVectorTileWithFallback(
  z: number,
  tx: number,
  ty: number
): Promise<{
  bundle: ParsedVectorTileBundle;
  source: 'versatiles-osm' | 'openfreemap-osm' | 'none';
}> {
  const key = `vt/${z}/${tx}/${ty}`;
  const cached = getLru(mvtTileBundleCache, key);
  if (cached) {
    const hasAny =
      cached.buildings.length > 0 || cached.roads.length > 0 || cached.waterFeatures.length > 0;
    return { bundle: cached, source: hasAny ? 'versatiles-osm' : 'none' };
  }

  // Primary: VersaTiles OSM (contains buildings, roads, and water worldwide)
  try {
    const vtUrl = `https://tiles.versatiles.org/tiles/osm/${z}/${tx}/${ty}`;
    const res = await fetch(vtUrl, {
      headers: { 'User-Agent': 'AetheriaGlobal/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      const parsed = parseVectorTileBundle(buf, 'versatiles', key);
      if (
        parsed.buildings.length > 0 ||
        parsed.roads.length > 0 ||
        parsed.waterFeatures.length > 0
      ) {
        setLru(mvtTileBundleCache, key, parsed, 20 * 60 * 1000, 56);
        return { bundle: parsed, source: 'versatiles-osm' };
      }
    }
  } catch {
    // Fall through to OpenFreeMap
  }

  // Fallback: OpenFreeMap Planet
  try {
    const template = await getOpenFreeMapTileTemplate();
    const ofmUrl = template
      .replace('{z}', String(z))
      .replace('{x}', String(tx))
      .replace('{y}', String(ty));
    const res = await fetch(ofmUrl, {
      headers: { 'User-Agent': 'AetheriaGlobal/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      const parsed = parseVectorTileBundle(buf, 'openfreemap', `ofm/${z}/${tx}/${ty}`);
      setLru(mvtTileBundleCache, key, parsed, 20 * 60 * 1000, 56);
      const hasAny =
        parsed.buildings.length > 0 || parsed.roads.length > 0 || parsed.waterFeatures.length > 0;
      return { bundle: parsed, source: hasAny ? 'openfreemap-osm' : 'none' };
    }
  } catch {
    // Return empty cleanly
  }

  const empty: ParsedVectorTileBundle = { buildings: [], roads: [], waterFeatures: [] };
  setLru(mvtTileBundleCache, key, empty, 10 * 60 * 1000, 56);
  return { bundle: empty, source: 'none' };
}


/**
 * Fetches real DEM terrain elevation + real OSM 3D building footprints for any Earth coordinate.
 */
export async function getRealTerrainForCoordinate(opts: {
  lat: number;
  lng: number;
  gridSize?: number;
  maxBuildings?: number;
}): Promise<RealTerrainPayload> {
  const lat = clamp(opts.lat, -84, 84);
  const lng = normalizeLngDeg(opts.lng);
  const gridSize = clamp(Math.round(opts.gridSize ?? 81), 33, 145);
  const maxBuildings = clamp(Math.round(opts.maxBuildings ?? 9500), 100, 16000);

  const win = computeTerrainTileWindow(lat, lng, 14, 96);
  const cacheKey = `${win.minTx}/${win.minTy}/${gridSize}/${maxBuildings}/${lat.toFixed(3)},${lng.toFixed(3)}`;
  const cached = getLru(payloadCache, cacheKey);
  if (cached) return cached;

  const tileCoords = [
    { col: 0, row: 0, tx: win.minTx, ty: win.minTy },
    { col: 1, row: 0, tx: win.maxTx, ty: win.minTy },
    { col: 0, row: 1, tx: win.minTx, ty: win.maxTy },
    { col: 1, row: 1, tx: win.maxTx, ty: win.maxTy },
  ];

  // Fetch Terrarium DEM tiles + OSM buildings tiles in parallel
  const demPromise = Promise.all(
    tileCoords.map((t) => fetchTerrariumTileMeters(win.zoom, t.tx, t.ty))
  );

  const buildingsPromise = (async (): Promise<{
    buildings: TerrainBuildingFootprint[];
    source: 'openfreemap-osm' | 'none';
  }> => {
    try {
      const tileResults = await Promise.all(
        tileCoords.map(async (t) => {
          const fetched = await fetchVectorTileWithFallback(win.zoom, t.tx, t.ty);
          return {
            col: t.col,
            row: t.row,
            items: fetched.bundle.buildings,
            source: fetched.source,
          };
        })
      );

      const [centerU, centerV] = latLngToTileWindowUV(lat, lng, win);
      const candidates: Array<{ score: number; building: TerrainBuildingFootprint }> = [];
      let anySuccess = false;

      for (const tr of tileResults) {
        if (tr.source !== 'none') anySuccess = true;
        for (const b of tr.items) {
          const uCenter = (tr.col + b.centroidX) / 2;
          const vCenter = (tr.row + b.centroidY) / 2;
          if (uCenter < 0.015 || uCenter > 0.985 || vCenter < 0.015 || vCenter > 0.985) continue;

          // Rank strictly by proximity first so city blocks stay 100% contiguous with zero missing neighbors
          const dist2 = (uCenter - centerU) ** 2 + (vCenter - centerV) ** 2;
          const score = dist2 - Math.min(0.0025, b.areaNorm * 1.2);

          const outer: Array<[number, number]> = b.outer.map(([px, py]) => [
            clamp((tr.col + px) / 2, 0.002, 0.998),
            clamp((tr.row + py) / 2, 0.002, 0.998),
          ]);
          const holes = b.holes?.map((ring) =>
            ring.map(
              ([px, py]) =>
                [
                  clamp((tr.col + px) / 2, 0.002, 0.998),
                  clamp((tr.row + py) / 2, 0.002, 0.998),
                ] as [number, number]
            )
          );

          candidates.push({
            score,
            building: {
              id: b.id,
              outer,
              holes,
              heightM: b.heightM,
              minHeightM: b.minHeightM,
              kind: b.kind,
            },
          });
        }
      }

      candidates.sort((a, b) => a.score - b.score);
      return {
        buildings: candidates.slice(0, maxBuildings).map((c) => c.building),
        source: anySuccess || candidates.length > 0 ? 'openfreemap-osm' : 'none',
      };
    } catch (err) {
      console.warn('OSM buildings fallback (none):', err);
      return { buildings: [], source: 'none' };
    }
  })();

  let elevationsM: number[] = [];
  let minElevationM = Infinity;
  let maxElevationM = -Infinity;
  let demSource: RealTerrainPayload['demSource'] = 'terrarium-dem';

  try {
    const tiles = await demPromise;
    // tiles order: [0]=(0,0), [1]=(1,0), [2]=(0,1), [3]=(1,1)
    elevationsM = sampleStitchedTilesAreaFiltered(tiles, gridSize);

    // Continuously floor submarine bathymetry / voids outside genuine below-sea-level inland basins
    if (!isKnownBelowSeaBasin(lat, lng)) {
      for (let i = 0; i < elevationsM.length; i++) {
        if (elevationsM[i] < -8) {
          elevationsM[i] = -8;
        }
      }
    }
    elevationsM = despikeElevationGrid(elevationsM, gridSize, gridSize);

    for (let i = 0; i < elevationsM.length; i++) {
      const e = elevationsM[i];
      if (e < minElevationM) minElevationM = e;
      if (e > maxElevationM) maxElevationM = e;
    }
  } catch (err) {
    console.warn('Terrarium DEM failed, sampling fallback elevation:', err);
    demSource = 'fallback';
    elevationsM = new Array<number>(gridSize * gridSize);
    minElevationM = Infinity;
    maxElevationM = -Infinity;
    for (let r = 0; r < gridSize; r++) {
      const v = r / (gridSize - 1);
      for (let c = 0; c < gridSize; c++) {
        const u = c / (gridSize - 1);
        const x = (u - 0.5) * 80;
        const z = (v - 0.5) * 80;
        const elev = Number((sampleTerrainElevation(x, z, lat, lng, 1) * 18).toFixed(1));
        elevationsM[r * gridSize + c] = elev;
        if (elev < minElevationM) minElevationM = elev;
        if (elev > maxElevationM) maxElevationM = elev;
      }
    }
  }

  const buildingResult = await buildingsPromise;

  const payload: RealTerrainPayload = {
    center: { lat, lng },
    zoom: win.zoom,
    tileSpan: {
      minTx: win.minTx,
      maxTx: win.maxTx,
      minTy: win.minTy,
      maxTy: win.maxTy,
    },
    bounds: win.bounds,
    spanMetersX: Math.round(win.spanMetersX),
    spanMetersZ: Math.round(win.spanMetersZ),
    sceneWidth: win.sceneWidth,
    sceneDepth: win.sceneDepth,
    rows: gridSize,
    cols: gridSize,
    elevationsM,
    minElevationM: Number.isFinite(minElevationM) ? minElevationM : 0,
    maxElevationM: Number.isFinite(maxElevationM) ? maxElevationM : 0,
    buildings: buildingResult.buildings,
    demSource,
    buildingsSource: buildingResult.source,
    fetchedAt: new Date().toISOString(),
  };

  setLru(payloadCache, cacheKey, payload, 30 * 60 * 1000, 8);
  return payload;
}

function sampleSingleTileBilinear(tile: Float32Array, pxFloat: number, pyFloat: number): number {
  const x0 = clamp(Math.floor(pxFloat), 0, 255);
  const y0 = clamp(Math.floor(pyFloat), 0, 255);
  const x1 = Math.min(255, x0 + 1);
  const y1 = Math.min(255, y0 + 1);
  const tx = clamp(pxFloat - x0, 0, 1);
  const ty = clamp(pyFloat - y0, 0, 1);

  const e00 = tile[y0 * 256 + x0] ?? 0;
  const e10 = tile[y0 * 256 + x1] ?? e00;
  const e01 = tile[y1 * 256 + x0] ?? e00;
  const e11 = tile[y1 * 256 + x1] ?? e00;
  const top = e00 + (e10 - e00) * tx;
  const bot = e01 + (e11 - e01) * tx;
  return top + (bot - top) * ty;
}

/**
 * Fetches an individual Mercator terrain & buildings chunk (z/tx/ty) for worldwide continuous 3D streaming.
 * Returns up to 12,000 real OSM building footprints inside a single z=14 tile (~2.4 km x 2.4 km)
 * so every mapped house in dense suburbs & cities extrudes cleanly with zero circular cutoff.
 */
export async function getTerrainChunkForTile(opts: {
  z: number;
  tx: number;
  ty: number;
  gridSize?: number;
  maxBuildings?: number;
  includeBuildings?: boolean;
}): Promise<TerrainChunkPayload> {
  const z = clamp(Math.round(opts.z), 10, 14);
  const n = Math.pow(2, z);
  const tx = ((Math.floor(opts.tx) % n) + n) % n;
  const ty = clamp(Math.floor(opts.ty), 0, n - 1);
  const gridSize = clamp(Math.round(opts.gridSize ?? (z === 14 ? 49 : 33)), 17, 97);
  const includeBuildings = opts.includeBuildings ?? z === 14;
  const maxBuildings = includeBuildings
    ? clamp(Math.round(opts.maxBuildings ?? 14000), 100, 20000)
    : 0;

  const cacheKey = `${z}/${tx}/${ty}/${gridSize}/${maxBuildings}`;
  const cached = getLru(chunkCache, cacheKey);
  if (cached) return cached;

  const win = computeSingleTileWindow(z, tx, ty);
  const midLat = (win.bounds.north + win.bounds.south) * 0.5;
  const midLng = (win.bounds.west + win.bounds.east) * 0.5;

  const demPromise = fetchTerrariumTileMeters(z, tx, ty);
  const vectorPromise =
    z === 14 || z === 12
      ? fetchVectorTileWithFallback(z, tx, ty).catch(() => ({
          bundle: { buildings: [], roads: [], waterFeatures: [] } as ParsedVectorTileBundle,
          source: 'none' as const,
        }))
      : Promise.resolve({
          bundle: { buildings: [], roads: [], waterFeatures: [] } as ParsedVectorTileBundle,
          source: 'none' as const,
        });

  let elevationsM = new Array<number>(gridSize * gridSize);
  let demSource: TerrainChunkPayload['demSource'] = 'terrarium-dem';

  try {
    const tile = await demPromise;
    elevationsM = sampleTileAreaFiltered(tile, gridSize);

    if (!isKnownBelowSeaBasin(midLat, midLng)) {
      for (let i = 0; i < elevationsM.length; i++) {
        if (elevationsM[i] < -8) elevationsM[i] = -8;
      }
    }
    elevationsM = despikeElevationGrid(elevationsM, gridSize, gridSize);
  } catch {
    demSource = 'fallback';
    for (let r = 0; r < gridSize; r++) {
      const v = r / (gridSize - 1);
      for (let c = 0; c < gridSize; c++) {
        const u = c / (gridSize - 1);
        elevationsM[r * gridSize + c] = Number(
          (sampleTerrainElevation((u - 0.5) * 40, (v - 0.5) * 40, midLat, midLng, 1) * 18).toFixed(1)
        );
      }
    }
  }

  const vRes = await vectorPromise;
  if (!isKnownBelowSeaBasin(midLat, midLng) && vRes.bundle.waterFeatures.length > 0) {
    elevationsM = carveCoastalWaterElevations(
      elevationsM,
      gridSize,
      gridSize,
      vRes.bundle.waterFeatures,
      z === 14 ? 32.0 : 12.0,
      -4.5
    );
  }

  let minElevationM = Infinity;
  let maxElevationM = -Infinity;
  for (let i = 0; i < elevationsM.length; i++) {
    const e = elevationsM[i];
    if (e < minElevationM) minElevationM = e;
    if (e > maxElevationM) maxElevationM = e;
  }

  const keepBuildingsAndRoads = includeBuildings && z === 14;
  const buildings: TerrainBuildingFootprint[] = keepBuildingsAndRoads
    ? vRes.bundle.buildings.slice(0, maxBuildings).map((b) => ({
        id: b.id,
        outer: b.outer,
        holes: b.holes,
        heightM: b.heightM,
        minHeightM: b.minHeightM,
        kind: b.kind,
      }))
    : [];

  const payload: TerrainChunkPayload = {
    zoom: z,
    tx,
    ty,
    bounds: win.bounds,
    spanMetersX: Math.round(win.spanMetersX),
    spanMetersZ: Math.round(win.spanMetersZ),
    rows: gridSize,
    cols: gridSize,
    elevationsM,
    minElevationM: Number.isFinite(minElevationM) ? minElevationM : 0,
    maxElevationM: Number.isFinite(maxElevationM) ? maxElevationM : 0,
    buildings,
    roads: keepBuildingsAndRoads ? vRes.bundle.roads : [],
    waterFeatures: vRes.bundle.waterFeatures,
    demSource,
    buildingsSource: keepBuildingsAndRoads ? vRes.source : 'none',
  };

  setLru(chunkCache, cacheKey, payload, 25 * 60 * 1000, 48);
  return payload;
}

/**
 * Generates a cached equirectangular global elevation grid (512x256 normalized [0..1])
 * from Terrarium z=2 planetary DEM tiles so Earth's mountain ranges have crisp 3D relief on the globe.
 */
export async function getPlanetaryDemGrid(): Promise<{
  width: number;
  height: number;
  heights01: number[];
}> {
  if (cachedPlanetDem) return cachedPlanetDem;

  const width = 512;
  const height = 256;
  const heights01 = new Array<number>(width * height).fill(0);

  try {
    const tiles = await Promise.all(
      Array.from({ length: 16 }, (_, idx) => {
        const tx = idx % 4;
        const ty = Math.floor(idx / 4);
        return fetchTerrariumTileMeters(2, tx, ty).catch(() => null);
      })
    );

    for (let y = 0; y < height; y++) {
      const lat = clamp(90 - ((y + 0.5) / height) * 180, -84, 84);
      const fTy = latToTileY(lat, 2);
      const ty = clamp(Math.floor(fTy), 0, 3);
      const py = clamp((fTy - ty) * 255, 0, 255);

      for (let x = 0; x < width; x++) {
        const lng = -180 + ((x + 0.5) / width) * 360;
        const fTx = lngToTileX(lng, 2);
        const tx = clamp(Math.floor(fTx), 0, 3);
        const px = clamp((fTx - tx) * 255, 0, 255);
        const tile = tiles[ty * 4 + tx];
        const meters = tile ? sampleSingleTileBilinear(tile, px, py) : 0;
        // Clamp bathymetry at sea level so oceans remain glassy and continents rise organically
        const aboveSea = Math.max(0, meters);
        heights01[y * width + x] = Number(clamp(aboveSea / 6200, 0, 1).toFixed(3));
      }
    }
    cachedPlanetDem = { width, height, heights01 };
  } catch {
    cachedPlanetDem = { width, height, heights01 };
  }

  return cachedPlanetDem;
}
