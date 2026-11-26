import * as THREE from 'three';
import { clamp, latLngToCartesian } from '../shared/geo.ts';
import type {
  CycloneVortexSpec,
  GlobalEvent,
  GlobalWeatherRadarResponse,
  GlobalWindFieldResponse,
} from '../shared/types.ts';
import {
  computeCycloneForecastCone,
  DEFAULT_ISOBAR_LEVELS_HPA,
  encodePrecipNorm,
  extractIsobarSegments,
  sampleWeatherRadarAtLatLng,
  superposeCyclonesOnWeather,
  wrapLngDeg,
} from '../shared/weatherRadar.ts';
import { extractCycloneVorticesFromEvents } from '../shared/windField.ts';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_RADIUS_KM = 6371;

/**
 * Computes a closed great-circle ring on the sphere around (lat, lng) at radiusKm.
 */
function buildSphericalRingPoints(
  lat: number,
  lng: number,
  radiusKm: number,
  globeRadius: number,
  segments = 36
): THREE.Vector3[] {
  const latRad = lat * DEG_TO_RAD;
  const angDist = radiusKm / EARTH_RADIUS_KM;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinAng = Math.sin(angDist);
  const cosAng = Math.cos(angDist);

  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const bearing = (i / segments) * Math.PI * 2;
    const nextLatRad = Math.asin(
      clamp(sinLat * cosAng + cosLat * sinAng * Math.cos(bearing), -1, 1)
    );
    const dLngRad = Math.atan2(
      Math.sin(bearing) * sinAng * cosLat,
      cosAng - sinLat * Math.sin(nextLatRad)
    );
    const ptLat = clamp(nextLatRad * RAD_TO_DEG, -85, 85);
    const ptLng = wrapLngDeg(lng + dLngRad * RAD_TO_DEG);
    const c = latLngToCartesian(ptLat, ptLng, globeRadius);
    pts.push(new THREE.Vector3(c.x, c.y, c.z));
  }
  return pts;
}

/**
 * 3D Globe Meteorological Radar Layer combining:
 * 1. High-resolution equirectangular Doppler DataTexture + custom GLSL convective radar shader
 *    (5-tap sub-texel smoothing, 3D spherical fBm convective echo breakup, dBZ contour lines,
 *     and gentle wind-advected shimmer with zero antimeridian/pole seams)
 * 2. Smooth 2.5°x3° sea-level barometric pressure isobar contours (980..1026 hPa)
 * 3. NHC-style 72-hour tropical cyclone tracks with gradient uncertainty cones & 24/48/72h rings
 */
export class GlobeWeatherRadarLayer {
  public readonly group = new THREE.Group();

  private readonly globeRadius: number;
  private readonly isSoftwareGl: boolean;
  private readonly texW: number;
  private readonly texH: number;
  private radarData: Uint8Array | null = null;
  private radarTex: THREE.DataTexture | null = null;
  private precipGeo: THREE.SphereGeometry | null = null;
  private precipMat: THREE.ShaderMaterial | null = null;
  private precipMesh: THREE.Mesh | null = null;

  private isobarGeo: THREE.BufferGeometry | null = null;
  private isobarMat: THREE.LineBasicMaterial | null = null;
  private isobarLines: THREE.LineSegments | null = null;

  private readonly coneGroup = new THREE.Group();
  private readonly coneGeos: THREE.BufferGeometry[] = [];
  private readonly coneMats: THREE.Material[] = [];

  private radarField: GlobalWeatherRadarResponse | null = null;
  private windField: GlobalWindFieldResponse | null = null;
  private cyclones: CycloneVortexSpec[] = [];
  private enabled = false;
  private allocated = false;
  private lastDataSignature = '';

