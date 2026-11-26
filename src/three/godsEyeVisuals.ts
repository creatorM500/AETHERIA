import * as THREE from 'three';
import { latLngToCartesian } from '../shared/geo.ts';

export interface GodsEyeShaderUniforms {
  nightMode: { value: number };
  godsEyeMode: { value: number };
  scanRadius: { value: number };
  scanActive: { value: number };
  scanOrigin: { value: THREE.Vector3 };
  horizonFadeRadius: { value: number };
  time: { value: number };
  focusPoint: { value: THREE.Vector3 };
  edgeColor?: { value: THREE.Color };
}

export interface Tier1MaskShaderBinding {
  hasMask: number;
  maskTexUniform: { value: THREE.DataTexture | null };
  originXZ: { value: THREE.Vector2 };
  tileSize: { value: THREE.Vector2 };
}

const DEFAULT_ORIGIN_XZ = { value: new THREE.Vector2(0, 0) };
const DEFAULT_TILE_SIZE = { value: new THREE.Vector2(48, 48) };
const DEFAULT_MASK_TEX = { value: null as THREE.DataTexture | null };

/**
 * Enhances a MeshStandardMaterial ground/DEM terrain chunk with:
 * - Real-world road/terrain feature preservation inside "Ojo de Dios" spectral hologram
 * - Screen-space derivative (fwidth) anti-aliased topographic isolines & coordinate grid
 * - Terrain-conforming orbital radar sweep & coordinate lock rings draped over mountains
 * - Optional Tier-1 coverage mask discard (prevents coarse Tier-2 LOD from poking through Tier-1)
 * - Seamless radial fade to #06090f at the ~52km horizon
 */
