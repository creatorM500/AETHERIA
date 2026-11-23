import * as THREE from 'three';

/**
 * Inner Rayleigh atmospheric limb scattering shader modulated by solar illumination.
 */
export function createAtmosphereMaterial(sunDirection = new THREE.Vector3(0.65, 0.55, 0.52).normalize()): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color('#38bdf8') },
      twilightColor: { value: new THREE.Color('#1d4ed8') },
      sunDir: { value: sunDirection.clone().normalize() },
      intensity: { value: 0.82 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldNormal;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvPosition.xyz);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 glowColor;
      uniform vec3 twilightColor;
      uniform vec3 sunDir;
      uniform float intensity;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldNormal;
      void main() {
        float rim = 1.0 - max(0.0, dot(vViewDir, vNormal));
        float dayFactor = smoothstep(-0.28, 0.55, dot(vWorldNormal, sunDir));
        float fresnel = pow(rim, 3.0);
        vec3 scatterCol = mix(twilightColor, glowColor, dayFactor);
        float alpha = fresnel * intensity * mix(0.28, 1.0, dayFactor);
        gl_FragColor = vec4(scatterCol, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });
}

/**
 * Outer back-face orbital corona halo that softly transitions the planetary limb into deep space.
 */
export function createOuterHaloMaterial(sunDirection = new THREE.Vector3(0.65, 0.55, 0.52).normalize()): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color('#22d3ee') },
      sunDir: { value: sunDirection.clone().normalize() },
      intensity: { value: 0.42 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldNormal;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvPosition.xyz);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 glowColor;
      uniform vec3 sunDir;
      uniform float intensity;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldNormal;
      void main() {
        float viewDot = dot(vNormal, vViewDir);
        float limb = pow(clamp(0.68 - viewDot, 0.0, 1.0), 3.4);
        float dayFactor = smoothstep(-0.35, 0.6, dot(vWorldNormal, sunDir));
        float alpha = limb * intensity * mix(0.22, 1.0, dayFactor);
        gl_FragColor = vec4(glowColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
  });
}
