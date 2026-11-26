import { clamp, haversineKm, latToTileY, lngToTileX, tileXToLng, tileYToLat } from './geo.ts';
import type { QualityTier, TerrainWaterFeature } from './types.ts';

export interface TerrainTileWindow {
  zoom: number;
  minTx: number;
  maxTx: number;
  minTy: number;
  maxTy: number;
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  spanMetersX: number;
  spanMetersZ: number;
  sceneWidth: number;
  sceneDepth: number;
}

export interface SingleTileWindow {
  zoom: number;
  tx: number;
  ty: number;
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  spanMetersX: number;
  spanMetersZ: number;
}

export interface AdaptiveQualitySpec {
  tier: QualityTier;
  demGridSize: number;
  maxBuildings: number;
  textureSize: number;
  pixelRatioCap: number;
  shadowsEnabled: boolean;
}

/**
 * Decodes an AWS Mapzen Terrarium RGB pixel into elevation in meters.
 * Spec: elevation = (R * 256 + G + B / 256) - 32768
 */
export function decodeTerrariumPixel(r: number, g: number, b: number): number {
  const meters = r * 256 + g + b / 256 - 32768;
  return clamp(meters, -500, 9000);
}

/**
 * Computes a centered 2x2 Web Mercator tile window at zoom=14 around (lat, lng),
 * guaranteeing the requested point sits cleanly inside the inner 50% of the patch.
 */
export function computeTerrainTileWindow(
  lat: number,
  lng: number,
  zoom = 14,
  targetSceneWidth = 96
): TerrainTileWindow {
  const n = Math.pow(2, zoom);
  const fTx = lngToTileX(lng, zoom);
  const fTy = latToTileY(lat, zoom);

  // Pick 2x2 window surrounding the nearest tile corner so target lies near patch center
  const baseX = Math.round(fTx) - 1;
  const baseY = clamp(Math.round(fTy) - 1, 0, Math.max(0, n - 2));

  const minTx = ((baseX % n) + n) % n;
  const maxTx = (minTx + 1) % n;
  const minTy = baseY;
  const maxTy = Math.min(n - 1, baseY + 1);

  const west = tileXToLng(minTx, zoom);
  // Handle antimeridian cleanly for east bound calculation
  const eastRaw = tileXToLng(minTx + 2, zoom);
  const north = tileYToLat(minTy, zoom);
  const south = tileYToLat(maxTy + 1, zoom);

  const midLat = (north + south) * 0.5;
  const midLng = (west + eastRaw) * 0.5;
  const spanMetersX = Math.max(400, haversineKm({ lat: midLat, lng: west }, { lat: midLat, lng: eastRaw }) * 1000);
  const spanMetersZ = Math.max(400, haversineKm({ lat: north, lng: midLng }, { lat: south, lng: midLng }) * 1000);

  const sceneWidth = targetSceneWidth;
  const sceneDepth = clamp(targetSceneWidth * (spanMetersZ / spanMetersX), 48, 130);

  return {
    zoom,
    minTx,
    maxTx,
    minTy,
    maxTy,
    bounds: {
      north,
      south,
      east: eastRaw > 180 ? eastRaw - 360 : eastRaw,
      west,
    },
    spanMetersX,
    spanMetersZ,
    sceneWidth,
    sceneDepth,
  };
}

/**
 * Computes metric bounds and world spans for any single Web Mercator tile (z, tx, ty).
 */
