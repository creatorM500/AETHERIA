import * as THREE from 'three';
import type { GlobeTextureMode } from '../shared/types.ts';

export interface TerrainAtmospherePalette {
  zenithHex: string;
  midHex: string;
  horizonHex: string;
  fogHex: string;
  fogDensity: number;
}

export function getTerrainAtmospherePalette(mode: GlobeTextureMode): TerrainAtmospherePalette {
  if (mode === 'godseye') {
    return {
      zenithHex: '#030812',
      midHex: '#071728',
      horizonHex: '#0d2b44',
      fogHex: '#0c273e',
      fogDensity: 0.00145,
    };
  }
  if (mode === 'thermal') {
    return {
      zenithHex: '#03050c',
      midHex: '#081020',
      horizonHex: '#122038',
      fogHex: '#0f1b30',
      fogDensity: 0.0015,
    };
  }
  if (mode === 'topo') {
    return {
      zenithHex: '#0c1c34',
      midHex: '#1b385c',
      horizonHex: '#2f5378',
      fogHex: '#28496a',
      fogDensity: 0.00135,
    };
  }
  // satellite
  return {
    zenithHex: '#09162a',
    midHex: '#152e4d',
    horizonHex: '#27486b',
    fogHex: '#213f5f',
    fogDensity: 0.00135,
  };
}

/**
 * Procedural atmospheric Sky Dome for Terreno 3D so distant mountains, coastal seas,
 * and skylines blend into a physically grounded twilight/day horizon rather than raw black void.
 */
export class TerrainSkyDome {
  public readonly mesh: THREE.Mesh;
  private readonly geo: THREE.SphereGeometry;
  private readonly mat: THREE.ShaderMaterial;

  constructor(initialMode: GlobeTextureMode, sunDirection = new THREE.Vector3(0.55, 0.42, 0.45)) {
    const pal = getTerrainAtmospherePalette(initialMode);
    this.geo = new THREE.SphereGeometry(620, 32, 20);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color(pal.zenithHex) },
        uMid: { value: new THREE.Color(pal.midHex) },
        uHorizon: { value: new THREE.Color(pal.horizonHex) },
        uSunDir: { value: sunDirection.clone().normalize() },
        uSunGlowOpacity: { value: initialMode === 'satellite' || initialMode === 'topo' ? 0.34 : 0.14 },
      },
      vertexShader: `
        varying vec3 vLocalDir;
        void main() {
          vLocalDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uZenith;
        uniform vec3 uMid;
        uniform vec3 uHorizon;
        uniform vec3 uSunDir;
        uniform float uSunGlowOpacity;
        varying vec3 vLocalDir;

        void main() {
          vec3 d = normalize(vLocalDir);
          float h = clamp(d.y, -0.25, 1.0);
          float lowMix = smoothstep(-0.08, 0.18, h);
          float highMix = smoothstep(0.14, 0.78, h);
          vec3 sky = mix(uHorizon, uMid, lowMix);
          sky = mix(sky, uZenith, highMix);

          // Subtle directional atmospheric scattering near sun azimuth along horizon
          float sunAlign = max(0.0, dot(d, normalize(uSunDir)));
          float horizonBelt = exp(-pow(max(0.0, h) / 0.24, 2.0));
          float scatter = pow(sunAlign, 5.0) * horizonBelt * uSunGlowOpacity;
          sky += vec3(0.85, 0.62, 0.38) * scatter;

          gl_FragColor = vec4(sky, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
  }

  public setMode(mode: GlobeTextureMode) {
    const pal = getTerrainAtmospherePalette(mode);
    (this.mat.uniforms.uZenith.value as THREE.Color).set(pal.zenithHex);
    (this.mat.uniforms.uMid.value as THREE.Color).set(pal.midHex);
    (this.mat.uniforms.uHorizon.value as THREE.Color).set(pal.horizonHex);
    this.mat.uniforms.uSunGlowOpacity.value =
      mode === 'satellite' || mode === 'topo' ? 0.34 : 0.14;
  }

  public updatePosition(x: number, y: number, z: number) {
    this.mesh.position.set(x, y, z);
  }

  public dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}
