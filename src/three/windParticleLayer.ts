import * as THREE from 'three';
import { clamp } from '../shared/geo.ts';
import type { GlobalEvent, GlobalWindFieldResponse } from '../shared/types.ts';
import {
  buildAtmosphericBaselineWindField,
  computeWindAdvectionScale,
  EARTH_RADIUS_KM,
  extractCycloneVorticesFromEvents,
  prepareCycloneVortices,
  samplePreparedCycloneAtNormal,
  sampleWindFieldAtLatLng,
  tangentEastNorthAtNormal,
  windSpeedToColorRGB,
  type CycloneSampleResult,
  type PreparedCycloneVortex,
} from '../shared/windField.ts';

const PARTICLE_COUNT = 4200;
const SPINE_POINTS = 9;
const VERTS_PER_PARTICLE = SPINE_POINTS * 2;
const RAD_TO_DEG = 180 / Math.PI;
const MAX_VORTEX_PARTICLE_SHARE = 0.34;
const MAX_PARTICLES_PER_CYCLONE = 280;

function createSeededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 3D Spherical Wind Particle Streamline Layer:
 * - Renders 4,200 tapered aerodynamic 3D ribbons in a single Mesh draw call
 * - Advects particles across the sphere using real-time bilinear (u, v) wind vectors
 * - Superposes real-scale Rankine tropical cyclone vortices (Coriolis CW/CCW + inward spiral)
 * - Uses RK2 midpoint integration inside vortices so streamlines curve smoothly around the eye
 */
export class GlobeWindParticleLayer {
  public readonly group = new THREE.Group();

  private globeRadius: number;
  private enabled = false;
  private allocated = false;
  private windField: GlobalWindFieldResponse;
  private cyclones: PreparedCycloneVortex[] = [];
  private referenceMaxMs = 20.0;
  private rand = createSeededRandom(20261121);
  private lastAltitude = 16.0;
  private focusX = 0;
  private focusY = 0.33;
  private focusZ = 0.94;
  private wasRegionalZoom = false;
  private lastFieldSignature = '';
  private lastCyclonesSignature = '';

  // Per-particle state (lazily allocated only when layer is enabled)
  private nx: Float32Array | null = null;
  private ny: Float32Array | null = null;
  private nz: Float32Array | null = null;
  private age: Float32Array | null = null;
  private maxAge: Float32Array | null = null;
  private particleSpeedMs: Float32Array | null = null;
  private particleVortexIdx: Int16Array | null = null;
  private particleVortexBlend: Uint8Array | null = null;
  // Spine ring buffer flattened: particle i, spine j (0=oldest tail .. SPINE_POINTS-1=head)
  private spineX: Float32Array | null = null;
  private spineY: Float32Array | null = null;
  private spineZ: Float32Array | null = null;

  private readonly scratchCyclone: CycloneSampleResult = {
    vx: 0,
    vy: 0,
    vz: 0,
    blendWeight: 0,
    speedMs: 0,
    vorticityScale: 0,
    spiralCurvature: 0,
  };
  private readonly velScratch1 = {
    vx: 0,
    vy: 0,
    vz: 0,
    speedMs: 0,
    vortexWeight: 0,
    vorticityScale: 0,
    cycloneAngleRad: 0.05,
  };
  private readonly velScratch2 = {
    vx: 0,
    vy: 0,
    vz: 0,
    speedMs: 0,
    vortexWeight: 0,
    vorticityScale: 0,
    cycloneAngleRad: 0.05,
  };

  // GPU mesh & buffers (lazily allocated)
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  private colAttr: THREE.BufferAttribute | null = null;
  private alphaAttr: THREE.BufferAttribute | null = null;
  private posArray: Float32Array | null = null;
  private colArray: Float32Array | null = null;
  private alphaArray: Float32Array | null = null;

  constructor(globeRadius: number) {
    this.globeRadius = globeRadius;
    this.windField = buildAtmosphericBaselineWindField();
    this.recomputeReferenceMaxMs();
    this.group.visible = false;
  }

