import * as THREE from 'three';
import { clamp } from './geo.ts';
import {
  isKnownBelowSeaBasin,
  isPointInOceanWaterFeatures,
  isPointInWaterFeatureRings,
  sampleElevationGrid,
} from './terrainMath.ts';
import type {
  TerrainBuildingFootprint,
  TerrainChunkPayload,
  TerrainRoadPolyline,
  TerrainWaterFeature,
} from './types.ts';

export const ARCH_BASE_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0.16, 0.17, 0.20], // Architectural concrete
  [0.24, 0.20, 0.16], // Warm limestone / travertine
  [0.14, 0.17, 0.21], // Slate stone
  [0.26, 0.16, 0.14], // Terracotta / brick
  [0.23, 0.21, 0.17], // Sandstone / ochre stucco
  [0.13, 0.14, 0.16], // Basalt / charcoal
];

export const ARCH_ROOF_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0.32, 0.34, 0.38],
  [0.42, 0.37, 0.31],
  [0.27, 0.32, 0.38],
  [0.44, 0.27, 0.22], // Terracotta gable roof
  [0.39, 0.35, 0.29],
  [0.25, 0.27, 0.31],
];

export interface RawIndexedBuffers {
  pos: Float32Array;
  norm: Int8Array | Float32Array;
  col: Uint8Array | Float32Array;
  uv?: Float32Array;
  index: Uint16Array | Uint32Array;
  vertexCount: number;
  indexCount: number;
}

export function estimateRawBuffersByteLength(raw: RawIndexedBuffers | null): number {
  if (!raw) return 0;
  return (
    raw.pos.byteLength +
    raw.norm.byteLength +
    raw.col.byteLength +
    (raw.uv ? raw.uv.byteLength : 0) +
    raw.index.byteLength
  );
}

export interface ChunkGeometryBuildInput {
  payload: TerrainChunkPayload;
  baseElevationM: number;
  metersToSceneY: number;
  chunkWidth: number;
  chunkDepth: number;
  verticalExaggeration: number;
  seedOffset: number;
  includeHoles: boolean;
  includeRoadsAndWater: boolean;
  includeWater?: boolean;
  skipWater?: boolean;
}

export interface ChunkGeometryBuildOutput {
  stdGeo: RawIndexedBuffers | null;
  towerGeo: RawIndexedBuffers | null;
  roadsGeo: RawIndexedBuffers | null;
  waterGeo: RawIndexedBuffers | null;
  builtCount: number;
}

export class IndexedTypedGeometryBuilder {
  private pos: Float32Array;
  private norm: Int8Array | Float32Array;
  private col: Uint8Array | Float32Array;
  private uv: Float32Array | null;
  private indices: Uint32Array;
  private compact: boolean;
  private vCount = 0;
  private vCap: number;
  private iCount = 0;
  private iCap: number;

  constructor(initialVertices = 2048, withUv = false, compact = true) {
    this.vCap = Math.max(256, initialVertices);
    this.iCap = Math.max(512, Math.floor(this.vCap * 1.5));
    this.compact = compact;
    this.pos = new Float32Array(this.vCap * 3);
    this.norm = compact ? new Int8Array(this.vCap * 3) : new Float32Array(this.vCap * 3);
    this.col = compact ? new Uint8Array(this.vCap * 3) : new Float32Array(this.vCap * 3);
    this.uv = withUv ? new Float32Array(this.vCap * 2) : null;
    this.indices = new Uint32Array(this.iCap);
  }

  public ensureVerts(extraVertices: number) {
    const needed = this.vCount + extraVertices;
    if (needed <= this.vCap) return;
    let nextCap = this.vCap;
    while (nextCap < needed) nextCap *= 2;

    const nextPos = new Float32Array(nextCap * 3);
    nextPos.set(this.pos.subarray(0, this.vCount * 3));
    this.pos = nextPos;

    const nextNorm = this.compact ? new Int8Array(nextCap * 3) : new Float32Array(nextCap * 3);
    nextNorm.set(this.norm.subarray(0, this.vCount * 3));
    this.norm = nextNorm;

    const nextCol = this.compact ? new Uint8Array(nextCap * 3) : new Float32Array(nextCap * 3);
    nextCol.set(this.col.subarray(0, this.vCount * 3));
    this.col = nextCol;

    if (this.uv) {
      const nextUv = new Float32Array(nextCap * 2);
      nextUv.set(this.uv.subarray(0, this.vCount * 2));
      this.uv = nextUv;
    }

    this.vCap = nextCap;
  }

  public ensureIndices(extraIndices: number) {
    const needed = this.iCount + extraIndices;
    if (needed <= this.iCap) return;
    let nextCap = this.iCap;
    while (nextCap < needed) nextCap *= 2;
    const nextIdx = new Uint32Array(nextCap);
    nextIdx.set(this.indices.subarray(0, this.iCount));
    this.indices = nextIdx;
    this.iCap = nextCap;
  }

  public pushVertexFast(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    r: number,
    g: number,
    b: number,
    u = 0,
    v = 0
  ): number {
    const idx = this.vCount;
    const i = idx * 3;
    this.pos[i] = x;
    this.pos[i + 1] = y;
    this.pos[i + 2] = z;
    if (this.compact) {
      this.norm[i] = Math.round((nx < -1 ? -1 : nx > 1 ? 1 : nx) * 127);
      this.norm[i + 1] = Math.round((ny < -1 ? -1 : ny > 1 ? 1 : ny) * 127);
      this.norm[i + 2] = Math.round((nz < -1 ? -1 : nz > 1 ? 1 : nz) * 127);
      this.col[i] = Math.round((r < 0 ? 0 : r > 1 ? 1 : r) * 255);
      this.col[i + 1] = Math.round((g < 0 ? 0 : g > 1 ? 1 : g) * 255);
      this.col[i + 2] = Math.round((b < 0 ? 0 : b > 1 ? 1 : b) * 255);
    } else {
      this.norm[i] = nx;
      this.norm[i + 1] = ny;
      this.norm[i + 2] = nz;
      this.col[i] = r;
      this.col[i + 1] = g;
      this.col[i + 2] = b;
    }
    if (this.uv) {
      const ui = idx * 2;
      this.uv[ui] = u;
      this.uv[ui + 1] = v;
    }
    this.vCount = idx + 1;
    return idx;
  }

  public pushTri(a: number, b: number, c: number) {
    const k = this.iCount;
    this.indices[k] = a;
    this.indices[k + 1] = b;
    this.indices[k + 2] = c;
    this.iCount = k + 3;
  }

