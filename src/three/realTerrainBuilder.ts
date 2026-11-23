import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp } from '../shared/geo.ts';
import {
  computeTerrainTileWindow,
  elevationToSceneY,
  latLngToTileWindowUV,
  sampleElevationGrid,
  uvToSceneXZ,
  type TerrainTileWindow,
} from '../shared/terrainMath.ts';
import type {
  GlobeTextureMode,
  PredictiveRouteResult,
  RealTerrainPayload,
} from '../shared/types.ts';
import { streamSectorTextureIntoCanvas } from './worldTiles.ts';

export interface RealSectorSceneBuild {
  root: THREE.Group;
  tileWindow: TerrainTileWindow;
  getTerrainMesh: () => THREE.Mesh | null;
  setTextureMode: (mode: GlobeTextureMode) => void;
  setVerticalExaggeration: (exaggeration: number) => void;
  updatePayload: (payload: RealTerrainPayload, route: PredictiveRouteResult | null) => void;
  dispose: () => void;
}

/**
 * Injects procedural architectural facade window bays, floor bands, roof terrace shading,
 * and nocturnal lit-window patterns into MeshStandardMaterial via onBeforeCompile.
 */
export function applyArchitecturalFacadeShader(
  material: THREE.MeshStandardMaterial,
  nightUniform: { value: number },
  isHighRise: boolean,
  coordScale = 1.0
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNightMode = nightUniform;
    shader.uniforms.uIsHighRise = { value: isHighRise ? 1.0 : 0.0 };
    shader.uniforms.uCoordScale = { value: coordScale };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vArchPos;
        varying vec3 vArchNormal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vArchPos = position;
        vArchNormal = normalize(objectNormal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vArchPos;
        varying vec3 vArchNormal;
        uniform float uNightMode;
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

        // Procedural multi-story floor bands + curtain-wall window bays on vertical walls (~3.4m/floor)
        vec3 scaledPos = vArchPos * uCoordScale;
        float floorScale = mix(11.5, 13.8, uIsHighRise);
        float bayScale = mix(7.2, 9.2, uIsHighRise);
        float fy = fract(scaledPos.y * floorScale);
        float fx = fract((scaledPos.x * 0.73 + scaledPos.z * 0.68) * bayScale);

        // Rooftop gravel/membrane surface texture & parapet depth so overhead roofs look architectural
        float roofCell = archHash21(floor(scaledPos.xz * 6.5));
        float roofMicro = archHash21(floor(scaledPos.xz * 22.0));
        float roofUnit = smoothstep(0.84, 0.94, roofCell);
        vec3 roofBaseTint = mix(vec3(0.48, 0.51, 0.56), vec3(0.64, 0.66, 0.70), roofMicro * 0.65);
        roofBaseTint = mix(roofBaseTint, vec3(0.32, 0.36, 0.42), roofUnit * 0.62);
        vec3 roofTint = mix(vec3(1.0), roofBaseTint, roofMask);
        diffuseColor.rgb *= roofTint;

        float winY = smoothstep(0.16, 0.30, fy) * (1.0 - smoothstep(0.76, 0.88, fy));
        float winX = smoothstep(0.14, 0.26, fx) * (1.0 - smoothstep(0.76, 0.88, fx));
        float windowBay = winX * winY * wallMask;

        // Subtle podium/ground contact darkening + crisp mullion-to-glass contrast
        float floorShade = mix(0.92, 1.04, smoothstep(0.0, 0.14, fract(scaledPos.y * 0.65)));
        float dayShade = mix(floorShade, mix(0.46, 0.36, uIsHighRise), windowBay);
        vec3 dayColor = diffuseColor.rgb * dayShade;

        // Nocturnal urban lighting: darkened facades with selective warm/cool interior windows
        float cellId = archHash21(vec2(
          floor((scaledPos.x * 0.73 + scaledPos.z * 0.68) * bayScale),
          floor(scaledPos.y * floorScale)
        ));
        float lit = step(mix(0.62, 0.44, uIsHighRise), cellId) * windowBay;
        vec3 warmOrCool = mix(vec3(1.0, 0.78, 0.42), vec3(0.45, 0.84, 1.0), step(0.84, cellId));
        vec3 nightColor = diffuseColor.rgb * mix(0.28, 0.38, roofMask) + warmOrCool * lit * 1.15;

        diffuseColor.rgb = mix(dayColor, nightColor, clamp(uNightMode, 0.0, 1.0));`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (uNightMode > 0.05) {
          float nRoof = smoothstep(0.55, 0.85, abs(vArchNormal.y));
          vec3 nScaled = vArchPos * uCoordScale;
          float nFloor = mix(11.5, 13.8, uIsHighRise);
          float nBay = mix(7.2, 9.2, uIsHighRise);
          float nFy = fract(nScaled.y * nFloor);
          float nFx = fract((nScaled.x * 0.73 + nScaled.z * 0.68) * nBay);
          float nWin = smoothstep(0.16, 0.30, nFy) * (1.0 - smoothstep(0.76, 0.88, nFy))
                     * smoothstep(0.14, 0.26, nFx) * (1.0 - smoothstep(0.76, 0.88, nFx))
                     * (1.0 - nRoof);
          float nCid = archHash21(vec2(
            floor((nScaled.x * 0.73 + nScaled.z * 0.68) * nBay),
            floor(nScaled.y * nFloor)
          ));
          float nLit = step(mix(0.62, 0.44, uIsHighRise), nCid) * nWin;
          vec3 glowCol = mix(vec3(1.0, 0.72, 0.32), vec3(0.35, 0.82, 1.0), step(0.84, nCid));
          totalEmissiveRadiance += glowCol * nLit * 0.85 * uNightMode;
        }`
      );
  };
  material.customProgramCacheKey = () => `arch-facade-${isHighRise ? 'tower' : 'std'}-${coordScale.toFixed(3)}`;
}

