import * as THREE from 'three';
import { clamp } from '../shared/geo.ts';
import type { GlobalWindFieldResponse } from '../shared/types.ts';
import {
  buildAtmosphericBaselineWindField,
  sampleWindFieldAtLatLng,
  tangentEastNorthAtNormal,
  windSpeedToColorRGB,
} from '../shared/windField.ts';

const PARTICLE_COUNT = 4200;
const SPINE_POINTS = 9;
const VERTS_PER_PARTICLE = SPINE_POINTS * 2;
const RAD_TO_DEG = 180 / Math.PI;

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
 * - Balances global circulation coverage with adaptive regional focus seeding when zoomed in
 * - Encodes wind velocity via dynamic color ramp & streamline length, and direction via taper/alpha
 */
export class GlobeWindParticleLayer {
  public readonly group = new THREE.Group();

  private globeRadius: number;
  private enabled = true;
  private windField: GlobalWindFieldResponse;
  private referenceMaxMs = 20.0;
  private rand = createSeededRandom(20261121);
  private lastAltitude = 16.0;
  private focusX = 0;
  private focusY = 0.33;
  private focusZ = 0.94;
  private wasRegionalZoom = false;
  private lastFieldSignature = '';

  // Per-particle state (zero GC in render loop)
  private nx = new Float32Array(PARTICLE_COUNT);
  private ny = new Float32Array(PARTICLE_COUNT);
  private nz = new Float32Array(PARTICLE_COUNT);
  private age = new Float32Array(PARTICLE_COUNT);
  private maxAge = new Float32Array(PARTICLE_COUNT);
  private particleSpeedMs = new Float32Array(PARTICLE_COUNT);
  // Spine ring buffer flattened: particle i, spine j (0=oldest tail .. SPINE_POINTS-1=head)
  private spineX = new Float32Array(PARTICLE_COUNT * SPINE_POINTS);
  private spineY = new Float32Array(PARTICLE_COUNT * SPINE_POINTS);
  private spineZ = new Float32Array(PARTICLE_COUNT * SPINE_POINTS);

  // GPU mesh & buffers
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private alphaAttr: THREE.BufferAttribute;
  private posArray: Float32Array;
  private colArray: Float32Array;
  private alphaArray: Float32Array;