  public pushWallQuad(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    baseY: number,
    topY: number,
    nx: number,
    nz: number,
    bR: number,
    bG: number,
    bB: number,
    tR: number,
    tG: number,
    tB: number
  ) {
    const v0 = this.pushVertexFast(x0, baseY, z0, nx, 0, nz, bR, bG, bB);
    const v1 = this.pushVertexFast(x1, baseY, z1, nx, 0, nz, bR, bG, bB);
    const v2 = this.pushVertexFast(x1, topY, z1, nx, 0, nz, tR, tG, tB);
    const v3 = this.pushVertexFast(x0, topY, z0, nx, 0, nz, tR, tG, tB);
    this.pushTri(v0, v1, v2);
    this.pushTri(v0, v2, v3);
  }

  public toRawBuffers(): RawIndexedBuffers | null {
    if (this.vCount === 0 || this.iCount === 0) return null;
    const pos = this.pos.slice(0, this.vCount * 3);
    const norm = this.norm.slice(0, this.vCount * 3);
    const col = this.col.slice(0, this.vCount * 3);
    const uv = this.uv ? this.uv.slice(0, this.vCount * 2) : undefined;
    let index: Uint16Array | Uint32Array;
    if (this.vCount <= 65535) {
      const u16 = new Uint16Array(this.iCount);
      for (let i = 0; i < this.iCount; i++) u16[i] = this.indices[i];
      index = u16;
    } else {
      index = this.indices.slice(0, this.iCount);
    }
    return {
      pos,
      norm,
      col,
      uv,
      index,
      vertexCount: this.vCount,
      indexCount: this.iCount,
    };
  }
}

const _qx = new Float64Array(6);
const _qz = new Float64Array(6);

function cleanRing2D(pts: THREE.Vector2[]): THREE.Vector2[] {
  const cleaned: THREE.Vector2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (cleaned.length > 0) {
      const prev = cleaned[cleaned.length - 1];
      if (Math.hypot(p.x - prev.x, p.y - prev.y) < 1e-4) continue;
    }
    cleaned.push(p);
  }
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-4) {
      cleaned.pop();
    }
  }
  return cleaned;
}

function emitPitchedQuadBuilding(
  builder: IndexedTypedGeometryBuilder,
  baseY: number,
  eaveY: number,
  ridgeY: number,
  bR: number,
  bG: number,
  bB: number,
  wTopR: number,
  wTopG: number,
  wTopB: number,
  rR: number,
  rG: number,
  rB: number
): boolean {
  // Choose longer axis for ridge span so roof slopes smoothly over shorter dimension
  const e01 = Math.hypot(_qx[1] - _qx[0], _qz[1] - _qz[0]);
  const e12 = Math.hypot(_qx[2] - _qx[1], _qz[2] - _qz[1]);
  // Vertices ordered CCW in (x, -z)
  const idx0 = e01 >= e12 ? 0 : 1;
  const i0 = idx0;
  const i1 = (idx0 + 1) % 4;
  const i2 = (idx0 + 2) % 4;
  const i3 = (idx0 + 3) % 4;

  // Two gable ridge endpoints inset slightly for a hipped-gable hybrid silhouette
  const rxA = (_qx[i0] + _qx[i3]) * 0.5;
  const rzA = (_qz[i0] + _qz[i3]) * 0.5;
  const rxB = (_qx[i1] + _qx[i2]) * 0.5;
  const rzB = (_qz[i1] + _qz[i2]) * 0.5;
  const hipLerp = 0.18;
  const hxA = rxA + (rxB - rxA) * hipLerp;
  const hzA = rzA + (rzB - rzA) * hipLerp;
  const hxB = rxB + (rxA - rxB) * hipLerp;
  const hzB = rzB + (rzA - rzB) * hipLerp;

  builder.ensureVerts(4 * 4 + 14);
  builder.ensureIndices(4 * 6 + 6 * 3);

  // 4 vertical walls up to eaveY
  for (let k = 0; k < 4; k++) {
    const m = (k + 1) % 4;
    const x0 = _qx[k];
    const z0 = _qz[k];
    const x1 = _qx[m];
    const z1 = _qz[m];
    const ex = x1 - x0;
    const ez = z1 - z0;
    const len = Math.hypot(ex, ez);
    if (len < 1e-4) continue;
    builder.pushWallQuad(
      x0,
      z0,
      x1,
      z1,
      baseY,
      eaveY,
      -ez / len,
      ex / len,
      bR,
      bG,
      bB,
      wTopR,
      wTopG,
      wTopB
    );
  }

  const pushRoofTri = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    bright: number
  ) => {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen;
    ny /= nLen;
    nz /= nLen;
    const cr = clamp(rR * bright, 0, 1);
    const cg = clamp(rG * bright, 0, 1);
    const cb = clamp(rB * bright, 0, 1);
    const v0 = builder.pushVertexFast(ax, ay, az, nx, ny, nz, cr * 0.9, cg * 0.9, cb * 0.9);
    const v1 = builder.pushVertexFast(bx, by, bz, nx, ny, nz, cr * 0.9, cg * 0.9, cb * 0.9);
    const v2 = builder.pushVertexFast(cx, cy, cz, nx, ny, nz, cr * 1.12, cg * 1.12, cb * 1.12);
    builder.pushTri(v0, v1, v2);
  };

  // Two main sloped roof planes (2 tris each) + two hip end triangles
  pushRoofTri(_qx[i0], eaveY, _qz[i0], _qx[i1], eaveY, _qz[i1], hxB, ridgeY, hzB, 1.06);
  pushRoofTri(_qx[i0], eaveY, _qz[i0], hxB, ridgeY, hzB, hxA, ridgeY, hzA, 1.06);
  pushRoofTri(_qx[i2], eaveY, _qz[i2], _qx[i3], eaveY, _qz[i3], hxA, ridgeY, hzA, 0.94);
  pushRoofTri(_qx[i2], eaveY, _qz[i2], hxA, ridgeY, hzA, hxB, ridgeY, hzB, 0.94);
  pushRoofTri(_qx[i3], eaveY, _qz[i3], _qx[i0], eaveY, _qz[i0], hxA, ridgeY, hzA, 0.98);
  pushRoofTri(_qx[i1], eaveY, _qz[i1], _qx[i2], eaveY, _qz[i2], hxB, ridgeY, hzB, 1.02);

  return true;
}