export function applyGodsEyeTerrainShader(
  material: THREE.MeshStandardMaterial,
  uniforms: GodsEyeShaderUniforms,
  tier1Mask?: Tier1MaskShaderBinding
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGodsEyeMode = uniforms.godsEyeMode;
    shader.uniforms.uNightMode = uniforms.nightMode;
    shader.uniforms.uScanRadius = uniforms.scanRadius;
    shader.uniforms.uScanActive = uniforms.scanActive;
    shader.uniforms.uScanOrigin = uniforms.scanOrigin;
    shader.uniforms.uHorizonFadeRadius = uniforms.horizonFadeRadius;
    shader.uniforms.uTime = uniforms.time;
    shader.uniforms.uFocusPoint = uniforms.focusPoint;
    shader.uniforms.uEdgeColor = uniforms.edgeColor ?? { value: new THREE.Color('#06090f') };
    shader.uniforms.uHasTier1Mask = { value: tier1Mask ? tier1Mask.hasMask : 0.0 };
    shader.uniforms.uTier1MaskTex = tier1Mask ? tier1Mask.maskTexUniform : DEFAULT_MASK_TEX;
    shader.uniforms.uTier1OriginXZ = tier1Mask ? tier1Mask.originXZ : DEFAULT_ORIGIN_XZ;
    shader.uniforms.uTier1TileSize = tier1Mask ? tier1Mask.tileSize : DEFAULT_TILE_SIZE;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGeoWorldPos;
        varying vec3 vGeoNormal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vGeoWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGeoNormal = normalize(objectNormal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGeoWorldPos;
        varying vec3 vGeoNormal;
        uniform float uGodsEyeMode;
        uniform float uNightMode;
        uniform float uScanRadius;
        uniform float uScanActive;
        uniform vec3 uScanOrigin;
        uniform float uHorizonFadeRadius;
        uniform float uTime;
        uniform vec3 uFocusPoint;
        uniform vec3 uEdgeColor;
        uniform float uHasTier1Mask;
        uniform sampler2D uTier1MaskTex;
        uniform vec2 uTier1OriginXZ;
        uniform vec2 uTier1TileSize;

        float aaGridLine(float coord, float scale, float linePx) {
          float p = coord * scale;
          float d = abs(fract(p - 0.5) - 0.5);
          float fw = max(fwidth(p), 0.0015);
          return 1.0 - smoothstep(0.0, fw * linePx, d);
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (uHasTier1Mask > 0.5) {
          vec2 relTier1 = (vGeoWorldPos.xz - uTier1OriginXZ) / max(uTier1TileSize, vec2(0.001));
          if (relTier1.x >= 0.0 && relTier1.x < 7.0 && relTier1.y >= 0.0 && relTier1.y < 7.0) {
            vec2 maskUv = (floor(relTier1) + 0.5) / 8.0;
            if (texture2D(uTier1MaskTex, maskUv).r > 0.5) {
              discard;
            }
          }
        }
        // Slope & elevation micro-relief shading across ALL modes so valleys, ridges & cliffs read cleanly
        float slopeSteep = clamp(1.0 - abs(vGeoNormal.y), 0.0, 1.0);
        float elevTint = clamp(vGeoWorldPos.y * 0.009, -0.05, 0.09);
        diffuseColor.rgb *= mix(1.0 + elevTint, 0.76, smoothstep(0.14, 0.68, slopeSteep));

        if (uGodsEyeMode > 0.05) {
          float luma = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          // Local contrast derivative extracts roads, riverbanks, runways & urban edges from satellite tiles
          float featureEdge = clamp(length(vec2(dFdx(luma), dFdy(luma))) * 5.2, 0.0, 1.0);

          // Spectral grading preserves real roads, green parks, mountain snow & shorelines
          vec3 satSpectral = diffuseColor.rgb * vec3(0.28, 0.62, 0.82);
          vec3 tacticalDepth = mix(
            vec3(0.010, 0.028, 0.058),
            vec3(0.042, 0.155, 0.245),
            pow(clamp(luma * 1.05, 0.0, 1.0), 0.92)
          );
          vec3 integratedBase = mix(tacticalDepth, satSpectral, 0.50);
          integratedBase += vec3(0.08, 0.68, 0.90) * featureEdge * 0.22;

          float isoLine = aaGridLine(vGeoWorldPos.y, 0.92, 1.15);
          float majorIso = aaGridLine(vGeoWorldPos.y, 0.184, 1.45);
          float gx = aaGridLine(vGeoWorldPos.x, 0.083333, 1.1);
          float gz = aaGridLine(vGeoWorldPos.z, 0.083333, 1.1);
          float gridLine = max(gx, gz);

          float distFocus = length(vGeoWorldPos.xz - uFocusPoint.xz);
          float gridFade = exp(-distFocus * 0.0055);
          integratedBase += vec3(0.02, 0.22, 0.34) * gridLine * 0.26 * gridFade;
          integratedBase += vec3(0.06, 0.60, 0.82) * (isoLine * 0.18 + majorIso * 0.36);

          diffuseColor.rgb = mix(diffuseColor.rgb, integratedBase, uGodsEyeMode);
        }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float distFromScan = length(vGeoWorldPos.xz - uScanOrigin.xz);
        float waveBand = exp(-pow((distFromScan - uScanRadius) * 0.22, 2.0)) * uScanActive;

        float distFocusEm = length(vGeoWorldPos.xz - uFocusPoint.xz);
        float radarRadius = mod(uTime * 18.0, 110.0);
        float continuousPulse = exp(-pow((distFocusEm - radarRadius) * 0.48, 2.0)) * (1.0 - smoothstep(75.0, 110.0, radarRadius));

        // Terrain-draped holographic lock rings directly projected on ground elevation
        float lockRingInner = exp(-pow((distFocusEm - 5.2) * 3.8, 2.0));
        float lockRingOuter = exp(-pow((distFocusEm - 14.5) * 2.6, 2.0));
        float crossAxisX = exp(-pow(abs(vGeoWorldPos.z - uFocusPoint.z) * 5.0, 2.0)) * step(distFocusEm, 18.0) * (1.0 - step(distFocusEm, 3.6));
        float crossAxisZ = exp(-pow(abs(vGeoWorldPos.x - uFocusPoint.x) * 5.0, 2.0)) * step(distFocusEm, 18.0) * (1.0 - step(distFocusEm, 3.6));

        if (waveBand > 0.01 || uGodsEyeMode > 0.05) {
          float eIso = aaGridLine(vGeoWorldPos.y, 0.92, 1.2);
          float eMaj = aaGridLine(vGeoWorldPos.y, 0.184, 1.5);
          float eGx = aaGridLine(vGeoWorldPos.x, 0.083333, 1.15);
          float eGz = aaGridLine(vGeoWorldPos.z, 0.083333, 1.15);
          float eGrid = max(eGx, eGz);
          float eFade = exp(-distFocusEm * 0.0055);
          float lumaEm = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          float roadTrace = clamp(length(vec2(dFdx(lumaEm), dFdy(lumaEm))) * 4.5, 0.0, 1.0);

          vec3 cyanGlow = vec3(0.08, 0.78, 0.95);
          totalEmissiveRadiance += cyanGlow * (
            waveBand * (0.30 + eIso * 0.62 + eGrid * 0.40) +
            uGodsEyeMode * (
              eIso * 0.10 +
              eMaj * 0.30 +
              eGrid * 0.10 * eFade +
              roadTrace * 0.14 * eFade +
              continuousPulse * (0.09 + eIso * 0.22) +
              (lockRingInner * 0.28 + lockRingOuter * 0.18 + (crossAxisX + crossAxisZ) * 0.18)
            )
          );
        }`
      )
      .replace(
        '#include <opaque_fragment>',
        `if (uHorizonFadeRadius > 1.0) {
          float camDistXZ = length(vGeoWorldPos.xz - uFocusPoint.xz);
          float edgeFade = smoothstep(uHorizonFadeRadius * 0.72, uHorizonFadeRadius, camDistXZ);
          outgoingLight = mix(outgoingLight, uEdgeColor, edgeFade);
        }
        #include <opaque_fragment>`
      );
  };
  material.customProgramCacheKey = () => 'godseye-terrain-v4';
}