function createArchitecturalSkirtGeometry(
  terrainGeo: THREE.PlaneGeometry,
  rows: number,
  cols: number,
  bottomY = -3.2
): THREE.BufferGeometry {
  const posAttr = terrainGeo.attributes.position;
  const positions: number[] = [];

  const pushQuad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number
  ) => {
    positions.push(
      ax, ay, az,
      ax, bottomY, az,
      bx, by, bz,

      bx, by, bz,
      ax, bottomY, az,
      bx, bottomY, bz
    );
  };

  const getIdx = (r: number, c: number) => r * cols + c;

  for (let c = 0; c < cols - 1; c++) {
    const i0 = getIdx(0, c);
    const i1 = getIdx(0, c + 1);
    pushQuad(
      posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1),
      posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0)
    );
  }
  for (let c = 0; c < cols - 1; c++) {
    const i0 = getIdx(rows - 1, c);
    const i1 = getIdx(rows - 1, c + 1);
    pushQuad(
      posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0),
      posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1)
    );
  }
  for (let r = 0; r < rows - 1; r++) {
    const i0 = getIdx(r, 0);
    const i1 = getIdx(r + 1, 0);
    pushQuad(
      posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0),
      posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1)
    );
  }
  for (let r = 0; r < rows - 1; r++) {
    const i0 = getIdx(r, cols - 1);
    const i1 = getIdx(r + 1, cols - 1);
    pushQuad(
      posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1),
      posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0)
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

const ARCH_BASE_PALETTE = [
  [0.16, 0.17, 0.20], // Architectural concrete shadow base
  [0.24, 0.20, 0.16], // Warm limestone / travertine base
  [0.14, 0.17, 0.21], // Slate stone base
  [0.26, 0.16, 0.14], // Terracotta / brick base
  [0.23, 0.21, 0.17], // Sandstone / ochre stucco base
  [0.13, 0.14, 0.16], // Anodized charcoal / basalt base
];

const ARCH_ROOF_PALETTE = [
  [0.32, 0.34, 0.38],
  [0.42, 0.37, 0.31],
  [0.27, 0.32, 0.38],
  [0.40, 0.29, 0.25],
  [0.39, 0.35, 0.29],
  [0.25, 0.27, 0.31],
];