  constructor(globeRadius: number) {
    this.globeRadius = globeRadius;
    this.windField = buildAtmosphericBaselineWindField();
    this.referenceMaxMs = Math.max(18.0, (this.windField.metrics.maxSpeedKmh || 65) / 3.6);

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
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), globeRadius * 1.15);

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

    this.initParticles();
    this.warmupStreamlines(16);
    this.rebuildRibbonGeometry(this.lastAltitude);
  }

  private respawnParticle(i: number, randomAge = false) {
    let px = 0;
    let py = 0;
    let pz = 1;

    // 45% of particles concentrate inside the visible hemisphere cone when zoomed into a region
    const useRegionalCone = this.lastAltitude < 8.5 && i % 9 < 4;
    if (useRegionalCone) {
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

    this.nx[i] = px;
    this.ny[i] = py;
    this.nz[i] = pz;

    const life = 1.8 + this.rand() * 2.4;
    this.maxAge[i] = life;
    this.age[i] = randomAge ? this.rand() * life : 0;

    const baseSpine = i * SPINE_POINTS;
    for (let j = 0; j < SPINE_POINTS; j++) {
      this.spineX[baseSpine + j] = px;
      this.spineY[baseSpine + j] = py;
      this.spineZ[baseSpine + j] = pz;
    }
  }

  private initParticles() {
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.respawnParticle(i, true);
    }
  }

  private advectParticle(i: number, dtSec: number, altFactor: number) {
    this.age[i] += dtSec;
    let curX = this.nx[i];
    let curY = this.ny[i];
    let curZ = this.nz[i];

    // Respawn if lifetime elapsed or particle drifted into extreme polar singularity
    if (this.age[i] >= this.maxAge[i] || Math.abs(curY) > 0.985) {
      this.respawnParticle(i, false);
      return;
    }

    const lat = Math.asin(clamp(curY, -1, 1)) * RAD_TO_DEG;
    const lng = Math.atan2(-curZ, curX) * RAD_TO_DEG;

    const { uEastMs, vNorthMs, speedMs } = sampleWindFieldAtLatLng(this.windField, lat, lng);
    this.particleSpeedMs[i] = speedMs;

    const basis = tangentEastNorthAtNormal(curX, curY, curZ);

    const effectiveScale = 0.0078 * altFactor;
    const minAdvectRatio = speedMs > 0.05 && speedMs < 3.0 ? 3.0 / speedMs : 1.0;
    const vx = (uEastMs * basis.ex + vNorthMs * basis.northX) * minAdvectRatio;
    const vy = (uEastMs * basis.ey + vNorthMs * basis.northY) * minAdvectRatio;
    const vz = (uEastMs * basis.ez + vNorthMs * basis.northZ) * minAdvectRatio;

    curX += vx * effectiveScale * dtSec;
    curY += vy * effectiveScale * dtSec;
    curZ += vz * effectiveScale * dtSec;
    const invLen = 1 / Math.max(1e-7, Math.hypot(curX, curY, curZ));
    curX *= invLen;
    curY *= invLen;
    curZ *= invLen;

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

  private warmupStreamlines(steps: number, altFactor = 1.0) {
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        this.advectParticle(i, 0.035, altFactor);
      }
    }
  }

  private rebuildRibbonGeometry(altitude: number) {
    const baseHalfWidth = clamp(altitude * 0.0026, 0.0032, 0.036);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const baseSpine = i * SPINE_POINTS;
      const baseVert = i * VERTS_PER_PARTICLE;

      const speedMs = this.particleSpeedMs[i];
      const [cr, cg, cb] = windSpeedToColorRGB(speedMs, this.referenceMaxMs);
      const lifeRatio = clamp(this.age[i] / Math.max(0.1, this.maxAge[i]), 0, 1);
      const lifeFade = Math.pow(Math.sin(lifeRatio * Math.PI), 0.65);
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
            const hw = (baseHalfWidth * taper) / bLen;
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
    this.group.visible = enabled;
  }

  public setData(field: GlobalWindFieldResponse) {
    const signature = `${field.updatedAt}|${field.rows}x${field.cols}|${field.metrics.maxSpeedKmh}`;
    if (signature === this.lastFieldSignature) {
      return;
    }
    this.lastFieldSignature = signature;
    this.windField = field;
    this.referenceMaxMs = Math.max(18.0, (field.metrics.maxSpeedKmh || 65) / 3.6);
    this.initParticles();
    this.warmupStreamlines(16, clamp(this.lastAltitude / 11.0, 0.36, 1.18));
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

    this.group.visible = altitude > 0.12;
    if (!this.group.visible) return;

    this.lastAltitude = altitude;
    const focusMoved =
      Math.hypot(focusX - this.focusX, focusY - this.focusY, focusZ - this.focusZ) > 0.25;
    this.focusX = focusX;
    this.focusY = focusY;
    this.focusZ = focusZ;

    const isRegional = altitude < 8.5;
    if (isRegional && (!this.wasRegionalZoom || focusMoved)) {
      this.wasRegionalZoom = true;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        if (i % 9 < 4) this.respawnParticle(i, true);
      }
      this.warmupStreamlines(12, clamp(altitude / 11.0, 0.36, 1.18));
    } else if (!isRegional) {
      this.wasRegionalZoom = false;
    }

    const closeFade = clamp((altitude - 0.12) / 0.35, 0, 1);
    this.material.uniforms.uGlobalOpacity.value = 0.95 * closeFade;

    const dt = clamp(deltaSec, 0.014, 0.055);
    const altFactor = clamp(altitude / 11.0, 0.36, 1.18);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.advectParticle(i, dt, altFactor);
    }
    this.rebuildRibbonGeometry(altitude);
  }

  public dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