/**
 * Enhances building MeshStandardMaterial with ground contact AO,
 * architectural windows/rooftops, nocturnal illuminated windows,
 * and world-integrated "God's Eye" volumetric wireframe/scan shimmer.
 */
export function applyGodsEyeBuildingShader(
  material: THREE.MeshStandardMaterial,
  uniforms: Pick<
    GodsEyeShaderUniforms,
    'nightMode' | 'godsEyeMode' | 'scanRadius' | 'scanActive' | 'scanOrigin' | 'time' | 'focusPoint'
  >,
  isHighRise: boolean,
  coordScale = 1.0
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNightMode = uniforms.nightMode;
    shader.uniforms.uGodsEyeMode = uniforms.godsEyeMode;
    shader.uniforms.uScanRadius = uniforms.scanRadius;
    shader.uniforms.uScanActive = uniforms.scanActive;
    shader.uniforms.uScanOrigin = uniforms.scanOrigin;
    shader.uniforms.uTime = uniforms.time;
    shader.uniforms.uFocusPoint = uniforms.focusPoint;
    shader.uniforms.uIsHighRise = { value: isHighRise ? 1.0 : 0.0 };
    shader.uniforms.uCoordScale = { value: coordScale };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vArchPos;
        varying vec3 vArchWorldPos;
        varying vec3 vArchNormal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vArchPos = position;
        vArchWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vArchNormal = normalize(objectNormal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vArchPos;
        varying vec3 vArchWorldPos;
        varying vec3 vArchNormal;
        uniform float uNightMode;
        uniform float uGodsEyeMode;
        uniform float uScanRadius;
        uniform float uScanActive;
        uniform vec3 uScanOrigin;
        uniform float uTime;
        uniform vec3 uFocusPoint;
        uniform float uIsHighRise;
        uniform float uCoordScale;

        float archHash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float roofMask = smoothstep(0.55, 0.85, abs(vArchNormal.y));
        float wallMask = 1.0 - roofMask;

        vec3 scaledPos = vArchPos * uCoordScale;
        float floorScale = mix(11.5, 13.8, uIsHighRise);
        float bayScale = mix(7.2, 9.2, uIsHighRise);
        float fy = fract(scaledPos.y * floorScale);
        float fx = fract((scaledPos.x * 0.73 + scaledPos.z * 0.68) * bayScale);

        // Crisp rooftop mechanical penthouses & sunlit upper cornice contrast
        float roofCell = archHash21(floor(scaledPos.xz * 6.5));
        float roofMicro = archHash21(floor(scaledPos.xz * 22.0));
        float roofUnit = smoothstep(0.84, 0.94, roofCell);
        vec3 roofBaseTint = mix(vec3(0.54, 0.57, 0.62), vec3(0.70, 0.73, 0.77), roofMicro * 0.65);
        roofBaseTint = mix(roofBaseTint, vec3(0.36, 0.40, 0.46), roofUnit * 0.60);
        diffuseColor.rgb *= mix(vec3(1.0), roofBaseTint, roofMask);

        float winY = smoothstep(0.16, 0.30, fy) * (1.0 - smoothstep(0.76, 0.88, fy));
        float winX = smoothstep(0.14, 0.26, fx) * (1.0 - smoothstep(0.76, 0.88, fx));
        float windowBay = winX * winY * wallMask;

        // Ground-contact AO darkening + vertical sun-bounce gradient + crisp spandrel ribs
        float vertRel = clamp((vArchWorldPos.y - uFocusPoint.y + 0.4) * 0.45, 0.0, 1.0);
        float contactAO = mix(0.82, 1.04, smoothstep(0.0, 0.55, vertRel));
        float floorShade = mix(0.88, 1.06, smoothstep(0.0, 0.14, fract(scaledPos.y * 0.65))) * contactAO;
        float spandrelBand = 1.0 - smoothstep(0.0, 0.14, fy);
        float dayShade = mix(floorShade, mix(0.42, 0.30, uIsHighRise), windowBay);
        dayShade *= mix(1.0, 0.84, spandrelBand * wallMask * uIsHighRise);
        vec3 dayColor = diffuseColor.rgb * dayShade;

        float cellId = archHash21(vec2(
          floor((scaledPos.x * 0.73 + scaledPos.z * 0.68) * bayScale),
          floor(scaledPos.y * floorScale)
        ));
        float lit = step(mix(0.62, 0.44, uIsHighRise), cellId) * windowBay;
        vec3 warmOrCool = mix(vec3(1.0, 0.78, 0.42), vec3(0.45, 0.84, 1.0), step(0.84, cellId));
        vec3 nightColor = diffuseColor.rgb * mix(0.28, 0.38, roofMask) + warmOrCool * lit * 1.15;

        vec3 baseOut = mix(dayColor, nightColor, clamp(uNightMode, 0.0, 1.0));

        // God's Eye anodized glass + cyan wireframe floor slabs anchored to ground
        if (uGodsEyeMode > 0.05) {
          float ribY = 1.0 - smoothstep(0.025, 0.095, abs(fy - 0.5));
          vec3 archTint = diffuseColor.rgb * vec3(0.18, 0.42, 0.58);
          vec3 holoBody = mix(
            mix(vec3(0.018, 0.052, 0.105), archTint, 0.45),
            vec3(0.055, 0.19, 0.30),
            roofMask * 0.75 + uIsHighRise * 0.25
          );
          holoBody += vec3(0.08, 0.56, 0.78) * (ribY * wallMask * 0.38 + windowBay * 0.20);
          baseOut = mix(baseOut, holoBody, uGodsEyeMode);
        }

        diffuseColor.rgb = baseOut;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float bRoof = smoothstep(0.55, 0.85, abs(vArchNormal.y));
        vec3 bScaled = vArchPos * uCoordScale;
        float bFloor = mix(11.5, 13.8, uIsHighRise);
        float bBay = mix(7.2, 9.2, uIsHighRise);
        float bFy = fract(bScaled.y * bFloor);
        float bFx = fract((bScaled.x * 0.73 + bScaled.z * 0.68) * bBay);
        float bWin = smoothstep(0.16, 0.30, bFy) * (1.0 - smoothstep(0.76, 0.88, bFy))
                   * smoothstep(0.14, 0.26, bFx) * (1.0 - smoothstep(0.76, 0.88, bFx))
                   * (1.0 - bRoof);

        if (uNightMode > 0.05) {
          float nCid = archHash21(vec2(
            floor((bScaled.x * 0.73 + bScaled.z * 0.68) * bBay),
            floor(bScaled.y * bFloor)
          ));
          float nLit = step(mix(0.62, 0.44, uIsHighRise), nCid) * bWin;
          vec3 glowCol = mix(vec3(1.0, 0.72, 0.32), vec3(0.35, 0.82, 1.0), step(0.84, nCid));
          totalEmissiveRadiance += glowCol * nLit * 0.85 * uNightMode;
        }

        float bDistScan = length(vArchWorldPos.xz - uScanOrigin.xz);
        float bScan = exp(-pow((bDistScan - uScanRadius) * 0.22, 2.0)) * uScanActive;
        float bDistFocus = length(vArchWorldPos.xz - uFocusPoint.xz);
        float bRadarRadius = mod(uTime * 18.0, 110.0);
        float bRadar = exp(-pow((bDistFocus - bRadarRadius) * 0.48, 2.0)) * (1.0 - smoothstep(75.0, 110.0, bRadarRadius));
        float bFocusAura = exp(-bDistFocus * 0.032);

        if (uGodsEyeMode > 0.05 || bScan > 0.01) {
          float floorEdge = 1.0 - smoothstep(0.025, 0.095, abs(bFy - 0.1));
          float roofGrid = (1.0 - smoothstep(0.02, 0.07, abs(fract(bScaled.x * 1.4) - 0.5))) * bRoof;
          float holoDataNode = step(0.80, archHash21(vec2(floor((bScaled.x + bScaled.z) * bBay), floor(bScaled.y * bFloor)))) * bWin;
          float vertDataFlow = pow(max(0.0, sin(vArchWorldPos.y * 2.2 - uTime * 2.4)), 4.0) * uIsHighRise * (1.0 - bRoof);
          vec3 holoCyan = vec3(0.10, 0.86, 1.0);
          totalEmissiveRadiance += holoCyan * (
            uGodsEyeMode * (
              floorEdge * (1.0 - bRoof) * (0.28 + bFocusAura * 0.24) +
              bRoof * (0.12 + roofGrid * 0.20) +
              holoDataNode * 0.65 +
              vertDataFlow * 0.24 +
              bRadar * (0.22 + floorEdge * 0.45)
            ) +
            bScan * (0.40 + floorEdge * 0.62)
          );
        }`
      );
  };
  material.customProgramCacheKey = () =>
    `godseye-bldg-v3-${isHighRise ? 'tower' : 'std'}-${coordScale.toFixed(3)}`;
}

/**
 * Enhances vector road ribbons with crisp curbs, subtle lane markings,
 * nocturnal road glow, and Ojo de Dios cyan vector corridor tracing.
 */
export function applyRoadNetworkShader(
  material: THREE.MeshStandardMaterial,
  uniforms: Pick<
    GodsEyeShaderUniforms,
    'nightMode' | 'godsEyeMode' | 'horizonFadeRadius' | 'focusPoint' | 'time' | 'edgeColor'
  >
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNightMode = uniforms.nightMode;
    shader.uniforms.uGodsEyeMode = uniforms.godsEyeMode;
    shader.uniforms.uHorizonFadeRadius = uniforms.horizonFadeRadius;
    shader.uniforms.uFocusPoint = uniforms.focusPoint;
    shader.uniforms.uTime = uniforms.time;
    shader.uniforms.uEdgeColor = uniforms.edgeColor ?? { value: new THREE.Color('#06090f') };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vRoadUv;
        varying vec3 vRoadWorldPos;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vRoadUv = uv;
        vRoadWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vRoadUv;
        varying vec3 vRoadWorldPos;
        uniform float uNightMode;
        uniform float uGodsEyeMode;
        uniform float uHorizonFadeRadius;
        uniform vec3 uFocusPoint;
        uniform float uTime;
        uniform vec3 uEdgeColor;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float across = vRoadUv.x;
        float centerDist = abs(across - 0.5);
        float dash = step(0.45, fract(vRoadUv.y * 0.9));
        float centerStripe = (1.0 - smoothstep(0.025, 0.065, centerDist)) * dash;
        float curbEdge = smoothstep(0.38, 0.48, centerDist);

        vec3 asphalt = diffuseColor.rgb * mix(1.0, 0.72, curbEdge);
        asphalt = mix(asphalt, vec3(0.75, 0.78, 0.82), centerStripe * 0.42);
        if (uGodsEyeMode > 0.05) {
          vec3 tacRoad = mix(vec3(0.025, 0.085, 0.145), vec3(0.14, 0.62, 0.84), curbEdge * 0.55 + centerStripe * 0.65);
          asphalt = mix(asphalt, tacRoad, uGodsEyeMode * 0.88);
        }
        diffuseColor.rgb = asphalt;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float rCenter = abs(vRoadUv.x - 0.5);
        float rCurb = smoothstep(0.40, 0.49, rCenter);
        float rDash = step(0.45, fract(vRoadUv.y * 0.9));
        float rStripe = (1.0 - smoothstep(0.02, 0.06, rCenter)) * rDash;
        if (uNightMode > 0.05) {
          totalEmissiveRadiance += vec3(0.95, 0.68, 0.30) * rStripe * 0.38 * uNightMode;
        }
        if (uGodsEyeMode > 0.05) {
          float pulseFlow = 0.5 + 0.5 * sin(vRoadUv.y * 1.4 - uTime * 3.0);
          totalEmissiveRadiance += vec3(0.08, 0.78, 0.98) * (rCurb * 0.24 + rStripe * (0.22 + pulseFlow * 0.16)) * uGodsEyeMode;
        }`
      )
      .replace(
        '#include <opaque_fragment>',
        `if (uHorizonFadeRadius > 1.0) {
          float distXZ = length(vRoadWorldPos.xz - uFocusPoint.xz);
          float edgeFade = smoothstep(uHorizonFadeRadius * 0.72, uHorizonFadeRadius, distXZ);
          outgoingLight = mix(outgoingLight, uEdgeColor, edgeFade);
        }
        #include <opaque_fragment>`
      );
  };
  material.customProgramCacheKey = () => 'godseye-road-v1';
}

