import * as THREE from 'three';
import {
  clamp,
  latLngToCartesian,
  latToTileY,
  lngToTileX,
  tileXToLng,
  tileYToLat,
} from '../shared/geo.ts';
import { getTileNeighborhoodCoords } from '../shared/terrainMath.ts';
import type { TerrainChunkPayload } from '../shared/types.ts';
import { buildGlobeTileBuildingsFast } from './fastBuildingExtruder.ts';
import {
  applyGodsEyeBuildingShader,
  type GodsEyeShaderUniforms,
} from './godsEyeVisuals.ts';

const EARTH_RADIUS_M = 6_371_000;
const Z14_COUNT = 16384;
const MAX_CONCURRENT_CHUNKS = 4;
const MAX_CACHED_CHUNKS = 10;

interface GlobeChunkEntry {
  key: string;
  tx: number;
  ty: number;
  group: THREE.Group;
  stdMesh: THREE.Mesh | null;
  towerMesh: THREE.Mesh | null;
  lastUsedMs: number;
}

function tileUVToLatLng(u: number, v: number, tx: number, ty: number): { lat: number; lng: number } {
  const fTx = tx + u;
  const fTy = clamp(ty + v, 0.001, Z14_COUNT - 0.001);
  return {
    lat: tileYToLat(fTy, 14),
    lng: tileXToLng(((fTx % Z14_COUNT) + Z14_COUNT) % Z14_COUNT, 14),
  };
}

/**
 * Renders ALL real extruded 3D OSM houses & skyscrapers directly onto the curved 3D Globe
 * using a sliding 3x3 z=14 tile chunk cache at neighborhood / street zoom (z >= 15).
 */
export class GlobeStreetBuildingsManager {
  public readonly group = new THREE.Group();
  private globeRadius: number;
  private stdMat: THREE.MeshStandardMaterial;
  private towerMat: THREE.MeshStandardMaterial;

  private chunks = new Map<string, GlobeChunkEntry>();
  private payloadCache = new Map<string, TerrainChunkPayload>();
  private desiredKeys = new Set<string>();
  private inflight = new Map<string, AbortController>();
  private fetchQueue: Array<{ key: string; tx: number; ty: number; priority: number }> = [];
  private queuedKeys = new Set<string>();

  private activeCenterKey = '';
  private disposed = false;
  private onDirty: () => void;