export function computeSingleTileWindow(zoom: number, tx: number, ty: number): SingleTileWindow {
  const n = Math.pow(2, zoom);
  const wTx = ((tx % n) + n) % n;
  const wTy = clamp(ty, 0, n - 1);
  const west = tileXToLng(wTx, zoom);
  const eastRaw = tileXToLng(wTx + 1, zoom);
  const north = tileYToLat(wTy, zoom);
  const south = tileYToLat(wTy + 1, zoom);

  const midLat = (north + south) * 0.5;
  const midLng = (west + eastRaw) * 0.5;
  const spanMetersX = Math.max(
    180,
    haversineKm({ lat: midLat, lng: west }, { lat: midLat, lng: eastRaw }) * 1000
  );
  const spanMetersZ = Math.max(
    180,
    haversineKm({ lat: north, lng: midLng }, { lat: south, lng: midLng }) * 1000
  );

  return {
    zoom,
    tx: wTx,
    ty: wTy,
    bounds: {
      north,
      south,
      east: eastRaw > 180 ? eastRaw - 360 : eastRaw,
      west,
    },
    spanMetersX,
    spanMetersZ,
  };
}

/**
 * Returns an ordered center-first (2*radius+1)^2 tile ring around (centerTx, centerTy)
 * with longitudinal wraparound and polar latitude clamping.
 */
export function getTileNeighborhoodCoords(
  centerTx: number,
  centerTy: number,
  zoom: number,
  radius: number
): Array<{ tx: number; ty: number; dx: number; dy: number; dist2: number }> {
  const n = Math.pow(2, zoom);
  const out: Array<{ tx: number; ty: number; dx: number; dy: number; dist2: number }> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    const ty = centerTy + dy;
    if (ty < 0 || ty >= n) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const tx = (((centerTx + dx) % n) + n) % n;
      out.push({ tx, ty, dx, dy, dist2: dx * dx + dy * dy });
    }
  }
  out.sort((a, b) => a.dist2 - b.dist2);
  return out;
}

/**
 * Projects lat/lng to normalized [u, v] in [0..1] inside a Mercator tile window.
 * u = 0 (west) -> 1 (east), v = 0 (north) -> 1 (south).
 */
export function latLngToTileWindowUV(
  lat: number,
  lng: number,
  win: Pick<TerrainTileWindow, 'zoom' | 'minTx' | 'minTy' | 'maxTy'>
): [number, number] {
  const n = Math.pow(2, win.zoom);
  const fTx = lngToTileX(lng, win.zoom);
  const fTy = latToTileY(lat, win.zoom);

  let dx = fTx - win.minTx;
  if (dx < -n / 2) dx += n;
  if (dx > n / 2) dx -= n;

  const u = dx / 2;
  const spanY = win.maxTy + 1 - win.minTy;
  const v = (fTy - win.minTy) / spanY;
  return [u, v];
}

/**
 * Converts normalized tile window [u, v] to Three.js local scene (x, z) coordinates:
 * x: -sceneWidth/2 (west) .. +sceneWidth/2 (east)
 * z: -sceneDepth/2 (north) .. +sceneDepth/2 (south)
 */
export function uvToSceneXZ(
  u: number,
  v: number,
  sceneWidth: number,
  sceneDepth: number
): [number, number] {
  return [(u - 0.5) * sceneWidth, (v - 0.5) * sceneDepth];
}

/**
 * Inverse projection from Three.js local scene (x, z) coordinates back to (lat, lng)
 * inside a Mercator TerrainTileWindow.
 */
export function sceneXZToLatLng(
  x: number,
  z: number,
  win: Pick<TerrainTileWindow, 'zoom' | 'minTx' | 'minTy' | 'maxTy' | 'sceneWidth' | 'sceneDepth'>
): { lat: number; lng: number } {
  const u = x / win.sceneWidth + 0.5;
  const v = z / win.sceneDepth + 0.5;
  const n = Math.pow(2, win.zoom);
  const fTx = win.minTx + u * 2;
  const spanY = win.maxTy + 1 - win.minTy;
  const fTy = clamp(win.minTy + v * spanY, 0.001, n - 0.001);
  const wrappedTx = ((fTx % n) + n) % n;
  return {
    lat: tileYToLat(fTy, win.zoom),
    lng: tileXToLng(wrappedTx, win.zoom),
  };
}

/**
 * Bilinearly samples elevation (meters) from a row-major DEM grid (row 0 = north, col 0 = west).
 */
