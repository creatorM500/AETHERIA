import * as THREE from 'three';
import { clamp, latLngToCartesian } from '../shared/geo.ts';
import {
  normalizeQuakesForDynamicHeat,
  rasterizeEquirectangularHeatField,
  type NormalizedHeatPoint,
} from '../shared/seismicHeat.ts';
import type { SeismicHeatScaleMetrics, SeismicQuake24h } from '../shared/types.ts';

const HEAT_TEX_W = 720;
const HEAT_TEX_H = 360;
const MAX_QUAKES_INSTANCES = 512;

const _dummy = new THREE.Object3D();
const _up = new THREE.Vector3(0, 1, 0);
const _normal = new THREE.Vector3();
const _color = new THREE.Color();

/**
 * 3D Spherical Seismic Heatmap Visual Layer + Instanced Epicenter Telemetry Columns:
 * - High-res 720x360 curved equirectangular thermal shader shell (seamless across ±180° antimeridian)
 *   with 5-tap bilinear-artifact smoothing, dynamic heat-ramp shading, and subtle fwidth() isotherm contours
 * - Altitude-scaled InstancedMesh epicenter pins & hollow target halos for significant 24h events
 */
export class GlobeSeismicHeatmapLayer {
  public readonly group = new THREE.Group();
  private globeRadius: number;
  private heatTex: THREE.DataTexture;
  private shellGeo: THREE.SphereGeometry;
  private shellMat: THREE.ShaderMaterial;
  private shellMesh: THREE.Mesh;

  private pinGeo: THREE.CylinderGeometry;
  private pinMat: THREE.MeshBasicMaterial;
  private pinMesh: THREE.InstancedMesh;

  private ringGeo: THREE.RingGeometry;
  private ringMat: THREE.MeshBasicMaterial;
  private ringMesh: THREE.InstancedMesh;

  private normalizedPoints: NormalizedHeatPoint[] = [];
  private pinQuakes: SeismicQuake24h[] = [];
  private ringQuakes: SeismicQuake24h[] = [];
  private enabled = true;
  private lastAltitude = 16;

