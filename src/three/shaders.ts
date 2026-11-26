import * as THREE from 'three';

export interface GlobeSolarUniforms {
  uSunDir: { value: THREE.Vector3 };
  uTerminatorEnabled: { value: number };
  uNightLightsMap: { value: THREE.Texture };
  uNightLightsIntensity: { value: number };
  uPlanetRoughnessMap: { value: THREE.Texture };
}

/**
 * Inner Rayleigh + twilight atmospheric limb scattering shader modulated by real-time solar direction.
 */
export function createAtmosphereMaterial(
  sunDirection = new THREE.Vector3(0.65, 0.55, 0.52).normalize()
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color('#38bdf8') },
      twilightColor: { value: new THREE.Color('#1d4ed8') },
      twilightScatterColor: { value: new THREE.Color('#fb923c') },
      sunDir: { value: sunDirection.clone().normalize() },
      intensity: { value: 0.68 },
      terminatorStrength: { value: 0.0 },
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
      uniform vec3 twilightScatterColor;
      uniform vec3 sunDir;
      uniform float intensity;
      uniform float terminatorStrength;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldNormal;
      void main() {
        float rim = 1.0 - max(0.0, dot(vViewDir, vNormal));
        float sunDot = dot(normalize(vWorldNormal), normalize(sunDir));
        float dayFactor = smoothstep(-0.20, 0.44, sunDot);
        float twilightBand = exp(-pow((sunDot + 0.02) / 0.135, 2.0)) * terminatorStrength;

        float fresnel = pow(rim, 3.15);
        vec3 baseCol = mix(twilightColor, glowColor, dayFactor);
        vec3 scatterCol = mix(baseCol, twilightScatterColor, clamp(twilightBand * 0.84, 0.0, 0.86));

        float nightFloor = mix(0.22, 0.075, terminatorStrength);
        float alpha = fresnel * intensity * mix(nightFloor, 1.0, max(dayFactor, twilightBand * 0.90));
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
 * Outer back-face orbital corona halo that softly transitions the planetary limb into deep space
 * and warms slightly across the solar terminator.
 */
export function createOuterHaloMaterial(
  sunDirection = new THREE.Vector3(0.65, 0.55, 0.52).normalize()
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color('#22d3ee') },
      twilightScatterColor: { value: new THREE.Color('#f97316') },
      sunDir: { value: sunDirection.clone().normalize() },
      intensity: { value: 0.36 },
      terminatorStrength: { value: 0.0 },
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
      uniform vec3 twilightScatterColor;
      uniform vec3 sunDir;
      uniform float intensity;
      uniform float terminatorStrength;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldNormal;
      void main() {
        float viewDot = dot(vNormal, vViewDir);
        float limb = pow(clamp(0.69 - viewDot, 0.0, 1.0), 3.3);
        float sunDot = dot(normalize(vWorldNormal), normalize(sunDir));
        float dayFactor = smoothstep(-0.26, 0.50, sunDot);
        float twilightBand = exp(-pow((sunDot + 0.015) / 0.155, 2.0)) * terminatorStrength;
        vec3 col = mix(glowColor, twilightScatterColor, clamp(twilightBand * 0.62, 0.0, 0.68));
        float nightFloor = mix(0.22, 0.065, terminatorStrength);
        float alpha = limb * intensity * mix(nightFloor, 1.0, max(dayFactor, twilightBand * 0.76));
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
  });
}

/**
 * Enhances the main globe PBR surface material with a real-time UTC solar terminator:
 * blends sunlit satellite imagery (with orbital ocean sunglint & Rayleigh aerial perspective)
 * smoothly across golden/copper twilight into deep nocturnal shadows + warm-core urban city lights.
 */