function buildExtrudedBuildingsGeometry(
  payload: RealTerrainPayload,
  verticalExaggeration: number,
  highRiseOnly: boolean
): THREE.BufferGeometry | null {
  const metersToScene = payload.sceneWidth / Math.max(400, payload.spanMetersX);
  const geos: THREE.BufferGeometry[] = [];
  const baseCol = new THREE.Color();
  const roofCol = new THREE.Color();

  for (let i = 0; i < payload.buildings.length; i++) {
    const b = payload.buildings[i];
    const isHighRise = b.heightM >= 28;
    if (isHighRise !== highRiseOnly) continue;
    if (b.outer.length < 3) continue;

    // Sample DEM at centroid AND every perimeter corner so buildings on steep slopes never float
    let cu = 0;
    let cv = 0;
    let minCornerElevM = Infinity;
    const step = b.outer.length > 16 ? Math.ceil(b.outer.length / 12) : 1;

    for (let k = 0; k < b.outer.length; k++) {
      const pu = b.outer[k][0];
      const pv = b.outer[k][1];
      cu += pu;
      cv += pv;
      if (k % step === 0) {
        const ce = sampleElevationGrid(payload.elevationsM, payload.rows, payload.cols, pu, pv);
        if (ce < minCornerElevM) minCornerElevM = ce;
      }
    }
    cu /= b.outer.length;
    cv /= b.outer.length;

    const centroidElevM = sampleElevationGrid(payload.elevationsM, payload.rows, payload.cols, cu, cv);
    if (!Number.isFinite(minCornerElevM)) minCornerElevM = centroidElevM;
    const foundationElevM = Math.min(centroidElevM, minCornerElevM);

    const centroidY = elevationToSceneY(
      centroidElevM,
      payload.minElevationM,
      payload.spanMetersX,
      payload.sceneWidth,
      verticalExaggeration
    );
    const foundationY = elevationToSceneY(
      foundationElevM,
      payload.minElevationM,
      payload.spanMetersX,
      payload.sceneWidth,
      verticalExaggeration
    );

    const minHScene = b.minHeightM * metersToScene;
    const roofTopY = centroidY + Math.max(0.10, b.heightM * metersToScene);
    const baseY = foundationY + minHScene - 0.14; // Embed firmly below lowest slope corner
    const extrudeDepth = Math.max(0.14, roofTopY - baseY);

    const shape = new THREE.Shape();
    for (let k = 0; k < b.outer.length; k++) {
      const [sx, sz] = uvToSceneXZ(b.outer[k][0], b.outer[k][1], payload.sceneWidth, payload.sceneDepth);
      if (k === 0) shape.moveTo(sx, -sz);
      else shape.lineTo(sx, -sz);
    }
    shape.closePath();

    if (b.holes && b.holes.length > 0) {
      for (const hole of b.holes) {
        if (hole.length < 3) continue;
        const path = new THREE.Path();
        for (let k = 0; k < hole.length; k++) {
          const [hx, hz] = uvToSceneXZ(hole[k][0], hole[k][1], payload.sceneWidth, payload.sceneDepth);
          if (k === 0) path.moveTo(hx, -hz);
          else path.lineTo(hx, -hz);
        }
        path.closePath();
        shape.holes.push(path);
      }
    }

    let extrude: THREE.BufferGeometry;
    try {
      extrude = new THREE.ExtrudeGeometry(shape, {
        depth: extrudeDepth,
        bevelEnabled: false,
        steps: 1,
      });
    } catch {
      continue;
    }

    extrude.rotateX(-Math.PI / 2);
    const microShift = ((i % 7) - 3) * 0.0025;
    extrude.translate(microShift, baseY, -microShift);
    extrude.deleteAttribute('uv');

    const posAttr = extrude.attributes.position;
    const colors = new Float32Array(posAttr.count * 3);

    if (isHighRise) {
      const style = i % 3;
      if (style === 0) {
        baseCol.set('#13243a');
        roofCol.set('#5ca8dc');
      } else if (style === 1) {
        baseCol.set('#1c2738');
        roofCol.set('#7eb4d6');
      } else {
        baseCol.set('#282524');
        roofCol.set('#a8977e');
      }
    } else {
      const pIdx = i % ARCH_BASE_PALETTE.length;
      const jitter = ((i * 37) % 9) * 0.012;
      const bp = ARCH_BASE_PALETTE[pIdx];
      const rp = ARCH_ROOF_PALETTE[pIdx];
      baseCol.setRGB(bp[0] + jitter, bp[1] + jitter, bp[2] + jitter);
      roofCol.setRGB(rp[0] + jitter, rp[1] + jitter, rp[2] + jitter);
    }

    const topY = baseY + extrudeDepth;
    for (let v = 0; v < posAttr.count; v++) {
      const vy = posAttr.getY(v);
      const t = clamp((vy - baseY) / Math.max(0.05, topY - baseY), 0, 1);
      const ao = 0.56 + 0.44 * t;
      colors[v * 3] = THREE.MathUtils.lerp(baseCol.r, roofCol.r, t) * ao;
      colors[v * 3 + 1] = THREE.MathUtils.lerp(baseCol.g, roofCol.g, t) * ao;
      colors[v * 3 + 2] = THREE.MathUtils.lerp(baseCol.b, roofCol.b, t) * ao;
    }
    extrude.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geos.push(extrude);
  }

  if (geos.length === 0) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) return null;
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Progressive WebGL Real 3D Terrain & Real OSM Buildings Scene Builder.
 * Starts immediately with an aligned Mercator raster slab, then upgrades seamlessly
 * when Terrarium DEM elevation & VersaTiles/OpenFreeMap OSM 3D buildings arrive.
 */
