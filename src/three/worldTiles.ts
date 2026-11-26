import * as THREE from 'three';
import {
  latLngToCartesian,
  latToTileY,
  lngToTileX,
  tileXToLng,
  tileYToLat,
} from '../shared/geo.ts';
import type { GlobeTextureMode } from '../shared/types.ts';
import { applyRegionalTileTerminatorShader, type GlobeSolarUniforms } from './shaders.ts';

function getTileUrl(mode: GlobeTextureMode, z: number, x: number, y: number): string {
  if (mode === 'satellite' || mode === 'godseye') {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  }
  if (mode === 'thermal') {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
  }
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

function getLabelOverlayUrl(mode: GlobeTextureMode, z: number, x: number, y: number): string | null {
  if (mode === 'satellite' || mode === 'godseye') {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`;
  }
  if (mode === 'thermal') {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/${z}/${y}/${x}`;
  }
  return null;
}

function loadCorsImage(url: string, timeoutMs = 12_000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    let settled = false;
    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      img.src = '';
      reject(new Error(`Tile timed out: ${url}`));
    }, timeoutMs);
    img.onload = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Tile failed: ${url}`));
    };
    img.src = url;
  });
}

/**
 * Applies crisp luminance-preserving spectral cyan grading for God's Eye globe tiles
 * so glaciers, mountain ridges, coastlines, rivers, and roads remain razor-sharp.
 */
function applySpectralTintRect(
  ctx: CanvasRenderingContext2D,
  mode: GlobeTextureMode,
  x: number,
  y: number,
  w: number,
  h: number
) {
  if (mode === 'godseye') {
    ctx.save();
    ctx.globalCompositeOperation = 'color';
    ctx.fillStyle = 'rgba(14, 165, 233, 0.56)';
    ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(165, 215, 240, 0.88)';
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  } else if (mode === 'thermal') {
    ctx.save();
    ctx.fillStyle = 'rgba(6, 12, 24, 0.44)';
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
}

const MAX_PLANETARY_CANVAS_CACHE = 2;
const planetaryCanvasCache = new Map<GlobeTextureMode, HTMLCanvasElement>();

function disposeCachedCanvas(canvas: HTMLCanvasElement | undefined) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function disposeTextureAndCanvas(tex: THREE.Texture | undefined) {
  if (!tex) return;
  tex.dispose();
  const img = tex.image as HTMLCanvasElement | undefined;
  if (img && typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) {
    disposeCachedCanvas(img);
  }
}

let placeholderProbeCanvas: HTMLCanvasElement | null = null;
let placeholderProbeCtx: CanvasRenderingContext2D | null = null;

/**
 * Detects Esri World_Imagery "Map data not yet available" gray placeholder JPEGs
 * (flat grayscale #cccccc with faint gray centered text) so street-level zoom
 * can seamlessly sub-crop crisp native z=18/z=17 parent imagery instead.
 */
export function isEsriPlaceholderImage(img: HTMLImageElement): boolean {
  try {
    if (!placeholderProbeCanvas) {
      placeholderProbeCanvas = document.createElement('canvas');
      placeholderProbeCanvas.width = 32;
      placeholderProbeCanvas.height = 32;
      placeholderProbeCtx = placeholderProbeCanvas.getContext('2d', {
        willReadFrequently: true,
      });
    }
    if (!placeholderProbeCtx) return false;
    placeholderProbeCtx.drawImage(img, 0, 0, 32, 32);
    const { data } = placeholderProbeCtx.getImageData(0, 0, 32, 32);
    let grayCount = 0;
    let minL = 255;
    let maxL = 0;
    let samples = 0;
    for (let y = 2; y < 32; y += 2) {
      for (let x = 2; x < 32; x += 2) {
        const i = (y * 32 + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const diff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
        const luma = (r + g + b) / 3;
        if (diff <= 8) grayCount++;
        if (luma < minL) minL = luma;
        if (luma > maxL) maxL = luma;
        samples++;
      }
    }
    return grayCount / samples > 0.96 && minL > 135 && maxL - minL < 75;
  } catch {
    return false;
  }
}

/**
 * Re-projects a z=2 -> z=3 Mercator tile grid onto an equirectangular CanvasTexture
 * so real-world satellite, holographic spectral, dark thermal, and street map imagery
 * wrap crisply across the entire planet.
 */
export async function streamPlanetaryTilesIntoCanvas(
  mode: GlobeTextureMode,
  canvas: HTMLCanvasElement,
  texture: THREE.CanvasTexture,
  isCancelled: () => boolean,
  onFrameDirty: () => void
): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const cachedPlanetary = planetaryCanvasCache.get(mode);
  if (cachedPlanetary) {
    planetaryCanvasCache.delete(mode);
    planetaryCanvasCache.set(mode, cachedPlanetary);
    ctx.drawImage(cachedPlanetary, 0, 0, canvas.width, canvas.height);
    texture.needsUpdate = true;
    onFrameDirty();
    return;
  }

  const w = canvas.width;
  const h = canvas.height;
  const zoom = 2;

  const drawTileSet = async (zLevel: number) => {
    const count = Math.pow(2, zLevel);
    const coords: Array<{ tx: number; ty: number }> = [];
    for (let ty = 0; ty < count; ty++) {
      for (let tx = 0; tx < count; tx++) {
        coords.push({ tx, ty });
      }
    }

    let lastUploadMs = performance.now();
    let cursor = 0;
    const workerCount = zLevel <= 2 ? 8 : 6;

    const runWorker = async () => {
      while (cursor < coords.length && !isCancelled()) {
        const { tx, ty } = coords[cursor++];
        try {
          const baseImg = await loadCorsImage(getTileUrl(mode, zLevel, tx, ty));
          if (isCancelled()) return;

          const westLng = tileXToLng(tx, zLevel);
          const eastLng = tileXToLng(tx + 1, zLevel);
          const dx = ((westLng + 180) / 360) * w;
          const dw = ((eastLng - westLng) / 360) * w + 0.6;

          const strips = 4;
          for (let s = 0; s < strips; s++) {
            const f0 = s / strips;
            const f1 = (s + 1) / strips;
            const northLat = ty === 0 && s === 0 ? 90 : tileYToLat(ty + f0, zLevel);
            const southLat = ty === count - 1 && s === strips - 1 ? -90 : tileYToLat(ty + f1, zLevel);

            const sy = f0 * baseImg.height;
            const sh = (f1 - f0) * baseImg.height;
            const dy = ((90 - northLat) / 180) * h;
            const dh = ((northLat - southLat) / 180) * h + 0.6;

            ctx.drawImage(baseImg, 0, sy, baseImg.width, sh, dx, dy, dw, dh);
            applySpectralTintRect(ctx, mode, dx, dy, dw, dh);
          }

          if (zLevel >= 3) {
            const now = performance.now();
            if (now - lastUploadMs >= 320) {
              lastUploadMs = now;
              texture.needsUpdate = true;
              onFrameDirty();
            }
          }
        } catch {
          // Keep procedural continent layer intact for any failed tile
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    if (!isCancelled()) {
      texture.needsUpdate = true;
      onFrameDirty();
    }
  };

  if (zoom > 0) {
    await drawTileSet(2);
    if (!isCancelled()) {
      await drawTileSet(3);
      if (!isCancelled()) {
        if (planetaryCanvasCache.size >= MAX_PLANETARY_CANVAS_CACHE) {
          const oldest = planetaryCanvasCache.keys().next().value;
          if (oldest) {
            disposeCachedCanvas(planetaryCanvasCache.get(oldest));
            planetaryCanvasCache.delete(oldest);
          }
        }
        const snapW = Math.min(2048, w);
        const snapH = Math.min(1024, h);
        const snapshot = document.createElement('canvas');
        snapshot.width = snapW;
        snapshot.height = snapH;
        snapshot.getContext('2d')?.drawImage(canvas, 0, 0, snapW, snapH);
        planetaryCanvasCache.set(mode, snapshot);
      }
    }
  }
}

const MAX_SECTOR_CANVAS_CACHE = 4;
const sectorCanvasCache = new Map<string, HTMLCanvasElement>();

/**
 * Progressively renders real Mercator imagery (z=14 fast base -> z=15 crisp detail)
 * aligned pixel-for-pixel to a 2x2 z=14 RealTerrain tile window.
 */
export async function streamSectorTextureIntoCanvas(
  mode: GlobeTextureMode,
  tileSpan: { minTx: number; maxTx: number; minTy: number; maxTy: number },
  baseZoom: number,
  canvas: HTMLCanvasElement,
  texture: THREE.CanvasTexture,
  isCancelled: () => boolean,
  onDirty: () => void
): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const effectiveMode = mode === 'godseye' ? 'satellite' : mode;
  const cacheKey = `${effectiveMode}/${baseZoom}/${tileSpan.minTx}/${tileSpan.minTy}/${canvas.width}`;
  const cached = sectorCanvasCache.get(cacheKey);
  if (cached) {
    ctx.drawImage(cached, 0, 0, canvas.width, canvas.height);
    texture.needsUpdate = true;
    onDirty();
    return;
  }

  ctx.fillStyle = '#0d1526';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.14)';
  ctx.lineWidth = 1;
  const step = canvas.width / 8;
  for (let i = 1; i < 8; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, canvas.height);
    ctx.moveTo(0, i * step);
    ctx.lineTo(canvas.width, i * step);
    ctx.stroke();
  }
  texture.needsUpdate = true;
  onDirty();

  const w = canvas.width;
  const h = canvas.height;

  const drawPass = async (subDivide: 1 | 2) => {
    const z = baseZoom + (subDivide === 2 ? 1 : 0);
    const n = Math.pow(2, z);
    const gridCount = 2 * subDivide;
    const cellW = w / gridCount;
    const cellH = h / gridCount;

    const tasks: Array<{ gx: number; gy: number; tx: number; ty: number }> = [];
    for (let gy = 0; gy < gridCount; gy++) {
      for (let gx = 0; gx < gridCount; gx++) {
        const tx = ((tileSpan.minTx * subDivide + gx) % n + n) % n;
        const ty = Math.max(0, Math.min(n - 1, tileSpan.minTy * subDivide + gy));
        tasks.push({ gx, gy, tx, ty });
      }
    }

    await Promise.all(
      tasks.map(async ({ gx, gy, tx, ty }) => {
        if (isCancelled()) return;
        const fetchZ = effectiveMode === 'thermal' ? Math.min(15, z) : z;
        const url = getTileUrl(effectiveMode, fetchZ, tx, ty);
        try {
          const img = await loadCorsImage(url);
          if (isCancelled()) return;
          if (effectiveMode === 'satellite' && z >= 15 && isEsriPlaceholderImage(img)) {
            return;
          }

          const dx = gx * cellW;
          const dy = gy * cellH;
          ctx.drawImage(img, dx, dy, cellW + 0.5, cellH + 0.5);
          if (effectiveMode === 'thermal') {
            applySpectralTintRect(ctx, 'thermal', dx, dy, cellW + 0.5, cellH + 0.5);
          }

          if (effectiveMode !== 'topo' && z <= 14) {
            const labelUrl = getLabelOverlayUrl(effectiveMode, z, tx, ty);
            if (labelUrl) {
              try {
                const lbl = await loadCorsImage(labelUrl);
                if (!isCancelled()) {
                  ctx.drawImage(lbl, dx, dy, cellW + 0.5, cellH + 0.5);
                }
              } catch {
                // Labels optional
              }
            }
          }
        } catch {
          // Keep coarser pass intact
        }
      })
    );

    if (!isCancelled()) {
      texture.needsUpdate = true;
      onDirty();
    }
  };

  await drawPass(1);
  if (isCancelled()) return;
  await drawPass(2);
  if (isCancelled()) return;

  if (sectorCanvasCache.size >= MAX_SECTOR_CANVAS_CACHE) {
    const oldest = sectorCanvasCache.keys().next().value;
    if (oldest) {
      disposeCachedCanvas(sectorCanvasCache.get(oldest));
      sectorCanvasCache.delete(oldest);
    }
  }
  const snapshot = document.createElement('canvas');
  snapshot.width = w;
  snapshot.height = h;
  snapshot.getContext('2d')?.drawImage(canvas, 0, 0);
  sectorCanvasCache.set(cacheKey, snapshot);
}

const MAX_SINGLE_CHUNK_CANVAS_CACHE = 12;
const singleChunkCanvasCache = new Map<string, HTMLCanvasElement>();

export function trimTileCanvasCaches() {
  for (const canvas of sectorCanvasCache.values()) {
    disposeCachedCanvas(canvas);
  }
  sectorCanvasCache.clear();
  for (const canvas of singleChunkCanvasCache.values()) {
    disposeCachedCanvas(canvas);
  }
  singleChunkCanvasCache.clear();
}

/**
 * Progressively draws crisp imagery for a SINGLE Mercator terrain chunk (z, tx, ty):
 * - z === 14 + highResSubdivide: z=14 base -> crisp 2x2 z=15 sub-tiles (512px)
 * - z === 12 + highResSubdivide: z=12 base -> crisp 2x2 z=13 sub-tiles (512px) for sharp 48km mountains
 * - Shares crisp un-washed Esri imagery between 'satellite' & 'godseye' so GLSL handles HDR hologram blending!
 */
export async function streamSingleTileTextureIntoCanvas(
  mode: GlobeTextureMode,
  z: number,
  tx: number,
  ty: number,
  canvas: HTMLCanvasElement,
  texture: THREE.CanvasTexture,
  highResSubdivide: boolean,
  isCancelled: () => boolean,
  onDirty: () => void
): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const effectiveMode = mode === 'godseye' ? 'satellite' : mode;
  const cacheKey = `${effectiveMode}/${z}/${tx}/${ty}/${canvas.width}/${highResSubdivide ? 2 : 1}`;
  const cached = singleChunkCanvasCache.get(cacheKey);
  if (cached) {
    singleChunkCanvasCache.delete(cacheKey);
    singleChunkCanvasCache.set(cacheKey, cached);
    ctx.drawImage(cached, 0, 0, canvas.width, canvas.height);
    texture.needsUpdate = true;
    onDirty();
    return;
  }

  ctx.fillStyle = '#0a1220';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(34, 211, 238, 0.16)';
  ctx.lineWidth = 1;
  const step = canvas.width / 4;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, canvas.height);
    ctx.moveTo(0, i * step);
    ctx.lineTo(canvas.width, i * step);
    ctx.stroke();
  }
  texture.needsUpdate = true;

  try {
    const baseImg = await loadCorsImage(getTileUrl(effectiveMode, z, tx, ty));
    if (isCancelled()) return;
    ctx.drawImage(baseImg, 0, 0, canvas.width, canvas.height);
    if (effectiveMode === 'thermal') {
      applySpectralTintRect(ctx, 'thermal', 0, 0, canvas.width, canvas.height);
    }
    texture.needsUpdate = true;
    onDirty();
  } catch {
    return;
  }

  if (highResSubdivide && (z === 14 || z === 12) && effectiveMode !== 'thermal') {
    const subZ = z + 1;
    const subN = Math.pow(2, subZ);
    const halfW = canvas.width / 2;
    const halfH = canvas.height / 2;
    await Promise.all(
      [0, 1, 2, 3].map(async (idx) => {
        if (isCancelled()) return;
        const gx = idx % 2;
        const gy = Math.floor(idx / 2);
        const stx = ((tx * 2 + gx) % subN + subN) % subN;
        const sty = Math.max(0, Math.min(subN - 1, ty * 2 + gy));
        try {
          const img = await loadCorsImage(getTileUrl(effectiveMode, subZ, stx, sty));
          if (isCancelled()) return;
          if (effectiveMode === 'satellite' && subZ >= 15 && isEsriPlaceholderImage(img)) {
            return;
          }
          ctx.drawImage(img, gx * halfW, gy * halfH, halfW + 0.5, halfH + 0.5);
        } catch {
          // Preserve crisp parent quadrant
        }
      })
    );
    if (!isCancelled()) {
      texture.needsUpdate = true;
      onDirty();
    }
  }

  if (!isCancelled()) {
    if (singleChunkCanvasCache.size >= MAX_SINGLE_CHUNK_CANVAS_CACHE) {
      const oldest = singleChunkCanvasCache.keys().next().value;
      if (oldest) {
        disposeCachedCanvas(singleChunkCanvasCache.get(oldest));
        singleChunkCanvasCache.delete(oldest);
      }
    }
    const snap = document.createElement('canvas');
    snap.width = canvas.width;
    snap.height = canvas.height;
    snap.getContext('2d')?.drawImage(canvas, 0, 0);
    singleChunkCanvasCache.set(cacheKey, snap);
  }
}

/**
 * Builds an exact curved spherical mesh patch matching a Web Mercator tile (tx, ty, z),
 * centered relative to its tile center (RTC) so Float32 WebGL rendering has zero jitter at z=19 (~80m).
 */
export function buildSphericalTileGeometry(
  tx: number,
  ty: number,
  zoom: number,
  radius: number,
  segs = 6
): { geometry: THREE.BufferGeometry; center: THREE.Vector3 } {
  const westLng = tileXToLng(tx, zoom);
  const eastLng = tileXToLng(tx + 1, zoom);
  const centerLat = tileYToLat(ty + 0.5, zoom);
  const centerLng = (westLng + eastLng) * 0.5;
  const centerPos = latLngToCartesian(centerLat, centerLng, radius);
  const center = new THREE.Vector3(centerPos.x, centerPos.y, centerPos.z);

  const stride = segs + 1;
  const positions = new Float32Array(stride * stride * 3);
  const uvs = new Float32Array(stride * stride * 2);
  const indices: number[] = [];

  for (let iv = 0; iv <= segs; iv++) {
    const v = iv / segs;
    const lat = tileYToLat(ty + (1 - v), zoom);
    for (let iu = 0; iu <= segs; iu++) {
      const u = iu / segs;
      const lng = westLng + u * (eastLng - westLng);
      const p = latLngToCartesian(lat, lng, radius);

      const idx = iv * stride + iu;
      positions[idx * 3] = p.x - center.x;
      positions[idx * 3 + 1] = p.y - center.y;
      positions[idx * 3 + 2] = p.z - center.z;

      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v;
    }
  }

  for (let iv = 0; iv < segs; iv++) {
    for (let iu = 0; iu < segs; iu++) {
      const a = iv * stride + iu;
      const b = iv * stride + (iu + 1);
      const c = (iv + 1) * stride + iu;
      const d = (iv + 1) * stride + (iu + 1);
      indices.push(a, b, d, a, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, center };
}

export function getTileZoomForAltitude(altitude: number, mode: GlobeTextureMode): number {
  let zoom = 0;
  if (altitude < 0.00042) zoom = 19;
  else if (altitude < 0.00095) zoom = 18;
  else if (altitude < 0.0022) zoom = 17;
  else if (altitude < 0.0055) zoom = 16;
  else if (altitude < 0.013) zoom = 15;
  else if (altitude < 0.032) zoom = 14;
  else if (altitude < 0.085) zoom = 13;
  else if (altitude < 0.28) zoom = 11;
  else if (altitude < 0.95) zoom = 9;
  else if (altitude < 2.6) zoom = 7;
  else if (altitude < 8.5) zoom = 5;
  else if (altitude < 16.5) zoom = 4;

  if (mode === 'thermal' && zoom > 16) {
    return 16;
  }
  return zoom;
}

interface DesiredTileSpec {
  key: string;
  zoom: number;
  tx: number;
  ty: number;
  radius: number;
  segs: number;
  renderOrder: number;
  priority: number;
}

const MAX_CONCURRENT_TILE_LOADS = 20;

/**
 * Manages live two-layer spherical regional tile patches (backdrop + ultra-deep street detail z=5..19)
 * on the 3D globe with a center-first, concurrency-capped queue.
 */
export class GlobeRegionalTileManager {
  public readonly group = new THREE.Group();
  private textureCache = new Map<string, THREE.Texture>();
  private rawParentCache = new Map<string, HTMLImageElement>();
  private loadingKeys = new Set<string>();
  private pendingQueue: DesiredTileSpec[] = [];
  private queuedKeys = new Set<string>();
  private prefetchedKeys = new Set<string>();
  private activeMeshes = new Map<string, THREE.Mesh>();
  private desiredSpecs = new Map<string, DesiredTileSpec>();
  private activeZoom = -1;
  private activeCenterTx = -1;
  private activeCenterTy = -1;
  private activeMode: GlobeTextureMode = 'satellite';
  private modeEpoch = 0;
  private maxAnisotropy: number;
  private globeRadius: number;
  private onDirty: () => void;
  private solarUniforms?: GlobeSolarUniforms;

  constructor(
    globeRadius: number,
    maxAnisotropy: number,
    onDirty: () => void,
    solarUniforms?: GlobeSolarUniforms
  ) {
    this.globeRadius = globeRadius;
    this.maxAnisotropy = maxAnisotropy;
    this.onDirty = onDirty;
    this.solarUniforms = solarUniforms;
  }

  public setMode(mode: GlobeTextureMode) {
    if (this.activeMode === mode) return;
    this.activeMode = mode;
    this.modeEpoch += 1;
    this.clearAllMeshes();
    for (const tex of this.textureCache.values()) {
      disposeTextureAndCanvas(tex);
    }
    this.textureCache.clear();
    this.rawParentCache.clear();
    this.loadingKeys.clear();
    this.pendingQueue = [];
    this.queuedKeys.clear();
    this.prefetchedKeys.clear();
    this.desiredSpecs.clear();
    this.activeZoom = -1;
  }

  public prefetchTarget(lat: number, lng: number, targetDistance: number) {
    const altitude = Math.max(0.00004, targetDistance - this.globeRadius);
    const zoom = getTileZoomForAltitude(altitude, this.activeMode);
    if (zoom < 5) return;

    const enqueueRing = (zLevel: number, _radius: number, renderOrder: number, basePri: number) => {
      const n = Math.pow(2, zLevel);
      const cx = Math.floor(lngToTileX(lng, zLevel));
      const cy = Math.max(0, Math.min(n - 1, Math.floor(latToTileY(lat, zLevel))));
      const segs = zLevel >= 14 ? 1 : zLevel >= 11 ? 2 : 5;

      for (let dy = -1; dy <= 1; dy++) {
        const ty = cy + dy;
        if (ty < 0 || ty >= n) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const tx = ((cx + dx) % n + n) % n;
          const key = `${this.activeMode}/${zLevel}/${tx}/${ty}`;
          if (
            this.textureCache.has(key) ||
            this.loadingKeys.has(key) ||
            this.queuedKeys.has(key)
          ) {
            continue;
          }
          this.prefetchedKeys.add(key);
          this.queuedKeys.add(key);
          this.pendingQueue.push({
            key,
            zoom: zLevel,
            tx,
            ty,
            radius: _radius,
            segs,
            renderOrder,
            priority: basePri + dx * dx + dy * dy,
          });
        }
      }
    };

    if (zoom >= 9) {
      enqueueRing(Math.max(5, zoom - 3), this.globeRadius + 0.000012, 1, -24);
    }
    enqueueRing(zoom, this.globeRadius + 0.000028, 2, -16);
    this.pendingQueue.sort((a, b) => a.priority - b.priority);
    this.pumpQueue();
  }

  private disposeMesh(mesh: THREE.Mesh) {
    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m) => m.dispose());
    } else {
      mesh.material.dispose();
    }
    this.group.remove(mesh);
  }

  private clearAllMeshes() {
    for (const mesh of this.activeMeshes.values()) {
      this.disposeMesh(mesh);
    }
    this.activeMeshes.clear();
  }

  public updateForCamera(
    cameraDistance: number,
    centerLat: number,
    centerLng: number,
    isFastFlight = false
  ): number {
    const altitude = Math.max(0.00004, cameraDistance - this.globeRadius);
    const zoom = getTileZoomForAltitude(altitude, this.activeMode);

    if (zoom === 0) {
      if (this.activeMeshes.size > 0) {
        this.clearAllMeshes();
        this.desiredSpecs.clear();
        this.pendingQueue = [];
        this.queuedKeys.clear();
        this.activeZoom = -1;
      }
      return 0;
    }

    const n = Math.pow(2, zoom);
    const centerTx = Math.floor(lngToTileX(centerLng, zoom));
    const centerTy = Math.max(0, Math.min(n - 1, Math.floor(latToTileY(centerLat, zoom))));

    if (isFastFlight && zoom >= 11) {
      return zoom;
    }

    if (
      zoom === this.activeZoom &&
      centerTx === this.activeCenterTx &&
      centerTy === this.activeCenterTy
    ) {
      return zoom;
    }

    this.activeZoom = zoom;
    this.activeCenterTx = centerTx;
    this.activeCenterTy = centerTy;

    const nextDesired = new Map<string, DesiredTileSpec>();

    const collectLayer = (
      layerZoom: number,
      span: number,
      radius: number,
      segs: number,
      renderOrder: number,
      basePriority: number
    ) => {
      const ln = Math.pow(2, layerZoom);
      const lcx = Math.floor(lngToTileX(centerLng, layerZoom));
      const lcy = Math.max(0, Math.min(ln - 1, Math.floor(latToTileY(centerLat, layerZoom))));

      for (let dy = -span; dy <= span; dy++) {
        const ty = lcy + dy;
        if (ty < 0 || ty >= ln) continue;
        for (let dx = -span; dx <= span; dx++) {
          const tx = ((lcx + dx) % ln + ln) % ln;
          const key = `${this.activeMode}/${layerZoom}/${tx}/${ty}`;
          const dist2 = dx * dx + dy * dy;
          nextDesired.set(key, {
            key,
            zoom: layerZoom,
            tx,
            ty,
            radius,
            segs,
            renderOrder,
            priority: basePriority + dist2,
          });
        }
      }
    };

    const detailRadius =
      zoom <= 5
        ? this.globeRadius + 0.014
        : zoom <= 9
          ? this.globeRadius + 0.005
          : this.globeRadius + 0.000028;

    if (zoom >= 9) {
      const bgZoom = Math.max(5, zoom - 3);
      const bgRadius = detailRadius - (zoom <= 9 ? 0.0025 : 0.000016);
      collectLayer(bgZoom, 1, bgRadius, 5, 1, 6);
    }

    const detailSpan = 2;
    const detailSegs = zoom >= 14 ? 1 : zoom >= 11 ? 2 : zoom >= 7 ? 5 : 8;
    collectLayer(zoom, detailSpan, detailRadius, detailSegs, 2, -2);

    this.desiredSpecs = nextDesired;

    const centerKey = `${this.activeMode}/${zoom}/${centerTx}/${centerTy}`;
    const hasCenterReady =
      this.activeMeshes.has(centerKey) || this.textureCache.has(centerKey);

    for (const [key, mesh] of this.activeMeshes.entries()) {
      if (!nextDesired.has(key)) {
        if (hasCenterReady) {
          this.disposeMesh(mesh);
          this.activeMeshes.delete(key);
        } else {
          mesh.renderOrder = 0;
        }
      }
    }

    this.pendingQueue = this.pendingQueue.filter((s) => this.prefetchedKeys.has(s.key));
    this.queuedKeys.clear();
    for (const s of this.pendingQueue) {
      this.queuedKeys.add(s.key);
    }

    for (const spec of nextDesired.values()) {
      if (this.activeMeshes.has(spec.key)) continue;
      const cachedTex = this.textureCache.get(spec.key);
      if (cachedTex) {
        this.textureCache.delete(spec.key);
        this.textureCache.set(spec.key, cachedTex);
        this.attachTileMesh(spec, cachedTex);
      } else if (!this.loadingKeys.has(spec.key) && !this.queuedKeys.has(spec.key)) {
        this.pendingQueue.push(spec);
        this.queuedKeys.add(spec.key);
      }
    }

    this.pendingQueue.sort((a, b) => a.priority - b.priority);
    this.pumpQueue();

    return zoom;
  }

  private pumpQueue() {
    while (
      this.loadingKeys.size < MAX_CONCURRENT_TILE_LOADS &&
      this.pendingQueue.length > 0
    ) {
      const spec = this.pendingQueue.shift()!;
      this.queuedKeys.delete(spec.key);
      const isPrefetched = this.prefetchedKeys.delete(spec.key);
      if (!this.desiredSpecs.has(spec.key) && !isPrefetched) continue;
      if (this.loadingKeys.has(spec.key) || this.activeMeshes.has(spec.key)) continue;

      this.loadingKeys.add(spec.key);
      void this.fetchCompositeTileTexture(this.activeMode, spec, this.modeEpoch);
    }
  }

  private pruneRetiredMeshesIfCenterLoaded() {
    if (this.activeZoom <= 0) return;
    const centerKey = `${this.activeMode}/${this.activeZoom}/${this.activeCenterTx}/${this.activeCenterTy}`;
    if (!this.activeMeshes.has(centerKey)) return;

    for (const [key, mesh] of this.activeMeshes.entries()) {
      if (!this.desiredSpecs.has(key)) {
        this.disposeMesh(mesh);
        this.activeMeshes.delete(key);
      }
    }
  }

  private async loadRawParent(
    mode: GlobeTextureMode,
    z: number,
    tx: number,
    ty: number
  ): Promise<HTMLImageElement> {
    const k = `${mode}/${z}/${tx}/${ty}`;
    const cached = this.rawParentCache.get(k);
    if (cached) {
      this.rawParentCache.delete(k);
      this.rawParentCache.set(k, cached);
      return cached;
    }
    const img = await loadCorsImage(getTileUrl(mode, z, tx, ty));
    if (this.rawParentCache.size >= 20) {
      const oldest = this.rawParentCache.keys().next().value;
      if (oldest) this.rawParentCache.delete(oldest);
    }
    this.rawParentCache.set(k, img);
    return img;
  }

  private async fetchCompositeTileTexture(
    mode: GlobeTextureMode,
    spec: DesiredTileSpec,
    epoch: number
  ) {
    try {
      const baseImg = await loadCorsImage(getTileUrl(mode, spec.zoom, spec.tx, spec.ty));
      if (epoch !== this.modeEpoch) return;

      let resolvedImg: HTMLImageElement = baseImg;
      let cropDz = 0;

      if ((mode === 'satellite' || mode === 'godseye') && spec.zoom >= 16 && isEsriPlaceholderImage(baseImg)) {
        for (let dz = 1; dz <= 3 && spec.zoom - dz >= 14; dz++) {
          const pz = spec.zoom - dz;
          const ptx = spec.tx >> dz;
          const pty = spec.ty >> dz;
          try {
            const parentImg = await this.loadRawParent(mode, pz, ptx, pty);
            if (epoch !== this.modeEpoch) return;
            if (!isEsriPlaceholderImage(parentImg)) {
              resolvedImg = parentImg;
              cropDz = dz;
              break;
            }
          } catch {
            // Try next coarser parent zoom
          }
        }
      }

      let labelImg: HTMLImageElement | null = null;
      const labelUrl = spec.zoom <= 13 ? getLabelOverlayUrl(mode, spec.zoom, spec.tx, spec.ty) : null;
      if (labelUrl) {
        try {
          labelImg = await loadCorsImage(labelUrl);
          if (epoch !== this.modeEpoch) return;
        } catch {
          labelImg = null;
        }
      }

      if (epoch !== this.modeEpoch) return;

      let tex: THREE.Texture;
      if (mode !== 'thermal' && mode !== 'godseye' && cropDz === 0 && !labelImg) {
        tex = new THREE.Texture(resolvedImg);
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d')!;
        if (cropDz > 0) {
          const scale = 1 << cropDz;
          const subX = spec.tx & (scale - 1);
          const subY = spec.ty & (scale - 1);
          const sw = resolvedImg.width / scale;
          const sh = resolvedImg.height / scale;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(resolvedImg, subX * sw, subY * sh, sw, sh, 0, 0, 256, 256);
        } else {
          ctx.drawImage(resolvedImg, 0, 0, 256, 256);
        }
        applySpectralTintRect(ctx, mode, 0, 0, 256, 256);
        if (labelImg) {
          ctx.drawImage(labelImg, 0, 0, 256, 256);
        }
        tex = new THREE.CanvasTexture(canvas);
      }

      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = this.maxAnisotropy;
      tex.needsUpdate = true;

      if (this.textureCache.size >= 96) {
        const oldestKey = this.textureCache.keys().next().value;
        if (oldestKey) {
          disposeTextureAndCanvas(this.textureCache.get(oldestKey));
          this.textureCache.delete(oldestKey);
        }
      }

      this.textureCache.set(spec.key, tex);
      this.loadingKeys.delete(spec.key);

      const currentSpec = this.desiredSpecs.get(spec.key);
      if (this.activeMode === mode && currentSpec && !this.activeMeshes.has(spec.key)) {
        this.attachTileMesh(currentSpec, tex);
        this.pruneRetiredMeshesIfCenterLoaded();
        this.onDirty();
      }
    } catch {
      if (epoch === this.modeEpoch) {
        this.loadingKeys.delete(spec.key);
      }
    } finally {
      if (epoch === this.modeEpoch) {
        this.pumpQueue();
      }
    }
  }

  private attachTileMesh(spec: DesiredTileSpec, tex: THREE.Texture) {
    const { geometry, center } = buildSphericalTileGeometry(
      spec.tx,
      spec.ty,
      spec.zoom,
      spec.radius,
      spec.segs
    );
    const commonOffset = {
      map: tex,
      polygonOffset: true,
      polygonOffsetFactor: -spec.renderOrder,
      polygonOffsetUnits: -spec.renderOrder,
    };
    const mat =
      spec.zoom <= 9
        ? new THREE.MeshStandardMaterial({
            ...commonOffset,
            roughness: 0.9,
            metalness: 0.05,
            envMapIntensity: 0.3,
          })
        : new THREE.MeshBasicMaterial({
            ...commonOffset,
            toneMapped: false,
          });
    if (mat instanceof THREE.MeshStandardMaterial && this.solarUniforms) {
      applyRegionalTileTerminatorShader(mat, this.solarUniforms);
    }
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.copy(center);
    mesh.renderOrder = spec.renderOrder;
    this.group.add(mesh);
    this.activeMeshes.set(spec.key, mesh);
  }

  public dispose() {
    this.modeEpoch += 1;
    this.clearAllMeshes();
    for (const tex of this.textureCache.values()) {
      disposeTextureAndCanvas(tex);
    }
    this.textureCache.clear();
    this.rawParentCache.clear();
    this.loadingKeys.clear();
    this.pendingQueue = [];
    this.queuedKeys.clear();
    this.prefetchedKeys.clear();
    this.desiredSpecs.clear();
  }
}