export function applyGlobeTerminatorShader(
  material: THREE.MeshStandardMaterial,
  solarUniforms: GlobeSolarUniforms
): void {
  material.customProgramCacheKey = () => 'globe-solar-terminator-v2';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = solarUniforms.uSunDir;
    shader.uniforms.uTerminatorEnabled = solarUniforms.uTerminatorEnabled;
    shader.uniforms.uNightLightsMap = solarUniforms.uNightLightsMap;
    shader.uniforms.uNightLightsIntensity = solarUniforms.uNightLightsIntensity;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTermWorldNormal;
        varying vec3 vTermViewDirWorld;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTermWorldNormal = normalize(mat3(modelMatrix) * normal);
        vec3 termWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTermViewDirWorld = normalize(cameraPosition - termWorldPos);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTermWorldNormal;
        varying vec3 vTermViewDirWorld;
        uniform vec3 uSunDir;
        uniform float uTerminatorEnabled;
        uniform sampler2D uNightLightsMap;
        uniform float uNightLightsIntensity;`
      )
      .replace(
        '#include <opaque_fragment>',
        `if (uTerminatorEnabled > 0.5) {
          vec3 wNorm = normalize(vTermWorldNormal);
          vec3 viewDirW = normalize(vTermViewDirWorld);
          vec3 sunDirN = normalize(uSunDir);
          float sunDot = dot(wNorm, sunDirN);
          float dayMask = smoothstep(-0.12, 0.16, sunDot);
          float nightMask = smoothstep(0.06, -0.17, sunDot);
          float goldenBand = exp(-pow((sunDot - 0.015) / 0.078, 2.0));
          float copperBand = exp(-pow((sunDot + 0.055) / 0.088, 2.0));

          float ndv = max(0.0, dot(wNorm, viewDirW));
          float limbFresnel = pow(1.0 - ndv, 2.65);

          // Orbital ocean solar sunglint masked strictly to smooth water via roughnessFactor
          vec3 halfVec = normalize(sunDirN + viewDirW);
          float oceanMask = smoothstep(0.68, 0.44, roughnessFactor);
          float sunglint = pow(max(0.0, dot(wNorm, halfVec)), 84.0) * oceanMask * dayMask;
          vec3 litDay = outgoingLight + vec3(1.0, 0.94, 0.82) * sunglint * 0.30;

          // Subtle Rayleigh atmospheric aerial perspective across sunlit globe limbs
          litDay += vec3(0.22, 0.54, 0.96) * limbFresnel * dayMask * 0.24;

          vec3 nightBase = diffuseColor.rgb * vec3(0.045, 0.082, 0.175) + vec3(0.004, 0.008, 0.018);
          nightBase += vec3(0.018, 0.036, 0.085) * pow(1.0 - ndv, 2.2) * nightMask;

          vec3 surfaceCol = mix(nightBase, litDay, dayMask);
          vec3 twilightCol = vec3(1.0, 0.56, 0.18) * goldenBand * 0.22 + vec3(0.92, 0.30, 0.12) * copperBand * 0.18;
          surfaceCol += twilightCol * (0.42 + 0.58 * diffuseColor.rgb);

          #ifdef USE_MAP
            vec3 cityLights = texture2D(uNightLightsMap, vMapUv).rgb;
            float cityCore = smoothstep(0.18, 0.85, max(cityLights.r, max(cityLights.g, cityLights.b)));
            vec3 warmCity = mix(cityLights * 0.92, cityLights * vec3(1.18, 1.04, 0.82), cityCore);
            surfaceCol += warmCity * nightMask * uNightLightsIntensity;
          #endif

          outgoingLight = surfaceCol;
        }
        #include <opaque_fragment>`
      );
  };
}

/**
 * Applies matching day/night terminator + Rayleigh aerial perspective + twilight scatter + city lights
 * onto streamed regional satellite tiles (zoom <= 9) so zooming down from orbit preserves seamless solar lighting.
 */