function emitBuildingIntoBuilder(
  builder: IndexedTypedGeometryBuilder,
  outerXZ: Array<[number, number]>,
  holesXZ: Array<Array<[number, number]>> | undefined,
  baseY: number,
  topY: number,
  baseR: number,
  baseG: number,
  baseB: number,
  roofR: number,
  roofG: number,
  roofB: number,
  allowPitchedRoof = false
): boolean {
  const botAo = 0.44;
  const bR = baseR * botAo;
  const bG = baseG * botAo;
  const bB = baseB * botAo;
  const tR = roofR;
  const tG = roofG;
  const tB = roofB;

  const hasHoles = Boolean(holesXZ && holesXZ.length > 0);

  if (!hasHoles && outerXZ.length <= 5) {
    let n = 0;
    for (let i = 0; i < outerXZ.length; i++) {
      const x = outerXZ[i][0];
      const z = outerXZ[i][1];
      if (n > 0 && Math.hypot(x - _qx[n - 1], z - _qz[n - 1]) < 1e-4) continue;
      if (n < 5) {
        _qx[n] = x;
        _qz[n] = z;
        n++;
      }
    }
    if (n > 1 && Math.hypot(_qx[0] - _qx[n - 1], _qz[0] - _qz[n - 1]) < 1e-4) {
      n--;
    }

    if (n === 3 || n === 4) {
      let area2 = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area2 += _qx[i] * -_qz[j] - _qx[j] * -_qz[i];
      }
      if (Math.abs(area2) > 1e-6) {
        let isConvex = true;
        if (n === 4) {
          let sign = 0;
          for (let i = 0; i < 4; i++) {
            const i1 = (i + 1) % 4;
            const i2 = (i + 2) % 4;
            const ax = _qx[i1] - _qx[i];
            const ay = -_qz[i1] - -_qz[i];
            const bx = _qx[i2] - _qx[i1];
            const by = -_qz[i2] - -_qz[i1];
            const cross = ax * by - ay * bx;
            if (Math.abs(cross) < 1e-7) {
              isConvex = false;
              break;
            }
            const s = cross > 0 ? 1 : -1;
            if (sign === 0) sign = s;
            else if (sign !== s) {
              isConvex = false;
              break;
            }
          }
        }

        if (isConvex) {
          const isCCW = area2 > 0;
          if (!isCCW) {
            if (n === 3) {
              const tx = _qx[1];
              const tz = _qz[1];
              _qx[1] = _qx[2];
              _qz[1] = _qz[2];
              _qx[2] = tx;
              _qz[2] = tz;
            } else {
              const tx1 = _qx[1];
              const tz1 = _qz[1];
              _qx[1] = _qx[3];
              _qz[1] = _qz[3];
              _qx[3] = tx1;
              _qz[3] = tz1;
            }
          }

          if (allowPitchedRoof && n === 4 && topY - baseY >= 0.08 && topY - baseY <= 0.42) {
            const eaveY = baseY + (topY - baseY) * 0.72;
            const ridgeY = topY + (topY - baseY) * 0.14;
            return emitPitchedQuadBuilding(
              builder,
              baseY,
              eaveY,
              ridgeY,
              bR,
              bG,
              bB,
              baseR * 0.92,
              baseG * 0.92,
              baseB * 0.92,
              tR,
              tG,
              tB
            );
          }

          const roofTriCount = n === 3 ? 1 : 2;
          builder.ensureVerts(n + n * 4);
          builder.ensureIndices(roofTriCount * 3 + n * 6);

          const rv0 = builder.pushVertexFast(_qx[0], topY, _qz[0], 0, 1, 0, tR, tG, tB);
          const rv1 = builder.pushVertexFast(_qx[1], topY, _qz[1], 0, 1, 0, tR, tG, tB);
          const rv2 = builder.pushVertexFast(_qx[2], topY, _qz[2], 0, 1, 0, tR, tG, tB);
          builder.pushTri(rv0, rv1, rv2);
          if (n === 4) {
            const rv3 = builder.pushVertexFast(_qx[3], topY, _qz[3], 0, 1, 0, tR, tG, tB);
            builder.pushTri(rv0, rv2, rv3);
          }

          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const x0 = _qx[i];
            const z0 = _qz[i];
            const x1 = _qx[j];
            const z1 = _qz[j];
            const ex = x1 - x0;
            const ez = z1 - z0;
            const edgeLen = Math.hypot(ex, ez);
            if (edgeLen < 1e-4) continue;
            builder.pushWallQuad(
              x0,
              z0,
              x1,
              z1,
              baseY,
              topY,
              -ez / edgeLen,
              ex / edgeLen,
              bR,
              bG,
              bB,
              tR,
              tG,
              tB
            );
          }
          return true;
        }
      }
    }
  }

  let contour = cleanRing2D(outerXZ.map(([x, z]) => new THREE.Vector2(x, -z)));
  if (contour.length < 3) return false;

  if (THREE.ShapeUtils.isClockWise(contour)) {
    contour = contour.reverse();
  }

  const holes: THREE.Vector2[][] = [];
  if (holesXZ && holesXZ.length > 0) {
    for (const ring of holesXZ) {
      let h = cleanRing2D(ring.map(([x, z]) => new THREE.Vector2(x, -z)));
      if (h.length < 3) continue;
      if (!THREE.ShapeUtils.isClockWise(h)) {
        h = h.reverse();
      }
      holes.push(h);
    }
  }

  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  } catch {
    return false;
  }
  if (faces.length === 0) return false;

  const flat2D: THREE.Vector2[] = [...contour];
  for (const h of holes) {
    for (const p of h) flat2D.push(p);
  }

  let totalWallEdges = contour.length;
  for (const h of holes) totalWallEdges += h.length;

  builder.ensureVerts(flat2D.length + totalWallEdges * 4);
  builder.ensureIndices(faces.length * 3 + totalWallEdges * 6);

  const roofBaseIdx = new Int32Array(flat2D.length);
  for (let i = 0; i < flat2D.length; i++) {
    const p = flat2D[i];
    roofBaseIdx[i] = builder.pushVertexFast(p.x, topY, -p.y, 0, 1, 0, tR, tG, tB);
  }
  for (let f = 0; f < faces.length; f++) {
    const [ia, ib, ic] = faces[f];
    if (ia >= flat2D.length || ib >= flat2D.length || ic >= flat2D.length) continue;
    builder.pushTri(roofBaseIdx[ia], roofBaseIdx[ib], roofBaseIdx[ic]);
  }

  const emitWalls = (ring: THREE.Vector2[]) => {
    const len = ring.length;
    for (let i = 0; i < len; i++) {
      const p0 = ring[i];
      const p1 = ring[(i + 1) % len];
      const x0 = p0.x;
      const z0 = -p0.y;
      const x1 = p1.x;
      const z1 = -p1.y;
      const ex = x1 - x0;
      const ez = z1 - z0;
      const edgeLen = Math.hypot(ex, ez);
      if (edgeLen < 1e-4) continue;
      builder.pushWallQuad(
        x0,
        z0,
        x1,
        z1,
        baseY,
        topY,
        -ez / edgeLen,
        ex / edgeLen,
        bR,
        bG,
        bB,
        tR,
        tG,
        tB
      );
    }
  };

  emitWalls(contour);
  for (const h of holes) emitWalls(h);
  return true;
}

function scaleRingAroundCentroid(
  ring: Array<[number, number]>,
  cx: number,
  cz: number,
  scale: number
): Array<[number, number]> {
  return ring.map(([x, z]) => [cx + (x - cx) * scale, cz + (z - cz) * scale]);
}

