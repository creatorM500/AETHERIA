import * as THREE from 'three';
import {
  clamp,
  latToTileY,
  lngToTileX,
  tileXToLng,
  tileYToLat,
} from '../shared/geo.ts';
import {
  computeSingleTileWindow,
  getTileNeighborhoodCoords,
  sampleElevationGrid,
  type SingleTileWindow,
} from '../shared/terrainMath.ts';
import type {
  GlobeTextureMode,
  PredictiveRouteResult,
  QualityTier,
  TerrainChunkPayload,
  TerrainHudStats,
  TerrainRoadPolyline,
} from '../shared/types.ts';
import { buildAllChunkGeometriesRaw } from '../shared/terrainGeometryBuilder.ts';
import { findNearestRoadInNormalizedTile } from '../shared/trafficCamera.ts';
import { rawBuffersToThreeGeometry } from './fastBuildingExtruder.ts';
import {
  applyGodsEyeBuildingShader,
  applyGodsEyeTerrainShader,
  applyRoadNetworkShader,
  type GodsEyeShaderUniforms,
  type Tier1MaskShaderBinding,
} from './godsEyeVisuals.ts';
import { createRealisticWaterMaterial } from './waterShader.ts';
import { TerrainGeometryWorkerPool } from './workerGeometryPool.ts';
import {
  streamSingleTileTextureIntoCanvas,
  trimTileCanvasCaches,
} from './worldTiles.ts';
import {
  getPersistedTerrainChunk,
  putPersistedTerrainChunk,
} from '../utils/terrainIndexedDbCache.ts';

const UNIT_TILE_WIDTH = 48; // 1 z=14 tile = 48 scene units (~2.4 km)
const Z14_COUNT = 16384; // 2^14
const Z12_COUNT = 4096; // 2^12
const MAX_CONCURRENT_CHUNK_FETCHES = 10;
const MAX_PAYLOAD_CACHE = 12;
const MAX_GPU_CHUNKS = 76; // 49 z=14 (7x7) + 25 z=12 (5x5) + small panning buffer

interface ActiveTerrainChunk {
  key: string;
  detailKey: string;
  tier: 1 | 2;
  dist2: number;
  isCoreTile: boolean;
  zoom: number;
  tx: number;
  ty: number;
  group: THREE.Group;
  terrainMesh: THREE.Mesh;
  terrainGeo: THREE.BufferGeometry;
  terrainMat: THREE.MeshStandardMaterial;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  stdMesh: THREE.Mesh | null;
  towerMesh: THREE.Mesh | null;
  roadsMesh: THREE.Mesh | null;
  waterMesh: THREE.Mesh | null;
  payload: TerrainChunkPayload;
  roadsIndex: TerrainRoadPolyline[];
  hasWaterFeatures: boolean;
  hasRoads: boolean;
  hasBuildings: boolean;
  chunkWidth: number;
  chunkDepth: number;
  builtExaggeration: number;
  builtWaterExaggeration: number;
  buildingsBuilt: number;
  buildingsPending: boolean;
  needsRehydrate: boolean;
  workerBuilding: boolean;
  buildEpoch: number;
  lastUsedMs: number;
  textureEpoch: number;
}

interface FetchQueueItem {
  key: string;
  tier: 1 | 2;
  dist2: number;
  isCoreTile: boolean;
  zoom: number;
  tx: number;
  ty: number;
  priority: number;
}

/**
 * Builds a terrain PlaneGeometry with flush surface vertices + downward vertical skirt
 * along the 4 outer edges so adjacent LOD tiers (z=14 <-> z=12) seal 100% without
 * distorting surface normals or creating dotted seam artifacts.
 */
function buildTerrainTileGeometry(
  payload: TerrainChunkPayload,
  width: number,
  depth: number,
  metersToSceneY: number,
  exaggeration: number,
  baseElevM: number,
  skirtDepth: number
): THREE.BufferGeometry {
  const { rows, cols, elevationsM } = payload;
  const segX = cols - 1;
  const segY = rows - 1;
  const baseGeo = new THREE.PlaneGeometry(width, depth, segX, segY);
  baseGeo.rotateX(-Math.PI / 2);

  const basePos = baseGeo.attributes.position as THREE.BufferAttribute;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const elev = elevationsM[idx] ?? baseElevM;
      const y = (elev - baseElevM) * metersToSceneY * exaggeration;
      basePos.setY(idx, y);
    }
  }
  basePos.needsUpdate = true;
  baseGeo.computeVertexNormals();

  if (skirtDepth <= 0) {
    baseGeo.computeBoundingSphere();
    return baseGeo;
  }

  const baseNorm = baseGeo.attributes.normal as THREE.BufferAttribute;
  const baseUv = baseGeo.attributes.uv as THREE.BufferAttribute;
  const baseIndex = baseGeo.getIndex()!;

  const perimCount = 2 * cols + 2 * rows;
  const skirtVerts = perimCount * 2;
  const totalVerts = basePos.count + skirtVerts;

  const posArr = new Float32Array(totalVerts * 3);
  const normArr = new Float32Array(totalVerts * 3);
  const uvArr = new Float32Array(totalVerts * 2);

  posArr.set(basePos.array as Float32Array);
  normArr.set(baseNorm.array as Float32Array);
  uvArr.set(baseUv.array as Float32Array);

  const indices: number[] = Array.from(baseIndex.array);
  let vCursor = basePos.count;

  const addSkirtEdge = (edgeIndices: number[], nx: number, nz: number) => {
    const startV = vCursor;
    for (let i = 0; i < edgeIndices.length; i++) {
      const vi = edgeIndices[i];
      const x = posArr[vi * 3];
      const y = posArr[vi * 3 + 1];
      const z = posArr[vi * 3 + 2];
      const u = uvArr[vi * 2];
      const v = uvArr[vi * 2 + 1];

      posArr[vCursor * 3] = x;
      posArr[vCursor * 3 + 1] = y;
      posArr[vCursor * 3 + 2] = z;
      normArr[vCursor * 3] = nx;
      normArr[vCursor * 3 + 1] = 0;
      normArr[vCursor * 3 + 2] = nz;
      uvArr[vCursor * 2] = u;
      uvArr[vCursor * 2 + 1] = v;
      vCursor++;

      posArr[vCursor * 3] = x;
      posArr[vCursor * 3 + 1] = y - skirtDepth;
      posArr[vCursor * 3 + 2] = z;
      normArr[vCursor * 3] = nx;
      normArr[vCursor * 3 + 1] = 0;
      normArr[vCursor * 3 + 2] = nz;
      uvArr[vCursor * 2] = u;
      uvArr[vCursor * 2 + 1] = v;
      vCursor++;
    }
    for (let i = 0; i < edgeIndices.length - 1; i++) {
      const t0 = startV + i * 2;
      const b0 = t0 + 1;
      const t1 = t0 + 2;
      const b1 = t0 + 3;
      // Outward-facing CCW winding so perimeter skirts never back-face cull
      indices.push(t0, b1, b0, t0, t1, b1);
    }
  };

  const northEdge: number[] = [];
  for (let c = 0; c < cols; c++) northEdge.push(c);
  addSkirtEdge(northEdge, 0, -1);

  const southEdge: number[] = [];
  for (let c = cols - 1; c >= 0; c--) southEdge.push((rows - 1) * cols + c);
  addSkirtEdge(southEdge, 0, 1);

  const westEdge: number[] = [];
  for (let r = rows - 1; r >= 0; r--) westEdge.push(r * cols);
  addSkirtEdge(westEdge, -1, 0);

  const eastEdge: number[] = [];
  for (let r = 0; r < rows; r++) eastEdge.push(r * cols + (cols - 1));
  addSkirtEdge(eastEdge, 1, 0);

  baseGeo.dispose();

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  out.setIndex(indices);
  out.userData = { rows, cols, skirtDepth };
  out.computeBoundingSphere();
  return out;
}

