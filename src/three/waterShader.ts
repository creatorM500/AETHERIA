import * as THREE from 'three';
import type { GodsEyeShaderUniforms } from './godsEyeVisuals.ts';

/**
 * Creates a seamless world-space animated water ShaderMaterial for coastal seas,
 * rivers, canals, and lakes inside Terreno 3D:
 * - Multi-octave animated surface wave normals in world XZ (zero tile seams)
 * - Fresnel sky/cyan grazing reflection + deep teal/navy water absorption
 * - Shoreline foam edge glow + sun specular glints + horizon fog fade
 */
export function createRealisticWaterMaterial(
  uniforms: GodsEyeShaderUniforms,
  sunDirection = new THREE.Vector3(0.55, 0.72, 0.42).normalize()
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: uniforms.time,
      uGodsEyeMode: uniforms.godsEyeMode,
      uNightMode: uniforms.nightMode,
      uHorizonFadeRadius: uniforms.horizonFadeRadius,
      uFocusPoint: uniforms.focusPoint,
      uSunDir: { value: sunDirection.clone().normalize() },
      uEdgeColor: { value: new THREE.Color('#06090f') },
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

      varying vec3 vWorldPos;
      varying float vDepth01;

      void main() {
        vec2 p = vWorldPos.xz;
        float t = uTime;

        // Multi-directional continuous world-space wave octaves (seamless across tiles)
        float w1 = sin(p.x * 1.45 + p.y * 0.85 + t * 1.75);
        float w2 = cos(p.x * 2.30 - p.y * 1.95 - t * 2.15);
        float w3 = sin((p.x - p.y) * 4.40 + t * 2.85) * 0.45;
        float w4 = cos((p.x * 0.65 + p.y * 3.80) - t * 2.40) * 0.35;

        float dx = 0.058 * (
          cos(p.x * 1.45 + p.y * 0.85 + t * 1.75) * 1.45
          - sin(p.x * 2.30 - p.y * 1.95 - t * 2.15) * 2.30
          + cos((p.x - p.y) * 4.40 + t * 2.85) * 1.98
          - sin((p.x * 0.65 + p.y * 3.80) - t * 2.40) * 0.23
        );
        float dz = 0.058 * (
          cos(p.x * 1.45 + p.y * 0.85 + t * 1.75) * 0.85
          + sin(p.x * 2.30 - p.y * 1.95 - t * 2.15) * 1.95
          - cos((p.x - p.y) * 4.40 + t * 2.85) * 1.98
          - sin((p.x * 0.65 + p.y * 3.80) - t * 2.40) * 1.33
        );

        vec3 N = normalize(vec3(-dx, 1.0, -dz));
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 L = normalize(uSunDir);
        vec3 H = normalize(L + V);

        float ndotv = clamp(dot(N, V), 0.0, 1.0);
        float fresnel = pow(1.0 - ndotv, 3.6);
        float spec = pow(max(dot(N, H), 0.0), 96.0);
        float glint = pow(max(dot(N, H), 0.0), 22.0) * 0.22;

        float depth = clamp(vDepth01, 0.0, 1.0);
        vec3 shallowColor = vec3(0.06, 0.44, 0.52);
        vec3 deepColor = vec3(0.014, 0.095, 0.195);
        vec3 skyReflect = mix(vec3(0.16, 0.48, 0.68), vec3(0.05, 0.14, 0.26), uNightMode);

        // Tactical holographic tint in Ojo de Dios mode
        vec3 holoShallow = vec3(0.04, 0.34, 0.48);
        vec3 holoDeep = vec3(0.008, 0.045, 0.105);
        shallowColor = mix(shallowColor, holoShallow, uGodsEyeMode * 0.72);
        deepColor = mix(deepColor, holoDeep, uGodsEyeMode * 0.72);
        skyReflect = mix(skyReflect, vec3(0.08, 0.65, 0.88), uGodsEyeMode * 0.65);

        vec3 baseWater = mix(shallowColor, deepColor, smoothstep(0.08, 0.88, depth));
        float waveHighlight = clamp((w1 + w2 + w3 + w4) * 0.12 + 0.5, 0.0, 1.0);
        baseWater += vec3(0.03, 0.11, 0.15) * waveHighlight;

        // Shoreline foam crest along shallow edges
        float shoreBand = (1.0 - smoothstep(0.0, 0.22, depth));
        float foamWave = smoothstep(0.15, 0.85, 0.5 + 0.5 * sin(depth * 24.0 - t * 2.6 + w1 * 1.4));
        float foam = shoreBand * (0.28 + 0.45 * foamWave);

        vec3 sunColor = mix(vec3(1.0, 0.94, 0.82), vec3(0.42, 0.86, 1.0), uGodsEyeMode * 0.75);
        vec3 col = mix(baseWater, skyReflect, fresnel * 0.74);
        col += sunColor * (spec * 1.25 + glint);
        col = mix(col, vec3(0.74, 0.94, 1.0), foam * 0.42);

        float edgeAlphaFade = 1.0;
        if (uHorizonFadeRadius > 1.0) {
          float distXZ = length(vWorldPos.xz - uFocusPoint.xz);
          float edgeFade = smoothstep(uHorizonFadeRadius * 0.72, uHorizonFadeRadius, distXZ);
          col = mix(col, uEdgeColor, edgeFade);
          edgeAlphaFade = 1.0 - smoothstep(116.0, 162.0, distXZ);
        }

        float alpha = mix(0.74, 0.90, clamp(depth + fresnel * 0.5, 0.0, 1.0)) * edgeAlphaFade;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}