export function sampleElevationGrid(
  elevationsM: number[],
  rows: number,
  cols: number,
  u: number,
  v: number
): number {
  if (elevationsM.length === 0 || rows < 2 || cols < 2) return 0;

  const cu = clamp(u, 0, 1);
  const cv = clamp(v, 0, 1);

  const fx = cu * (cols - 1);
  const fz = cv * (rows - 1);

  const c0 = Math.floor(fx);
  const r0 = Math.floor(fz);
  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);

  const tx = fx - c0;
  const tz = fz - r0;

  const e00 = elevationsM[r0 * cols + c0] ?? 0;
  const e10 = elevationsM[r0 * cols + c1] ?? e00;
  const e01 = elevationsM[r1 * cols + c0] ?? e00;
  const e11 = elevationsM[r1 * cols + c1] ?? e00;

  const top = e00 + (e10 - e00) * tx;
  const bot = e01 + (e11 - e01) * tx;
  return top + (bot - top) * tz;
}

/**
 * Computes scene Y displacement for a real elevation in meters given base elevation and vertical exaggeration.
 */
export function elevationToSceneY(
  elevationM: number,
  baseElevationM: number,
  spanMetersX: number,
  sceneWidth: number,
  verticalExaggeration = 1.4
): number {
  const metersToScene = sceneWidth / Math.max(400, spanMetersX);
  return (elevationM - baseElevationM) * metersToScene * verticalExaggeration;
}

/**
 * Resolves adaptive quality budgets for hardware vs software WebGL and observed frame time.
 */
export function getQualitySpecForTier(tier: QualityTier, isSoftwareGl: boolean, dpr = 1): AdaptiveQualitySpec {
  if (isSoftwareGl || tier === 'eco') {
    return {
      tier: 'eco',
      demGridSize: 49,
      maxBuildings: 14000,
      textureSize: 1024,
      pixelRatioCap: 1,
      shadowsEnabled: false,
    };
  }
  if (tier === 'balanced') {
    return {
      tier: 'balanced',
      demGridSize: 65,
      maxBuildings: 16000,
      textureSize: 1280,
      pixelRatioCap: Math.min(dpr, 1.25),
      shadowsEnabled: true,
    };
  }
  return {
    tier: 'ultra',
    demGridSize: 81,
    maxBuildings: 18000,
    textureSize: 1536,
    pixelRatioCap: Math.min(dpr, 1.5),
    shadowsEnabled: true,
  };
}

/**
 * Hysteretic adaptive tier step based on smoothed frame time in milliseconds.
 */
export function stepAdaptiveQualityTier(
  current: QualityTier,
  avgFrameMs: number,
  isSoftwareGl: boolean
): QualityTier {
  if (isSoftwareGl) return 'eco';
  if (current === 'ultra') {
    if (avgFrameMs > 28) return 'balanced';
    return 'ultra';
  }
  if (current === 'balanced') {
    if (avgFrameMs > 34) return 'eco';
    if (avgFrameMs < 17) return 'ultra';
    return 'balanced';
  }
  if (avgFrameMs < 20) return 'balanced';
  return 'eco';
}

const BELOW_SEA_BASIN_BOXES: Array<{ minLat: number; maxLat: number; minLng: number; maxLng: number }> = [
  { minLat: 30.8, maxLat: 33.1, minLng: 35.2, maxLng: 35.8 }, // Dead Sea / Jordan Valley (-430m)
  { minLat: 42.3, maxLat: 43.2, minLng: 88.6, maxLng: 90.2 }, // Turpan Depression (-154m)
  { minLat: 28.8, maxLat: 30.6, minLng: 26.2, maxLng: 28.8 }, // Qattara Depression (-133m)
  { minLat: 11.4, maxLat: 14.6, minLng: 40.0, maxLng: 42.7 }, // Danakil / Assal (-155m)
  { minLat: 35.7, maxLat: 36.8, minLng: -117.2, maxLng: -116.5 }, // Death Valley (-86m)
  { minLat: 33.0, maxLat: 33.7, minLng: -116.3, maxLng: -115.3 }, // Salton Sea (-72m)
  { minLat: 36.5, maxLat: 47.5, minLng: 46.5, maxLng: 54.5 }, // Caspian / Karagiye (-132m)
];