function updateTerrainGeometryHeights(
  geo: THREE.BufferGeometry,
  payload: TerrainChunkPayload,
  metersToSceneY: number,
  exaggeration: number,
  baseElevM: number
) {
  const { rows, cols, elevationsM } = payload;
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const baseCount = rows * cols;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const elev = elevationsM[idx] ?? baseElevM;
      const y = (elev - baseElevM) * metersToSceneY * exaggeration;
      posAttr.setY(idx, y);
    }
  }
  const skirtDepth = Number(geo.userData?.skirtDepth ?? 0);
  if (skirtDepth > 0 && posAttr.count > baseCount) {
    let cursor = baseCount;
    const syncEdge = (edge: number[]) => {
      for (const vi of edge) {
        const y = posAttr.getY(vi);
        posAttr.setY(cursor++, y);
        posAttr.setY(cursor++, y - skirtDepth);
      }
    };
    const northEdge: number[] = [];
    for (let c = 0; c < cols; c++) northEdge.push(c);
    syncEdge(northEdge);
    const southEdge: number[] = [];
    for (let c = cols - 1; c >= 0; c--) southEdge.push((rows - 1) * cols + c);
    syncEdge(southEdge);
    const westEdge: number[] = [];
    for (let r = rows - 1; r >= 0; r--) westEdge.push(r * cols);
    syncEdge(westEdge);
    const eastEdge: number[] = [];
    for (let r = 0; r < rows; r++) eastEdge.push(r * cols + (cols - 1));
    syncEdge(eastEdge);
  }
  posAttr.needsUpdate = true;
}

/**
 * Worldwide continuous multi-LOD 3D DEM + Imagery + 160k+ OSM Buildings streaming engine:
 * - Tier 1A (inner 3x3 z=14): full DEM (65px) + 1024px z=15 imagery + full buildings w/ courtyards + shadows
 * - Tier 1B (outer 7x7 z=14 ring, ~17x17km): 33px DEM + 512px z=14 imagery + fast quad-bypass buildings up to 160k+
 * - Tier 2 (5x5 z=12, ~48x48km): 49px DEM + 512px z=13 progressive mountain horizon fading seamlessly into fog
 */
export class GlobalTerrainStreamManager {
  public readonly root = new THREE.Group();
  private chunksGroup = new THREE.Group();
  private routeGroup = new THREE.Group();
  private cameraMarkerGroup = new THREE.Group();

  private uniforms: GodsEyeShaderUniforms;
  private textureMode: GlobeTextureMode;
  private verticalExaggeration = 1.45;
  private qualityTier: QualityTier;
  private maxAnisotropy: number;
  private shadowsEnabled: boolean;
  private isSoftwareGl: boolean;

  private stdBuildingMat: THREE.MeshStandardMaterial;
  private towerBuildingMat: THREE.MeshStandardMaterial;
  private roadNetworkMat: THREE.MeshStandardMaterial;
  private waterSurfaceMat: THREE.ShaderMaterial;
  private waterTier2Mat: THREE.ShaderMaterial;
  private workerPool: TerrainGeometryWorkerPool;

  private originTx = 0;
  private originTy = 0;
  private anchorWin: SingleTileWindow;
  private unitTileDepth = UNIT_TILE_WIDTH;
  private metersToSceneY = 1 / 50;
  private sessionBaseElevM: number | null = null;

  private focusLat = 0;
  private focusLng = 0;
  private activeRoute: PredictiveRouteResult | null = null;

  private payloadCache = new Map<string, TerrainChunkPayload>();
  private activeChunks = new Map<string, ActiveTerrainChunk>();
  private desiredKeys = new Set<string>();
  private fetchQueue: FetchQueueItem[] = [];
  private queuedKeys = new Set<string>();
  private inflightControllers = new Map<string, AbortController>();
  private buildQueue: string[] = [];
  private activeWorkerBuilds = 0;

  private lastCenterKey = '';
  private tier1BaseTx = 0;
  private tier1BaseTy = 0;
  private tier1MaskData = new Uint8Array(8 * 8 * 4);
  private tier1MaskTex: THREE.DataTexture;
  private tier1MaskBinding: Tier1MaskShaderBinding;
  private disposed = false;
  private onStatsChange?: (stats: TerrainHudStats) => void;
  private onAnchorReady?: (worldCenter: THREE.Vector3) => void;
  private onAssetUpdated?: () => void;
  private anchorSignaled = false;
  private lastStatsEmitMs = 0;

  constructor(opts: {
    lat: number;
    lng: number;
    textureMode: GlobeTextureMode;
    verticalExaggeration: number;
    qualityTier: QualityTier;
    maxAnisotropy: number;
    shadowsEnabled: boolean;
    isSoftwareGl: boolean;
    uniforms: GodsEyeShaderUniforms;
    route: PredictiveRouteResult | null;
    onStatsChange?: (stats: TerrainHudStats) => void;
    onAnchorReady?: (worldCenter: THREE.Vector3) => void;
    onAssetUpdated?: () => void;
  }) {
    this.textureMode = opts.textureMode;
    this.verticalExaggeration = opts.verticalExaggeration;
    this.qualityTier = opts.qualityTier;
    this.maxAnisotropy = opts.maxAnisotropy;
    this.shadowsEnabled = opts.shadowsEnabled;
    this.isSoftwareGl = opts.isSoftwareGl;
    this.uniforms = opts.uniforms;
    this.activeRoute = opts.route;
    this.onStatsChange = opts.onStatsChange;
    this.onAnchorReady = opts.onAnchorReady;
    this.onAssetUpdated = opts.onAssetUpdated;

    this.tier1MaskTex = new THREE.DataTexture(this.tier1MaskData, 8, 8, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tier1MaskTex.minFilter = THREE.NearestFilter;
    this.tier1MaskTex.magFilter = THREE.NearestFilter;
    this.tier1MaskTex.wrapS = THREE.ClampToEdgeWrapping;
    this.tier1MaskTex.wrapT = THREE.ClampToEdgeWrapping;
    this.tier1MaskTex.generateMipmaps = false;
    this.tier1MaskTex.needsUpdate = true;

    this.tier1MaskBinding = {
      hasMask: 1.0,
      maskTexUniform: { value: this.tier1MaskTex },
      originXZ: { value: new THREE.Vector2(0, 0) },
      tileSize: { value: new THREE.Vector2(UNIT_TILE_WIDTH, UNIT_TILE_WIDTH) },
    };

    this.root.add(this.chunksGroup, this.routeGroup, this.cameraMarkerGroup);

    this.stdBuildingMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.78,
      metalness: 0.12,
      envMapIntensity: 0.45,
    });
    applyGodsEyeBuildingShader(this.stdBuildingMat, this.uniforms, false, 1.0);