export function buildChunkBuildingsRaw(opts: {
  buildings: TerrainBuildingFootprint[];
  elevationsM: number[];
  rows: number;
  cols: number;
  minElevationM: number;
  baseElevationM?: number;
  spanMetersX: number;
  chunkWidth: number;
  chunkDepth: number;
  verticalExaggeration: number;
  metersToSceneY?: number;
  seedOffset?: number;
  includeHoles?: boolean;
}): {
  stdGeo: RawIndexedBuffers | null;
  towerGeo: RawIndexedBuffers | null;
  builtCount: number;
} {
  const {
    buildings,
    elevationsM,
    rows,
    cols,
    minElevationM,
    baseElevationM = minElevationM,
    spanMetersX,
    chunkWidth,
    chunkDepth,
    verticalExaggeration,
    metersToSceneY,
    seedOffset = 0,
    includeHoles = true,
  } = opts;

  const metersToScene = metersToSceneY ?? chunkWidth / Math.max(180, spanMetersX);
  const stdBuilder = new IndexedTypedGeometryBuilder(Math.min(72000, buildings.length * 14 + 256), false, true);
  const towerBuilder = new IndexedTypedGeometryBuilder(1024, false, true);
  const baseCol = new THREE.Color();
  const roofCol = new THREE.Color();
  let builtCount = 0;

  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b.outer.length < 3) continue;

    let cu = 0;
    let cv = 0;
    let minCornerElevM = Infinity;
    const step = b.outer.length > 16 ? Math.ceil(b.outer.length / 10) : 1;

    const outerXZ: Array<[number, number]> = new Array(b.outer.length);
    const microShift = (((i + seedOffset) % 7) - 3) * 0.002;

    for (let k = 0; k < b.outer.length; k++) {
      const pu = b.outer[k][0];
      const pv = b.outer[k][1];
      cu += pu;
      cv += pv;
      if (k % step === 0) {
        const ce = sampleElevationGrid(elevationsM, rows, cols, pu, pv);
        if (ce < minCornerElevM) minCornerElevM = ce;
      }
      outerXZ[k] = [
        (pu - 0.5) * chunkWidth + microShift,
        (pv - 0.5) * chunkDepth - microShift,
      ];
    }
    cu /= b.outer.length;
    cv /= b.outer.length;

    const cx = (cu - 0.5) * chunkWidth + microShift;
    const cz = (cv - 0.5) * chunkDepth - microShift;

    const centroidElevM = sampleElevationGrid(elevationsM, rows, cols, cu, cv);
    if (!Number.isFinite(minCornerElevM)) minCornerElevM = centroidElevM;
    const foundationElevM = Math.min(centroidElevM, minCornerElevM);

    const centroidY = (centroidElevM - baseElevationM) * metersToScene * verticalExaggeration;
    const foundationY = (foundationElevM - baseElevationM) * metersToScene * verticalExaggeration;

    const minHScene = b.minHeightM * metersToScene;
    const roofTopY = centroidY + Math.max(0.08, b.heightM * metersToScene);
    const baseY = foundationY + minHScene - 0.14;
    if (roofTopY <= baseY + 0.05) continue;

    const holesXZ =
      includeHoles && b.holes
        ? b.holes.map((ring) =>
            ring.map(
              ([hu, hv]) =>
                [
                  (hu - 0.5) * chunkWidth + microShift,
                  (hv - 0.5) * chunkDepth - microShift,
                ] as [number, number]
            )
          )
        : undefined;

    const isHighRise = b.heightM >= 28;
    if (isHighRise) {
      const style = (i + seedOffset) % 3;
      if (style === 0) {
        baseCol.set('#13243a');
        roofCol.set('#5ca8dc');
      } else if (style === 1) {
        baseCol.set('#1c2738');
        roofCol.set('#7eb4d6');
      } else {
        baseCol.set('#282524');
        roofCol.set('#a8977e');
      }

      // Multi-tier architectural articulation on tall towers inside core/detail chunks
      if (includeHoles && b.heightM >= 44 && !holesXZ && outerXZ.length <= 12) {
        const lowerTopY = baseY + (roofTopY - baseY) * 0.72;
        const okShaft = emitBuildingIntoBuilder(
          towerBuilder,
          outerXZ,
          undefined,
          baseY,
          lowerTopY,
          baseCol.r,
          baseCol.g,
          baseCol.b,
          roofCol.r * 0.9,
          roofCol.g * 0.9,
          roofCol.b * 0.9,
          false
        );
        const upperRing = scaleRingAroundCentroid(outerXZ, cx, cz, 0.78);
        emitBuildingIntoBuilder(
          towerBuilder,
          upperRing,
          undefined,
          lowerTopY - 0.04,
          roofTopY,
          baseCol.r * 1.12,
          baseCol.g * 1.12,
          baseCol.b * 1.15,
          roofCol.r,
          roofCol.g,
          roofCol.b,
          false
        );
        if (b.heightM >= 70) {
          const crownRing = scaleRingAroundCentroid(outerXZ, cx, cz, 0.44);
          emitBuildingIntoBuilder(
            towerBuilder,
            crownRing,
            undefined,
            roofTopY - 0.02,
            roofTopY + 3.2 * metersToScene,
            baseCol.r * 0.85,
            baseCol.g * 0.88,
            baseCol.b * 0.95,
            roofCol.r * 1.12,
            roofCol.g * 1.12,
            roofCol.b * 1.15,
            false
          );
        }
        if (okShaft) builtCount += 1;
        continue;
      }

      const ok = emitBuildingIntoBuilder(
        towerBuilder,
        outerXZ,
        holesXZ,
        baseY,
        roofTopY,
        baseCol.r,
        baseCol.g,
        baseCol.b,
        roofCol.r,
        roofCol.g,
        roofCol.b,
        false
      );
      if (ok) builtCount += 1;
    } else {
      const pIdx = (i + seedOffset) % ARCH_BASE_PALETTE.length;
      const jitter = (((i + seedOffset) * 37) % 9) * 0.011;
      const bp = ARCH_BASE_PALETTE[pIdx];
      const rp = ARCH_ROOF_PALETTE[pIdx];
      baseCol.setRGB(bp[0] + jitter, bp[1] + jitter, bp[2] + jitter);
      roofCol.setRGB(rp[0] + jitter, rp[1] + jitter, rp[2] + jitter);

      const usePitchedRoof =
        includeHoles &&
        b.heightM <= 14.5 &&
        !holesXZ &&
        outerXZ.length <= 5 &&
        (i + seedOffset) % 5 < 2;

      const ok = emitBuildingIntoBuilder(
        stdBuilder,
        outerXZ,
        holesXZ,
        baseY,
        roofTopY,
        baseCol.r,
        baseCol.g,
        baseCol.b,
        roofCol.r,
        roofCol.g,
        roofCol.b,
        usePitchedRoof
      );
      if (ok) builtCount += 1;
    }
  }

  return {
    stdGeo: stdBuilder.toRawBuffers(),
    towerGeo: towerBuilder.toRawBuffers(),
    builtCount,
  };
}