  constructor(globeRadius: number, isSoftwareGl: boolean) {
    this.globeRadius = globeRadius;

    const emptyField = new Uint8Array(HEAT_TEX_W * HEAT_TEX_H);
    this.heatTex = new THREE.DataTexture(emptyField, HEAT_TEX_W, HEAT_TEX_H, THREE.RedFormat);
    this.heatTex.magFilter = THREE.LinearFilter;
    this.heatTex.minFilter = THREE.LinearFilter;
    this.heatTex.wrapS = THREE.RepeatWrapping;
    this.heatTex.wrapT = THREE.ClampToEdgeWrapping;
    // row 0 = -90° South Pole (UV v=0), row H-1 = +90° North Pole (UV v=1)
    this.heatTex.flipY = false;
    this.heatTex.needsUpdate = true;

    this.shellGeo = new THREE.SphereGeometry(
      globeRadius + 0.048,
      isSoftwareGl ? 128 : 160,
      isSoftwareGl ? 96 : 120
    );

    this.shellMat = new THREE.ShaderMaterial({
      uniforms: {
        uHeatTex: { value: this.heatTex },
        uTexelSize: { value: new THREE.Vector2(1 / HEAT_TEX_W, 1 / HEAT_TEX_H) },
        uTime: { value: 0 },
        uOpacity: { value: 0.94 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uHeatTex;
        uniform vec2 uTexelSize;
        uniform float uTime;
        uniform float uOpacity;
        varying vec2 vUv;

        vec3 dynamicHeatRamp(float t) {
          vec3 c0 = vec3(0.03, 0.25, 0.45);
          vec3 c1 = vec3(0.02, 0.71, 0.83);
          vec3 c2 = vec3(0.13, 0.77, 0.37);
          vec3 c3 = vec3(0.98, 0.80, 0.08);
          vec3 c4 = vec3(0.98, 0.45, 0.09);
          vec3 c5 = vec3(0.94, 0.27, 0.27);
          vec3 c6 = vec3(1.00, 0.94, 0.82);

          vec3 col = mix(c0, c1, smoothstep(0.0, 0.20, t));
          col = mix(col, c2, smoothstep(0.20, 0.42, t));
          col = mix(col, c3, smoothstep(0.42, 0.62, t));
          col = mix(col, c4, smoothstep(0.62, 0.80, t));
          col = mix(col, c5, smoothstep(0.80, 0.93, t));
          col = mix(col, c6, smoothstep(0.93, 1.00, t));
          return col;
        }

        void main() {
          // 5-tap sub-texel cross filter prevents bilinear diamond artifacts
          vec2 off = uTexelSize * 0.65;
          float hc = texture2D(uHeatTex, vUv).r;
          float h1 = texture2D(uHeatTex, vUv + vec2(off.x, off.y)).r;
          float h2 = texture2D(uHeatTex, vUv + vec2(-off.x, off.y)).r;
          float h3 = texture2D(uHeatTex, vUv + vec2(off.x, -off.y)).r;
          float h4 = texture2D(uHeatTex, vUv + vec2(-off.x, -off.y)).r;
          float h = hc * 0.44 + (h1 + h2 + h3 + h4) * 0.14;
          if (h < 0.008) discard;

          float heat = smoothstep(0.018, 1.0, h);
          vec3 rampColor = dynamicHeatRamp(heat);

          // Anti-aliased thermal isotherm contour bands concentrated on warm active zones
          float isoPos = heat * 6.0;
          float fw = max(fwidth(isoPos), 0.002);
          float isoDist = abs(fract(isoPos - 0.5) - 0.5);
          float isoLine = (1.0 - smoothstep(0.0, fw * 1.4, isoDist)) * smoothstep(0.24, 0.82, heat);

          float wave = 0.5 + 0.5 * sin(heat * 16.0 - uTime * 2.2);
          vec3 finalColor = rampColor + vec3(0.28, 0.16, 0.06) * isoLine * 0.52 + rampColor * wave * 0.12 * smoothstep(0.48, 1.0, heat);

          // Translucent feathered heatmap so underlying coastlines, cities, and labels stay crisp
          float outerFeather = smoothstep(0.016, 0.24, h);
          float alpha = clamp(outerFeather * (0.14 + pow(heat, 0.92) * 0.52) + isoLine * 0.20, 0.0, 0.68) * uOpacity;
          gl_FragColor = vec4(finalColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });

    this.shellMesh = new THREE.Mesh(this.shellGeo, this.shellMat);
    this.shellMesh.renderOrder = 4;
    this.group.add(this.shellMesh);

    // Instanced 3D Epicenter Needles (bottom-center pivot, felt quakes only)
    this.pinGeo = new THREE.CylinderGeometry(0.003, 0.009, 1.0, 8);
    this.pinGeo.translate(0, 0.5, 0);
    this.pinMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.pinMesh = new THREE.InstancedMesh(this.pinGeo, this.pinMat, MAX_QUAKES_INSTANCES);
    this.pinMesh.count = 0;
    this.pinMesh.frustumCulled = false;
    this.pinMesh.renderOrder = 5;

    // Instanced Precision Ground Epicenter Target Halos (significant quakes only)
    this.ringGeo = new THREE.RingGeometry(0.026, 0.032, 24);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -8,
    });
    this.ringMesh = new THREE.InstancedMesh(this.ringGeo, this.ringMat, MAX_QUAKES_INSTANCES);
    this.ringMesh.count = 0;
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 5;

    this.group.add(this.pinMesh, this.ringMesh);
  }

  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.group.visible = enabled;
  }

  public setData(quakes: SeismicQuake24h[], metrics: SeismicHeatScaleMetrics) {
    const normalized = normalizeQuakesForDynamicHeat(quakes, metrics);
    this.normalizedPoints = normalized;

    const { field } = rasterizeEquirectangularHeatField(normalized, HEAT_TEX_W, HEAT_TEX_H);
    const texData = this.heatTex.image.data as Uint8Array;
    texData.set(field);
    this.heatTex.needsUpdate = true;

    this.syncInstances(this.lastAltitude);
  }

  private syncInstances(altitude: number) {
    const zoomScale = clamp(altitude / 12.0, 0.025, 1.35);

    let pinCount = 0;
    let ringCount = 0;
    this.pinQuakes = [];
    this.ringQuakes = [];

    for (let i = 0; i < this.normalizedPoints.length; i++) {
      const pt = this.normalizedPoints[i];
      if (pt.heatWeight01 < 0.24 && pinCount >= 40) continue;
      if (pt.heatWeight01 < 0.20) continue;

      const pos = latLngToCartesian(pt.quake.lat, pt.quake.lng, this.globeRadius + 0.052);
      _dummy.position.set(pos.x, pos.y, pos.z);
      _normal.set(pos.x, pos.y, pos.z).normalize();
      _dummy.quaternion.setFromUnitVectors(_up, _normal);

      _color.setRGB(pt.rgb[0], pt.rgb[1], pt.rgb[2]);

      if (pinCount < MAX_QUAKES_INSTANCES) {
        const heightScale = (0.14 + Math.pow(pt.heatWeight01, 1.45) * 0.65) * zoomScale;
        const radialScale = (0.55 + pt.heatWeight01 * 0.85) * zoomScale;
        _dummy.scale.set(radialScale, heightScale, radialScale);
        _dummy.updateMatrix();
        this.pinMesh.setMatrixAt(pinCount, _dummy.matrix);
        this.pinMesh.setColorAt(pinCount, _color);
        this.pinQuakes.push(pt.quake);
        pinCount++;
      }

      if (pt.heatWeight01 >= 0.36 && ringCount < MAX_QUAKES_INSTANCES) {
        const ringScale = (0.65 + pt.heatWeight01 * 1.1) * zoomScale;
        _dummy.scale.set(ringScale, 1, ringScale);
        _dummy.updateMatrix();
        this.ringMesh.setMatrixAt(ringCount, _dummy.matrix);
        this.ringMesh.setColorAt(ringCount, _color);
        this.ringQuakes.push(pt.quake);
        ringCount++;
      }
    }

    this.pinMesh.count = pinCount;
    this.ringMesh.count = ringCount;
    this.pinMesh.instanceMatrix.needsUpdate = true;
    this.ringMesh.instanceMatrix.needsUpdate = true;
    if (this.pinMesh.instanceColor) this.pinMesh.instanceColor.needsUpdate = true;
    if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true;
    if (pinCount > 0) this.pinMesh.computeBoundingSphere();
    if (ringCount > 0) this.ringMesh.computeBoundingSphere();
  }

  public getPickables(): THREE.Object3D[] {
    if (!this.enabled || !this.group.visible) return [];
    const out: THREE.Object3D[] = [];
    if (this.pinMesh.count > 0) out.push(this.pinMesh);
    if (this.ringMesh.count > 0) out.push(this.ringMesh);
    return out;
  }

  public resolveQuakeHit(hit: THREE.Intersection): SeismicQuake24h | null {
    if (hit.instanceId === undefined || hit.instanceId < 0) return null;
    if (hit.object === this.pinMesh) {
      return this.pinQuakes[hit.instanceId] ?? null;
    }
    if (hit.object === this.ringMesh) {
      return this.ringQuakes[hit.instanceId] ?? null;
    }
    return null;
  }

  public findNearestQuakeByLatLng(lat: number, lng: number, maxDeg = 3.2): SeismicQuake24h | null {
    if (!this.enabled || this.normalizedPoints.length === 0) return null;
    const cosLat = Math.max(0.25, Math.cos((lat * Math.PI) / 180));
    let bestQuake: SeismicQuake24h | null = null;
    let bestScore = Infinity;

    for (const pt of this.normalizedPoints) {
      const dLat = pt.quake.lat - lat;
      const dLng = (((pt.quake.lng - lng + 540) % 360) - 180) * cosLat;
      const degDist = Math.hypot(dLat, dLng);
      if (degDist > maxDeg) continue;
      // Slightly prefer stronger quakes when clicking inside overlapping heatmap zones
      const score = degDist - pt.heatWeight01 * 0.45;
      if (score < bestScore) {
        bestScore = score;
        bestQuake = pt.quake;
      }
    }
    return bestQuake;
  }

  public update(elapsedSec: number, altitude: number) {
    if (!this.enabled) {
      this.group.visible = false;
      return;
    }
    this.group.visible = altitude > 0.10;
    if (!this.group.visible) return;

    const closeFade = clamp((altitude - 0.10) / 0.24, 0, 1);
    this.shellMat.uniforms.uTime.value = elapsedSec;
    this.shellMat.uniforms.uOpacity.value = clamp(0.45 + (altitude - 1.5) * 0.045, 0.45, 0.90) * closeFade;

    if (Math.abs(altitude - this.lastAltitude) > Math.max(0.08, this.lastAltitude * 0.12)) {
      this.lastAltitude = altitude;
      this.syncInstances(altitude);
    }
  }

  public dispose() {
    this.heatTex.dispose();
    this.shellGeo.dispose();
    this.shellMat.dispose();
    this.pinGeo.dispose();
    this.pinMat.dispose();
    this.ringGeo.dispose();
    this.ringMat.dispose();
  }
}

/**
 * Local 24h seismic thermal overlay projected onto active Terreno 3D world coordinates.
 */
export class TerrainSeismicHeatmapLayer {
  public readonly group = new THREE.Group();
  private discGeo: THREE.PlaneGeometry;
  private pinGeo: THREE.CylinderGeometry;
  private meshes: Array<{ mesh: THREE.Mesh; mat: THREE.Material }> = [];