interface OrbitSatSpec {
  radius: number;
  inclination: number;
  raan: number;
  phase: number;
  speed: number;
}

const _satPos = new THREE.Vector3();
const _satAhead = new THREE.Vector3();
const _satDummy = new THREE.Object3D();
const _beamTmp = new THREE.Vector3();

/**
 * 18-satellite orbital tracking constellation + solar-wing buses + animated telemetry beams
 * and surface-hugging curved target swath on the 3D Globe ("Ojo de Dios" signature).
 */
export class GodsEyeOrbitalConstellation {
  public readonly group = new THREE.Group();
  private globeRadius: number;
  private satSpecs: OrbitSatSpec[] = [];
  private satBusMesh: THREE.InstancedMesh;
  private satWingMesh: THREE.InstancedMesh;
  private beamGeo: THREE.BufferGeometry;
  private beamMat: THREE.LineBasicMaterial;
  private beamLines: THREE.LineSegments;
  private pulseGeo: THREE.BufferGeometry;
  private pulseSprite: THREE.CanvasTexture;
  private pulseMat: THREE.PointsMaterial;
  private pulsePoints: THREE.Points;
  private ringGeos: THREE.BufferGeometry[] = [];
  private ringMats: THREE.LineBasicMaterial[] = [];
  private satWorldPositions: THREE.Vector3[] = [];
  private pickedSatPositions: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  private targetVec = new THREE.Vector3();
  private hasTarget = false;