function subdivideNormalizedPolyline(
  coords: Array<[number, number]>,
  maxStep = 0.035
): Array<[number, number]> {
  if (coords.length < 2) return coords;
  const out: Array<[number, number]> = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [u0, v0] = coords[i - 1];
    const [u1, v1] = coords[i];
    const dist = Math.hypot(u1 - u0, v1 - v0);
    const steps = Math.max(1, Math.min(18, Math.ceil(dist / maxStep)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([u0 + (u1 - u0) * t, v0 + (v1 - v0) * t]);
    }
  }
  return out;
}

function emitTerrainDrapedRibbon(
  builder: IndexedTypedGeometryBuilder,
  coords: Array<[number, number]>,
  halfWidthScene: number,
  yLiftScene: number,
  elevationsM: number[],
  rows: number,
  cols: number,
  baseElevationM: number,
  metersToSceneY: number,
  chunkWidth: number,
  chunkDepth: number,
  verticalExaggeration: number,
  edgeRgb: readonly [number, number, number],
  centerRgb: readonly [number, number, number],
  forceFlatY: number | null = null
) {
  const pts = subdivideNormalizedPolyline(coords, 0.032);
  if (pts.length < 2) return;

  builder.ensureVerts(pts.length * 3);
  builder.ensureIndices((pts.length - 1) * 12);

  let distAccum = 0;
  let prevLeft = -1;
  let prevCenter = -1;
  let prevRight = -1;

  for (let i = 0; i < pts.length; i++) {
    const [u, v] = pts[i];
    const cx = (clamp(u, -0.02, 1.02) - 0.5) * chunkWidth;
    const cz = (clamp(v, -0.02, 1.02) - 0.5) * chunkDepth;

    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dx = (next[0] - prev[0]) * chunkWidth;
    const dz = (next[1] - prev[1]) * chunkDepth;
    const segLen = Math.hypot(dx, dz) || 1;
    const nx2 = -dz / segLen;
    const nz2 = dx / segLen;

    if (i > 0) {
      distAccum += Math.hypot(
        (u - pts[i - 1][0]) * chunkWidth,
        (v - pts[i - 1][1]) * chunkDepth
      );
    }

    const elevM = sampleElevationGrid(elevationsM, rows, cols, clamp(u, 0, 1), clamp(v, 0, 1));
    const cy =
      forceFlatY !== null
        ? forceFlatY
        : (elevM - baseElevationM) * metersToSceneY * verticalExaggeration + yLiftScene;

    const lx = cx - nx2 * halfWidthScene;
    const lz = cz - nz2 * halfWidthScene;
    const rx = cx + nx2 * halfWidthScene;
    const rz = cz + nz2 * halfWidthScene;

    const iL = builder.pushVertexFast(
      lx,
      cy,
      lz,
      0,
      1,
      0,
      edgeRgb[0],
      edgeRgb[1],
      edgeRgb[2],
      0,
      distAccum
    );
    const iC = builder.pushVertexFast(
      cx,
      cy + 0.004,
      cz,
      0,
      1,
      0,
      centerRgb[0],
      centerRgb[1],
      centerRgb[2],
      0.5,
      distAccum
    );
    const iR = builder.pushVertexFast(
      rx,
      cy,
      rz,
      0,
      1,
      0,
      edgeRgb[0],
      edgeRgb[1],
      edgeRgb[2],
      1,
      distAccum
    );

    if (i > 0) {
      builder.pushTri(prevLeft, iL, iC);
      builder.pushTri(prevLeft, iC, prevCenter);
      builder.pushTri(prevCenter, iC, iR);
      builder.pushTri(prevCenter, iR, prevRight);
    }
    prevLeft = iL;
    prevCenter = iC;
    prevRight = iR;
  }
}

export function buildChunkRoadsRaw(opts: {
  roads: TerrainRoadPolyline[];
  elevationsM: number[];
  rows: number;
  cols: number;
  baseElevationM: number;
  metersToSceneY: number;
  chunkWidth: number;
  chunkDepth: number;
  verticalExaggeration: number;
}): RawIndexedBuffers | null {
  const {
    roads,
    elevationsM,
    rows,
    cols,
    baseElevationM,
    metersToSceneY,
    chunkWidth,
    chunkDepth,
    verticalExaggeration,
  } = opts;
  if (!roads || roads.length === 0) return null;

  const builder = new IndexedTypedGeometryBuilder(Math.min(32000, roads.length * 36 + 256), true, true);
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    const halfW = clamp(r.widthM * 0.5 * metersToSceneY, 0.05, 0.24);
    let lift = 0.085;
    let edgeCol: readonly [number, number, number] = [0.11, 0.13, 0.17];
    let midCol: readonly [number, number, number] = [0.18, 0.21, 0.27];

    if (r.kind === 'motorway') {
      lift = 0.115;
      edgeCol = [0.16, 0.18, 0.22];
      midCol = [0.56, 0.44, 0.24]; // Warm highway median accent
    } else if (r.kind === 'primary') {
      lift = 0.105;
      edgeCol = [0.14, 0.17, 0.22];
      midCol = [0.34, 0.38, 0.44];
    } else if (r.kind === 'secondary') {
      lift = 0.095;
      edgeCol = [0.13, 0.15, 0.20];
      midCol = [0.24, 0.28, 0.34];
    } else if (r.kind === 'rail') {
      lift = 0.09;
      edgeCol = [0.12, 0.12, 0.14];
      midCol = [0.42, 0.36, 0.28];
    }

    emitTerrainDrapedRibbon(
      builder,
      r.coords,
      halfW,
      lift,
      elevationsM,
      rows,
      cols,
      baseElevationM,
      metersToSceneY,
      chunkWidth,
      chunkDepth,
      verticalExaggeration,
      edgeCol,
      midCol
    );
  }

  return builder.toRawBuffers();
}

function clipConvexPolyToUnitSquare(poly: Array<[number, number]>): Array<[number, number]> {
  let pts = poly;
  const clipEdge = (
    input: Array<[number, number]>,
    inside: (p: [number, number]) => boolean,
    intersect: (a: [number, number], b: [number, number]) => [number, number]
  ): Array<[number, number]> => {
    if (input.length === 0) return [];
    const out: Array<[number, number]> = [];
    for (let i = 0; i < input.length; i++) {
      const curr = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const currIn = inside(curr);
      const prevIn = inside(prev);
      if (currIn !== prevIn) {
        out.push(intersect(prev, curr));
      }
      if (currIn) {
        out.push(curr);
      }
    }
    return out;
  };

  pts = clipEdge(
    pts,
    (p) => p[0] >= 0,
    (a, b) => {
      const t = (0 - a[0]) / (b[0] - a[0] || 1e-12);
      return [0, a[1] + (b[1] - a[1]) * t];
    }
  );
  pts = clipEdge(
    pts,
    (p) => p[0] <= 1,
    (a, b) => {
      const t = (1 - a[0]) / (b[0] - a[0] || 1e-12);
      return [1, a[1] + (b[1] - a[1]) * t];
    }
  );
  pts = clipEdge(
    pts,
    (p) => p[1] >= 0,
    (a, b) => {
      const t = (0 - a[1]) / (b[1] - a[1] || 1e-12);
      return [a[0] + (b[0] - a[0]) * t, 0];
    }
  );
  pts = clipEdge(
    pts,
    (p) => p[1] <= 1,
    (a, b) => {
      const t = (1 - a[1]) / (b[1] - a[1] || 1e-12);
      return [a[0] + (b[0] - a[0]) * t, 1];
    }
  );
  return pts;
}