    this.towerBuildingMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.28,
      metalness: 0.72,
      envMapIntensity: 0.72,
    });
    applyGodsEyeBuildingShader(this.towerBuildingMat, this.uniforms, true, 1.0);

    this.roadNetworkMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.08,
      envMapIntensity: 0.25,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    applyRoadNetworkShader(this.roadNetworkMat, this.uniforms);

    this.waterSurfaceMat = createRealisticWaterMaterial(this.uniforms);
    this.waterTier2Mat = createRealisticWaterMaterial(
      this.uniforms,
      undefined,
      this.tier1MaskBinding
    );
    this.workerPool = new TerrainGeometryWorkerPool(2);

    this.anchorWin = computeSingleTileWindow(14, 0, 0);
    this.setAnchor(opts.lat, opts.lng);
  }

  private refreshTier1Mask() {
    let dMinX = this.tier1BaseTx - this.originTx;
    if (dMinX > Z14_COUNT / 2) dMinX -= Z14_COUNT;
    if (dMinX < -Z14_COUNT / 2) dMinX += Z14_COUNT;
    this.tier1MaskBinding.originXZ.value.set(
      dMinX * UNIT_TILE_WIDTH,
      (this.tier1BaseTy - this.originTy) * this.unitTileDepth
    );
    this.tier1MaskBinding.tileSize.value.set(UNIT_TILE_WIDTH, this.unitTileDepth);

    this.tier1MaskData.fill(0);
    for (let row = 0; row < 7; row++) {
      const ty = this.tier1BaseTy + row;
      if (ty < 0 || ty >= Z14_COUNT) continue;
      for (let col = 0; col < 7; col++) {
        const tx = (((this.tier1BaseTx + col) % Z14_COUNT) + Z14_COUNT) % Z14_COUNT;
        if (this.activeChunks.has(`14/${tx}/${ty}`)) {
          const p = (row * 8 + col) * 4;
          this.tier1MaskData[p] = 255;
          this.tier1MaskData[p + 1] = 255;
          this.tier1MaskData[p + 2] = 255;
          this.tier1MaskData[p + 3] = 255;
        }
      }
    }
    this.tier1MaskTex.needsUpdate = true;
  }

  public setAnchor(lat: number, lng: number) {
    this.clearActiveChunks();
    this.payloadCache.clear();
    this.cancelAllFetches();
    this.buildQueue = [];
    this.sessionBaseElevM = null;
    this.anchorSignaled = false;
    this.lastCenterKey = '';

    this.focusLat = lat;
    this.focusLng = lng;
    this.originTx = Math.floor(lngToTileX(lng, 14));
    this.originTy = clamp(Math.floor(latToTileY(lat, 14)), 0, Z14_COUNT - 1);
    this.anchorWin = computeSingleTileWindow(14, this.originTx, this.originTy);
    this.unitTileDepth = UNIT_TILE_WIDTH * (this.anchorWin.spanMetersZ / this.anchorWin.spanMetersX);
    this.metersToSceneY = UNIT_TILE_WIDTH / Math.max(250, this.anchorWin.spanMetersX);

    this.updateFocusLatLng(lat, lng);
  }

  public latLngToWorldXZ(lat: number, lng: number): [number, number] {
    const fTx = lngToTileX(lng, 14);
    const fTy = latToTileY(lat, 14);
    let dx = fTx - this.originTx;
    if (dx > Z14_COUNT / 2) dx -= Z14_COUNT;
    if (dx < -Z14_COUNT / 2) dx += Z14_COUNT;
    const dz = fTy - this.originTy;
    return [dx * UNIT_TILE_WIDTH, dz * this.unitTileDepth];
  }

  public worldXZToLatLng(x: number, z: number): { lat: number; lng: number } {
    const fTx = this.originTx + x / UNIT_TILE_WIDTH;
    const fTy = clamp(this.originTy + z / this.unitTileDepth, 0.001, Z14_COUNT - 0.001);
    const wrappedTx = ((fTx % Z14_COUNT) + Z14_COUNT) % Z14_COUNT;
    return {
      lat: tileYToLat(fTy, 14),
      lng: tileXToLng(wrappedTx, 14),
    };
  }

  private tileCenterToWorldXZ(zoom: number, tx: number, ty: number): { cx: number; cz: number; scale: number } {
    const scale = zoom === 14 ? 1 : Math.pow(2, 14 - zoom);
    const centerInZ14X = (tx + 0.5) * scale;
    const centerInZ14Y = (ty + 0.5) * scale;
    let dx = centerInZ14X - this.originTx;
    if (dx > Z14_COUNT / 2) dx -= Z14_COUNT;
    if (dx < -Z14_COUNT / 2) dx += Z14_COUNT;
    const dz = centerInZ14Y - this.originTy;
    return {
      cx: dx * UNIT_TILE_WIDTH,
      cz: dz * this.unitTileDepth,
      scale,
    };
  }

  public sampleElevationMetersAtWorldXZ(x: number, z: number): number | null {
    const ll = this.worldXZToLatLng(x, z);
    const cTx14 = Math.floor(lngToTileX(ll.lng, 14));
    const cTy14 = clamp(Math.floor(latToTileY(ll.lat, 14)), 0, Z14_COUNT - 1);
    const k14 = `14/${cTx14}/${cTy14}`;
    const c14 = this.activeChunks.get(k14);
    if (c14) {
      const fTx = lngToTileX(ll.lng, 14);
      const fTy = latToTileY(ll.lat, 14);
      const u = clamp(fTx - cTx14, 0, 1);
      const v = clamp(fTy - cTy14, 0, 1);
      return sampleElevationGrid(c14.payload.elevationsM, c14.payload.rows, c14.payload.cols, u, v);
    }

    const cTx12 = Math.floor(lngToTileX(ll.lng, 12));
    const cTy12 = clamp(Math.floor(latToTileY(ll.lat, 12)), 0, Z12_COUNT - 1);
    const k12 = `12/${cTx12}/${cTy12}`;
    const c12 = this.activeChunks.get(k12);
    if (c12) {
      const fTx = lngToTileX(ll.lng, 12);
      const fTy = latToTileY(ll.lat, 12);
      const u = clamp(fTx - cTx12, 0, 1);
      const v = clamp(fTy - cTy12, 0, 1);
      return sampleElevationGrid(c12.payload.elevationsM, c12.payload.rows, c12.payload.cols, u, v);
    }
    return null;
  }

  public sampleHeightAtWorldXZ(x: number, z: number): number {
    const ll = this.worldXZToLatLng(x, z);
    const cTx14 = Math.floor(lngToTileX(ll.lng, 14));
    const cTy14 = clamp(Math.floor(latToTileY(ll.lat, 14)), 0, Z14_COUNT - 1);
    const k14 = `14/${cTx14}/${cTy14}`;
    const c14 = this.activeChunks.get(k14);
    if (c14) {
      const fTx = lngToTileX(ll.lng, 14);
      const fTy = latToTileY(ll.lat, 14);
      const u = clamp(fTx - cTx14, 0, 1);
      const v = clamp(fTy - cTy14, 0, 1);
      const elevM = sampleElevationGrid(c14.payload.elevationsM, c14.payload.rows, c14.payload.cols, u, v);
      const base = this.sessionBaseElevM ?? c14.payload.minElevationM;
      return (elevM - base) * this.metersToSceneY * this.verticalExaggeration;
    }

    const cTx12 = Math.floor(lngToTileX(ll.lng, 12));
    const cTy12 = clamp(Math.floor(latToTileY(ll.lat, 12)), 0, Z12_COUNT - 1);
    const k12 = `12/${cTx12}/${cTy12}`;
    const c12 = this.activeChunks.get(k12);
    if (c12) {
      const fTx = lngToTileX(ll.lng, 12);
      const fTy = latToTileY(ll.lat, 12);
      const u = clamp(fTx - cTx12, 0, 1);
      const v = clamp(fTy - cTy12, 0, 1);
      const elevM = sampleElevationGrid(c12.payload.elevationsM, c12.payload.rows, c12.payload.cols, u, v);
      const base = this.sessionBaseElevM ?? c12.payload.minElevationM;
      return (elevM - base) * this.metersToSceneY * this.verticalExaggeration;
    }

    return 0;
  }

  public getCameraAltitudeMeters(cameraY: number, groundY: number): number {
    const scaleY = Math.max(1e-6, this.metersToSceneY * this.verticalExaggeration);
    return Math.max(0, Math.round((cameraY - groundY) / scaleY));
  }

  public raycastTerrain(raycaster: THREE.Raycaster): { point: THREE.Vector3; lat: number; lng: number } | null {
    const targets: THREE.Object3D[] = [];
    for (const chunk of this.activeChunks.values()) {
      targets.push(chunk.terrainMesh);
    }
    if (targets.length === 0) return null;
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const pt = hits[0].point;
    const ll = this.worldXZToLatLng(pt.x, pt.z);
    return { point: pt, lat: ll.lat, lng: ll.lng };
  }

  public pickRoadAtRay(raycaster: THREE.Raycaster): {
    road: TerrainRoadPolyline;
    lat: number;
    lng: number;
    elevationM: number;
    bearingDeg: number;
    worldPoint: THREE.Vector3;
  } | null {
    // Raycast terrainMesh (whose CPU vertex/index buffers stay resident; roadsMesh releases CPU arrays after GPU upload)
    const tHit = this.raycastTerrain(raycaster);
    if (!tHit || !Number.isFinite(tHit.point.x) || !Number.isFinite(tHit.point.z)) {
      return null;
    }

    const hitLL = tHit.lat !== undefined && Number.isFinite(tHit.lat) && Number.isFinite(tHit.lng)
      ? { lat: tHit.lat, lng: tHit.lng }
      : this.worldXZToLatLng(tHit.point.x, tHit.point.z);
    if (!Number.isFinite(hitLL.lat) || !Number.isFinite(hitLL.lng)) return null;

    const centerTx = Math.floor(lngToTileX(hitLL.lng, 14));
    const centerTy = clamp(Math.floor(latToTileY(hitLL.lat, 14)), 0, Z14_COUNT - 1);
    const maxDistNorm = 0.055;

    let bestResult: {
      road: TerrainRoadPolyline;
      lat: number;
      lng: number;
      bearingDeg: number;
      distNorm: number;
    } | null = null;

    const hitFTx = lngToTileX(hitLL.lng, 14);
    const hitFTy = latToTileY(hitLL.lat, 14);

    for (let dy = -1; dy <= 1; dy++) {
      const ty = centerTy + dy;
      if (ty < 0 || ty >= Z14_COUNT) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const tx = (((centerTx + dx) % Z14_COUNT) + Z14_COUNT) % Z14_COUNT;
        const chunk = this.activeChunks.get(`14/${tx}/${ty}`);
        if (!chunk || chunk.roadsIndex.length === 0) continue;

        let localU = hitFTx - tx;
        if (localU > Z14_COUNT / 2) localU -= Z14_COUNT;
        if (localU < -Z14_COUNT / 2) localU += Z14_COUNT;
        const localV = hitFTy - ty;

        const candidate = findNearestRoadInNormalizedTile(
          chunk.roadsIndex,
          localU,
          localV,
          maxDistNorm
        );
        if (!candidate) continue;
        if (!bestResult || candidate.distNorm < bestResult.distNorm) {
          const snapLng = tileXToLng(((tx + candidate.u) % Z14_COUNT + Z14_COUNT) % Z14_COUNT, 14);
          const snapLat = tileYToLat(clamp(ty + candidate.v, 0.001, Z14_COUNT - 0.001), 14);
          bestResult = {
            road: candidate.road,
            lat: snapLat,
            lng: snapLng,
            bearingDeg: candidate.bearingDeg,
            distNorm: candidate.distNorm,
          };
        }
      }
    }

    if (!bestResult) return null;

    const [wx, wz] = this.latLngToWorldXZ(bestResult.lat, bestResult.lng);
    const wy = this.sampleHeightAtWorldXZ(wx, wz);
    const elevM = this.sampleElevationMetersAtWorldXZ(wx, wz) ?? 0;
    return {
      road: bestResult.road,
      lat: bestResult.lat,
      lng: bestResult.lng,
      elevationM: Math.round(elevM),
      bearingDeg: bestResult.bearingDeg,
      worldPoint: new THREE.Vector3(wx, wy, wz),
    };
  }

  private clearCameraMarker() {
    while (this.cameraMarkerGroup.children.length > 0) {
      const child = this.cameraMarkerGroup.children[0];
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
      this.cameraMarkerGroup.remove(child);
    }
  }

  public setTrafficCameraMarker(
    marker: { lat: number; lng: number; bearingDeg: number } | null
  ) {
    this.clearCameraMarker();
    if (!marker) return;

    const [wx, wz] = this.latLngToWorldXZ(marker.lat, marker.lng);
    const wy = this.sampleHeightAtWorldXZ(wx, wz);

    // Road anchor ring
    const ringGeo = new THREE.RingGeometry(0.45, 0.72, 28);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.set(wx, wy + 0.16, wz);
    ringMesh.renderOrder = 9;

    // Vertical camera mast + glowing CCTV node
    const mastPts = [
      new THREE.Vector3(wx, wy + 0.16, wz),
      new THREE.Vector3(wx, wy + 2.35, wz),
    ];
    const mastGeo = new THREE.BufferGeometry().setFromPoints(mastPts);
    const mastMat = new THREE.LineBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.88,
    });
    const mastLine = new THREE.Line(mastGeo, mastMat);
    mastLine.renderOrder = 9;

    const headGeo = new THREE.SphereGeometry(0.26, 12, 10);
    const headMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
    });
    const headMesh = new THREE.Mesh(headGeo, headMat);
    headMesh.position.set(wx, wy + 2.45, wz);
    headMesh.renderOrder = 9;

    // Directional FOV cone wedge showing camera aim along road bearing
    const fovGeo = new THREE.ConeGeometry(0.75, 1.85, 16, 1, true);
    fovGeo.rotateX(Math.PI / 2);
    const fovMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const fovMesh = new THREE.Mesh(fovGeo, fovMat);
    const bearingRad = (marker.bearingDeg * Math.PI) / 180;
    const dirX = Math.sin(bearingRad);
    const dirZ = -Math.cos(bearingRad);
    fovMesh.position.set(wx + dirX * 0.95, wy + 1.85, wz + dirZ * 0.95);
    fovMesh.lookAt(wx + dirX * 4.5, wy + 0.35, wz + dirZ * 4.5);
    fovMesh.renderOrder = 8;

    this.cameraMarkerGroup.add(ringMesh, mastLine, headMesh, fovMesh);
  }

  public setTextureMode(mode: GlobeTextureMode) {
    if (this.textureMode === mode) return;
    const prevWasSatFamily = this.textureMode === 'satellite' || this.textureMode === 'godseye';
    const nextIsSatFamily = mode === 'satellite' || mode === 'godseye';
    this.textureMode = mode;

    // Both 'satellite' and 'godseye' share crisp raw Esri GPU textures while GLSL renders HDR hologram shading!
    if (prevWasSatFamily && nextIsSatFamily) {
      return;
    }

    for (const chunk of this.activeChunks.values()) {
      chunk.textureEpoch += 1;
      const myEpoch = chunk.textureEpoch;
      const highRes =
        (chunk.isCoreTile || chunk.tier === 2) &&
        !this.isSoftwareGl &&
        chunk.canvas.width >= 512;
      void streamSingleTileTextureIntoCanvas(
        mode,
        chunk.zoom,
        chunk.tx,
        chunk.ty,
        chunk.canvas,
        chunk.texture,
        highRes,
        () => this.disposed || myEpoch !== chunk.textureEpoch,
        () => {
          this.onAssetUpdated?.();
        }
      );
    }
  }

  private getTargetSimultaneousBuildings(): number {
    if (this.qualityTier === 'eco') return 115_000;
    if (this.qualityTier === 'balanced') return 145_000;
    return 175_000;
  }

  private pruneChunkVectorPayload(chunk: ActiveTerrainChunk) {
    if (
      chunk.payload.buildings.length === 0 &&
      (chunk.payload.roads?.length ?? 0) === 0 &&
      (chunk.payload.waterFeatures?.length ?? 0) === 0
    ) {
      return;
    }
    chunk.payload = {
      ...chunk.payload,
      buildings: [],
      roads: [],
      waterFeatures: [],
    };
    this.payloadCache.delete(chunk.detailKey);
  }

  private async dispatchChunkWorkerBuild(
    chunk: ActiveTerrainChunk,
    buildEpoch: number,
    skipBuildingsForCap: boolean,
    rehydrateFirst: boolean
  ) {
    const key = chunk.key;
    try {
      let payload = chunk.payload;
      if (rehydrateFirst) {
        const [gridSizeStr, maxBuildingsStr] = chunk.detailKey.split(':').slice(1);
        const idbKey = `v4:${chunk.detailKey}`;
        let hydrated =
          this.payloadCache.get(chunk.detailKey) ?? (await getPersistedTerrainChunk(idbKey));
        if (this.disposed) return;
        if (!hydrated) {
          const url = `/api/terrain/chunk?z=${chunk.zoom}&tx=${chunk.tx}&ty=${chunk.ty}&gridSize=${
            gridSizeStr || '49'
          }&buildings=${chunk.tier === 1 ? 1 : 0}&maxBuildings=${maxBuildingsStr || '0'}`;
          const res = await fetch(url);
          if (!res.ok) return;
          hydrated = (await res.json()) as TerrainChunkPayload;
          if (this.disposed) return;
          void putPersistedTerrainChunk(idbKey, hydrated);
        }
        payload = {
          ...chunk.payload,
          buildings: hydrated.buildings,
          roads: hydrated.roads,
          waterFeatures: hydrated.waterFeatures,
        };
        if (chunk.tier === 1 && chunk.roadsIndex.length === 0 && hydrated.roads?.length) {
          chunk.roadsIndex = hydrated.roads.slice();
        }
      }

      const targetBeforeBuild = this.activeChunks.get(key);
      if (!targetBeforeBuild || targetBeforeBuild.buildEpoch !== buildEpoch) {
        return;
      }

      const buildPayload: TerrainChunkPayload = skipBuildingsForCap
        ? { ...payload, buildings: [] }
        : payload;
      const base = this.sessionBaseElevM ?? payload.minElevationM;
      const skipWaterForWorker =
        chunk.waterMesh !== null &&
        Math.abs(chunk.builtWaterExaggeration - this.verticalExaggeration) < 0.01;
      if (!skipWaterForWorker) {
        chunk.builtWaterExaggeration = this.verticalExaggeration;
      }

      const rawOut = await this.workerPool.buildChunkGeometry(key, {
        payload: buildPayload,
        baseElevationM: base,
        metersToSceneY: this.metersToSceneY,
        chunkWidth: chunk.chunkWidth,
        chunkDepth: chunk.chunkDepth,
        verticalExaggeration: this.verticalExaggeration,
        seedOffset: chunk.tx * 13 + chunk.ty * 31,
        includeHoles: chunk.isCoreTile,
        includeRoadsAndWater: chunk.tier === 1,
        includeWater:
          chunk.tier === 2 &&
          (payload.minElevationM <= 0.42 || chunk.hasWaterFeatures),
        skipWater: skipWaterForWorker,
      });

      if (this.disposed) return;
      const targetChunk = this.activeChunks.get(key);
      if (!targetChunk) return;
      if (targetChunk.buildEpoch !== buildEpoch) {
        if (targetChunk.buildingsPending && !this.buildQueue.includes(key)) {
          this.buildQueue.unshift(key);
        }
        return;
      }

      this.applyChunkGeometryOutput(targetChunk, {
        stdGeo: rawBuffersToThreeGeometry(rawOut.stdGeo),
        towerGeo: rawBuffersToThreeGeometry(rawOut.towerGeo),
        roadsGeo: rawBuffersToThreeGeometry(rawOut.roadsGeo),
        waterGeo: skipWaterForWorker ? undefined : rawBuffersToThreeGeometry(rawOut.waterGeo),
        builtCount: rawOut.builtCount,
      });
      // Free heavy OSM building/road/water arrays from JS heap now that GPU buffers exist
      this.pruneChunkVectorPayload(targetChunk);
    } catch {
      const targetChunk = this.activeChunks.get(key);
      if (targetChunk && !this.disposed && targetChunk.buildingsPending && !this.buildQueue.includes(key)) {
        this.buildQueue.push(key);
      }
    } finally {
      this.activeWorkerBuilds = Math.max(0, this.activeWorkerBuilds - 1);
      const targetChunk = this.activeChunks.get(key);
      if (targetChunk) {
        targetChunk.workerBuilding = false;
      }
      if (!this.disposed && this.buildQueue.length === 0 && this.activeWorkerBuilds === 0) {
        this.emitCurrentStats(true);
      }
    }
  }

  public trimMemory() {
    this.payloadCache.clear();
    trimTileCanvasCaches();
    this.cancelAllFetches();
    this.lastCenterKey = '';

    for (const [key, chunk] of Array.from(this.activeChunks.entries())) {
      if (!chunk.isCoreTile) {
        this.disposeChunk(chunk);
        this.activeChunks.delete(key);
        this.desiredKeys.delete(key);
      } else if (!chunk.buildingsPending && !chunk.workerBuilding) {
        this.pruneChunkVectorPayload(chunk);
      }
    }
    this.buildQueue = this.buildQueue.filter((key) => this.activeChunks.has(key));
    this.refreshTier1Mask();
  }

  public setVerticalExaggeration(exag: number) {
    if (Math.abs(this.verticalExaggeration - exag) < 0.01) return;
    this.verticalExaggeration = exag;
    const base = this.sessionBaseElevM ?? 0;

    for (const chunk of this.activeChunks.values()) {
      updateTerrainGeometryHeights(
        chunk.terrainGeo,
        chunk.payload,
        this.metersToSceneY,
        this.verticalExaggeration,
        base
      );
      chunk.group.position.y = chunk.tier === 2 ? -0.10 : 0;
      const needsTier2Water =
        chunk.waterMesh !== null ||
        chunk.payload.minElevationM <= 0.42 ||
        chunk.hasWaterFeatures;

      if (chunk.tier === 1) {
        chunk.buildEpoch += 1;
        const hasNeededVectors =
          (!chunk.hasBuildings || chunk.payload.buildings.length > 0) &&
          (!chunk.hasRoads || (chunk.payload.roads?.length ?? 0) > 0) &&
          (!chunk.hasWaterFeatures || (chunk.payload.waterFeatures?.length ?? 0) > 0);
        chunk.needsRehydrate = !hasNeededVectors;
        chunk.buildingsPending = true;
        if (!this.buildQueue.includes(chunk.key)) {
          this.buildQueue.push(chunk.key);
        }
      } else if (needsTier2Water) {
        chunk.buildEpoch += 1;
        const missingWaterVectors =
          chunk.hasWaterFeatures && (chunk.payload.waterFeatures?.length ?? 0) === 0;
        chunk.needsRehydrate = missingWaterVectors;
        chunk.buildingsPending = true;
        if (!this.buildQueue.includes(chunk.key)) {
          this.buildQueue.push(chunk.key);
        }
      }
    }
    this.buildQueue.sort((ka, kb) => {
      const ca = this.activeChunks.get(ka);
      const cb = this.activeChunks.get(kb);
      return (ca?.dist2 ?? 99) - (cb?.dist2 ?? 99);
    });
    this.rebuildRouteRibbon();
  }

  public setQualityTier(tier: QualityTier, shadowsEnabled: boolean) {
    this.qualityTier = tier;
    this.shadowsEnabled = shadowsEnabled;
    for (const chunk of this.activeChunks.values()) {
      chunk.terrainMesh.receiveShadow = shadowsEnabled;
      const cast = shadowsEnabled && chunk.isCoreTile;
      if (chunk.stdMesh) {
        chunk.stdMesh.castShadow = cast;
        chunk.stdMesh.receiveShadow = shadowsEnabled;
      }
      if (chunk.towerMesh) {
        chunk.towerMesh.castShadow = cast;
        chunk.towerMesh.receiveShadow = shadowsEnabled;
      }
    }
  }

  public updateRoute(route: PredictiveRouteResult | null) {
    this.activeRoute = route;
    this.rebuildRouteRibbon();
  }

  public updateFocusWorldXZ(worldX: number, worldZ: number) {
    const ll = this.worldXZToLatLng(worldX, worldZ);
    this.updateFocusLatLng(ll.lat, ll.lng);
  }

  private getChunkBuildSpec(
    tier: 1 | 2,
    isCoreTile: boolean,
    dist2 = 0
  ): { gridSize: number; maxBuildings: number } {
    const gridSize =
      tier === 1
        ? this.qualityTier === 'ultra'
          ? 65
          : 49
        : this.qualityTier === 'eco'
          ? 33
          : 49;
    const maxBuildings =
      tier === 1
        ? isCoreTile
          ? 18000
          : dist2 <= 8
            ? this.qualityTier === 'eco'
              ? 11000
              : 14000
            : this.qualityTier === 'eco'
              ? 7500
              : 10500
        : 0;
    return { gridSize, maxBuildings };
  }

  private getPayloadCacheKey(key: string, tier: 1 | 2, isCoreTile: boolean, dist2 = 0): string {
    const { gridSize, maxBuildings } = this.getChunkBuildSpec(tier, isCoreTile, dist2);
    return `${key}:${gridSize}:${maxBuildings}`;
  }

  public updateFocusLatLng(lat: number, lng: number) {
    if (this.disposed) return;
    this.focusLat = lat;
    this.focusLng = lng;

    const cTx14 = Math.floor(lngToTileX(lng, 14));
    const cTy14 = clamp(Math.floor(latToTileY(lat, 14)), 0, Z14_COUNT - 1);
    const cTx12 = Math.floor(lngToTileX(lng, 12));
    const cTy12 = clamp(Math.floor(latToTileY(lat, 12)), 0, Z12_COUNT - 1);

    const centerKey = `${cTx14}/${cTy14}`;
    if (centerKey === this.lastCenterKey) return;
    this.lastCenterKey = centerKey;
    this.tier1BaseTx = cTx14 - 3;
    this.tier1BaseTy = cTy14 - 3;

    const nextDesired = new Set<string>();
    const nextFetchList: FetchQueueItem[] = [];

    // Tier 1 (7x7 z=14 = 49 tiles = ~16.8 x 16.8 km): inner 3x3 Tier 1A + outer 40-tile Tier 1B -> 160k+ buildings
    const ring14 = getTileNeighborhoodCoords(cTx14, cTy14, 14, 3);
    for (const item of ring14) {
      const key = `14/${item.tx}/${item.ty}`;
      const isCoreTile = item.dist2 <= 2;
      nextDesired.add(key);

      const existing = this.activeChunks.get(key);
      if (existing) {
        existing.lastUsedMs = performance.now();
        existing.dist2 = item.dist2;
        existing.isCoreTile = isCoreTile;
        continue;
      }

      const detailKey = this.getPayloadCacheKey(key, 1, isCoreTile, item.dist2);
      const cachedPayload = this.payloadCache.get(detailKey);
      if (cachedPayload) {
        this.attachChunkFromPayload(key, detailKey, 1, item.dist2, isCoreTile, cachedPayload);
        continue;
      }

      if (!this.inflightControllers.has(key) && !this.queuedKeys.has(key)) {
        nextFetchList.push({
          key,
          tier: 1,
          dist2: item.dist2,
          isCoreTile,
          zoom: 14,
          tx: item.tx,
          ty: item.ty,
          priority: item.dist2,
        });
      }
    }

    // Tier 2 (5x5 z=12 = 25 tiles = ~48 x 48 km): progressive z=13 mountain horizon
    const ring12 = getTileNeighborhoodCoords(cTx12, cTy12, 12, 2);
    for (const item of ring12) {
      const key = `12/${item.tx}/${item.ty}`;
      nextDesired.add(key);

      const existing = this.activeChunks.get(key);
      if (existing) {
        existing.lastUsedMs = performance.now();
        existing.dist2 = item.dist2;
        continue;
      }

      const detailKey = this.getPayloadCacheKey(key, 2, false, item.dist2);
      const cachedPayload = this.payloadCache.get(detailKey);
      if (cachedPayload) {
        this.attachChunkFromPayload(key, detailKey, 2, item.dist2, false, cachedPayload);
        continue;
      }

      if (!this.inflightControllers.has(key) && !this.queuedKeys.has(key)) {
        nextFetchList.push({
          key,
          tier: 2,
          dist2: item.dist2,
          isCoreTile: false,
          zoom: 12,
          tx: item.tx,
          ty: item.ty,
          priority: 6 + item.dist2,
        });
      }
    }

    this.desiredKeys = nextDesired;

    for (const [key, ctrl] of this.inflightControllers.entries()) {
      if (!nextDesired.has(key)) {
        ctrl.abort();
        this.inflightControllers.delete(key);
      }
    }

    this.fetchQueue = this.fetchQueue.filter((q) => nextDesired.has(q.key));
    this.queuedKeys.clear();
    for (const q of this.fetchQueue) this.queuedKeys.add(q.key);
    for (const q of nextFetchList) {
      if (!this.queuedKeys.has(q.key)) {
        this.fetchQueue.push(q);
        this.queuedKeys.add(q.key);
      }
    }
    this.fetchQueue.sort((a, b) => a.priority - b.priority);

    if (this.activeChunks.size > MAX_GPU_CHUNKS) {
      const evictCandidates = Array.from(this.activeChunks.values())
        .filter((c) => !this.desiredKeys.has(c.key))
        .sort((a, b) => a.lastUsedMs - b.lastUsedMs);
      while (this.activeChunks.size > MAX_GPU_CHUNKS && evictCandidates.length > 0) {
        const victim = evictCandidates.shift()!;
        this.disposeChunk(victim);
        this.activeChunks.delete(victim.key);
      }
    }

    this.refreshTier1Mask();
    this.pumpFetchQueue();
    this.emitCurrentStats(true);
  }

  private pumpFetchQueue() {
    while (
      this.inflightControllers.size < MAX_CONCURRENT_CHUNK_FETCHES &&
      this.fetchQueue.length > 0 &&
      !this.disposed
    ) {
      const spec = this.fetchQueue.shift()!;
      this.queuedKeys.delete(spec.key);
      if (!this.desiredKeys.has(spec.key)) continue;
      if (this.activeChunks.has(spec.key) || this.inflightControllers.has(spec.key)) continue;

      const controller = new AbortController();
      this.inflightControllers.set(spec.key, controller);

      const { gridSize, maxBuildings } = this.getChunkBuildSpec(spec.tier, spec.isCoreTile, spec.dist2);
      const detailKey = `${spec.key}:${gridSize}:${maxBuildings}`;
      const url = `/api/terrain/chunk?z=${spec.zoom}&tx=${spec.tx}&ty=${spec.ty}&gridSize=${gridSize}&buildings=${
        spec.tier === 1 ? 1 : 0
      }&maxBuildings=${maxBuildings}`;
      const idbKey = `v4:${detailKey}`;

      void (async () => {
        try {
          let payload = await getPersistedTerrainChunk(idbKey);
          if (this.disposed || controller.signal.aborted) return;

          if (!payload) {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) return;
            payload = (await res.json()) as TerrainChunkPayload;
            if (this.disposed || controller.signal.aborted) return;
            void putPersistedTerrainChunk(idbKey, payload);
          }

          if (this.payloadCache.size >= MAX_PAYLOAD_CACHE) {
            const oldest = this.payloadCache.keys().next().value;
            if (oldest) this.payloadCache.delete(oldest);
          }
          this.payloadCache.set(detailKey, payload);

          if (this.desiredKeys.has(spec.key) && !this.activeChunks.has(spec.key)) {
            this.attachChunkFromPayload(
              spec.key,
              detailKey,
              spec.tier,
              spec.dist2,
              spec.isCoreTile,
              payload
            );
          }
        } catch {
          // Ignore transient or aborted fetch errors
        } finally {
          this.inflightControllers.delete(spec.key);
          this.pumpFetchQueue();
        }
      })();
    }
  }

  private attachChunkFromPayload(
    key: string,
    detailKey: string,
    tier: 1 | 2,
    dist2: number,
    isCoreTile: boolean,
    payload: TerrainChunkPayload
  ) {
    if (this.disposed || this.activeChunks.has(key)) return;

    if (this.sessionBaseElevM === null) {
      this.sessionBaseElevM = payload.minElevationM;
    }

    const { cx, cz, scale } = this.tileCenterToWorldXZ(payload.zoom, payload.tx, payload.ty);
    const chunkWidth = UNIT_TILE_WIDTH * scale;
    const chunkDepth = this.unitTileDepth * scale;

    const group = new THREE.Group();
    group.position.set(cx, tier === 2 ? -0.10 : 0, cz);

    const terrainGeo = buildTerrainTileGeometry(
      payload,
      chunkWidth,
      chunkDepth,
      this.metersToSceneY,
      this.verticalExaggeration,
      this.sessionBaseElevM,
      tier === 1 ? 4.5 : 2.5
    );

    // Match texture dimensions 1:1 to fetched Esri tile grids (2x2 256px = 512px, 1x 256px = 256px)
    const texPx =
      tier === 1
        ? isCoreTile
          ? this.isSoftwareGl
            ? 256
            : 512
          : 256
        : this.qualityTier === 'ultra' && !this.isSoftwareGl
          ? 512
          : 256;
    const canvas = document.createElement('canvas');
    canvas.width = texPx;
    canvas.height = texPx;

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.maxAnisotropy;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;

    const terrainMat = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.9,
      metalness: 0.04,
      envMapIntensity: 0.25,
    });
    applyGodsEyeTerrainShader(terrainMat, this.uniforms, tier === 2 ? this.tier1MaskBinding : undefined);

    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainMesh.receiveShadow = this.shadowsEnabled;
    group.add(terrainMesh);

    const hasWaterFeatures = Boolean(payload.waterFeatures?.length);
    const hasRoads = Boolean(payload.roads?.length);
    const hasBuildings = payload.buildings.length > 0;
    const hasWaterSurface = payload.minElevationM <= 0.42 || hasWaterFeatures;
    const hasImmediateNonBuilding =
      hasWaterSurface || (tier === 1 && !hasBuildings && hasRoads);
    const needsTier1WorkerBuild = tier === 1 && hasBuildings;

    const chunk: ActiveTerrainChunk = {
      key,
      detailKey,
      tier,
      dist2,
      isCoreTile,
      zoom: payload.zoom,
      tx: payload.tx,
      ty: payload.ty,
      group,
      terrainMesh,
      terrainGeo,
      terrainMat,
      canvas,
      texture,
      stdMesh: null,
      towerMesh: null,
      roadsMesh: null,
      waterMesh: null,
      payload,
      roadsIndex: tier === 1 && payload.roads ? payload.roads.slice() : [],
      hasWaterFeatures,
      hasRoads,
      hasBuildings,
      chunkWidth,
      chunkDepth,
      builtExaggeration: this.verticalExaggeration,
      builtWaterExaggeration: hasWaterSurface ? this.verticalExaggeration : -1,
      buildingsBuilt: 0,
      buildingsPending: needsTier1WorkerBuild,
      needsRehydrate: false,
      workerBuilding: false,
      buildEpoch: 1,
      lastUsedMs: performance.now(),
      textureEpoch: 1,
    };

    this.chunksGroup.add(group);
    this.activeChunks.set(key, chunk);
    if (tier === 1) {
      this.refreshTier1Mask();
    }

    const myEpoch = chunk.textureEpoch;
    const highRes = (isCoreTile || tier === 2) && !this.isSoftwareGl && texPx >= 512;
    void streamSingleTileTextureIntoCanvas(
      this.textureMode,
      payload.zoom,
      payload.tx,
      payload.ty,
      canvas,
      texture,
      highRes,
      () => this.disposed || myEpoch !== chunk.textureEpoch,
      () => {
        this.onAssetUpdated?.();
      }
    );

    if (hasImmediateNonBuilding) {
      const base = this.sessionBaseElevM ?? payload.minElevationM;
      const syncOut = buildAllChunkGeometriesRaw({
        payload: { ...payload, buildings: [] },
        baseElevationM: base,
        metersToSceneY: this.metersToSceneY,
        chunkWidth,
        chunkDepth,
        verticalExaggeration: this.verticalExaggeration,
        seedOffset: payload.tx * 13 + payload.ty * 31,
        includeHoles: false,
        includeRoadsAndWater: tier === 1 && !hasBuildings && hasRoads,
        includeWater: hasWaterSurface,
        skipWater: !hasWaterSurface,
      });
      if (syncOut.roadsGeo || syncOut.waterGeo) {
        this.applyChunkGeometryOutput(chunk, {
          stdGeo: null,
          towerGeo: null,
          roadsGeo: rawBuffersToThreeGeometry(syncOut.roadsGeo),
          waterGeo: rawBuffersToThreeGeometry(syncOut.waterGeo),
          builtCount: 0,
        });
      }
    }

    if (chunk.buildingsPending) {
      this.buildQueue.push(key);
      this.buildQueue.sort((ka, kb) => {
        const ca = this.activeChunks.get(ka);
        const cb = this.activeChunks.get(kb);
        return (ca?.dist2 ?? 99) - (cb?.dist2 ?? 99);
      });
    } else {
      // No worker build queued: immediately free heavy OSM vector arrays from JS heap
      this.pruneChunkVectorPayload(chunk);
    }

    if (!this.anchorSignaled && tier === 1) {
      const [wx, wz] = this.latLngToWorldXZ(this.focusLat, this.focusLng);
      const wy = this.sampleHeightAtWorldXZ(wx, wz);
      this.anchorSignaled = true;
      this.onAnchorReady?.(new THREE.Vector3(wx, wy, wz));
      this.rebuildRouteRibbon();
    }

    this.onAssetUpdated?.();
    this.emitCurrentStats(false);
  }

  public hasPendingWork(): boolean {
    return (
      this.inflightControllers.size > 0 ||
      this.buildQueue.length > 0 ||
      this.activeWorkerBuilds > 0
    );
  }

  private applyChunkGeometryOutput(
    chunk: ActiveTerrainChunk,
    output: {
      stdGeo: ReturnType<typeof rawBuffersToThreeGeometry>;
      towerGeo: ReturnType<typeof rawBuffersToThreeGeometry>;
      roadsGeo: ReturnType<typeof rawBuffersToThreeGeometry>;
      waterGeo?: ReturnType<typeof rawBuffersToThreeGeometry>;
      builtCount: number;
    }
  ) {
    if (chunk.stdMesh) {
      chunk.stdMesh.geometry.dispose();
      chunk.group.remove(chunk.stdMesh);
      chunk.stdMesh = null;
    }
    if (chunk.towerMesh) {
      chunk.towerMesh.geometry.dispose();
      chunk.group.remove(chunk.towerMesh);
      chunk.towerMesh = null;
    }
    if (chunk.roadsMesh) {
      chunk.roadsMesh.geometry.dispose();
      chunk.group.remove(chunk.roadsMesh);
      chunk.roadsMesh = null;
    }
    if (output.waterGeo !== undefined && chunk.waterMesh) {
      chunk.waterMesh.geometry.dispose();
      chunk.group.remove(chunk.waterMesh);
      chunk.waterMesh = null;
    }

    const castShadow = this.shadowsEnabled && chunk.isCoreTile;
    if (output.stdGeo) {
      const m = new THREE.Mesh(output.stdGeo, this.stdBuildingMat);
      m.castShadow = castShadow;
      m.receiveShadow = this.shadowsEnabled;
      chunk.group.add(m);
      chunk.stdMesh = m;
    }
    if (output.towerGeo) {
      const m = new THREE.Mesh(output.towerGeo, this.towerBuildingMat);
      m.castShadow = castShadow;
      m.receiveShadow = this.shadowsEnabled;
      chunk.group.add(m);
      chunk.towerMesh = m;
    }
    if (output.roadsGeo) {
      const m = new THREE.Mesh(output.roadsGeo, this.roadNetworkMat);
      m.receiveShadow = this.shadowsEnabled;
      m.renderOrder = 1;
      chunk.group.add(m);
      chunk.roadsMesh = m;
    }
    if (output.waterGeo) {
      const mat = chunk.tier === 2 ? this.waterTier2Mat : this.waterSurfaceMat;
      const m = new THREE.Mesh(output.waterGeo, mat);
      // Offset Tier-2 water upward by +0.10 to match Tier-1 seaY despite chunk.group.y = -0.10
      m.position.y = chunk.tier === 2 ? 0.10 : 0;
      m.renderOrder = 2;
      chunk.group.add(m);
      chunk.waterMesh = m;
    }

    chunk.buildingsBuilt = output.builtCount;
    this.onAssetUpdated?.();
    this.emitCurrentStats(this.buildQueue.length === 0 && this.activeWorkerBuilds === 0);
  }

  /**
   * Dispatches pending OSM buildings, vector roads, and coastal/river water mesh construction
   * to the background Web Worker pool (transferring zero-copy TypedArrays) with main-thread fallback.
   */
  public stepFrame() {
    if (this.disposed || this.buildQueue.length === 0) return;

    let currentTotalBuildings = 0;
    for (const c of this.activeChunks.values()) {
      if (c.tier === 1) currentTotalBuildings += c.buildingsBuilt;
    }

    const targetBuildings = this.getTargetSimultaneousBuildings();
    const maxConcurrentWorkerBuilds = this.workerPool.isWorkerBacked ? 4 : 1;
    while (this.buildQueue.length > 0 && this.activeWorkerBuilds < maxConcurrentWorkerBuilds) {
      const key = this.buildQueue.shift()!;
      const chunk = this.activeChunks.get(key);
      if (!chunk || !chunk.buildingsPending || chunk.workerBuilding) continue;

      chunk.buildingsPending = false;
      const rehydrateFirst = chunk.needsRehydrate;
      chunk.needsRehydrate = false;
      chunk.builtExaggeration = this.verticalExaggeration;

      const skipBuildingsForCap =
        chunk.tier === 2 || (!chunk.isCoreTile && currentTotalBuildings >= targetBuildings);
      const buildEpoch = chunk.buildEpoch;
      chunk.workerBuilding = true;
      this.activeWorkerBuilds += 1;

      void this.dispatchChunkWorkerBuild(chunk, buildEpoch, skipBuildingsForCap, rehydrateFirst);

      // Optimistically reserve count to avoid over-dispatching beyond tier cap
      if (!skipBuildingsForCap) {
        currentTotalBuildings += chunk.payload.buildings.length || chunk.buildingsBuilt;
      }
    }
  }

  private rebuildRouteRibbon() {
    while (this.routeGroup.children.length > 0) {
      const child = this.routeGroup.children[0];
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
      this.routeGroup.remove(child);
    }

    if (!this.activeRoute || this.activeRoute.polylinePath.length < 2) return;

    const pts: THREE.Vector3[] = [];
    for (const p of this.activeRoute.polylinePath) {
      const [wx, wz] = this.latLngToWorldXZ(p.lat, p.lng);
      if (Math.hypot(wx, wz) > 640) continue;
      const wy = this.sampleHeightAtWorldXZ(wx, wz);
      pts.push(new THREE.Vector3(wx, wy + 0.42, wz));
    }

    if (pts.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(pts);
      const ribbonGeo = new THREE.TubeGeometry(curve, Math.min(240, pts.length * 4), 0.34, 8, false);
      const ribbonMat = new THREE.MeshStandardMaterial({
        color: 0x22d3ee,
        emissive: 0x06b6d4,
        emissiveIntensity: 1.5,
        roughness: 0.25,
      });
      this.routeGroup.add(new THREE.Mesh(ribbonGeo, ribbonMat));
    }
  }

  private emitCurrentStats(force = false) {
    const now = performance.now();
    if (!force && now - this.lastStatsEmitMs < 150) {
      return;
    }
    this.lastStatsEmitMs = now;

    let minElev = Infinity;
    let maxElev = -Infinity;
    let totalBuildings = 0;
    let activeTier1Count = 0;
    let totalChunks = 0;
    let demSource = 'terrarium-dem';
    let buildingsSource = 'versatiles-osm';

    for (const c of this.activeChunks.values()) {
      totalChunks += 1;
      if (c.tier === 1) {
        activeTier1Count += 1;
        totalBuildings += c.buildingsBuilt;
        if (c.payload.buildingsSource !== 'none') {
          buildingsSource = c.payload.buildingsSource;
        }
      }
      if (c.payload.minElevationM < minElev) minElev = c.payload.minElevationM;
      if (c.payload.maxElevationM > maxElev) maxElev = c.payload.maxElevationM;
      demSource = c.payload.demSource;
    }

    const loading = this.inflightControllers.size > 0 || this.buildQueue.length > 0;
    const stage: TerrainHudStats['stage'] =
      totalChunks === 0 && loading
        ? 'dem'
        : this.buildQueue.length > 0
          ? 'buildings'
          : 'ready';

    this.onStatsChange?.({
      loading: activeTier1Count === 0 && loading,
      stage,
      minElevationM: Number.isFinite(minElev) ? Math.round(minElev) : 0,
      maxElevationM: Number.isFinite(maxElev) ? Math.round(maxElev) : 0,
      buildingsCount: totalBuildings,
      spanKm: 48.0,
      chunksLoaded: totalChunks,
      demSource,
      buildingsSource,
      qualityTier: this.qualityTier,
    });
  }

  private disposeChunk(chunk: ActiveTerrainChunk) {
    chunk.textureEpoch += 1;
    chunk.buildEpoch += 1;
    chunk.terrainGeo.dispose();
    chunk.terrainMat.dispose();
    chunk.texture.dispose();
    chunk.canvas.width = 0;
    chunk.canvas.height = 0;
    if (chunk.stdMesh) chunk.stdMesh.geometry.dispose();
    if (chunk.towerMesh) chunk.towerMesh.geometry.dispose();
    if (chunk.roadsMesh) chunk.roadsMesh.geometry.dispose();
    if (chunk.waterMesh) chunk.waterMesh.geometry.dispose();
    this.chunksGroup.remove(chunk.group);
  }

  private clearActiveChunks() {
    for (const chunk of this.activeChunks.values()) {
      this.disposeChunk(chunk);
    }
    this.activeChunks.clear();
  }

  private cancelAllFetches() {
    for (const ctrl of this.inflightControllers.values()) {
      ctrl.abort();
    }
    this.inflightControllers.clear();
    this.fetchQueue = [];
    this.queuedKeys.clear();
  }

  public dispose() {
    this.disposed = true;
    this.cancelAllFetches();
    this.clearActiveChunks();
    this.clearCameraMarker();
    this.payloadCache.clear();
    this.workerPool.dispose();
    while (this.routeGroup.children.length > 0) {
      const child = this.routeGroup.children[0];
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
      this.routeGroup.remove(child);
    }
    this.stdBuildingMat.dispose();
    this.towerBuildingMat.dispose();
    this.roadNetworkMat.dispose();
    this.waterSurfaceMat.dispose();
    this.waterTier2Mat.dispose();
    this.tier1MaskTex.dispose();
  }
}