  constructor(
    globeRadius: number,
    uniforms: Pick<
      GodsEyeShaderUniforms,
      'nightMode' | 'godsEyeMode' | 'scanRadius' | 'scanActive' | 'scanOrigin' | 'time' | 'focusPoint'
    >,
    onDirty: () => void
  ) {
    this.globeRadius = globeRadius;
    this.onDirty = onDirty;

    this.stdMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.78,
      metalness: 0.12,
      envMapIntensity: 0.45,
    });
    applyGodsEyeBuildingShader(this.stdMat, uniforms, false, 1 / 45);

    this.towerMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.28,
      metalness: 0.72,
      envMapIntensity: 0.72,
    });
    applyGodsEyeBuildingShader(this.towerMat, uniforms, true, 1 / 45);
  }

  public updateForCamera(tileZoom: number, lat: number, lng: number, isFastFlight: boolean) {
    if (this.disposed) return;

    if (tileZoom < 15) {
      this.group.visible = false;
      return;
    }

    this.group.visible = true;
    if (isFastFlight) return;

    const cTx = Math.floor(lngToTileX(lng, 14));
    const cTy = clamp(Math.floor(latToTileY(lat, 14)), 0, Z14_COUNT - 1);
    const centerKey = `${cTx}/${cTy}`;
    if (centerKey === this.activeCenterKey) return;
    this.activeCenterKey = centerKey;

    const ring = getTileNeighborhoodCoords(cTx, cTy, 14, 1);
    const nextDesired = new Set<string>();
    const nextQueue: Array<{ key: string; tx: number; ty: number; priority: number }> = [];

    for (const item of ring) {
      const key = `${item.tx}/${item.ty}`;
      nextDesired.add(key);

      const existing = this.chunks.get(key);
      if (existing) {
        existing.lastUsedMs = performance.now();
        existing.group.visible = true;
        continue;
      }

      const cached = this.payloadCache.get(key);
      if (cached) {
        this.attachChunk(key, cached);
        continue;
      }

      if (!this.inflight.has(key) && !this.queuedKeys.has(key)) {
        nextQueue.push({ key, tx: item.tx, ty: item.ty, priority: item.dist2 });
      }
    }

    this.desiredKeys = nextDesired;

    for (const [k, entry] of this.chunks.entries()) {
      entry.group.visible = nextDesired.has(k);
    }

    for (const [k, ctrl] of this.inflight.entries()) {
      if (!nextDesired.has(k)) {
        ctrl.abort();
        this.inflight.delete(k);
      }
    }

    this.fetchQueue = this.fetchQueue.filter((q) => nextDesired.has(q.key));
    this.queuedKeys.clear();
    for (const q of this.fetchQueue) this.queuedKeys.add(q.key);
    for (const q of nextQueue) {
      if (!this.queuedKeys.has(q.key)) {
        this.fetchQueue.push(q);
        this.queuedKeys.add(q.key);
      }
    }
    this.fetchQueue.sort((a, b) => a.priority - b.priority);

    // LRU evict old GPU chunks beyond MAX_CACHED_CHUNKS
    if (this.chunks.size > MAX_CACHED_CHUNKS) {
      const victims = Array.from(this.chunks.values())
        .filter((e) => !nextDesired.has(e.key))
        .sort((a, b) => a.lastUsedMs - b.lastUsedMs);
      while (this.chunks.size > MAX_CACHED_CHUNKS && victims.length > 0) {
        const victim = victims.shift()!;
        this.disposeChunk(victim);
        this.chunks.delete(victim.key);
      }
    }

    this.pumpQueue();
  }

  private pumpQueue() {
    while (
      this.inflight.size < MAX_CONCURRENT_CHUNKS &&
      this.fetchQueue.length > 0 &&
      !this.disposed
    ) {
      const spec = this.fetchQueue.shift()!;
      this.queuedKeys.delete(spec.key);
      if (!this.desiredKeys.has(spec.key)) continue;
      if (this.chunks.has(spec.key) || this.inflight.has(spec.key)) continue;

      const controller = new AbortController();
      this.inflight.set(spec.key, controller);

      void (async () => {
        try {
          const res = await fetch(
            `/api/terrain/chunk?z=14&tx=${spec.tx}&ty=${spec.ty}&gridSize=17&buildings=1&maxBuildings=12000`,
            { signal: controller.signal }
          );
          if (!res.ok) return;
          const payload = (await res.json()) as TerrainChunkPayload;
          if (this.disposed || controller.signal.aborted) return;

          if (this.payloadCache.size >= 6) {
            const oldest = this.payloadCache.keys().next().value;
            if (oldest) this.payloadCache.delete(oldest);
          }
          this.payloadCache.set(spec.key, payload);

          if (this.desiredKeys.has(spec.key) && !this.chunks.has(spec.key)) {
            this.attachChunk(spec.key, payload);
            this.onDirty();
          }
        } catch {
          // Ignore transient or aborted fetch errors
        } finally {
          this.inflight.delete(spec.key);
          this.pumpQueue();
        }
      })();
    }
  }

  private attachChunk(key: string, payload: TerrainChunkPayload) {
    if (this.disposed || this.chunks.has(key)) return;

    const surfaceR = this.globeRadius + 0.00003;
    const metersToGlobe = this.globeRadius / EARTH_RADIUS_M;
    const globeToMeters = 1 / metersToGlobe;

    const centerLL = tileUVToLatLng(0.5, 0.5, payload.tx, payload.ty);
    const originPt = latLngToCartesian(centerLL.lat, centerLL.lng, surfaceR);
    const origin = new THREE.Vector3(originPt.x, originPt.y, originPt.z);

    const up = origin.clone().normalize();
    const e1 = latLngToCartesian(centerLL.lat, centerLL.lng + 0.01, 1);
    const e0 = latLngToCartesian(centerLL.lat, centerLL.lng - 0.01, 1);
    const east = new THREE.Vector3(e1.x - e0.x, e1.y - e0.y, e1.z - e0.z).normalize();
    const south = new THREE.Vector3().crossVectors(east, up).normalize();
    east.crossVectors(up, south).normalize();

    const chunkGroup = new THREE.Group();
    const basisMat = new THREE.Matrix4().makeBasis(east, up, south);
    chunkGroup.position.copy(origin);
    chunkGroup.quaternion.setFromRotationMatrix(basisMat);
    chunkGroup.scale.setScalar(metersToGlobe);

    const tmpV = new THREE.Vector3();
    const { stdGeo, towerGeo } = buildGlobeTileBuildingsFast({
      buildings: payload.buildings,
      projectUVMeters: (u, v) => {
        const ll = tileUVToLatLng(u, v, payload.tx, payload.ty);
        const p = latLngToCartesian(ll.lat, ll.lng, surfaceR);
        tmpV.set(p.x - origin.x, p.y - origin.y, p.z - origin.z);
        return {
          ex: tmpV.dot(east) * globeToMeters,
          sz: tmpV.dot(south) * globeToMeters,
          sagittaM: tmpV.dot(up) * globeToMeters,
        };
      },
      seedOffset: payload.tx * 17 + payload.ty * 31,
    });

    let stdMesh: THREE.Mesh | null = null;
    let towerMesh: THREE.Mesh | null = null;
    if (stdGeo) {
      stdMesh = new THREE.Mesh(stdGeo, this.stdMat);
      stdMesh.frustumCulled = false;
      chunkGroup.add(stdMesh);
    }
    if (towerGeo) {
      towerMesh = new THREE.Mesh(towerGeo, this.towerMat);
      towerMesh.frustumCulled = false;
      chunkGroup.add(towerMesh);
    }

    this.group.add(chunkGroup);
    this.chunks.set(key, {
      key,
      tx: payload.tx,
      ty: payload.ty,
      group: chunkGroup,
      stdMesh,
      towerMesh,
      lastUsedMs: performance.now(),
    });
  }

  private disposeChunk(entry: GlobeChunkEntry) {
    if (entry.stdMesh) entry.stdMesh.geometry.dispose();
    if (entry.towerMesh) entry.towerMesh.geometry.dispose();
    this.group.remove(entry.group);
  }

  public dispose() {
    this.disposed = true;
    for (const ctrl of this.inflight.values()) ctrl.abort();
    this.inflight.clear();
    for (const entry of this.chunks.values()) this.disposeChunk(entry);
    this.chunks.clear();
    this.payloadCache.clear();
    this.stdMat.dispose();
    this.towerMat.dispose();
  }
}
