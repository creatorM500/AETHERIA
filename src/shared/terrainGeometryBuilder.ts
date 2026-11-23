import * as THREE from 'three';
import { clamp } from './geo.ts';
import { isKnownBelowSeaBasin, sampleElevationGrid } from './terrainMath.ts';
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
  norm: Float32Array;
  col: Float32Array;
  uv?: Float32Array;
  index: Uint16Array | Uint32Array;
  vertexCount: number;
  indexCount: number;
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
  private norm: Float32Array;
  private col: Float32Array;
  private uv: Float32Array | null;
  private indices: Uint32Array;
  private vCount = 0;
  private vCap: number;
  private iCount = 0;
  private iCap: number;

  constructor(initialVertices = 4096, withUv = false) {
    this.vCap = Math.max(256, initialVertices);
    this.iCap = Math.max(512, Math.floor(this.vCap * 1.5));
    this.pos = new Float32Array(this.vCap * 3);
    this.norm = new Float32Array(this.vCap * 3);
    this.col = new Float32Array(this.vCap * 3);
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

    const nextNorm = new Float32Array(nextCap * 3);
    nextNorm.set(this.norm.subarray(0, this.vCount * 3));
    this.norm = nextNorm;

    const nextCol = new Float32Array(nextCap * 3);
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
    this.norm[i] = nx;
    this.norm[i + 1] = ny;
    this.norm[i + 2] = nz;
    this.col[i] = r;
    this.col[i + 1] = g;
    this.col[i + 2] = b;
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
  const stdBuilder = new IndexedTypedGeometryBuilder(Math.min(180000, buildings.length * 18 + 512));
  const towerBuilder = new IndexedTypedGeometryBuilder(4096);
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

  const builder = new IndexedTypedGeometryBuilder(Math.min(48000, roads.length * 48 + 512), true);
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

  const seaY = (0 - baseElevationM) * metersToSceneY * verticalExaggeration + 0.035;
  const builder = new IndexedTypedGeometryBuilder(8192, true);

  // 1. Coastal sea plane cells wherever DEM reaches sea level (<= 0.35m) on non-basin coastal tiles
  if (isCoastalTile && minElevationM <= 0.35 && rows >= 2 && cols >= 2) {
    const cellWaterThresholdM = 0.35;
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
        const cellMin = Math.min(e00, e10, e01, e11);
        if (cellMin > cellWaterThresholdM) continue;

        const u0 = c / (cols - 1);
        const u1 = (c + 1) / (cols - 1);
        const x0 = (u0 - 0.5) * chunkWidth;
        const x1 = (u1 - 0.5) * chunkWidth;

        // col.r encodes normalized shallow shore proximity (1 = deep water, 0 = shoreline)
        const d00 = clamp((0.4 - e00) / 3.5, 0, 1);
        const d10 = clamp((0.4 - e10) / 3.5, 0, 1);
        const d01 = clamp((0.4 - e01) / 3.5, 0, 1);
        const d11 = clamp((0.4 - e11) / 3.5, 0, 1);

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

  // 2. Explicit OSM MVT Water Polygons (lakes, riverbanks, canals, bays) & Waterways (rivers, canals, streams)
  for (let i = 0; i < waterFeatures.length; i++) {
    const wf = waterFeatures[i];
    if (wf.isPolygon && wf.rings.length > 0) {
      let contour = cleanRing2D(
        wf.rings[0].map(([u, v]) => new THREE.Vector2((clamp(u, 0, 1) - 0.5) * chunkWidth, -(clamp(v, 0, 1) - 0.5) * chunkDepth))
      );
      if (contour.length < 3) continue;
      if (THREE.ShapeUtils.isClockWise(contour)) contour = contour.reverse();

      const holes: THREE.Vector2[][] = [];
      for (let hIdx = 1; hIdx < wf.rings.length; hIdx++) {
        let hole = cleanRing2D(
          wf.rings[hIdx].map(
            ([u, v]) => new THREE.Vector2((clamp(u, 0, 1) - 0.5) * chunkWidth, -(clamp(v, 0, 1) - 0.5) * chunkDepth)
          )
        );
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

      let waterElevM = 0;
      if (wf.kind !== 'ocean') {
        let minSample = Infinity;
        let sumSample = 0;
        const outerPts = wf.rings[0];
        for (let k = 0; k < outerPts.length; k++) {
          const s = sampleElevationGrid(
            elevationsM,
            rows,
            cols,
            clamp(outerPts[k][0], 0, 1),
            clamp(outerPts[k][1], 0, 1)
          );
          if (s < minSample) minSample = s;
          sumSample += s;
        }
        const avgSample = sumSample / Math.max(1, outerPts.length);
        if (isCoastalTile && wf.kind === 'river' && minSample <= 1.2) {
          waterElevM = 0;
        } else {
          // Place inland lake/canal water slightly above the lowest sampled basin floor while staying inset from banks
          waterElevM = Math.min(avgSample + 0.15, minSample + 1.2);
        }
      }

      const wy =
        wf.kind === 'ocean' || (isCoastalTile && wf.kind === 'river' && waterElevM === 0)
          ? seaY + 0.005
          : (waterElevM - baseElevationM) * metersToSceneY * verticalExaggeration + 0.055;

      const flat2D: THREE.Vector2[] = [...contour];
      for (const h of holes) {
        for (const p of h) flat2D.push(p);
      }
      builder.ensureVerts(flat2D.length);
      builder.ensureIndices(faces.length * 3);

      const depthVal = wf.kind === 'ocean' ? 0.85 : wf.kind === 'lake' ? 0.72 : 0.62;
      const vIdx = new Int32Array(flat2D.length);
      for (let k = 0; k < flat2D.length; k++) {
        const p = flat2D[k];
        const x = p.x;
        const z = -p.y;
        vIdx[k] = builder.pushVertexFast(
          x,
          wy,
          z,
          0,
          1,
          0,
          depthVal,
          0.6,
          1.0,
          x / chunkWidth + 0.5,
          z / chunkDepth + 0.5
        );
      }
      for (let f = 0; f < faces.length; f++) {
        const [ia, ib, ic] = faces[f];
        if (ia >= flat2D.length || ib >= flat2D.length || ic >= flat2D.length) continue;
        builder.pushTri(vIdx[ia], vIdx[ib], vIdx[ic]);
      }
    } else if (!wf.isPolygon && wf.rings.length > 0 && wf.rings[0].length >= 2) {
      const halfW = clamp((wf.widthM ?? 14) * 0.5 * metersToSceneY, 0.08, 0.42);
      emitTerrainDrapedRibbon(
        builder,
        wf.rings[0],
        halfW,
        0.065,
        elevationsM,
        rows,
        cols,
        baseElevationM,
        metersToSceneY,
        chunkWidth,
        chunkDepth,
        verticalExaggeration,
        [0.18, 0.6, 1.0],
        [0.68, 0.6, 1.0]
      );
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
  } = input;

  const bRes = buildChunkBuildingsRaw({
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
  });

  if (!includeRoadsAndWater) {
    return {
      ...bRes,
      roadsGeo: null,
      waterGeo: null,
    };
  }

  const midLat = (payload.bounds.north + payload.bounds.south) * 0.5;
  const midLng = (payload.bounds.west + payload.bounds.east) * 0.5;
  const isCoastalTile = !isKnownBelowSeaBasin(midLat, midLng);

  const roadsGeo = payload.roads?.length
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

  const waterGeo = buildChunkWaterRaw({
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