/**
 * Returns true if (lat, lng) lies inside a known continental depression well below sea level,
 * so ocean bathymetry clamping does not flatten genuine inland basins like the Dead Sea.
 */
export function isKnownBelowSeaBasin(lat: number, lng: number): boolean {
  for (let i = 0; i < BELOW_SEA_BASIN_BOXES.length; i++) {
    const b = BELOW_SEA_BASIN_BOXES[i];
    if (lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng) {
      return true;
    }
  }
  return false;
}

/**
 * Suppresses isolated DEM/DSM artifacts (single-pixel or narrow 1-3px building/ship spikes,
 * shoreline Lanczos ringing such as +322m/-287m, and -500m void pits inside land) on a 256x256
 * Terrarium tile while preserving genuine continuous mountain peaks, ridges, and sea cliffs.
 */
export function despikeDemTile256(src: Float32Array, clampOceanFloor = false): Float32Array {
  const out = new Float32Array(src);
  if (out.length !== 256 * 256) return out;

  const ringBuf = new Float32Array(24);
  const runRingPass = (radius: 2 | 3, highDiff: number, medDiff: number) => {
    const tmp = new Float32Array(out);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const isBorder = x === 0 || x === 255 || y === 0 || y === 255;
        const v = tmp[y * 256 + x];
        let count = 0;
        for (let oy = -radius; oy <= radius; oy++) {
          const ny = y + oy;
          if (ny < 0 || ny > 255) continue;
          for (let ox = -radius; ox <= radius; ox++) {
            if (Math.abs(ox) !== radius && Math.abs(oy) !== radius) continue;
            const nx = x + ox;
            if (nx < 0 || nx > 255) continue;
            ringBuf[count++] = tmp[ny * 256 + nx];
          }
        }
        if (count < 5) continue;
        const view = ringBuf.subarray(0, count);
        view.sort();
        const med = view[Math.floor(count * 0.5)];
        const upper = view[Math.min(count - 1, Math.floor(count * 0.82))];
        const lower = view[Math.max(0, Math.floor(count * 0.18))];

        const hDiff = isBorder ? 22 : highDiff;
        const mDiff = isBorder ? 30 : medDiff;

        if (v - upper > hDiff && v - med > mDiff) {
          out[y * 256 + x] = med + Math.min(4, Math.max(0, upper - med) * 0.5);
        } else if (lower - v > hDiff && med - v > mDiff) {
          out[y * 256 + x] = med - Math.min(4, Math.max(0, med - lower) * 0.5);
        }
      }
    }
  };

  // Pass 1 (7x7 outer ring) removes 1-3px ringing clusters & DSM spires; Pass 2 (5x5 ring) cleans residual edges
  runRingPass(3, 10, 15);
  runRingPass(2, 9, 13);

  if (clampOceanFloor) {
    for (let i = 0; i < out.length; i++) {
      if (out[i] < -8) out[i] = -8;
    }
  }
  return out;
}

/**
 * Downsamples a 256x256 DEM tile into a gridSize x gridSize row-major elevation array (meters)
 * using trimmed-mean box filtering over interior cells and 1D trimmed filtering along tile borders
 * so adjacent tiles stitch identically at shared edges without aliasing sub-grid bumps into pyramids.
 */