  constructor(globeRadius: number) {
    this.globeRadius = globeRadius;

    // 3 inclined orbital shells with 6 satellites each = 18 multi-part satellites
    const shells = [
      { r: globeRadius * 1.15, inc: 0.42, raan: 0.2, speed: 0.16 },
      { r: globeRadius * 1.20, inc: -0.78, raan: 1.55, speed: 0.12 },
      { r: globeRadius * 1.25, inc: 1.12, raan: -0.95, speed: 0.14 },
    ];

    shells.forEach((sh, sIdx) => {
      for (let k = 0; k < 6; k++) {
        this.satSpecs.push({
          radius: sh.r,
          inclination: sh.inc,
          raan: sh.raan,
          phase: (k / 6) * Math.PI * 2 + sIdx * 0.4,
          speed: sh.speed,
        });
        this.satWorldPositions.push(new THREE.Vector3());
      }

      const pts: THREE.Vector3[] = [];
      const segs = 96;
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pts.push(this.orbitPoint(sh.r, sh.inc, sh.raan, a, new THREE.Vector3()));
      }
      const rGeo = new THREE.BufferGeometry().setFromPoints(pts);
      const rMat = new THREE.LineBasicMaterial({
        color: 0x22d3ee,
        transparent: true,
        opacity: sIdx === 0 ? 0.24 : 0.13,
      });
      this.ringGeos.push(rGeo);
      this.ringMats.push(rMat);
      this.group.add(new THREE.LineLoop(rGeo, rMat));
    });