  constructor() {
    this.discGeo = new THREE.PlaneGeometry(1, 1);
    this.discGeo.rotateX(-Math.PI / 2);
    this.pinGeo = new THREE.CylinderGeometry(0.14, 0.36, 1, 8);
    this.pinGeo.translate(0, 0.5, 0);
  }

  public syncLocalQuakes(
    quakes: SeismicQuake24h[],
    metrics: SeismicHeatScaleMetrics,
    enabled: boolean,
    latLngToWorldXZ: (lat: number, lng: number) => [number, number],
    sampleHeightAtWorldXZ: (x: number, z: number) => number
  ) {
    this.clearMeshes();
    this.group.visible = enabled;
    if (!enabled || quakes.length === 0) return;

    const normalized = normalizeQuakesForDynamicHeat(quakes, metrics);
    for (const pt of normalized) {
      const [wx, wz] = latLngToWorldXZ(pt.quake.lat, pt.quake.lng);
      if (Math.hypot(wx, wz) > 480) continue;

      const wy = sampleHeightAtWorldXZ(wx, wz);
      const col = new THREE.Color(pt.rgb[0], pt.rgb[1], pt.rgb[2]);
      const radius = 14 + pt.heatWeight01 * 26;

      const discMat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: col },
          uWeight: { value: pt.heatWeight01 },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uColor;
          uniform float uWeight;
          varying vec2 vUv;
          void main() {
            float d = length(vUv - 0.5) * 2.0;
            if (d > 1.0) discard;
            float falloff = exp(-d * d * 3.4);
            float ring = exp(-pow((d - 0.68) * 14.0, 2.0)) * 0.7;
            float alpha = clamp(falloff * (0.42 + uWeight * 0.32) + ring * 0.45, 0.0, 0.85);
            gl_FragColor = vec4(uColor + vec3(0.2, 0.1, 0.05) * ring, alpha);
          }
        `,
        transparent: true,
        depthWrite: false,
      });
      const disc = new THREE.Mesh(this.discGeo, discMat);
      disc.position.set(wx, wy + 0.18, wz);
      disc.scale.set(radius * 2, 1, radius * 2);
      disc.renderOrder = 4;
      disc.userData.quake24h = pt.quake;

      const pinMat = new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: 0.9,
      });
      const pin = new THREE.Mesh(this.pinGeo, pinMat);
      pin.position.set(wx, wy + 0.15, wz);
      pin.scale.set(1, 3.5 + pt.heatWeight01 * 7.5, 1);
      pin.userData.quake24h = pt.quake;

      this.group.add(disc, pin);
      this.meshes.push({ mesh: disc, mat: discMat }, { mesh: pin, mat: pinMat });
    }
  }

  public getPickables(): THREE.Object3D[] {
    if (!this.group.visible) return [];
    return this.meshes.map((item) => item.mesh);
  }

  private clearMeshes() {
    for (const item of this.meshes) {
      item.mat.dispose();
      this.group.remove(item.mesh);
    }
    this.meshes = [];
  }

  public dispose() {
    this.clearMeshes();
    this.discGeo.dispose();
    this.pinGeo.dispose();
  }
}