  constructor(globeRadius: number, isSoftwareGl: boolean) {
    this.globeRadius = globeRadius;
    this.isSoftwareGl = isSoftwareGl;
    this.texW = isSoftwareGl ? 540 : 720;
    this.texH = isSoftwareGl ? 270 : 360;
    this.coneGroup.renderOrder = 5;
    this.group.visible = false;
  }

  public isAllocated(): boolean {
    return this.allocated;
  }

  private ensureAllocated() {
    if (this.allocated) return;

    this.radarData = new Uint8Array(this.texW * this.texH * 4);
    this.radarTex = new THREE.DataTexture(
      this.radarData,
      this.texW,
      this.texH,
      THREE.RGBAFormat
    );
    this.radarTex.wrapS = THREE.RepeatWrapping;
    this.radarTex.wrapT = THREE.ClampToEdgeWrapping;
    this.radarTex.minFilter = THREE.LinearFilter;
    this.radarTex.magFilter = THREE.LinearFilter;
    this.radarTex.generateMipmaps = false;
    // row 0 = -90° South Pole (UV v=0), row H-1 = +90° North Pole (UV v=1)
    this.radarTex.flipY = false;
    this.radarTex.needsUpdate = true;

    this.precipGeo = new THREE.SphereGeometry(
      this.globeRadius * 1.0044,
      this.isSoftwareGl ? 96 : 128,
      this.isSoftwareGl ? 72 : 96
    );
    this.precipMat = new THREE.ShaderMaterial({
      uniforms: {
        uRadarTex: { value: this.radarTex },
        uTexelSize: { value: new THREE.Vector2(1 / this.texW, 1 / this.texH) },
        uTime: { value: 0 },
        uOpacity: { value: 0.92 },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vUnitPos;
        varying vec3 vViewNormal;
        void main() {
          vUv = uv;
          vUnitPos = normalize(position);
          vViewNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uRadarTex;
        uniform vec2 uTexelSize;
        uniform float uTime;
        uniform float uOpacity;

        varying vec2 vUv;
        varying vec3 vUnitPos;
        varying vec3 vViewNormal;

        float hash3(vec3 p) {
          p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.23));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }

        float noise3(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);

          float n000 = hash3(i + vec3(0.0, 0.0, 0.0));
          float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
          float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
          float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
          float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
          float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
          float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
          float n111 = hash3(i + vec3(1.0, 1.0, 1.0));

          float nx00 = mix(n000, n100, f.x);
          float nx10 = mix(n010, n110, f.x);
          float nx01 = mix(n001, n101, f.x);
          float nx11 = mix(n011, n111, f.x);

          float nxy0 = mix(nx00, nx10, f.y);
          float nxy1 = mix(nx01, nx11, f.y);
          return mix(nxy0, nxy1, f.z);
        }

        float fbm3(vec3 p) {
          float v = 0.0;
          float a = 0.54;
          for (int i = 0; i < 3; i++) {
            v += a * noise3(p);
            p = p * 2.07 + vec3(13.1, 7.7, 19.3);
            a *= 0.48;
          }
          return v;
        }

        vec3 dopplerRadarRamp(float t) {
          vec3 c0 = vec3(0.22, 0.74, 0.97); // Trace mist: sky cyan (#38bdf8)
          vec3 c1 = vec3(0.06, 0.73, 0.51); // Light rain: Doppler emerald (#10b981)
          vec3 c2 = vec3(0.52, 0.80, 0.09); // Moderate bands: chartreuse (#84cc16)
          vec3 c3 = vec3(0.98, 0.80, 0.08); // Heavy convection: amber gold (#facc15)
          vec3 c4 = vec3(0.98, 0.45, 0.09); // Intense storm: vivid orange (#f97316)
          vec3 c5 = vec3(0.94, 0.24, 0.24); // Severe squall: crimson (#ef4444)
          vec3 c6 = vec3(0.91, 0.47, 0.98); // Extreme eyewall: magenta-violet (#e879f9)

          vec3 col = mix(c0, c1, smoothstep(0.00, 0.18, t));
          col = mix(col, c2, smoothstep(0.18, 0.36, t));
          col = mix(col, c3, smoothstep(0.36, 0.54, t));
          col = mix(col, c4, smoothstep(0.54, 0.72, t));
          col = mix(col, c5, smoothstep(0.72, 0.88, t));
          col = mix(col, c6, smoothstep(0.88, 1.00, t));
          return col;
        }

        void main() {
          // 5-tap sub-texel cross filter smooths coarse synoptic grid diamonds
          vec2 off = uTexelSize * 0.75;
          vec3 tc = texture2D(uRadarTex, vUv).rgb;
          vec3 t1 = texture2D(uRadarTex, vUv + vec2(off.x, off.y)).rgb;
          vec3 t2 = texture2D(uRadarTex, vUv + vec2(-off.x, off.y)).rgb;
          vec3 t3 = texture2D(uRadarTex, vUv + vec2(off.x, -off.y)).rgb;
          vec3 t4 = texture2D(uRadarTex, vUv + vec2(-off.x, -off.y)).rgb;
          vec3 tex = tc * 0.46 + (t1 + t2 + t3 + t4) * 0.135;

          float pBase = tex.r;
          if (pBase < 0.02) discard;

          float cloud = tex.g;
          float trough = tex.b;

          // 3D spherical convective echo breakup (completely seam-free at ±180° and poles)
          float adv = uTime * 0.014;
          float ca = cos(adv);
          float sa = sin(adv);
          vec3 pAdv = vec3(
            vUnitPos.x * ca - vUnitPos.z * sa,
            vUnitPos.y,
            vUnitPos.x * sa + vUnitPos.z * ca
          );

          vec3 warp = vec3(
            fbm3(pAdv * 7.2 + vec3(0.0, 2.1, uTime * 0.022)),
            fbm3(pAdv * 7.2 + vec3(4.3, -1.4, 0.0)),
            fbm3(pAdv * 7.2 + vec3(-2.8, 3.7, -uTime * 0.018))
          ) - 0.5;

          float cells = fbm3(pAdv * 18.5 + warp * 1.75);
          float ridgeRaw = fbm3(pAdv * 11.5 - warp * 1.4);
          float frontalBand = pow(clamp(1.0 - abs(ridgeRaw * 2.0 - 1.0), 0.0, 1.0), 1.6);
          float micro = noise3(pAdv * 44.0 - warp * 1.15);
          float echoTex = clamp(cells * 0.48 + frontalBand * 0.34 + micro * 0.18, 0.0, 1.0);

          // Break synoptic troughs into sharp curved Doppler frontal bands & convective cells
          // while preserving tight cyclone eyewalls and spiral arms
          float stratiformMod = mix(0.18, 1.52, smoothstep(0.32, 0.78, echoTex)) * mix(0.85, 1.14, cloud);
          float coreMod = mix(0.84, 1.28, echoTex);
          float coreProtect = smoothstep(0.42, 0.80, max(pBase, trough * 0.94));

          float echo = pBase * mix(stratiformMod, coreMod, coreProtect);
          if (echo < 0.065) discard;

          float t = clamp(smoothstep(0.065, 0.90, echo), 0.0, 1.0);
          vec3 rampColor = dopplerRadarRamp(t);

          // Anti-aliased dBZ iso-intensity contour bands inside active precipitation shields
          float isoPos = t * 5.0;
          float fw = max(fwidth(isoPos), 0.002);
          float isoDist = abs(fract(isoPos - 0.5) - 0.5);
          float isoLine = (1.0 - smoothstep(0.0, fw * 1.35, isoDist)) * smoothstep(0.18, 0.86, t);

          vec3 coreGlow = rampColor * smoothstep(0.55, 1.0, t) * 0.22;
          vec3 finalColor = rampColor + vec3(0.28, 0.34, 0.40) * isoLine * 0.42 + coreGlow;

          float wetFeather = smoothstep(0.065, 0.17, echo);
          float limbFade = smoothstep(0.04, 0.30, abs(dot(normalize(vViewNormal), vec3(0.0, 0.0, 1.0))));
          float alpha = clamp(wetFeather * (0.28 + pow(t, 0.74) * 0.62) + isoLine * 0.16, 0.0, 0.92) * uOpacity * limbFade;
          gl_FragColor = vec4(finalColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.precipMesh = new THREE.Mesh(this.precipGeo, this.precipMat);
    this.precipMesh.renderOrder = 3;

    this.isobarGeo = new THREE.BufferGeometry();
    this.isobarMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    });
    this.isobarLines = new THREE.LineSegments(this.isobarGeo, this.isobarMat);
    this.isobarLines.renderOrder = 4;

    this.group.add(this.precipMesh, this.isobarLines, this.coneGroup);
    this.allocated = true;
  }

  public releaseIdleMemory() {
    if (this.enabled || !this.allocated) return;
    this.clearCones();
    if (this.precipMesh) this.group.remove(this.precipMesh);
    if (this.isobarLines) this.group.remove(this.isobarLines);
    this.group.remove(this.coneGroup);
    this.precipGeo?.dispose();
    this.precipMat?.dispose();
    this.radarTex?.dispose();
    this.isobarGeo?.dispose();
    this.isobarMat?.dispose();
    this.precipMesh = null;
    this.precipGeo = null;
    this.precipMat = null;
    this.radarTex = null;
    this.radarData = null;
    this.isobarLines = null;
    this.isobarGeo = null;
    this.isobarMat = null;
    this.lastDataSignature = '';
    this.allocated = false;
    this.group.visible = false;
  }

  private computeDataSignature(): string {
    if (!this.radarField) return '';
    const cycSig = this.cyclones
      .map((c) => `${c.id}:${c.lat.toFixed(2)},${c.lng.toFixed(2)},${c.centralPressureHpa}`)
      .join('|');
    const windSig = this.windField?.updatedAt ?? 'none';
    return `${this.radarField.updatedAt}|${windSig}|${cycSig}`;
  }

  private syncBuffersIfNeeded() {
    if (!this.enabled || !this.radarField) {
      this.group.visible = false;
      return;
    }
    this.ensureAllocated();
    const nextSig = this.computeDataSignature();
    if (nextSig !== this.lastDataSignature) {
      this.lastDataSignature = nextSig;
      this.rebuildPrecipitationTexture();
      this.rebuildIsobars();
      this.rebuildCycloneForecastCones();
    }
    this.group.visible = true;
  }

  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      this.syncBuffersIfNeeded();
    } else {
      this.group.visible = false;
      this.releaseIdleMemory();
    }
  }

  public setData(
    radarField: GlobalWeatherRadarResponse | null,
    windField: GlobalWindFieldResponse | null,
    events: readonly GlobalEvent[]
  ) {
    this.radarField = radarField;
    this.windField = windField;
    this.cyclones = extractCycloneVorticesFromEvents(events);

    if (!this.radarField) {
      this.group.visible = false;
      return;
    }

    if (!this.enabled) {
      this.lastDataSignature = '';
      this.group.visible = false;
      return;
    }

    this.syncBuffersIfNeeded();
  }

  private rebuildPrecipitationTexture() {
    if (!this.radarField || !this.radarData || !this.radarTex) return;
    const w = this.texW;
    const h = this.texH;
    const data = this.radarData;

    for (let y = 0; y < h; y++) {
      // flipY=false -> row 0 maps to UV v=0 (-90° South Pole), row h-1 to +90° North Pole
      const lat = -90 + ((y + 0.5) / h) * 180;
      for (let x = 0; x < w; x++) {
        const lng = -180 + ((x + 0.5) / w) * 360;
        const base = sampleWeatherRadarAtLatLng(this.radarField, lat, lng);
        const combined = superposeCyclonesOnWeather(base, this.cyclones, lat, lng);

        // Coarse 15°x20° point gauges often sit between frontal squall lines; synthesize
        // realistic synoptic frontal band energy inside deep overcast low-pressure troughs
        const lowDeficit = clamp((1010.5 - combined.pressureHpa) / 26, 0, 1);
        const moistGate = clamp((combined.cloudPct - 56) / 36, 0, 1);
        const frontalPotentialMmH = lowDeficit * moistGate * 17.5;
        const effectivePrecipMmH = Math.max(combined.precipMmH, frontalPotentialMmH);

        const idx = (y * w + x) * 4;
        data[idx] = Math.round(encodePrecipNorm(effectivePrecipMmH) * 255);
        data[idx + 1] = Math.round(clamp(combined.cloudPct / 100, 0, 1) * 255);
        data[idx + 2] = Math.round(clamp((1016 - combined.pressureHpa) / 52, 0, 1) * 255);
        data[idx + 3] = 255;
      }
    }
    this.radarTex.needsUpdate = true;
  }

  private rebuildIsobars() {
    if (!this.radarField || !this.isobarGeo) return;
    const segments = extractIsobarSegments(
      this.radarField,
      this.cyclones,
      DEFAULT_ISOBAR_LEVELS_HPA
    );

    const SUBDIV = 2;
    const pos = new Float32Array(segments.length * SUBDIV * 6);
    const col = new Float32Array(segments.length * SUBDIV * 6);
    const isoR = this.globeRadius * 1.005;

    let cursor = 0;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      let dLng = s.lng2 - s.lng1;
      if (dLng > 180) dLng -= 360;
      if (dLng < -180) dLng += 360;

      // Barometric pressure hierarchy: extreme core coral-red -> trough gold -> sea-level sky -> high ridge blue
      let cr = 0.68;
      let cg = 0.90;
      let cb = 1.0;
      if (s.levelHpa <= 988) {
        cr = 0.99;
        cg = 0.34;
        cb = 0.28;
      } else if (s.levelHpa <= 996) {
        cr = 0.99;
        cg = 0.54;
        cb = 0.22;
      } else if (s.levelHpa <= 1004) {
        cr = 0.98;
        cg = 0.80;
        cb = 0.28;
      } else if (s.levelHpa >= 1020) {
        cr = 0.38;
        cg = 0.74;
        cb = 0.98;
      }

      for (let step = 0; step < SUBDIV; step++) {
        const t0 = step / SUBDIV;
        const t1 = (step + 1) / SUBDIV;
        const latA = s.lat1 + (s.lat2 - s.lat1) * t0;
        const lngA = s.lng1 + dLng * t0;
        const latB = s.lat1 + (s.lat2 - s.lat1) * t1;
        const lngB = s.lng1 + dLng * t1;

        const p1 = latLngToCartesian(latA, lngA, isoR);
        const p2 = latLngToCartesian(latB, lngB, isoR);

        pos[cursor] = p1.x;
        pos[cursor + 1] = p1.y;
        pos[cursor + 2] = p1.z;
        pos[cursor + 3] = p2.x;
        pos[cursor + 4] = p2.y;
        pos[cursor + 5] = p2.z;

        col[cursor] = cr;
        col[cursor + 1] = cg;
        col[cursor + 2] = cb;
        col[cursor + 3] = cr;
        col[cursor + 4] = cg;
        col[cursor + 5] = cb;
        cursor += 6;
      }
    }

    this.isobarGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.isobarGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.isobarGeo.computeBoundingSphere();
  }

  private clearCones() {
    while (this.coneGroup.children.length > 0) {
      this.coneGroup.remove(this.coneGroup.children[0]);
    }
    for (const g of this.coneGeos) g.dispose();
    for (const m of this.coneMats) m.dispose();
    this.coneGeos.length = 0;
    this.coneMats.length = 0;
  }

  private rebuildCycloneForecastCones() {
    this.clearCones();
    if (this.cyclones.length === 0) return;

    const coneR = this.globeRadius * 1.0056;
    const trackR = this.globeRadius * 1.0064;

    for (const cyc of this.cyclones) {
      const cone = computeCycloneForecastCone(cyc, this.windField, 72);
      if (cone.waypoints.length < 2) continue;

      // 1. Gradient translucent spherical ribbon cone strip + final 72h cap
      const positions: number[] = [];
      const progress: number[] = [];
      const edgeMask: number[] = [];
      const indices: number[] = [];

      const nWp = cone.waypoints.length;
      for (let i = 0; i < nWp; i++) {
        const frac = i / Math.max(1, nWp - 1);
        const lPt = latLngToCartesian(cone.leftEdge[i].lat, cone.leftEdge[i].lng, coneR);
        const rPt = latLngToCartesian(cone.rightEdge[i].lat, cone.rightEdge[i].lng, coneR);
        positions.push(lPt.x, lPt.y, lPt.z, rPt.x, rPt.y, rPt.z);
        progress.push(frac, frac);
        edgeMask.push(1.0, 1.0);
        if (i > 0) {
          const v0 = (i - 1) * 2;
          const v1 = v0 + 1;
          const v2 = i * 2;
          const v3 = v2 + 1;
          indices.push(v0, v2, v1, v1, v2, v3);
        }
      }

      // Add semicircular cap tip triangles at 72h end
      const lastWp = cone.waypoints[nWp - 1];
      const capCenter = latLngToCartesian(lastWp.lat, lastWp.lng, coneR);
      const capCenterIdx = positions.length / 3;
      positions.push(capCenter.x, capCenter.y, capCenter.z);
      progress.push(1.0);
      edgeMask.push(0.2);

      const capStart = cone.leftEdge.length;
      const capEnd = cone.conePolygon.length - cone.rightEdge.length;
      const lastLeftIdx = (nWp - 1) * 2;
      const lastRightIdx = lastLeftIdx + 1;
      let prevCapIdx = lastLeftIdx;
      for (let k = capStart; k < capEnd; k++) {
        const cp = latLngToCartesian(cone.conePolygon[k].lat, cone.conePolygon[k].lng, coneR);
        const curIdx = positions.length / 3;
        positions.push(cp.x, cp.y, cp.z);
        progress.push(1.0);
        edgeMask.push(1.0);
        indices.push(capCenterIdx, prevCapIdx, curIdx);
        prevCapIdx = curIdx;
      }
      indices.push(capCenterIdx, prevCapIdx, lastRightIdx);

      const stripGeo = new THREE.BufferGeometry();
      stripGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      stripGeo.setAttribute('aProgress', new THREE.Float32BufferAttribute(progress, 1));
      stripGeo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edgeMask, 1));
      stripGeo.setIndex(indices);

      const coneBaseColor = new THREE.Color(
        cyc.cycloneCategory >= 3 ? 0xf97316 : 0xfbbf24
      );
      const stripMat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: coneBaseColor },
        },
        vertexShader: `
          attribute float aProgress;
          attribute float aEdge;
          varying float vProgress;
          varying float vEdge;
          void main() {
            vProgress = aProgress;
            vEdge = aEdge;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uColor;
          varying float vProgress;
          varying float vEdge;
          void main() {
            float timeFade = mix(0.32, 0.11, smoothstep(0.0, 1.0, vProgress));
            float rimLift = mix(0.85, 1.15, vEdge);
            gl_FragColor = vec4(uColor * rimLift, timeFade);
          }
        `,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const stripMesh = new THREE.Mesh(stripGeo, stripMat);
      stripMesh.renderOrder = 5;
      this.coneGroup.add(stripMesh);
      this.coneGeos.push(stripGeo);
      this.coneMats.push(stripMat);

      // 2. Crisp cone outer perimeter border loop
      const borderPts: THREE.Vector3[] = cone.conePolygon.map((pt) => {
        const c = latLngToCartesian(pt.lat, pt.lng, coneR + 0.002);
        return new THREE.Vector3(c.x, c.y, c.z);
      });
      const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPts);
      const borderMat = new THREE.LineBasicMaterial({
        color: cyc.cycloneCategory >= 3 ? 0xfdba74 : 0xfde68a,
        transparent: true,
        opacity: 0.86,
        depthWrite: false,
      });
      const borderLine = new THREE.LineLoop(borderGeo, borderMat);
      borderLine.renderOrder = 6;
      this.coneGroup.add(borderLine);
      this.coneGeos.push(borderGeo);
      this.coneMats.push(borderMat);

      // 3. Expanding 24h / 48h / 72h uncertainty rings on sphere
      for (const wp of cone.waypoints) {
        if (wp.hoursAhead !== 24 && wp.hoursAhead !== 48 && wp.hoursAhead !== 72) continue;
        const ringPts = buildSphericalRingPoints(
          wp.lat,
          wp.lng,
          wp.coneRadiusKm,
          coneR + 0.0025,
          36
        );
        const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
        const ringMat = new THREE.LineBasicMaterial({
          color: 0xfef3c7,
          transparent: true,
          opacity: wp.hoursAhead === 24 ? 0.55 : wp.hoursAhead === 48 ? 0.42 : 0.32,
          depthWrite: false,
        });
        const ringLine = new THREE.LineLoop(ringGeo, ringMat);
        ringLine.renderOrder = 6;
        this.coneGroup.add(ringLine);
        this.coneGeos.push(ringGeo);
        this.coneMats.push(ringMat);
      }

      // 4. Center forecast track line + 12h/24h/48h/72h forecast nodes
      const trackPts: THREE.Vector3[] = cone.waypoints.map((wp) => {
        const c = latLngToCartesian(wp.lat, wp.lng, trackR);
        return new THREE.Vector3(c.x, c.y, c.z);
      });
      const trackGeo = new THREE.BufferGeometry().setFromPoints(trackPts);
      const trackMat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.94,
        depthWrite: false,
      });
      const trackLine = new THREE.Line(trackGeo, trackMat);
      trackLine.renderOrder = 7;
      this.coneGroup.add(trackLine);
      this.coneGeos.push(trackGeo);
      this.coneMats.push(trackMat);

      const nodeGeo = new THREE.BufferGeometry().setFromPoints(trackPts);
      const nodeMat = new THREE.PointsMaterial({
        color: cyc.cycloneCategory >= 3 ? 0xfb923c : 0xfef08a,
        size: 0.16,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
      });
      const nodePts = new THREE.Points(nodeGeo, nodeMat);
      nodePts.renderOrder = 7;
      this.coneGroup.add(nodePts);
      this.coneGeos.push(nodeGeo);
      this.coneMats.push(nodeMat);
    }
  }

  public update(altitude: number, elapsedSec = 0) {
    if (!this.enabled || !this.radarField) {
      this.group.visible = false;
      return;
    }
    this.syncBuffersIfNeeded();
    this.group.visible = altitude > 0.08;
    if (!this.group.visible || !this.precipMat || !this.isobarMat) return;

    // Gently fade global precip & isobars below ~1.2 units so high-zoom street map tiles stay sharp
    const fade = THREE.MathUtils.clamp((altitude - 0.10) / 0.85, 0.18, 1.0);
    this.precipMat.uniforms.uTime.value = elapsedSec;
    this.precipMat.uniforms.uOpacity.value = 0.94 * fade;
    this.isobarMat.opacity = 0.62 * fade;
  }

  public dispose() {
    this.enabled = false;
    this.releaseIdleMemory();
  }
}