export function createProgressiveRealTerrainScene(opts: {
  centerLat: number;
  centerLng: number;
  initialMode: GlobeTextureMode;
  textureSize: number;
  maxAnisotropy: number;
  shadowsEnabled: boolean;
  route: PredictiveRouteResult | null;
  onTextureDirty: () => void;
}): RealSectorSceneBuild {
  const root = new THREE.Group();
  const win = computeTerrainTileWindow(opts.centerLat, opts.centerLng, 14, 96);

  let disposed = false;
  let texEpoch = 0;
  let currentMode: GlobeTextureMode = opts.initialMode;
  let currentExaggeration = 1.45;
  let currentPayload: RealTerrainPayload | null = null;
  let currentRoute: PredictiveRouteResult | null = opts.route;

  const nightUniform = { value: opts.initialMode === 'thermal' ? 1.0 : 0.0 };

  const canvas = document.createElement('canvas');
  canvas.width = opts.textureSize;
  canvas.height = opts.textureSize;
  const terrainTex = new THREE.CanvasTexture(canvas);
  terrainTex.colorSpace = THREE.SRGBColorSpace;
  terrainTex.anisotropy = opts.maxAnisotropy;
  terrainTex.wrapS = THREE.ClampToEdgeWrapping;
  terrainTex.wrapT = THREE.ClampToEdgeWrapping;

  const terrainMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: terrainTex,
    roughness: 0.86,
    metalness: 0.04,
  });
  terrainMat.onBeforeCompile = (shader) => {
    shader.uniforms.uHalfSize = { value: new THREE.Vector2(win.sceneWidth * 0.5, win.sceneDepth * 0.5) };
    shader.uniforms.uEdgeColor = { value: new THREE.Color('#06090f') };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vTerrainLocalXZ;
        varying vec3 vTerrainNormal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTerrainLocalXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
        vTerrainNormal = normalize(objectNormal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vTerrainLocalXZ;
        varying vec3 vTerrainNormal;
        uniform vec2 uHalfSize;
        uniform vec3 uEdgeColor;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Subtle topographic ridge & escarpment micro-contrast
        float slopeSteep = clamp(1.0 - abs(vTerrainNormal.y), 0.0, 1.0);
        diffuseColor.rgb *= mix(1.0, 0.86, smoothstep(0.18, 0.68, slopeSteep));`
      )
      .replace(
        '#include <opaque_fragment>',
        `vec2 normEdge = abs(vTerrainLocalXZ) / max(uHalfSize, vec2(1.0));
        float edgeDist = max(normEdge.x, normEdge.y);
        float radialDist = length(normEdge) * 0.86;
        float edgeFade = smoothstep(0.84, 1.0, max(edgeDist, radialDist));
        outgoingLight = mix(outgoingLight, uEdgeColor, edgeFade);
        #include <opaque_fragment>`
      );
  };
  terrainMat.customProgramCacheKey = () => `real-terrain-edge-fade-${win.sceneWidth.toFixed(1)}`;

  const skirtMat = new THREE.MeshStandardMaterial({
    color: 0x06090f,
    roughness: 0.96,
    metalness: 0.02,
  });

  // Horizon floor apron blends seamlessly into #06090f fog without catching bright sky reflection
  const horizonGeo = new THREE.PlaneGeometry(540, 540);
  horizonGeo.rotateX(-Math.PI / 2);
  const horizonMat = new THREE.MeshBasicMaterial({
    color: 0x06090f,
    fog: true,
  });
  const horizonMesh = new THREE.Mesh(horizonGeo, horizonMat);
  horizonMesh.position.y = -3.26;
  root.add(horizonMesh);

  const stdBuildingsMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.84,
    metalness: 0.08,
    envMapIntensity: 0.28,
  });
  applyArchitecturalFacadeShader(stdBuildingsMat, nightUniform, false);

  const towerBuildingsMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.26,
    metalness: 0.72,
    envMapIntensity: 0.78,
  });
  applyArchitecturalFacadeShader(towerBuildingsMat, nightUniform, true);

  let terrainMesh: THREE.Mesh | null = null;
  let skirtMesh: THREE.Mesh | null = null;
  let stdBuildingsMesh: THREE.Mesh | null = null;
  let towerBuildingsMesh: THREE.Mesh | null = null;
  const overlaysGroup = new THREE.Group();
  root.add(overlaysGroup);

  const clearMesh = (mesh: THREE.Mesh | null) => {
    if (!mesh) return;
    mesh.geometry.dispose();
    root.remove(mesh);
  };

  const clearOverlays = () => {
    const children = [...overlaysGroup.children];
    for (const child of children) {
      child.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
          obj.geometry?.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material?.dispose();
        }
      });
      overlaysGroup.remove(child);
    }
  };

  const buildFlatPlaceholder = () => {
    clearMesh(terrainMesh);
    clearMesh(skirtMesh);
    const geo = new THREE.PlaneGeometry(win.sceneWidth, win.sceneDepth, 4, 4);
    geo.rotateX(-Math.PI / 2);
    terrainMesh = new THREE.Mesh(geo, terrainMat);
    terrainMesh.receiveShadow = opts.shadowsEnabled;
    root.add(terrainMesh);

    const skirtGeo = createArchitecturalSkirtGeometry(geo, 5, 5, -3.24);
    skirtMesh = new THREE.Mesh(skirtGeo, skirtMat);
    root.add(skirtMesh);
  };

  const rebuildFromPayload = (payload: RealTerrainPayload, route: PredictiveRouteResult | null) => {
    if (disposed) return;

    clearMesh(terrainMesh);
    clearMesh(skirtMesh);
    clearMesh(stdBuildingsMesh);
    clearMesh(towerBuildingsMesh);
    clearOverlays();
    stdBuildingsMesh = null;
    towerBuildingsMesh = null;

    const { rows, cols, sceneWidth, sceneDepth, elevationsM, minElevationM, spanMetersX } = payload;

    // 1. Real Topographic DEM Mesh
    const tGeo = new THREE.PlaneGeometry(sceneWidth, sceneDepth, cols - 1, rows - 1);
    tGeo.rotateX(-Math.PI / 2);
    const posAttr = tGeo.attributes.position;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const elevM = elevationsM[idx] ?? minElevationM;
        const y = elevationToSceneY(elevM, minElevationM, spanMetersX, sceneWidth, currentExaggeration);
        posAttr.setY(idx, y);
      }
    }
    tGeo.computeVertexNormals();
    tGeo.computeBoundingSphere();

    terrainMesh = new THREE.Mesh(tGeo, terrainMat);
    terrainMesh.receiveShadow = opts.shadowsEnabled;
    root.add(terrainMesh);

    const skirtGeo = createArchitecturalSkirtGeometry(tGeo, rows, cols, -3.24);
    skirtMesh = new THREE.Mesh(skirtGeo, skirtMat);
    root.add(skirtMesh);

    // 2. Real OSM 3D Buildings (2 batched draw calls with procedural facade shader)
    if (payload.buildings.length > 0) {
      const stdGeo = buildExtrudedBuildingsGeometry(payload, currentExaggeration, false);
      if (stdGeo) {
        stdBuildingsMesh = new THREE.Mesh(stdGeo, stdBuildingsMat);
        stdBuildingsMesh.castShadow = opts.shadowsEnabled;
        stdBuildingsMesh.receiveShadow = opts.shadowsEnabled;
        root.add(stdBuildingsMesh);
      }

      const towerGeo = buildExtrudedBuildingsGeometry(payload, currentExaggeration, true);
      if (towerGeo) {
        towerBuildingsMesh = new THREE.Mesh(towerGeo, towerBuildingsMat);
        towerBuildingsMesh.castShadow = opts.shadowsEnabled;
        towerBuildingsMesh.receiveShadow = opts.shadowsEnabled;
        root.add(towerBuildingsMesh);
      }
    }

    // 3. Center Focus Coordinate Marker grounded on real DEM
    const [centerU, centerV] = latLngToTileWindowUV(payload.center.lat, payload.center.lng, win);
    const [cx, cz] = uvToSceneXZ(centerU, centerV, sceneWidth, sceneDepth);
    const centerElevM = sampleElevationGrid(elevationsM, rows, cols, centerU, centerV);
    const centerY = elevationToSceneY(centerElevM, minElevationM, spanMetersX, sceneWidth, currentExaggeration);

    const ringGeo = new THREE.RingGeometry(0.65, 0.92, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.72,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(cx, centerY + 0.08, cz);
    overlaysGroup.add(ring);

    const spireGeo = new THREE.CylinderGeometry(0.05, 0.05, 3.6, 8);
    spireGeo.translate(0, 1.8, 0);
    const spireMat = new THREE.MeshStandardMaterial({
      color: 0x22d3ee,
      emissive: 0x06b6d4,
      emissiveIntensity: 1.2,
      roughness: 0.2,
    });
    const spire = new THREE.Mesh(spireGeo, spireMat);
    spire.position.set(cx, centerY + 0.08, cz);
    overlaysGroup.add(spire);

    // 4. Active Route 3D Ribbon projected onto real DEM elevation
    if (route && route.polylinePath.length >= 2) {
      const routePts: THREE.Vector3[] = [];
      for (const pt of route.polylinePath) {
        const [u, v] = latLngToTileWindowUV(pt.lat, pt.lng, win);
        if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) continue;
        const [rx, rz] = uvToSceneXZ(clamp(u, 0, 1), clamp(v, 0, 1), sceneWidth, sceneDepth);
        const rElev = sampleElevationGrid(elevationsM, rows, cols, u, v);
        const ry = elevationToSceneY(rElev, minElevationM, spanMetersX, sceneWidth, currentExaggeration) + 0.22;
        routePts.push(new THREE.Vector3(rx, ry, rz));
      }

      if (routePts.length >= 2) {
        const curve = new THREE.CatmullRomCurve3(routePts);
        const tubeGeo = new THREE.TubeGeometry(curve, Math.min(96, routePts.length * 3), 0.22, 8, false);
        const tubeMat = new THREE.MeshStandardMaterial({
          color: 0x22d3ee,
          emissive: 0x06b6d4,
          emissiveIntensity: 1.3,
          roughness: 0.25,
        });
        overlaysGroup.add(new THREE.Mesh(tubeGeo, tubeMat));
      }
    }
  };

  const triggerTextureLoad = (mode: GlobeTextureMode) => {
    texEpoch += 1;
    const myEpoch = texEpoch;
    void streamSectorTextureIntoCanvas(
      mode,
      win,
      win.zoom,
      canvas,
      terrainTex,
      () => disposed || myEpoch !== texEpoch,
      opts.onTextureDirty
    );
  };

  buildFlatPlaceholder();
  triggerTextureLoad(opts.initialMode);

  return {
    root,
    tileWindow: win,
    getTerrainMesh: () => terrainMesh,
    setTextureMode: (mode: GlobeTextureMode) => {
      nightUniform.value = mode === 'thermal' ? 1.0 : 0.0;
      if (currentMode === mode) return;
      currentMode = mode;
      triggerTextureLoad(mode);
    },
    setVerticalExaggeration: (exaggeration: number) => {
      if (Math.abs(currentExaggeration - exaggeration) < 0.01) return;
      currentExaggeration = exaggeration;
      if (currentPayload) {
        rebuildFromPayload(currentPayload, currentRoute);
      }
    },
    updatePayload: (payload: RealTerrainPayload, route: PredictiveRouteResult | null) => {
      currentPayload = payload;
      currentRoute = route;
      rebuildFromPayload(payload, route);
    },
    dispose: () => {
      disposed = true;
      texEpoch += 1;
      clearMesh(terrainMesh);
      clearMesh(skirtMesh);
      clearMesh(stdBuildingsMesh);
      clearMesh(towerBuildingsMesh);
      clearOverlays();
      horizonGeo.dispose();
      horizonMat.dispose();
      terrainTex.dispose();
      terrainMat.dispose();
      skirtMat.dispose();
      stdBuildingsMat.dispose();
      towerBuildingsMat.dispose();
    },
  };
}