function emitSubdividedWaterTriangle(
  builder: IndexedTypedGeometryBuilder,
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  y: number,
  depthSampler: (u: number, v: number) => number,
  chunkWidth: number,
  chunkDepth: number,
  maxEdgeUV = 0.085,
  depthLeft = 3
) {
  const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
  if (Math.abs(cross) < 1e-10) return;

  // Enforce +Y upward-facing winding in Three.js XZ coordinates (negative cross in (u, v))
  const a = p0;
  const b = cross > 0 ? p2 : p1;
  const c = cross > 0 ? p1 : p2;

  if (depthLeft > 0) {
    const d01 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d12 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const d20 = Math.hypot(a[0] - c[0], a[1] - c[1]);
    if (d01 > maxEdgeUV || d12 > maxEdgeUV || d20 > maxEdgeUV) {
      if (d01 >= d12 && d01 >= d20) {
        const m: [number, number] = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
        emitSubdividedWaterTriangle(builder, a, m, c, y, depthSampler, chunkWidth, chunkDepth, maxEdgeUV, depthLeft - 1);
        emitSubdividedWaterTriangle(builder, m, b, c, y, depthSampler, chunkWidth, chunkDepth, maxEdgeUV, depthLeft - 1);
        return;
      }
      if (d12 >= d01 && d12 >= d20) {
        const m: [number, number] = [(b[0] + c[0]) * 0.5, (b[1] + c[1]) * 0.5];
        emitSubdividedWaterTriangle(builder, a, b, m, y, depthSampler, chunkWidth, chunkDepth, maxEdgeUV, depthLeft - 1);
        emitSubdividedWaterTriangle(builder, a, m, c, y, depthSampler, chunkWidth, chunkDepth, maxEdgeUV, depthLeft - 1);
        return;
      }
      const m: [number, number] = [(c[0] + a[0]) * 0.5, (c[1] + a[1]) * 0.5];
      emitSubdividedWaterTriangle(builder, a, b, m, y, depthSampler, chunkWidth, chunkDepth, maxEdgeUV, depthLeft - 1);
      emitSubdividedWaterTriangle(builder, m, b, c, y, depthSampler, chunkWidth, chunkDepth, maxEdgeUV, depthLeft - 1);
      return;
    }
  }

  builder.ensureVerts(3);
  builder.ensureIndices(3);
  const ia = builder.pushVertexFast(
    (a[0] - 0.5) * chunkWidth,
    y,
    (a[1] - 0.5) * chunkDepth,
    0,
    1,
    0,
    depthSampler(a[0], a[1]),
    0.5,
    1.0,
    a[0],
    a[1]
  );
  const ib = builder.pushVertexFast(
    (b[0] - 0.5) * chunkWidth,
    y,
    (b[1] - 0.5) * chunkDepth,
    0,
    1,
    0,
    depthSampler(b[0], b[1]),
    0.5,
    1.0,
    b[0],
    b[1]
  );
  const ic = builder.pushVertexFast(
    (c[0] - 0.5) * chunkWidth,
    y,
    (c[1] - 0.5) * chunkDepth,
    0,
    1,
    0,
    depthSampler(c[0], c[1]),
    0.5,
    1.0,
    c[0],
    c[1]
  );
  builder.pushTri(ia, ib, ic);
}