export function applyRegionalTileTerminatorShader(
  material: THREE.MeshStandardMaterial,
  solarUniforms: GlobeSolarUniforms
): void {
  material.customProgramCacheKey = () => 'regional-tile-terminator-v3';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = solarUniforms.uSunDir;
    shader.uniforms.uTerminatorEnabled = solarUniforms.uTerminatorEnabled;
    shader.uniforms.uNightLightsMap = solarUniforms.uNightLightsMap;
    shader.uniforms.uNightLightsIntensity = solarUniforms.uNightLightsIntensity;
    shader.uniforms.uPlanetRoughnessMap = solarUniforms.uPlanetRoughnessMap;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTileGlobeNormal;
        varying vec3 vTileViewDirWorld;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 tileWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTileGlobeNormal = normalize(tileWorldPos);
        vTileViewDirWorld = normalize(cameraPosition - tileWorldPos);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTileGlobeNormal;
        varying vec3 vTileViewDirWorld;
        uniform vec3 uSunDir;
        uniform float uTerminatorEnabled;
        uniform sampler2D uNightLightsMap;
        uniform float uNightLightsIntensity;
        uniform sampler2D uPlanetRoughnessMap;`
      )
      .replace(
        '#include <opaque_fragment>',
        `if (uTerminatorEnabled > 0.5) {
          vec3 wNorm = normalize(vTileGlobeNormal);
          vec3 viewDirW = normalize(vTileViewDirWorld);
          vec3 sunDirN = normalize(uSunDir);
          float sunDot = dot(wNorm, sunDirN);
          float dayMask = smoothstep(-0.12, 0.16, sunDot);
          float nightMask = smoothstep(0.06, -0.17, sunDot);
          float goldenBand = exp(-pow((sunDot - 0.015) / 0.078, 2.0));
          float copperBand = exp(-pow((sunDot + 0.055) / 0.088, 2.0));

          vec2 equirectUv = vec2(
            atan(-wNorm.z, wNorm.x) / 6.28318530718 + 0.5,
            asin(clamp(wNorm.y, -1.0, 1.0)) / 3.14159265359 + 0.5
          );
          float planetRough = texture2D(uPlanetRoughnessMap, equirectUv).r;
          vec3 halfVec = normalize(sunDirN + viewDirW);
          float oceanMask = smoothstep(0.68, 0.44, planetRough);
          float sunglint = pow(max(0.0, dot(wNorm, halfVec)), 84.0) * oceanMask * dayMask;

          float ndv = max(0.0, dot(wNorm, viewDirW));
          float limbFresnel = pow(1.0 - ndv, 2.65);
          vec3 litDay = outgoingLight + vec3(1.0, 0.94, 0.82) * sunglint * 0.28;
          litDay += vec3(0.20, 0.50, 0.92) * limbFresnel * dayMask * 0.20;

          vec3 nightBase = diffuseColor.rgb * vec3(0.045, 0.082, 0.175) + vec3(0.004, 0.008, 0.018);
          nightBase += vec3(0.018, 0.036, 0.085) * pow(1.0 - ndv, 2.2) * nightMask;

          vec3 surfaceCol = mix(nightBase, litDay, dayMask);
          vec3 twilightCol = vec3(1.0, 0.54, 0.18) * goldenBand * 0.20 + vec3(0.90, 0.28, 0.12) * copperBand * 0.16;
          surfaceCol += twilightCol * (0.42 + 0.58 * diffuseColor.rgb);

          vec3 cityLights = texture2D(uNightLightsMap, equirectUv).rgb;
          float cityCore = smoothstep(0.18, 0.85, max(cityLights.r, max(cityLights.g, cityLights.b)));
          vec3 warmCity = mix(cityLights * 0.92, cityLights * vec3(1.18, 1.04, 0.82), cityCore);
          surfaceCol += warmCity * nightMask * uNightLightsIntensity;

          outgoingLight = surfaceCol;
        }
        #include <opaque_fragment>`
      );
  };
}

/**
 * Modulates the orbital cloud shell so night-side clouds stay dark and transparent enough
 * to reveal glowing city grids underneath while catching sunlit highlights and warm sunset scatter.
 */
export function applyCloudTerminatorShader(
  material: THREE.MeshStandardMaterial,
  solarUniforms: GlobeSolarUniforms
): void {
  material.customProgramCacheKey = () => 'cloud-solar-terminator-v2';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = solarUniforms.uSunDir;
    shader.uniforms.uTerminatorEnabled = solarUniforms.uTerminatorEnabled;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vCloudWorldNormal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vCloudWorldNormal = normalize(mat3(modelMatrix) * normal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vCloudWorldNormal;
        uniform vec3 uSunDir;
        uniform float uTerminatorEnabled;`
      )
      .replace(
        '#include <opaque_fragment>',
        `if (uTerminatorEnabled > 0.5) {
          float sunDot = dot(normalize(vCloudWorldNormal), normalize(uSunDir));
          float cloudDay = smoothstep(-0.15, 0.21, sunDot);
          float cloudTwilight = exp(-pow((sunDot + 0.015) / 0.105, 2.0));
          vec3 nightCloud = diffuseColor.rgb * vec3(0.035, 0.062, 0.13);
          outgoingLight = mix(nightCloud, outgoingLight * 1.06, cloudDay);
          outgoingLight += vec3(1.0, 0.50, 0.20) * cloudTwilight * 0.32;
        }
        #include <opaque_fragment>`
      );
  };
}