    // Part 1: Metallic faceted sensor bus core
    const busGeo = new THREE.OctahedronGeometry(0.085, 0);
    busGeo.scale(1.2, 0.75, 1.4);
    const busMat = new THREE.MeshBasicMaterial({ color: 0xe0f2fe });
    this.satBusMesh = new THREE.InstancedMesh(busGeo, busMat, this.satSpecs.length);
    this.satBusMesh.frustumCulled = false;

    // Part 2: Wide cyan photovoltaic solar wings
    const wingGeo = new THREE.BoxGeometry(0.46, 0.012, 0.11);
    const wingMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee });
    this.satWingMesh = new THREE.InstancedMesh(wingGeo, wingMat, this.satSpecs.length);
    this.satWingMesh.frustumCulled = false;
    this.group.add(this.satBusMesh, this.satWingMesh);

    // Dynamic 3-beam triangulation lock lines (6 vertices = 3 segments)
    const beamPos = new Float32Array(6 * 3);
    this.beamGeo = new THREE.BufferGeometry();
    this.beamGeo.setAttribute('position', new THREE.BufferAttribute(beamPos, 3));
    this.beamMat = new THREE.LineBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.48,
      blending: THREE.AdditiveBlending,
    });
    this.beamLines = new THREE.LineSegments(this.beamGeo, this.beamMat);
    this.beamLines.frustumCulled = false;
    this.beamLines.visible = false;
    this.group.add(this.beamLines);

    // Animated circular data-lock packet pulses traveling down the 3 beams into Earth
    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = 64;
    spriteCanvas.height = 64;
    const sCtx = spriteCanvas.getContext('2d');
    if (sCtx) {
      const grad = sCtx.createRadialGradient(32, 32, 2, 32, 32, 30);
      grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
      grad.addColorStop(0.35, 'rgba(165, 243, 252, 0.9)');
      grad.addColorStop(1, 'rgba(34, 211, 238, 0)');
      sCtx.fillStyle = grad;
      sCtx.fillRect(0, 0, 64, 64);
    }
    this.pulseSprite = new THREE.CanvasTexture(spriteCanvas);
    const pulsePos = new Float32Array(3 * 3);
    this.pulseGeo = new THREE.BufferGeometry();
    this.pulseGeo.setAttribute('position', new THREE.BufferAttribute(pulsePos, 3));
    this.pulseMat = new THREE.PointsMaterial({
      color: 0xa5f3fc,
      map: this.pulseSprite,
      size: 0.28,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      alphaTest: 0.01,
    });
    this.pulsePoints = new THREE.Points(this.pulseGeo, this.pulseMat);
    this.pulsePoints.frustumCulled = false;
    this.pulsePoints.visible = false;
    this.group.add(this.pulsePoints);
  }

  private orbitPoint(
    radius: number,
    inc: number,
    raan: number,
    angle: number,
    out: THREE.Vector3
  ): THREE.Vector3 {
    const x0 = Math.cos(angle) * radius;
    const z0 = Math.sin(angle) * radius;
    const y1 = -z0 * Math.sin(inc);
    const z1 = z0 * Math.cos(inc);
    const cosR = Math.cos(raan);
    const sinR = Math.sin(raan);
    out.set(x0 * cosR - z1 * sinR, y1, x0 * sinR + z1 * cosR);
    return out;
  }

  public setTargetLatLng(lat: number, lng: number) {
    const pt = latLngToCartesian(lat, lng, this.globeRadius + 0.04);
    this.targetVec.set(pt.x, pt.y, pt.z);
    this.hasTarget = true;
  }

  public update(elapsedSec: number, altitude: number, isGodsEyeMode: boolean) {
    this.group.visible = altitude > 0.65;
    if (!this.group.visible) return;

    for (let i = 0; i < this.satSpecs.length; i++) {
      const sp = this.satSpecs[i];
      const angle = sp.phase + elapsedSec * sp.speed;
      this.orbitPoint(sp.radius, sp.inclination, sp.raan, angle, _satPos);
      this.orbitPoint(sp.radius, sp.inclination, sp.raan, angle + 0.04, _satAhead);
      this.satWorldPositions[i].copy(_satPos);
      _satDummy.position.copy(_satPos);
      _satDummy.lookAt(_satAhead);
      _satDummy.updateMatrix();
      this.satBusMesh.setMatrixAt(i, _satDummy.matrix);
      this.satWingMesh.setMatrixAt(i, _satDummy.matrix);
    }
    this.satBusMesh.instanceMatrix.needsUpdate = true;
    this.satWingMesh.instanceMatrix.needsUpdate = true;

    if (this.hasTarget) {
      let best0 = -1;
      let best1 = -1;
      let best2 = -1;
      let d0 = Infinity;
      let d1 = Infinity;
      let d2 = Infinity;
      for (let i = 0; i < this.satWorldPositions.length; i++) {
        const d = this.satWorldPositions[i].distanceToSquared(this.targetVec);
        if (d < d0) {
          d2 = d1; best2 = best1;
          d1 = d0; best1 = best0;
          d0 = d; best0 = i;
        } else if (d < d1) {
          d2 = d1; best2 = best1;
          d1 = d; best1 = i;
        } else if (d < d2) {
          d2 = d; best2 = i;
        }
      }

      const attr = this.beamGeo.attributes.position as THREE.BufferAttribute;
      const pulseAttr = this.pulseGeo.attributes.position as THREE.BufferAttribute;
      const picks = [best0, best1, best2];
      for (let k = 0; k < 3; k++) {
        const satPos = this.satWorldPositions[Math.max(0, picks[k])];
        this.pickedSatPositions[k].copy(satPos);
        attr.setXYZ(k * 2, satPos.x, satPos.y, satPos.z);
        attr.setXYZ(k * 2 + 1, this.targetVec.x, this.targetVec.y, this.targetVec.z);

        const t = (elapsedSec * 0.72 + k * 0.33) % 1.0;
        _beamTmp.copy(satPos).lerp(this.targetVec, t);
        pulseAttr.setXYZ(k, _beamTmp.x, _beamTmp.y, _beamTmp.z);
      }
      attr.needsUpdate = true;
      pulseAttr.needsUpdate = true;
      this.beamMat.opacity = isGodsEyeMode ? 0.56 : 0.28;
      this.beamLines.visible = true;
      this.pulsePoints.visible = isGodsEyeMode;
    } else {
      this.beamLines.visible = false;
      this.pulsePoints.visible = false;
    }
  }

  public dispose() {
    this.satBusMesh.geometry.dispose();
    (this.satBusMesh.material as THREE.Material).dispose();
    this.satWingMesh.geometry.dispose();
    (this.satWingMesh.material as THREE.Material).dispose();
    this.beamGeo.dispose();
    this.beamMat.dispose();
    this.pulseGeo.dispose();
    this.pulseSprite.dispose();
    this.pulseMat.dispose();
    this.ringGeos.forEach((g) => g.dispose());
    this.ringMats.forEach((m) => m.dispose());
  }
}