export function buildChunkWaterRaw(opts: {
  waterFeatures: TerrainWaterFeature[];
  elevationsM: number[];
  rows: number;
  cols: number;
  minElevationM: number;
  baseElevationM: number;
  metersToSceneY: number;
  chunkWidth: number;
  chunkDepth: number;
  verticalExaggeration: number;
  isCoastalTile: boolean;
}): RawIndexedBuffers | null {
  const {
    waterFeatures,
    elevationsM,
    rows,
    cols,
    minElevationM,
    baseElevationM,
    metersToSceneY,
    chunkWidth,
    chunkDepth,
    verticalExaggeration,
    isCoastalTile,
  } = opts;

  const seaLift = clamp(1.05 * metersToSceneY * verticalExaggeration, 0.040, 0.074);
  const seaY = (0 - baseElevationM) * metersToSceneY * verticalExaggeration + seaLift;
  const builder = new IndexedTypedGeometryBuilder(2048, true, false);

  const cellWaterThresholdM = 0.42;
  const oceanFeatures = waterFeatures.filter(
    (wf) => wf.isPolygon && wf.kind === 'ocean' && wf.rings.length > 0
  );
  const hasOceanPolys = isCoastalTile && oceanFeatures.length > 0;
  const hasCoastalDem = isCoastalTile && minElevationM <= cellWaterThresholdM && rows >= 2 && cols >= 2;
  const hasCoastalSea = hasOceanPolys || hasCoastalDem;

  let landDist: Float32Array | null = null;
  let hasAnyLand = false;
  if (hasCoastalSea && rows >= 2 && cols >= 2) {
    const maxCellSpan = Math.max(12, Math.ceil(5.2 / Math.max(0.25, chunkWidth / Math.max(1, cols - 1))));
    landDist = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      const v = r / (rows - 1);
      for (let c = 0; c < cols; c++) {
        const u = c / (cols - 1);
        const idx = r * cols + c;
        const isWaterVert = hasOceanPolys
          ? isPointInOceanWaterFeatures(u, v, oceanFeatures) || (elevationsM[idx] ?? 0) <= cellWaterThresholdM
          : (elevationsM[idx] ?? 0) <= cellWaterThresholdM;
        if (!isWaterVert) hasAnyLand = true;
        landDist[idx] = isWaterVert ? maxCellSpan : 0;
      }
    }
    if (hasAnyLand) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          let d = landDist[idx];
          if (r > 0) d = Math.min(d, landDist[(r - 1) * cols + c] + 1);
          if (c > 0) d = Math.min(d, landDist[r * cols + (c - 1)] + 1);
          if (r > 0 && c > 0) d = Math.min(d, landDist[(r - 1) * cols + (c - 1)] + 1.414);
          if (r > 0 && c < cols - 1) d = Math.min(d, landDist[(r - 1) * cols + (c + 1)] + 1.414);
          landDist[idx] = d;
        }
      }
      for (let r = rows - 1; r >= 0; r--) {
        for (let c = cols - 1; c >= 0; c--) {
          const idx = r * cols + c;
          let d = landDist[idx];
          if (r < rows - 1) d = Math.min(d, landDist[(r + 1) * cols + c] + 1);
          if (c < cols - 1) d = Math.min(d, landDist[r * cols + (c + 1)] + 1);
          if (r < rows - 1 && c < cols - 1) d = Math.min(d, landDist[(r + 1) * cols + (c + 1)] + 1.414);
          if (r < rows - 1 && c > 0) d = Math.min(d, landDist[(r + 1) * cols + (c - 1)] + 1.414);
          landDist[idx] = d;
        }
      }
    }
  }

  const scenePerCell = cols > 1 ? chunkWidth / (cols - 1) : 1.0;
  const sampleDepthAtUV = (u: number, v: number): number => {
    const cu = clamp(u, 0, 1);
    const cv = clamp(v, 0, 1);
    if (!landDist || !hasAnyLand || rows < 2 || cols < 2) return 0.88;
    const fx = cu * (cols - 1);
    const fz = cv * (rows - 1);
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fz);
    const c1 = Math.min(cols - 1, c0 + 1);
    const r1 = Math.min(rows - 1, r0 + 1);
    const tx = fx - c0;
    const tz = fz - r0;
    const d00 = landDist[r0 * cols + c0] ?? 0;
    const d10 = landDist[r0 * cols + c1] ?? d00;
    const d01 = landDist[r1 * cols + c0] ?? d00;
    const d11 = landDist[r1 * cols + c1] ?? d00;
    const distCells = (d00 + (d10 - d00) * tx) * (1 - tz) + (d01 + (d11 - d01) * tx) * tz;
    // Scale to physical scene units so Tier-1 (48u) and Tier-2 (192u) match seamlessly across chunk edges
    const distScene = distCells * scenePerCell;
    const shoreDepth = clamp(0.10 + (distScene / 3.4) * 0.78, 0.10, 0.88);
    const elev = sampleElevationGrid(elevationsM, rows, cols, cu, cv);
    const bathyBoost = elev < -0.5 ? clamp((-0.5 - elev) / 4.0, 0, 0.25) : 0;
    return clamp(shoreDepth + bathyBoost, 0.10, 0.90);
  };

  // 1A. Authoritative 1m OSM MVT 'ocean' / bay / harbor polygons (clipped to [0,1] & subdivided for coastal gradient)
  if (hasOceanPolys) {
    for (let i = 0; i < oceanFeatures.length; i++) {
      const wf = oceanFeatures[i];
      let contour = cleanRing2D(wf.rings[0].map(([u, v]) => new THREE.Vector2(u, -v)));
      if (contour.length < 3) continue;
      if (THREE.ShapeUtils.isClockWise(contour)) contour = contour.reverse();

      const holes: THREE.Vector2[][] = [];
      for (let hIdx = 1; hIdx < wf.rings.length; hIdx++) {
        let hole = cleanRing2D(wf.rings[hIdx].map(([u, v]) => new THREE.Vector2(u, -v)));
        if (hole.length < 3) continue;
        if (!THREE.ShapeUtils.isClockWise(hole)) hole = hole.reverse();
        holes.push(hole);
      }

      let faces: number[][];
      try {
        faces = THREE.ShapeUtils.triangulateShape(contour, holes);
      } catch {
        continue;
      }
      if (faces.length === 0) continue;

      const flatUV: Array<[number, number]> = contour.map((p) => [p.x, -p.y]);
      for (const h of holes) {
        for (const p of h) flatUV.push([p.x, -p.y]);
      }

      for (let f = 0; f < faces.length; f++) {
        const [ia, ib, ic] = faces[f];
        if (ia >= flatUV.length || ib >= flatUV.length || ic >= flatUV.length) continue;
        const clipped = clipConvexPolyToUnitSquare([flatUV[ia], flatUV[ib], flatUV[ic]]);
        if (clipped.length < 3) continue;
        for (let t = 1; t < clipped.length - 1; t++) {
          emitSubdividedWaterTriangle(
            builder,
            clipped[0],
            clipped[t],
            clipped[t + 1],
            seaY,
            sampleDepthAtUV,
            chunkWidth,
            chunkDepth,
            0.085,
            3
          );
        }
      }
    }
  } else if (hasCoastalDem && landDist) {
    // 1B. DEM coastal sea fallback when MVT ocean polygon is unavailable
    for (let r = 0; r < rows - 1; r++) {
      const v0 = r / (rows - 1);
      const v1 = (r + 1) / (rows - 1);
      const z0 = (v0 - 0.5) * chunkDepth;
      const z1 = (v1 - 0.5) * chunkDepth;

      for (let c = 0; c < cols - 1; c++) {
        const e00 = elevationsM[r * cols + c] ?? 0;
        const e10 = elevationsM[r * cols + (c + 1)] ?? 0;
        const e01 = elevationsM[(r + 1) * cols + c] ?? 0;
        const e11 = elevationsM[(r + 1) * cols + (c + 1)] ?? 0;
        if (Math.min(e00, e10, e01, e11) > cellWaterThresholdM) continue;

        const u0 = c / (cols - 1);
        const u1 = (c + 1) / (cols - 1);
        const x0 = (u0 - 0.5) * chunkWidth;
        const x1 = (u1 - 0.5) * chunkWidth;

        const d00 = sampleDepthAtUV(u0, v0);
        const d10 = sampleDepthAtUV(u1, v0);
        const d01 = sampleDepthAtUV(u0, v1);
        const d11 = sampleDepthAtUV(u1, v1);

        builder.ensureVerts(4);
        builder.ensureIndices(6);
        const i00 = builder.pushVertexFast(x0, seaY, z0, 0, 1, 0, d00, 0.5, 1.0, u0, v0);
        const i10 = builder.pushVertexFast(x1, seaY, z0, 0, 1, 0, d10, 0.5, 1.0, u1, v0);
        const i01 = builder.pushVertexFast(x0, seaY, z1, 0, 1, 0, d01, 0.5, 1.0, u0, v1);
        const i11 = builder.pushVertexFast(x1, seaY, z1, 0, 1, 0, d11, 0.5, 1.0, u1, v1);
        builder.pushTri(i00, i01, i10);
        builder.pushTri(i10, i01, i11);
      }
    }
  }

  // 2. Inland Lakes, Canals, Riverbanks & Waterway Ribbons (deduplicated against ocean polygons)
  for (let i = 0; i < waterFeatures.length; i++) {
    const wf = waterFeatures[i];
    if (wf.isPolygon && wf.rings.length > 0) {
      if (wf.kind === 'ocean') continue;

      let minSample = Infinity;
      let sumSample = 0;
      let cu = 0;
      let cv = 0;
      const outerPts = wf.rings[0];
      for (let k = 0; k < outerPts.length; k++) {
        const pu = clamp(outerPts[k][0], 0, 1);
        const pv = clamp(outerPts[k][1], 0, 1);
        cu += pu;
        cv += pv;
        const s = sampleElevationGrid(elevationsM, rows, cols, pu, pv);
        if (s < minSample) minSample = s;
        sumSample += s;
      }
      const nPts = Math.max(1, outerPts.length);
      const avgSample = sumSample / nPts;
      cu /= nPts;
      cv /= nPts;

      if (
        hasOceanPolys &&
        minSample <= 0.8 &&
        avgSample <= 2.4 &&
        isPointInOceanWaterFeatures(cu, cv, oceanFeatures)
      ) {
        continue;
      }

      if (
        !hasOceanPolys &&
        hasCoastalDem &&
        minSample <= 0.45 &&
        avgSample <= 1.25 &&
        (wf.kind === 'river' || wf.kind === 'canal' || wf.kind === 'lake')
      ) {
        continue;
      }

      let contour = cleanRing2D(wf.rings[0].map(([u, v]) => new THREE.Vector2(u, -v)));
      if (contour.length < 3) continue;
      if (THREE.ShapeUtils.isClockWise(contour)) contour = contour.reverse();

      const holes: THREE.Vector2[][] = [];
      for (let hIdx = 1; hIdx < wf.rings.length; hIdx++) {
        let hole = cleanRing2D(wf.rings[hIdx].map(([u, v]) => new THREE.Vector2(u, -v)));
        if (hole.length < 3) continue;
        if (!THREE.ShapeUtils.isClockWise(hole)) hole = hole.reverse();
        holes.push(hole);
      }

      let faces: number[][];
      try {
        faces = THREE.ShapeUtils.triangulateShape(contour, holes);
      } catch {
        continue;
      }
      if (faces.length === 0) continue;

      const clampedCandidate = Math.min(avgSample + 0.15, minSample + 1.2);
      const waterElevM = isCoastalTile ? Math.max(0.05, clampedCandidate) : clampedCandidate;
      const wy = (waterElevM - baseElevationM) * metersToSceneY * verticalExaggeration + 0.045;
      const depthVal = wf.kind === 'lake' ? 0.68 : 0.56;

      const flatUV: Array<[number, number]> = contour.map((p) => [p.x, -p.y]);
      for (const h of holes) {
        for (const p of h) flatUV.push([p.x, -p.y]);
      }

      for (let f = 0; f < faces.length; f++) {
        const [ia, ib, ic] = faces[f];
        if (ia >= flatUV.length || ib >= flatUV.length || ic >= flatUV.length) continue;
        const clipped = clipConvexPolyToUnitSquare([flatUV[ia], flatUV[ib], flatUV[ic]]);
        if (clipped.length < 3) continue;
        for (let t = 1; t < clipped.length - 1; t++) {
          emitSubdividedWaterTriangle(
            builder,
            clipped[0],
            clipped[t],
            clipped[t + 1],
            wy,
            () => depthVal,
            chunkWidth,
            chunkDepth,
            0.25,
            1
          );
        }
      }
    } else if (!wf.isPolygon && wf.rings.length > 0 && wf.rings[0].length >= 2) {
      // Skip open-bay/ocean waterway centerlines already covered by coastal sea/ocean polygons
      const pts = wf.rings[0];
      const filteredRun: Array<[number, number]> = [];
      const halfW = clamp((wf.widthM ?? 14) * 0.5 * metersToSceneY, 0.08, 0.42);
      const flushRun = () => {
        if (filteredRun.length >= 2) {
          emitTerrainDrapedRibbon(
            builder,
            filteredRun,
            halfW,
            0.055,
            elevationsM,
            rows,
            cols,
            baseElevationM,
            metersToSceneY,
            chunkWidth,
            chunkDepth,
            verticalExaggeration,
            [0.24, 0.6, 1.0],
            [0.64, 0.6, 1.0]
          );
        }
        filteredRun.length = 0;
      };

      for (let p = 0; p < pts.length; p++) {
        const [u, v] = pts[p];
        if (hasOceanPolys && isPointInOceanWaterFeatures(u, v, oceanFeatures)) {
          flushRun();
          continue;
        }
        if (hasCoastalDem) {
          const elev = sampleElevationGrid(elevationsM, rows, cols, clamp(u, 0, 1), clamp(v, 0, 1));
          if (elev <= cellWaterThresholdM) {
            flushRun();
            continue;
          }
        }
        filteredRun.push([u, v]);
      }
      flushRun();
    }
  }

  return builder.toRawBuffers();
}

