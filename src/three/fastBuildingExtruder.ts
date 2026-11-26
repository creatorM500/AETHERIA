import * as THREE from 'three';
import {
  ARCH_BASE_PALETTE,
  ARCH_ROOF_PALETTE,
  buildChunkBuildingsRaw,
  IndexedTypedGeometryBuilder,
  type RawIndexedBuffers,
} from '../shared/terrainGeometryBuilder.ts';
import type { TerrainBuildingFootprint } from '../shared/types.ts';

export { ARCH_BASE_PALETTE, ARCH_ROOF_PALETTE };

function releaseAttributeArrayAfterUpload(this: THREE.BufferAttribute) {
  const arr = this.array as THREE.TypedArray | undefined;
  if (arr && arr.length > 0) {
    const Ctor = arr.constructor as { new (len: number): THREE.TypedArray };
    (this as unknown as { array: THREE.TypedArray }).array = new Ctor(0);
  }
}

export function rawBuffersToThreeGeometry(
  raw: RawIndexedBuffers | null,
  releaseCpuAfterUpload = true
): THREE.BufferGeometry | null {
  if (!raw || raw.vertexCount === 0 || raw.indexCount === 0) return null;
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(raw.pos, 3);
  const normAttr = new THREE.BufferAttribute(raw.norm, 3, !(raw.norm instanceof Float32Array));
  const colAttr = new THREE.BufferAttribute(raw.col, 3, !(raw.col instanceof Float32Array));
  const idxAttr = new THREE.BufferAttribute(raw.index, 1);

  if (releaseCpuAfterUpload) {
    posAttr.onUpload(releaseAttributeArrayAfterUpload);
    normAttr.onUpload(releaseAttributeArrayAfterUpload);
    colAttr.onUpload(releaseAttributeArrayAfterUpload);
    idxAttr.onUpload(releaseAttributeArrayAfterUpload);
  }

  geo.setAttribute('position', posAttr);
  geo.setAttribute('normal', normAttr);
  geo.setAttribute('color', colAttr);
  if (raw.uv) {
    const uvAttr = new THREE.BufferAttribute(raw.uv, 2);
    if (releaseCpuAfterUpload) {
      uvAttr.onUpload(releaseAttributeArrayAfterUpload);
    }
    geo.setAttribute('uv', uvAttr);
  }
  geo.setIndex(idxAttr);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * High-speed indexed extruded buildings generator for a DEM terrain chunk.
 */
export function buildChunkBuildingsFast(opts: {
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
  stdGeo: THREE.BufferGeometry | null;
  towerGeo: THREE.BufferGeometry | null;
  builtCount: number;
} {
  const res = buildChunkBuildingsRaw(opts);
  return {
    stdGeo: rawBuffersToThreeGeometry(res.stdGeo),
    towerGeo: rawBuffersToThreeGeometry(res.towerGeo),
    builtCount: res.builtCount,
  };
}

/**
 * High-speed direct building extruder for tangent-plane chunks on the 3D spherical Globe.
 * Units are meters relative to the chunk tangent origin.
 */
export function buildGlobeTileBuildingsFast(opts: {
  buildings: TerrainBuildingFootprint[];
  projectUVMeters: (u: number, v: number) => { ex: number; sz: number; sagittaM: number };
  seedOffset?: number;
}): {
  stdGeo: THREE.BufferGeometry | null;
  towerGeo: THREE.BufferGeometry | null;
  builtCount: number;
} {
  const { buildings, projectUVMeters, seedOffset = 0 } = opts;
  const stdBuilder = new IndexedTypedGeometryBuilder(Math.min(64000, buildings.length * 14 + 256), false, true);
  const towerBuilder = new IndexedTypedGeometryBuilder(1024, false, true);
  const baseCol = new THREE.Color();
  const roofCol = new THREE.Color();
  let builtCount = 0;

  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b.outer.length < 3) continue;

    let minSagittaM = Infinity;
    const outerXZ: Array<[number, number]> = new Array(b.outer.length);
    const microShift = (((i + seedOffset) % 7) - 3) * 0.06;

    for (let k = 0; k < b.outer.length; k++) {
      const pt = projectUVMeters(b.outer[k][0], b.outer[k][1]);
      if (pt.sagittaM < minSagittaM) minSagittaM = pt.sagittaM;
      outerXZ[k] = [pt.ex + microShift, pt.sz - microShift];
    }

    const baseY = (Number.isFinite(minSagittaM) ? minSagittaM : 0) + b.minHeightM - 2.0;
    const topY = baseY + Math.max(3.5, b.heightM - b.minHeightM + 2.0);
    const isHighRise = b.heightM >= 28;
    const builder = isHighRise ? towerBuilder : stdBuilder;

    if (isHighRise) {
      const style = (i + seedOffset) % 3;
      if (style === 0) {
        baseCol.set('#13243a');
        roofCol.set('#447fa8');
      } else if (style === 1) {
        baseCol.set('#1c2738');
        roofCol.set('#5f85a6');
      } else {
        baseCol.set('#282524');
        roofCol.set('#7d705e');
      }
    } else {
      const pIdx = (i + seedOffset) % ARCH_BASE_PALETTE.length;
      const jitter = (((i + seedOffset) * 31) % 9) * 0.011;
      const bp = ARCH_BASE_PALETTE[pIdx];
      const rp = ARCH_ROOF_PALETTE[pIdx];
      baseCol.setRGB(bp[0] + jitter, bp[1] + jitter, bp[2] + jitter);
      roofCol.setRGB(rp[0] + jitter, rp[1] + jitter, rp[2] + jitter);
    }

    let contour = outerXZ.map(([x, z]) => new THREE.Vector2(x, -z));
    if (contour.length < 3) continue;
    if (THREE.ShapeUtils.isClockWise(contour)) contour = contour.reverse();
    let faces: number[][];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      continue;
    }
    if (faces.length === 0) continue;

    builder.ensureVerts(contour.length + contour.length * 4);
    builder.ensureIndices(faces.length * 3 + contour.length * 6);
    const roofIdx = new Int32Array(contour.length);
    for (let k = 0; k < contour.length; k++) {
      roofIdx[k] = builder.pushVertexFast(
        contour[k].x,
        topY,
        -contour[k].y,
        0,
        1,
        0,
        roofCol.r,
        roofCol.g,
        roofCol.b
      );
    }
    for (let f = 0; f < faces.length; f++) {
      const [ia, ib, ic] = faces[f];
      builder.pushTri(roofIdx[ia], roofIdx[ib], roofIdx[ic]);
    }
    for (let k = 0; k < contour.length; k++) {
      const p0 = contour[k];
      const p1 = contour[(k + 1) % contour.length];
      const ex = p1.x - p0.x;
      const ez = -p1.y - -p0.y;
      const len = Math.hypot(ex, ez);
      if (len < 1e-4) continue;
      builder.pushWallQuad(
        p0.x,
        -p0.y,
        p1.x,
        -p1.y,
        baseY,
        topY,
        -ez / len,
        ex / len,
        baseCol.r * 0.44,
        baseCol.g * 0.44,
        baseCol.b * 0.44,
        roofCol.r,
        roofCol.g,
        roofCol.b
      );
    }
    builtCount += 1;
  }

  return {
    stdGeo: rawBuffersToThreeGeometry(stdBuilder.toRawBuffers()),
    towerGeo: rawBuffersToThreeGeometry(towerBuilder.toRawBuffers()),
    builtCount,
  };
}