export function sampleTileAreaFiltered(tile: Float32Array, gridSize: number): number[] {
  const out = new Array<number>(gridSize * gridSize);
  const stepPx = 255 / Math.max(1, gridSize - 1);
  const halfWin = clamp(Math.floor(stepPx * 0.45), 1, 3);
  const samples: number[] = [];

  for (let r = 0; r < gridSize; r++) {
    const cy = Math.round((r / (gridSize - 1)) * 255);
    const ry = r === 0 || r === gridSize - 1 ? 0 : halfWin;
    for (let c = 0; c < gridSize; c++) {
      const cx = Math.round((c / (gridSize - 1)) * 255);
      const rx = c === 0 || c === gridSize - 1 ? 0 : halfWin;

      if (rx === 0 && ry === 0) {
        out[r * gridSize + c] = Number((tile[cy * 256 + cx] ?? 0).toFixed(1));
        continue;
      }

      samples.length = 0;
      const y0 = Math.max(0, cy - ry);
      const y1 = Math.min(255, cy + ry);
      const x0 = Math.max(0, cx - rx);
      const x1 = Math.min(255, cx + rx);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          samples.push(tile[yy * 256 + xx] ?? 0);
        }
      }
      samples.sort((a, b) => a - b);
      const lo = Math.floor(samples.length * 0.25);
      const hi = Math.max(lo + 1, Math.ceil(samples.length * 0.75));
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += samples[i];
      out[r * gridSize + c] = Number((sum / (hi - lo)).toFixed(1));
    }
  }

  return out;
}

/**
 * Downsamples a stitched 2x2 array of 256x256 DEM tiles ([tl, tr, bl, br]) into a gridSize x gridSize
 * elevation array using trimmed footprint filtering.
 */
export function sampleStitchedTilesAreaFiltered(tiles: Float32Array[], gridSize: number): number[] {
  const out = new Array<number>(gridSize * gridSize);
  const stepPx = 511 / Math.max(1, gridSize - 1);
  const halfWin = clamp(Math.floor(stepPx * 0.45), 1, 3);
  const samples: number[] = [];

  const readStitched = (ix: number, iy: number): number => {
    const cx = clamp(ix, 0, 511);
    const cy = clamp(iy, 0, 511);
    const tileCol = cx >= 256 ? 1 : 0;
    const tileRow = cy >= 256 ? 1 : 0;
    const lx = cx - tileCol * 256;
    const ly = cy - tileRow * 256;
    return tiles[tileRow * 2 + tileCol]?.[ly * 256 + lx] ?? 0;
  };

  for (let r = 0; r < gridSize; r++) {
    const cy = Math.round((r / (gridSize - 1)) * 511);
    const ry = r === 0 || r === gridSize - 1 ? 0 : halfWin;
    for (let c = 0; c < gridSize; c++) {
      const cx = Math.round((c / (gridSize - 1)) * 511);
      const rx = c === 0 || c === gridSize - 1 ? 0 : halfWin;

      if (rx === 0 && ry === 0) {
        out[r * gridSize + c] = Number(readStitched(cx, cy).toFixed(1));
        continue;
      }

      samples.length = 0;
      const y0 = Math.max(0, cy - ry);
      const y1 = Math.min(511, cy + ry);
      const x0 = Math.max(0, cx - rx);
      const x1 = Math.min(511, cx + rx);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          samples.push(readStitched(xx, yy));
        }
      }
      samples.sort((a, b) => a - b);
      const lo = Math.floor(samples.length * 0.25);
      const hi = Math.max(lo + 1, Math.ceil(samples.length * 0.75));
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += samples[i];
      out[r * gridSize + c] = Number((sum / (hi - lo)).toFixed(1));
    }
  }

  return out;
}

/**
 * Suppresses isolated 1-vertex pyramids or pits on an elevation grid relative to its 2nd-highest
 * and 2nd-lowest 8-neighbors, leaving continuous ridges (which have >= 2 high neighbors) intact.
 */