/**
 * Precision counter-rotating 3D target-lock reticle + vertical optical lock column
 * anchoring ground coordinates to orbital telemetry in both Globo 3D and Terreno 3D.
 */
export class GodsEyeTargetReticle {
  public readonly group = new THREE.Group();
  private outerRing: THREE.Mesh;
  private innerRing: THREE.Mesh;
  private haloRing: THREE.Mesh;
  private tickMesh: THREE.LineSegments;
  private columnMesh: THREE.Line;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];

  constructor() {
    const outerGeo = new THREE.RingGeometry(0.955, 1.0, 64);
    outerGeo.rotateX(-Math.PI / 2);
    const outerMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.outerRing = new THREE.Mesh(outerGeo, outerMat);

    const innerGeo = new THREE.RingGeometry(0.60, 0.635, 48, 1, 0, Math.PI * 1.45);
    innerGeo.rotateX(-Math.PI / 2);
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.innerRing = new THREE.Mesh(innerGeo, innerMat);

    const haloGeo = new THREE.RingGeometry(0.42, 0.445, 48);
    haloGeo.rotateX(-Math.PI / 2);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.haloRing = new THREE.Mesh(haloGeo, haloMat);
    this.haloRing.position.y = 0.65;

    // 4 cardinal optical bracket ticks
    const tickPts = new Float32Array([
      1.08, 0, 0, 1.42, 0, 0,
      -1.08, 0, 0, -1.42, 0, 0,
      0, 0, 1.08, 0, 0, 1.42,
      0, 0, -1.08, 0, 0, -1.42,
    ]);
    const tickGeo = new THREE.BufferGeometry();
    tickGeo.setAttribute('position', new THREE.BufferAttribute(tickPts, 3));
    const tickMat = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.85,
    });
    this.tickMesh = new THREE.LineSegments(tickGeo, tickMat);

    // Subtle vertical telemetry beam anchoring target coordinate upward
    const colGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.05, 0),
      new THREE.Vector3(0, 1.85, 0),
    ]);
    const colMat = new THREE.LineBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.36,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.columnMesh = new THREE.Line(colGeo, colMat);

    this.geos.push(outerGeo, innerGeo, haloGeo, tickGeo, colGeo);
    this.mats.push(outerMat, innerMat, haloMat, tickMat, colMat);
    this.group.add(this.outerRing, this.innerRing, this.haloRing, this.tickMesh, this.columnMesh);
  }

  public update(elapsedSec: number) {
    this.outerRing.rotation.y = elapsedSec * 0.35;
    this.innerRing.rotation.y = -elapsedSec * 0.65;
    const pulse = 0.88 + 0.22 * Math.sin(elapsedSec * 2.2);
    this.haloRing.scale.setScalar(pulse);
    this.haloRing.position.y = 0.55 + 0.12 * Math.sin(elapsedSec * 1.6);
  }

  public dispose() {
    this.geos.forEach((g) => g.dispose());
    this.mats.forEach((m) => m.dispose());
  }
}