  public isAllocated(): boolean {
    return this.allocated;
  }

  private ensureAllocated() {
    if (this.allocated) return;

    this.nx = new Float32Array(PARTICLE_COUNT);
    this.ny = new Float32Array(PARTICLE_COUNT);
    this.nz = new Float32Array(PARTICLE_COUNT);
    this.age = new Float32Array(PARTICLE_COUNT);
    this.maxAge = new Float32Array(PARTICLE_COUNT);
    this.particleSpeedMs = new Float32Array(PARTICLE_COUNT);
    this.particleVortexIdx = new Int16Array(PARTICLE_COUNT);
    this.particleVortexIdx.fill(-1);
    this.particleVortexBlend = new Uint8Array(PARTICLE_COUNT);
    this.spineX = new Float32Array(PARTICLE_COUNT * SPINE_POINTS);
    this.spineY = new Float32Array(PARTICLE_COUNT * SPINE_POINTS);
    this.spineZ = new Float32Array(PARTICLE_COUNT * SPINE_POINTS);

    const totalVerts = PARTICLE_COUNT * VERTS_PER_PARTICLE;
    const totalIndices = PARTICLE_COUNT * (SPINE_POINTS - 1) * 6;

    this.posArray = new Float32Array(totalVerts * 3);
    this.colArray = new Float32Array(totalVerts * 3);
    this.alphaArray = new Float32Array(totalVerts);
    const indices = new Uint32Array(totalIndices);

    let idxPtr = 0;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const baseV = i * VERTS_PER_PARTICLE;
      for (let j = 0; j < SPINE_POINTS - 1; j++) {
        const v0 = baseV + j * 2;
        const v1 = v0 + 1;
        const v2 = v0 + 2;
        const v3 = v0 + 3;
        indices[idxPtr++] = v0;
        indices[idxPtr++] = v1;
        indices[idxPtr++] = v2;
        indices[idxPtr++] = v1;
        indices[idxPtr++] = v3;
        indices[idxPtr++] = v2;
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.posArray, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colArray, 3);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alphaArray, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setAttribute('aAlpha', this.alphaAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), this.globeRadius * 1.15);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uGlobalOpacity: { value: 0.94 },
      },
      vertexShader: `
        attribute vec3 color;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uGlobalOpacity;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float a = clamp(vAlpha * uGlobalOpacity, 0.0, 0.98);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.group.add(this.mesh);
    this.allocated = true;

    this.assignVortexSlots();
    this.initParticles();
    this.warmupStreamlines(16, computeWindAdvectionScale(this.lastAltitude));
    this.rebuildRibbonGeometry(this.lastAltitude);
  }

  public releaseIdleMemory() {
    if (this.enabled || !this.allocated) return;
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh = null;
    }
    this.geometry?.dispose();
    this.material?.dispose();
    this.geometry = null;
    this.material = null;
    this.posAttr = null;
    this.colAttr = null;
    this.alphaAttr = null;
    this.posArray = null;
    this.colArray = null;
    this.alphaArray = null;
    this.nx = null;
    this.ny = null;
    this.nz = null;
    this.age = null;
    this.maxAge = null;
    this.particleSpeedMs = null;
    this.particleVortexIdx = null;
    this.particleVortexBlend = null;
    this.spineX = null;
    this.spineY = null;
    this.spineZ = null;
    this.allocated = false;
    this.group.visible = false;
  }

  private recomputeReferenceMaxMs() {
    let maxMs = Math.max(18.0, (this.windField.metrics.maxSpeedKmh || 65) / 3.6);
    for (let i = 0; i < this.cyclones.length; i++) {
      maxMs = Math.max(maxMs, this.cyclones[i].maxWindMs);
    }
    this.referenceMaxMs = clamp(maxMs, 18.0, 48.0);
  }

  private assignVortexSlots() {
    if (!this.particleVortexIdx) return;
    this.particleVortexIdx.fill(-1);
    if (this.cyclones.length === 0) return;
    const perCyclone = Math.min(
      MAX_PARTICLES_PER_CYCLONE,
      Math.floor((PARTICLE_COUNT * MAX_VORTEX_PARTICLE_SHARE) / this.cyclones.length)
    );
    if (perCyclone <= 0) return;

    let ptr = 0;
    for (let c = 0; c < this.cyclones.length; c++) {
      for (let k = 0; k < perCyclone && ptr < PARTICLE_COUNT; k++, ptr++) {
        this.particleVortexIdx[ptr] = c;
      }
    }
  }

  private respawnParticle(i: number, randomAge = false) {
    if (
      !this.nx ||
      !this.ny ||
      !this.nz ||
      !this.age ||
      !this.maxAge ||
      !this.particleVortexIdx ||
      !this.particleVortexBlend ||
      !this.spineX ||
      !this.spineY ||
      !this.spineZ
    ) {
      return;
    }
    let px = 0;
    let py = 0;
    let pz = 1;
    const assignedCycloneIdx = this.particleVortexIdx[i];

    if (assignedCycloneIdx >= 0 && assignedCycloneIdx < this.cyclones.length) {
      const cyc = this.cyclones[assignedCycloneIdx];
      const basis = tangentEastNorthAtNormal(cyc.cx, cyc.cy, cyc.cz);
      const minAng = (cyc.coreRadiusKm * 0.22) / EARTH_RADIUS_KM;
      const maxAng = cyc.nominalAngleRad * 1.45;
      const ang = Math.sqrt(minAng * minAng + this.rand() * Math.max(1e-6, maxAng * maxAng - minAng * minAng));
      const az = this.rand() * Math.PI * 2;
      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);
      const cosAz = Math.cos(az);
      const sinAz = Math.sin(az);
      px = cyc.cx * cosA + sinA * (cosAz * basis.ex + sinAz * basis.northX);
      py = cyc.cy * cosA + sinA * (cosAz * basis.ey + sinAz * basis.northY);
      pz = cyc.cz * cosA + sinA * (cosAz * basis.ez + sinAz * basis.northZ);
      const inv = 1 / Math.max(1e-7, Math.hypot(px, py, pz));
      px *= inv;
      py *= inv;
      pz *= inv;
    } else if (this.lastAltitude < 8.5 && i % 9 < 4) {
      // 45% of non-cyclone particles concentrate inside the visible hemisphere cone when zoomed in
      const basis = tangentEastNorthAtNormal(this.focusX, this.focusY, this.focusZ);
      const maxAngle = clamp(this.lastAltitude * 0.095, 0.08, 0.72);
      const ang = Math.sqrt(this.rand()) * maxAngle;
      const az = this.rand() * Math.PI * 2;
      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);
      const cosAz = Math.cos(az);
      const sinAz = Math.sin(az);
      px =
        this.focusX * cosA +
        sinA * (cosAz * basis.ex + sinAz * basis.northX);
      py =
        this.focusY * cosA +
        sinA * (cosAz * basis.ey + sinAz * basis.northY);
      pz =
        this.focusZ * cosA +
        sinA * (cosAz * basis.ez + sinAz * basis.northZ);
      const inv = 1 / Math.max(1e-7, Math.hypot(px, py, pz));
      px *= inv;
      py *= inv;
      pz *= inv;
    } else {
      // Area-uniform global spherical distribution clamped away from extreme poles (|lat| <= 78°)
      const sinLat = (this.rand() * 2 - 1) * 0.978;
      const cosLat = Math.sqrt(Math.max(1e-6, 1 - sinLat * sinLat));
      const theta = this.rand() * Math.PI * 2;
      px = -cosLat * Math.cos(theta);
      py = sinLat;
      pz = cosLat * Math.sin(theta);
    }

    this.nx![i] = px;
    this.ny![i] = py;
    this.nz![i] = pz;
    this.particleVortexBlend![i] = assignedCycloneIdx >= 0 ? 220 : 0;

    const life = assignedCycloneIdx >= 0 ? 1.15 + this.rand() * 1.45 : 1.8 + this.rand() * 2.4;
    this.maxAge![i] = life;
    this.age![i] = randomAge ? this.rand() * life : 0;

    const baseSpine = i * SPINE_POINTS;
    for (let j = 0; j < SPINE_POINTS; j++) {
      this.spineX![baseSpine + j] = px;
      this.spineY![baseSpine + j] = py;
      this.spineZ![baseSpine + j] = pz;
    }
  }

  private initParticles() {
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.respawnParticle(i, true);
    }
  }

  /**
   * Evaluates combined global + cyclone 3D tangent velocity (m/s) at sphere normal (px, py, pz)
   * into a pre-allocated output struct (zero GC in render loop).
   */
  private sampleTangentVelocityAtNormal(
    px: number,
    py: number,
    pz: number,
    out: typeof this.velScratch1
  ): typeof this.velScratch1 {
    const lat = Math.asin(clamp(py, -1, 1)) * RAD_TO_DEG;
    const lng = Math.atan2(-pz, px) * RAD_TO_DEG;

    const { uEastMs, vNorthMs } = sampleWindFieldAtLatLng(this.windField, lat, lng);
    const basis = tangentEastNorthAtNormal(px, py, pz);

    let vx = uEastMs * basis.ex + vNorthMs * basis.northX;
    let vy = uEastMs * basis.ey + vNorthMs * basis.northY;
    let vz = uEastMs * basis.ez + vNorthMs * basis.northZ;
    let maxVortexWeight = 0;
    let maxVorticityScale = 0;
    let dominantAngleRad = 0.05;

    for (let c = 0; c < this.cyclones.length; c++) {
      const cyc = this.cyclones[c];
      if (!samplePreparedCycloneAtNormal(cyc, px, py, pz, this.scratchCyclone)) {
        continue;
      }
      const w = this.scratchCyclone.blendWeight;
      vx = vx * (1 - w) + this.scratchCyclone.vx;
      vy = vy * (1 - w) + this.scratchCyclone.vy;
      vz = vz * (1 - w) + this.scratchCyclone.vz;
      if (w > maxVortexWeight) {
        maxVortexWeight = w;
        dominantAngleRad = cyc.nominalAngleRad;
      }
      if (this.scratchCyclone.vorticityScale > maxVorticityScale) {
        maxVorticityScale = this.scratchCyclone.vorticityScale;
      }
    }

    out.vx = vx;
    out.vy = vy;
    out.vz = vz;
    out.speedMs = Math.hypot(vx, vy, vz);
    out.vortexWeight = maxVortexWeight;
    out.vorticityScale = maxVorticityScale;
    out.cycloneAngleRad = dominantAngleRad;
    return out;
  }

  private advectParticle(i: number, dtSec: number, advectScale: number) {
    if (
      !this.nx ||
      !this.ny ||
      !this.nz ||
      !this.age ||
      !this.maxAge ||
      !this.particleSpeedMs ||
      !this.particleVortexBlend ||
      !this.spineX ||
      !this.spineY ||
      !this.spineZ
    ) {
      return;
    }
    this.age[i] += dtSec;
    let curX = this.nx[i];
    let curY = this.ny[i];
    let curZ = this.nz[i];

    // Respawn if lifetime elapsed or particle drifted into extreme polar singularity
    if (this.age[i] >= this.maxAge[i] || Math.abs(curY) > 0.985) {
      this.respawnParticle(i, false);
      return;
    }

    const s1 = this.sampleTangentVelocityAtNormal(curX, curY, curZ, this.velScratch1);
    this.particleSpeedMs[i] = s1.speedMs;
    this.particleVortexBlend[i] = Math.round(clamp(s1.vortexWeight, 0, 1) * 255);

    const effectiveScale = advectScale;
    const inVortex = s1.vortexWeight > 0.04;

    if (inVortex) {
      // Multi-substep RK2 midpoint advection inside vortices scales angular step clamping
      // to each cyclone's real spherical radius (nominalAngleRad) and dynamic vorticityScale.
      const subSteps = s1.vorticityScale > 1.35 ? 3 : 2;
      const subDt = dtSec / subSteps;
      const maxSubStepRad = clamp(s1.cycloneAngleRad * 0.22, 0.006, 0.016);

      for (let step = 0; step < subSteps; step++) {
        const k1 =
          step === 0
            ? s1
            : this.sampleTangentVelocityAtNormal(curX, curY, curZ, this.velScratch1);
        const visualSpeed1 = k1.speedMs > 34 ? 34 + (k1.speedMs - 34) * 0.25 : k1.speedMs;
        const vortGain1 = clamp(0.78 + (k1.vorticityScale - 0.6) * 0.24, 0.72, 1.32);
        let scale1 =
          k1.speedMs > 1e-4 ? (visualSpeed1 / k1.speedMs) * effectiveScale * 0.72 * vortGain1 : 0;
        const disp1 = k1.speedMs * scale1 * subDt;
        if (disp1 > maxSubStepRad && disp1 > 1e-6) {
          scale1 *= maxSubStepRad / disp1;
        }

        let mx = curX + k1.vx * scale1 * subDt * 0.5;
        let my = curY + k1.vy * scale1 * subDt * 0.5;
        let mz = curZ + k1.vz * scale1 * subDt * 0.5;
        const mInv = 1 / Math.max(1e-7, Math.hypot(mx, my, mz));
        mx *= mInv;
        my *= mInv;
        mz *= mInv;

        const k2 = this.sampleTangentVelocityAtNormal(mx, my, mz, this.velScratch2);
        const visualSpeed2 = k2.speedMs > 34 ? 34 + (k2.speedMs - 34) * 0.25 : k2.speedMs;
        const vortGain2 = clamp(0.78 + (k2.vorticityScale - 0.6) * 0.24, 0.72, 1.32);
        let scale2 =
          k2.speedMs > 1e-4 ? (visualSpeed2 / k2.speedMs) * effectiveScale * 0.72 * vortGain2 : 0;
        const disp2 = k2.speedMs * scale2 * subDt;
        if (disp2 > maxSubStepRad && disp2 > 1e-6) {
          scale2 *= maxSubStepRad / disp2;
        }

        curX += k2.vx * scale2 * subDt;
        curY += k2.vy * scale2 * subDt;
        curZ += k2.vz * scale2 * subDt;
        const invLen = 1 / Math.max(1e-7, Math.hypot(curX, curY, curZ));
        curX *= invLen;
        curY *= invLen;
        curZ *= invLen;
      }
    } else {
      const minAdvectRatio = s1.speedMs > 0.05 && s1.speedMs < 3.0 ? 3.0 / s1.speedMs : 1.0;
      curX += s1.vx * minAdvectRatio * effectiveScale * dtSec;
      curY += s1.vy * minAdvectRatio * effectiveScale * dtSec;
      curZ += s1.vz * minAdvectRatio * effectiveScale * dtSec;
      const invLen = 1 / Math.max(1e-7, Math.hypot(curX, curY, curZ));
      curX *= invLen;
      curY *= invLen;
      curZ *= invLen;
    }

    this.nx[i] = curX;
    this.ny[i] = curY;
    this.nz[i] = curZ;

    // Shift spine tail -> head and append new head
    const baseSpine = i * SPINE_POINTS;
    for (let j = 0; j < SPINE_POINTS - 1; j++) {
      this.spineX[baseSpine + j] = this.spineX[baseSpine + j + 1];
      this.spineY[baseSpine + j] = this.spineY[baseSpine + j + 1];
      this.spineZ[baseSpine + j] = this.spineZ[baseSpine + j + 1];
    }
    this.spineX[baseSpine + SPINE_POINTS - 1] = curX;
    this.spineY[baseSpine + SPINE_POINTS - 1] = curY;
    this.spineZ[baseSpine + SPINE_POINTS - 1] = curZ;
  }

  private warmupStreamlines(
    steps: number,
    advectScale = computeWindAdvectionScale(this.lastAltitude),
    onlyVortex = false
  ) {
    if (!this.allocated || !this.particleVortexIdx) return;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        if (onlyVortex && this.particleVortexIdx[i] < 0) continue;
        this.advectParticle(i, 0.035, advectScale);
      }
    }
  }

  private rebuildRibbonGeometry(altitude: number) {
    if (
      !this.allocated ||
      !this.particleSpeedMs ||
      !this.age ||
      !this.maxAge ||
      !this.particleVortexBlend ||
      !this.spineX ||
      !this.spineY ||
      !this.spineZ ||
      !this.posArray ||
      !this.colArray ||
      !this.alphaArray ||
      !this.posAttr ||
      !this.colAttr ||
      !this.alphaAttr
    ) {
      return;
    }
    const baseHalfWidth = clamp(altitude * 0.0026, 0.0032, 0.036);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const baseSpine = i * SPINE_POINTS;
      const baseVert = i * VERTS_PER_PARTICLE;

      const speedMs = this.particleSpeedMs[i];
      const [cr, cg, cb] = windSpeedToColorRGB(speedMs, this.referenceMaxMs);
      const lifeRatio = clamp(this.age[i] / Math.max(0.1, this.maxAge[i]), 0, 1);
      const lifeFade = Math.pow(Math.sin(lifeRatio * Math.PI), 0.65);
      const vortexFade = this.particleVortexBlend[i] / 255;
      const particleHalfWidth = baseHalfWidth * (1 - 0.36 * vortexFade);
      const radius = this.globeRadius + 0.082 + clamp(speedMs / this.referenceMaxMs, 0, 1) * 0.052;

      for (let j = 0; j < SPINE_POINTS; j++) {
        const sx = this.spineX[baseSpine + j];
        const sy = this.spineY[baseSpine + j];
        const sz = this.spineZ[baseSpine + j];

        let tx: number;
        let ty: number;
        let tz: number;
        if (j < SPINE_POINTS - 1) {
          tx = this.spineX[baseSpine + j + 1] - sx;
          ty = this.spineY[baseSpine + j + 1] - sy;
          tz = this.spineZ[baseSpine + j + 1] - sz;
        } else {
          tx = sx - this.spineX[baseSpine + j - 1];
          ty = sy - this.spineY[baseSpine + j - 1];
          tz = sz - this.spineZ[baseSpine + j - 1];
        }

        const tLen = Math.hypot(tx, ty, tz);
        let sideX = 0;
        let sideY = 0;
        let sideZ = 0;

        if (tLen > 1e-7) {
          const bx = ty * sz - tz * sy;
          const by = tz * sx - tx * sz;
          const bz = tx * sy - ty * sx;
          const bLen = Math.hypot(bx, by, bz);
          if (bLen > 1e-7) {
            const tNorm = j / (SPINE_POINTS - 1);
            const taper =
              tNorm < 0.82
                ? Math.pow(tNorm / 0.82, 0.7)
                : 1.0 - ((tNorm - 0.82) / 0.18) * 0.52;
            const hw = (particleHalfWidth * taper) / bLen;
            sideX = bx * hw;
            sideY = by * hw;
            sideZ = bz * hw;
          }
        }

        const px = sx * radius;
        const py = sy * radius;
        const pz = sz * radius;

        const vIdxL = baseVert + j * 2;
        const vIdxR = vIdxL + 1;

        this.posArray[vIdxL * 3] = px - sideX;
        this.posArray[vIdxL * 3 + 1] = py - sideY;
        this.posArray[vIdxL * 3 + 2] = pz - sideZ;

        this.posArray[vIdxR * 3] = px + sideX;
        this.posArray[vIdxR * 3 + 1] = py + sideY;
        this.posArray[vIdxR * 3 + 2] = pz + sideZ;

        const tNorm = j / (SPINE_POINTS - 1);
        const headBoost = tNorm > 0.65 ? (tNorm - 0.65) * 0.68 : 0;
        const vr = Math.min(1, cr + headBoost * (1 - cr));
        const vg = Math.min(1, cg + headBoost * (1 - cg));
        const vb = Math.min(1, cb + headBoost * (1 - cb));

        this.colArray[vIdxL * 3] = vr;
        this.colArray[vIdxL * 3 + 1] = vg;
        this.colArray[vIdxL * 3 + 2] = vb;

        this.colArray[vIdxR * 3] = vr;
        this.colArray[vIdxR * 3 + 1] = vg;
        this.colArray[vIdxR * 3 + 2] = vb;

        const vertAlpha = (0.08 + Math.pow(tNorm, 1.25) * 0.90) * lifeFade;
        this.alphaArray[vIdxL] = vertAlpha;
        this.alphaArray[vIdxR] = vertAlpha;
      }
    }

    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      this.ensureAllocated();
      this.group.visible = true;
    } else {
      this.group.visible = false;
      this.releaseIdleMemory();
    }
  }

  public setData(field: GlobalWindFieldResponse) {
    const signature = `${field.updatedAt}|${field.rows}x${field.cols}|${field.metrics.maxSpeedKmh}`;
    if (signature === this.lastFieldSignature) {
      return;
    }
    this.lastFieldSignature = signature;
    this.windField = field;
    this.recomputeReferenceMaxMs();
    if (!this.allocated) return;
    this.initParticles();
    this.warmupStreamlines(16, computeWindAdvectionScale(this.lastAltitude));
    this.rebuildRibbonGeometry(this.lastAltitude);
  }

  public setCyclones(events: readonly GlobalEvent[]) {
    const specs = extractCycloneVorticesFromEvents(events);
    let sig = '';
    for (let i = 0; i < specs.length; i++) {
      const c = specs[i];
      sig += `${c.id}:${c.lat.toFixed(2)},${c.lng.toFixed(2)}:${Math.round(c.radiusKm)}:${Math.round(c.maxWindMs * 10)}:${c.centralPressureHpa}:${c.cycloneCategory}:${Math.round(c.vorticityScale * 100)}|`;
    }
    if (sig === this.lastCyclonesSignature) {
      return;
    }
    this.lastCyclonesSignature = sig;
    this.cyclones = prepareCycloneVortices(specs);
    this.recomputeReferenceMaxMs();
    if (!this.allocated) return;
    this.assignVortexSlots();

    if (this.cyclones.length > 0 && this.particleVortexIdx) {
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        if (this.particleVortexIdx[i] >= 0) {
          this.respawnParticle(i, true);
        }
      }
      this.warmupStreamlines(14, computeWindAdvectionScale(this.lastAltitude), true);
    }
    this.rebuildRibbonGeometry(this.lastAltitude);
  }

  public update(
    deltaSec: number,
    altitude: number,
    focusX = 0,
    focusY = 0.33,
    focusZ = 0.94
  ) {
    if (!this.enabled) {
      this.group.visible = false;
      return;
    }
    this.ensureAllocated();

    this.group.visible = altitude > 0.12;
    if (!this.group.visible) return;

    this.lastAltitude = altitude;
    const focusMoved =
      Math.hypot(focusX - this.focusX, focusY - this.focusY, focusZ - this.focusZ) > 0.25;
    this.focusX = focusX;
    this.focusY = focusY;
    this.focusZ = focusZ;

    const advectScale = computeWindAdvectionScale(altitude);
    const isRegional = altitude < 8.5;
    if (isRegional && (!this.wasRegionalZoom || focusMoved) && this.particleVortexIdx) {
      this.wasRegionalZoom = true;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        if (this.particleVortexIdx[i] < 0 && i % 9 < 4) this.respawnParticle(i, true);
      }
      this.warmupStreamlines(12, advectScale);
    } else if (!isRegional) {
      this.wasRegionalZoom = false;
    }

    const closeFade = clamp((altitude - 0.12) / 0.35, 0, 1);
    if (this.material) {
      this.material.uniforms.uGlobalOpacity.value = 0.95 * closeFade;
    }

    const dt = clamp(deltaSec, 0.014, 0.055);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.advectParticle(i, dt, advectScale);
    }
    this.rebuildRibbonGeometry(altitude);
  }

  public dispose() {
    this.enabled = false;
    this.releaseIdleMemory();
  }
}