export function buildAllChunkGeometriesRaw(input: ChunkGeometryBuildInput): ChunkGeometryBuildOutput {
  const {
    payload,
    baseElevationM,
    metersToSceneY,
    chunkWidth,
    chunkDepth,
    verticalExaggeration,
    seedOffset,
    includeHoles,
    includeRoadsAndWater,
    includeWater = false,
    skipWater = false,
  } = input;

  const bRes =
    payload.buildings.length > 0
      ? buildChunkBuildingsRaw({
          buildings: payload.buildings,
          elevationsM: payload.elevationsM,
          rows: payload.rows,
          cols: payload.cols,
          minElevationM: payload.minElevationM,
          baseElevationM,
          spanMetersX: payload.spanMetersX,
          chunkWidth,
          chunkDepth,
          verticalExaggeration,
          metersToSceneY,
          seedOffset,
          includeHoles,
        })
      : { stdGeo: null, towerGeo: null, builtCount: 0 };

  if (!includeRoadsAndWater && !includeWater) {
    return {
      ...bRes,
      roadsGeo: null,
      waterGeo: null,
    };
  }

  const midLat = (payload.bounds.north + payload.bounds.south) * 0.5;
  const midLng = (payload.bounds.west + payload.bounds.east) * 0.5;
  const isCoastalTile = !isKnownBelowSeaBasin(midLat, midLng);

  const roadsGeo =
    includeRoadsAndWater && payload.roads?.length
      ? buildChunkRoadsRaw({
          roads: payload.roads,
          elevationsM: payload.elevationsM,
          rows: payload.rows,
          cols: payload.cols,
          baseElevationM,
          metersToSceneY,
          chunkWidth,
          chunkDepth,
          verticalExaggeration,
        })
      : null;

  const waterGeo = skipWater
    ? null
    : buildChunkWaterRaw({
        waterFeatures: payload.waterFeatures ?? [],
        elevationsM: payload.elevationsM,
        rows: payload.rows,
        cols: payload.cols,
        minElevationM: payload.minElevationM,
        baseElevationM,
        metersToSceneY,
        chunkWidth,
        chunkDepth,
        verticalExaggeration,
        isCoastalTile,
      });

  return {
    ...bRes,
    roadsGeo,
    waterGeo,
  };
}
