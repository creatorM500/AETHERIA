import * as THREE from 'three';
import type { GodsEyeShaderUniforms, Tier1MaskShaderBinding } from './godsEyeVisuals.ts';

const DEFAULT_ORIGIN_XZ = { value: new THREE.Vector2(0, 0) };
const DEFAULT_TILE_SIZE = { value: new THREE.Vector2(48, 48) };
const DEFAULT_MASK_TEX = { value: null as THREE.DataTexture | null };

/**
 * Creates a seamless world-space animated water ShaderMaterial for coastal seas,
 * rivers, canals, and lakes inside Terreno 3D:
 * - Screen-footprint (`fwidth`) & distance-filtered wave normals (zero noisy static at overview altitude)
 * - Fresnel sky/cyan grazing reflection + deep teal/navy water absorption
 * - Shoreline foam edge glow + sun specular glints + horizon fog fade
 * - Optional Tier-1 mask discard so Tier-2 (z=12) coastal ocean meets Tier-1 (z=14) with zero overlap
 */
export function createRealisticWaterMaterial(
  uniforms: GodsEyeShaderUniforms,
  sunDirection = new THREE.Vector3(0.55, 0.72, 0.42).normalize(),
  tier1Mask?: Tier1MaskShaderBinding
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: uniforms.time,
      uGodsEyeMode: uniforms.godsEyeMode,
      uNightMode: uniforms.nightMode,
      uHorizonFadeRadius: uniforms.horizonFadeRadius,
      uFocusPoint: uniforms.focusPoint,
      uSunDir: { value: sunDirection.clone().normalize() },
      uEdgeColor: uniforms.edgeColor ?? { value: new THREE.Color('#06090f') },
      uHasTier1Mask: { value: tier1Mask ? tier1Mask.hasMask : 0.0 },
      uTier1MaskTex: tier1Mask ? tier1Mask.maskTexUniform : DEFAULT_MASK_TEX,
      uTier1OriginXZ: tier1Mask ? tier1Mask.originXZ : DEFAULT_ORIGIN_XZ,
      uTier1TileSize: tier1Mask ? tier1Mask.tileSize : DEFAULT_TILE_SIZE,
    },
    vertexShader: `
      attribute vec3 color;
      varying vec3 vWorldPos;
      varying float vDepth01;

      void main() {
        vDepth01 = color.r;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uGodsEyeMode;
      uniform float uNightMode;
      uniform float uHorizonFadeRadius;
      uniform vec3 uFocusPoint;
      uniform vec3 uSunDir;
      uniform vec3 uEdgeColor;
      uniform float uHasTier1Mask;
      uniform sampler2D uTier1MaskTex;
      uniform vec2 uTier1OriginXZ;
      uniform vec2 uTier1TileSize;

      varying vec3 vWorldPos;
      varying float vDepth01;

      void main() {
        if (uHasTier1Mask > 0.5) {
          vec2 relTier1 = (vWorldPos.xz - uTier1OriginXZ) / max(uTier1TileSize, vec2(0.001));
          if (relTier1.x >= 0.0 && relTier1.x < 7.0 && relTier1.y >= 0.0 && relTier1.y < 7.0) {
            vec2 maskUv = (floor(relTier1) + 0.5) / 8.0;
            if (texture2D(uTier1MaskTex, maskUv).r > 0.5) {
              discard;
            }
          }
        }

        vec2 p = vWorldPos.xz;
        float t = uTime;
        float camDist = length(cameraPosition - vWorldPos);
        float footprint = max(length(fwidth(p)), 0.015);
        float distSmooth = 1.0 - smoothstep(42.0, 240.0, camDist);

        // Analytical mip-filtering per wave octave prevents sub-pixel specular aliasing at high altitude
        float f1 = 1.0 - smoothstep(0.32, 1.35, footprint * 0.42);
        float f2 = 1.0 - smoothstep(0.32, 1.35, footprint * 0.80);
        float f3 = 1.0 - smoothstep(0.32, 1.35, footprint * 1.48);
        float f4 = 1.0 - smoothstep(0.32, 1.35, footprint * 2.35);

        float w1 = sin(p.x * 0.36 + p.y * 0.22 + t * 1.15) * f1;
        float w2 = cos(p.x * 0.62 - p.y * 0.54 - t * 1.45) * f2;
        float w3 = sin((p.x - p.y) * 1.12 + t * 1.95) * 0.48 * f3;
        float w4 = cos((p.x * 0.45 + p.y * 1.90) - t * 2.10) * 0.32 * f4;

        float slopeAmp = mix(0.016, 0.044, distSmooth);
        float dx = slopeAmp * (
          cos(p.x * 0.36 + p.y * 0.22 + t * 1.15) * 0.36 * f1
          - sin(p.x * 0.62 - p.y * 0.54 - t * 1.45) * 0.62 * f2
          + cos((p.x - p.y) * 1.12 + t * 1.95) * 0.54 * f3
          - sin((p.x * 0.45 + p.y * 1.90) - t * 2.10) * 0.14 * f4
        );
        float dz = slopeAmp * (
          cos(p.x * 0.36 + p.y * 0.22 + t * 1.15) * 0.22 * f1
          + sin(p.x * 0.62 - p.y * 0.54 - t * 1.45) * 0.54 * f2
          - cos((p.x - p.y) * 1.12 + t * 1.95) * 0.54 * f3
          - sin((p.x * 0.45 + p.y * 1.90) - t * 2.10) * 0.61 * f4
        );

        vec3 N = normalize(vec3(-dx, 1.0, -dz));
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 L = normalize(uSunDir);
        vec3 H = normalize(L + V);

        float ndotv = clamp(dot(N, V), 0.0, 1.0);
        float fresnel = pow(1.0 - ndotv, 3.6);
        float specPow = mix(24.0, 92.0, distSmooth);
        float specGain = mix(0.24, 1.0, distSmooth);
        float spec = pow(max(dot(N, H), 0.0), specPow) * specGain;
        float glint = pow(max(dot(N, H), 0.0), 16.0) * 0.12;

        float depth = clamp(vDepth01, 0.0, 1.0);
        vec3 shallowColor = vec3(0.036, 0.28, 0.39);
        vec3 deepColor = vec3(0.014, 0.088, 0.185);
        vec3 skyReflect = mix(vec3(0.16, 0.44, 0.64), vec3(0.045, 0.13, 0.24), uNightMode);

        // Tactical holographic tint in Ojo de Dios mode
        vec3 holoShallow = vec3(0.030, 0.26, 0.40);
        vec3 holoDeep = vec3(0.008, 0.045, 0.105);
        shallowColor = mix(shallowColor, holoShallow, uGodsEyeMode * 0.72);
        deepColor = mix(deepColor, holoDeep, uGodsEyeMode * 0.72);
        skyReflect = mix(skyReflect, vec3(0.08, 0.65, 0.88), uGodsEyeMode * 0.65);

        vec3 baseWater = mix(shallowColor, deepColor, smoothstep(0.06, 0.76, depth));
        float waveHighlight = clamp((w1 + w2 + w3 + w4) * 0.09 + 0.5, 0.0, 1.0);
        baseWater += vec3(0.018, 0.072, 0.11) * waveHighlight;

        // Shoreline foam crest strictly hugged along shallow coastal margins
        float shoreBand = 1.0 - smoothstep(0.04, 0.22, depth);
        float foamWave = smoothstep(0.22, 0.86, 0.5 + 0.5 * sin(depth * 20.0 - t * 2.1 + w1 * 1.1));
        float foam = shoreBand * (0.20 + 0.34 * foamWave) * mix(0.55, 1.0, distSmooth);

        vec3 sunColor = mix(vec3(1.0, 0.94, 0.82), vec3(0.42, 0.86, 1.0), uGodsEyeMode * 0.75);
        vec3 col = mix(baseWater, skyReflect, fresnel * 0.72);
        col += sunColor * (spec + glint);
        col = mix(col, vec3(0.76, 0.95, 1.0), foam * 0.36);

        float edgeAlphaFade = 1.0;
        if (uHorizonFadeRadius > 1.0) {
          float distXZ = length(vWorldPos.xz - uFocusPoint.xz);
          float edgeFade = smoothstep(uHorizonFadeRadius * 0.72, uHorizonFadeRadius, distXZ);
          col = mix(col, uEdgeColor, edgeFade);
          edgeAlphaFade = 1.0 - edgeFade;
        }

        float alpha = mix(0.78, 0.94, clamp(depth * 0.85 + fresnel * 0.45, 0.0, 1.0)) * edgeAlphaFade;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}