export function despikeElevationGrid(elevationsM: number[], rows: number, cols: number): number[] {
  if (rows < 3 || cols < 3 || elevationsM.length < rows * cols) return elevationsM;
  const out = [...elevationsM];
  const n8 = new Float32Array(8);

  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const v = elevationsM[r * cols + c];
      let k = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          n8[k++] = elevationsM[(r + oy) * cols + (c + ox)];
        }
      }
      n8.sort();
      const secondHighest = n8[6];
      const secondLowest = n8[1];
      if (v > secondHighest + 7) {
        out[r * cols + c] = Number((secondHighest + 1.5).toFixed(1));
      } else if (v < secondLowest - 7) {
        out[r * cols + c] = Number((secondLowest - 1.5).toFixed(1));
      }
    }
  }

  return out;
}

/**
 * Ray-casting 2D point-in-polygon test in normalized [u, v] tile coordinates.
 */
export function isPointInPolygon2D(u: number, v: number, ring: Array<[number, number]>): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = (yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Tests whether (u, v) lies inside an MVT polygon's outer ring while excluding any interior island holes.
 */
export function isPointInWaterFeatureRings(
  u: number,
  v: number,
  rings: Array<Array<[number, number]>>
): boolean {
  if (rings.length === 0 || !isPointInPolygon2D(u, v, rings[0])) {
    return false;
  }
  for (let h = 1; h < rings.length; h++) {
    if (isPointInPolygon2D(u, v, rings[h])) {
      return false;
    }
  }
  return true;
}

/**
 * Returns true if (u, v) falls inside any MVT 'ocean' polygon in the tile.
 */
export function isPointInOceanWaterFeatures(
  u: number,
  v: number,
  waterFeatures: TerrainWaterFeature[]
): boolean {
  for (let i = 0; i < waterFeatures.length; i++) {
    const wf = waterFeatures[i];
    if (wf.isPolygon && wf.kind === 'ocean' && isPointInWaterFeatureRings(u, v, wf.rings)) {
      return true;
    }
  }
  return false;
}

/**
 * Depresses shoreline/channel DEM vertices that fall inside crisp MVT 'ocean' polygons when
 * coarse 30m Terrarium DSM/DEM smears adjacent seawalls/hills above sea level (e.g. +0.7m..+3.5m
 * inside narrow harbor channels and pier slips), while preserving real coastal cliffs (> maxCarveElevM).
 */
export function carveCoastalWaterElevations(
  elevationsM: number[],
  rows: number,
  cols: number,
  waterFeatures: TerrainWaterFeature[],
  maxCarveElevM = 32.0,
  carvedDepthM = -4.5
): number[] {
  if (rows < 2 || cols < 2 || elevationsM.length < rows * cols) return elevationsM;
  const oceanPolys = waterFeatures.filter((wf) => wf.isPolygon && wf.kind === 'ocean' && wf.rings.length > 0);
  if (oceanPolys.length === 0) return elevationsM;

  const inOcean = new Uint8Array(rows * cols);
  const out = [...elevationsM];
  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const u = c / (cols - 1);
      for (let k = 0; k < oceanPolys.length; k++) {
        if (isPointInWaterFeatureRings(u, v, oceanPolys[k].rings)) {
          inOcean[idx] = 1;
          const elev = out[idx] ?? 0;
          if (elev <= maxCarveElevM && elev > carvedDepthM) {
            out[idx] = Math.min(elev, carvedDepthM);
          }
          break;
        }
      }
    }
  }

  // Soften 1-ring low coastal seawall/quay/pier vertices (0.5m..7.5m smeared by 30m Terrarium DSM)
  // immediately adjacent to carved ocean cells so interpolated terrain triangles do not poke above seaY inside narrow slips.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (inOcean[idx]) continue;
      const elev = out[idx] ?? 0;
      if (elev <= 1.2 || elev > 7.5) continue;

      let touchesOcean = false;
      for (let dr = -1; dr <= 1 && !touchesOcean; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          if (inOcean[rr * cols + cc]) {
            touchesOcean = true;
            break;
          }
        }
      }
      if (touchesOcean) {
        out[idx] = Number((1.2 + (elev - 1.2) * 0.25).toFixed(1));
      }
    }
  }

  return out;
}


