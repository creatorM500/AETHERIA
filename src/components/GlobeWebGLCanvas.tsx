import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  cartesianToLatLng,
  clamp,
  haversineKm,
  latLngToCartesian,
} from '../shared/geo.ts';
import {
  getQualitySpecForTier,
  stepAdaptiveQualityTier,
} from '../shared/terrainMath.ts';
import type {
  GlobalEvent,
  GlobalWindFieldResponse,
  GlobeTextureMode,
  LiveTerrainCoords,
  PredictiveRouteResult,
  QualityTier,
  SectorPreset,
  SeismicHeatScaleMetrics,
  SeismicQuake24h,
  TerrainHudStats,
  ViewportMode,
} from '../shared/types.ts';
import {
  GodsEyeOrbitalConstellation,
  GodsEyeTargetReticle,
  type GodsEyeShaderUniforms,
} from '../three/godsEyeVisuals.ts';
import {
  createCloudTexture,
  createGlobeTextures,
} from '../three/proceduralTextures.ts';
import {
  GlobeSeismicHeatmapLayer,
  TerrainSeismicHeatmapLayer,
} from '../three/seismicHeatmapLayer.ts';
import { GlobeWindParticleLayer } from '../three/windParticleLayer.ts';
import { GlobalTerrainStreamManager } from '../three/worldTerrainStream.ts';
import { createAtmosphereMaterial, createOuterHaloMaterial } from '../three/shaders.ts';
import {
  GlobeRegionalTileManager,
  streamPlanetaryTilesIntoCanvas,
} from '../three/worldTiles.ts';

export type GlobePickMode = 'none' | 'origin' | 'destination' | 'terrain';

interface GlobeWebGLCanvasProps {
  events: GlobalEvent[];
  selectedEvent: GlobalEvent | null;
  onSelectEvent: (event: GlobalEvent | null) => void;
  textureMode: GlobeTextureMode;
  viewportMode: ViewportMode;
  activeSector: SectorPreset;
  activeRoute: PredictiveRouteResult | null;
  focusTarget: { lat: number; lng: number; zoomDistance?: number; nonce: number } | null;
  zoomSignal?: { action: 'in' | 'out' | 'street'; nonce: number } | null;
  onAltitudeChange?: (info: {
    altitudeMeters: number;
    tileZoom: number;
    lat: number;
    lng: number;
  }) => void;
  terrainExaggeration?: number;
  qualityPreference?: 'auto' | QualityTier;
  onTerrainStatsChange?: (stats: TerrainHudStats) => void;
  autoRotate: boolean;
  pickMode: GlobePickMode;
  onPickGlobePoint: (lat: number, lng: number) => void;
  onTerrainRelocate?: (lat: number, lng: number, recenterCamera: boolean) => void;
  onUserInteract?: () => void;
  flyAlongActive: boolean;
  onFlyAlongProgress: (progress01: number) => void;
  onFlyAlongComplete: () => void;
  seismicHeatmapEnabled?: boolean;
  seismicQuakes24h?: SeismicQuake24h[];
  seismicMetrics?: SeismicHeatScaleMetrics | null;
  onSelectQuake24h?: (quake: SeismicQuake24h | null) => void;
  onLiveTerrainCoordsChange?: (coords: LiveTerrainCoords) => void;
  windLayerEnabled?: boolean;
  windField?: GlobalWindFieldResponse | null;
}

const GLOBE_RADIUS = 10;

// Pre-allocated scratch math helpers (Zero GC in render loop)
const _vec3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function detectSoftwareGl(): boolean {
  try {
    const probeCanvas = document.createElement('canvas');
    const gl = probeCanvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export function GlobeWebGLCanvas({
  events,
  selectedEvent,
  onSelectEvent,
  textureMode,
  viewportMode,
  activeSector,
  activeRoute,
  focusTarget,
  zoomSignal,
  onAltitudeChange,
  terrainExaggeration = 1.45,
  qualityPreference = 'auto',
  onTerrainStatsChange,
  autoRotate,
  pickMode,
  onPickGlobePoint,
  onTerrainRelocate,
  onUserInteract,
  flyAlongActive,
  onFlyAlongProgress,
  onFlyAlongComplete,
  seismicHeatmapEnabled = true,
  seismicQuakes24h = [],
  seismicMetrics = null,
  onSelectQuake24h,
  onLiveTerrainCoordsChange,
  windLayerEnabled = true,
  windField = null,
}: GlobeWebGLCanvasProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [contextLost, setContextLost] = useState(false);

  const callbacksRef = useRef({
    onSelectEvent,
    onPickGlobePoint,
    onTerrainRelocate,
    onUserInteract,
    onFlyAlongProgress,
    onFlyAlongComplete,
    onAltitudeChange,
    onTerrainStatsChange,
    onSelectQuake24h,
    onLiveTerrainCoordsChange,
  });
  callbacksRef.current = {
    onSelectEvent,
    onPickGlobePoint,
    onTerrainRelocate,
    onUserInteract,
    onFlyAlongProgress,
    onFlyAlongComplete,
    onAltitudeChange,
    onTerrainStatsChange,
    onSelectQuake24h,
    onLiveTerrainCoordsChange,
  };

  const propsRef = useRef({
    viewportMode,
    autoRotate,
    selectedEvent,
    pickMode,
    flyAlongActive,
    activeRoute,
    textureMode,
    terrainExaggeration,
    qualityPreference,
    activeSector,
    seismicHeatmapEnabled,
    seismicQuakes24h,
    seismicMetrics,
    windLayerEnabled,
    windField,
  });
  propsRef.current = {
    viewportMode,
    autoRotate,
    selectedEvent,
    pickMode,
    flyAlongActive,
    activeRoute,
    textureMode,
    terrainExaggeration,
    qualityPreference,
    activeSector,
    seismicHeatmapEnabled,
    seismicQuakes24h,
    seismicMetrics,
    windLayerEnabled,
    windField,
  };

  const sceneHandleRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    globeRoot: THREE.Group;
    sectorContainer: THREE.Group;
    earthMat: THREE.MeshStandardMaterial;
    markersGroup: THREE.Group;
    routeGroup: THREE.Group;
    interactables: THREE.Object3D[];
    animatedBeacons: Array<{ mesh: THREE.Mesh; baseScale: number; phase: number }>;
    flyState: {
      active: boolean;
      dir: THREE.Vector3;
      logAlt: number;
      lookAt: THREE.Vector3;
      isSector: boolean;
      camPos: THREE.Vector3;
    };
    flyAlongState: {
      curve: THREE.CatmullRomCurve3 | null;
      progress: number;
      marker: THREE.Mesh;
      lastEmitMs: number;
    };
    isSoftwareGl: boolean;
    maxAnisotropy: number;
    setTextureMode: (mode: GlobeTextureMode) => void;
    setVerticalExaggeration: (exag: number) => void;
    setQualityPreference: (pref: 'auto' | QualityTier) => void;
    rebuildEvents: (evs: GlobalEvent[], selectedId: string | null) => void;
    rebuildRouteArc: (route: PredictiveRouteResult | null) => void;
    rebuildSector: (preset: SectorPreset, route: PredictiveRouteResult | null) => void;
    syncViewportMode: (mode: ViewportMode, sector: SectorPreset, isModeSwitch: boolean) => void;
    syncSeismicHeatmap: (
      enabled: boolean,
      quakes: SeismicQuake24h[],
      metrics: SeismicHeatScaleMetrics | null
    ) => void;
    syncWindLayer: (enabled: boolean, field: GlobalWindFieldResponse | null) => void;
    resetFlyAlong: () => void;
    prefetchTarget: (lat: number, lng: number, targetDist: number) => void;
    setReticleTarget: (lat: number, lng: number) => void;
    applyZoomAction: (action: 'in' | 'out' | 'street', fallbackLat: number, fallbackLng: number) => void;
    requestRender: () => void;
  } | null>(null);
  const prevViewportModeRef = useRef<ViewportMode>(viewportMode);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const isSoftwareGl = detectSoftwareGl();
    const initialTier: QualityTier = isSoftwareGl ? 'eco' : 'ultra';
    let currentQualityTier: QualityTier = initialTier;
    let activeQualitySpec = getQualitySpecForTier(
      initialTier,
      isSoftwareGl,
      window.devicePixelRatio || 1
    );

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: isSoftwareGl,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setPixelRatio(activeQualitySpec.pixelRatioCap);
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = activeQualitySpec.shadowsEnabled;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.setAttribute('data-testid', 'webgl-globe-canvas');
    container.appendChild(renderer.domElement);

    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#06090f');
    scene.fog = new THREE.FogExp2('#06090f', 0.004);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTarget = pmremGenerator.fromScene(roomEnv, 0.04);
    scene.environment = envTarget.texture;
    roomEnv.dispose();
    pmremGenerator.dispose();

    const camera = new THREE.PerspectiveCamera(44, width / height, 0.25, 420);
    camera.position.set(0, 9.5, 25.5);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.07;
    controls.enablePan = false;
    controls.minDistance = GLOBE_RADIUS + 0.00012; // ~76m street/sidewalk altitude
    controls.maxDistance = 44;
    controls.rotateSpeed = 0.72;
    controls.zoomSpeed = 0.9;

    const initialIsGodsEye = propsRef.current.textureMode === 'godseye';
    scene.environmentIntensity = initialIsGodsEye ? 0.22 : 1.0;

    // 3-Point Studio / Orbital Lighting Rig
    const keyLight = new THREE.DirectionalLight(0xfff4de, initialIsGodsEye ? 0.95 : 2.2);
    keyLight.position.set(42, 48, 34);
    if (!isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(2048, 2048);
      keyLight.shadow.camera.left = -56;
      keyLight.shadow.camera.right = 56;
      keyLight.shadow.camera.top = 56;
      keyLight.shadow.camera.bottom = -56;
      keyLight.shadow.bias = -0.0004;
      keyLight.shadow.normalBias = 0.03;
    }
    scene.add(keyLight);

    const hemiLight = new THREE.HemisphereLight(0x38bdf8, 0x0f172a, 1.05);
    scene.add(hemiLight);

    const rimLight = new THREE.DirectionalLight(0x22d3ee, 0.85);
    rimLight.position.set(-22, -10, -18);
    scene.add(rimLight);

    // Spectral Starfield (cool O/B blue-white, crisp white, warm K/M amber)
    const starCount = 950;
    const starPos = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 95 + (i % 45);
      const theta = ((i * 137.508) % 360) * (Math.PI / 180);
      const phi = Math.acos(1 - (2 * (i + 0.5)) / starCount);
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.cos(phi);
      starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

      const tintSeed = (i * 29) % 10;
      const brightness = 0.65 + ((i * 17) % 11) * 0.032;
      if (tintSeed < 3) {
        starColors[i * 3] = 0.72 * brightness;
        starColors[i * 3 + 1] = 0.86 * brightness;
        starColors[i * 3 + 2] = 1.0 * brightness;
      } else if (tintSeed > 7) {
        starColors[i * 3] = 1.0 * brightness;
        starColors[i * 3 + 1] = 0.88 * brightness;
        starColors[i * 3 + 2] = 0.70 * brightness;
      } else {
        starColors[i * 3] = 0.92 * brightness;
        starColors[i * 3 + 1] = 0.95 * brightness;
        starColors[i * 3 + 2] = 1.0 * brightness;
      }
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
    const starCanvas = document.createElement('canvas');
    starCanvas.width = 32;
    starCanvas.height = 32;
    const starCtx = starCanvas.getContext('2d');
    if (starCtx) {
      const g = starCtx.createRadialGradient(16, 16, 1, 16, 16, 15);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.75)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      starCtx.fillStyle = g;
      starCtx.fillRect(0, 0, 32, 32);
    }
    const starSprite = new THREE.CanvasTexture(starCanvas);
    const starMat = new THREE.PointsMaterial({
      vertexColors: true,
      map: starSprite,
      size: 0.42,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      alphaTest: 0.01,
    });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    // Shared "Ojo de Dios" holographic & optical scan shader uniforms
    const godsEyeUniforms: GodsEyeShaderUniforms = {
      nightMode: { value: propsRef.current.textureMode === 'thermal' ? 1.0 : 0.0 },
      godsEyeMode: { value: propsRef.current.textureMode === 'godseye' ? 1.0 : 0.0 },
      scanRadius: { value: 0.0 },
      scanActive: { value: 0.0 },
      scanOrigin: { value: new THREE.Vector3(0, 0, 0) },
      horizonFadeRadius: { value: 0.0 },
      time: { value: 0.0 },
      focusPoint: { value: new THREE.Vector3(0, 0, 0) },
    };

    let scanAnimActive = false;
    let scanAnimStartMs = 0;
    let scanAnimMaxRadius = 150;
    const triggerScanSweep = (ox: number, oy: number, oz: number, maxR = 150) => {
      godsEyeUniforms.scanOrigin.value.set(ox, oy, oz);
      godsEyeUniforms.scanRadius.value = 0;
      godsEyeUniforms.scanActive.value = 1;
      scanAnimStartMs = performance.now();
      scanAnimMaxRadius = maxR;
      scanAnimActive = true;
    };

    // --- ORBITAL GLOBE ROOT ---
    const globeRoot = new THREE.Group();
    scene.add(globeRoot);

    const bootTexMode = propsRef.current.textureMode;
    const initialTex = createGlobeTextures(bootTexMode, maxAnisotropy, !isSoftwareGl);
    const earthGeo = new THREE.SphereGeometry(
      GLOBE_RADIUS,
      isSoftwareGl ? 64 : 128,
      isSoftwareGl ? 48 : 96
    );
    const earthMat = new THREE.MeshStandardMaterial({
      map: initialTex.colorMap,
      bumpMap: initialTex.bumpMap,
      bumpScale: 0.04,
      roughnessMap: initialTex.roughnessMap,
      roughness: 0.9,
      metalness: 0.05,
      envMapIntensity: 0.3,
    });
    const earthMesh = new THREE.Mesh(earthGeo, earthMat);
    globeRoot.add(earthMesh);

    let disposed = false;
    let swRenderBusy = false;
    let swDirty = true;
    let swTimerId = 0;
    let loopPaused = document.visibilityState === 'hidden';
    function requestRenderIfNeeded() {
      if (!isSoftwareGl || disposed || loopPaused) return;
      swDirty = true;
      if (swRenderBusy || swTimerId !== 0) return;
      swTimerId = window.setTimeout(() => {
        swTimerId = 0;
        if (!disposed && !loopPaused) tick();
      }, 16);
    }

    const globeSeismicLayer = new GlobeSeismicHeatmapLayer(GLOBE_RADIUS, isSoftwareGl);
    globeSeismicLayer.setEnabled(propsRef.current.seismicHeatmapEnabled);

    const globeWindLayer = new GlobeWindParticleLayer(GLOBE_RADIUS);
    globeWindLayer.setEnabled(propsRef.current.windLayerEnabled);
    if (propsRef.current.windField) {
      globeWindLayer.setData(propsRef.current.windField);
    }

    const cloudTex = createCloudTexture(!isSoftwareGl);
    const cloudGeo = new THREE.SphereGeometry(GLOBE_RADIUS * 1.016, 48, 36);
    const cloudMat = new THREE.MeshStandardMaterial({
      map: cloudTex,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      roughness: 1,
    });
    const cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
    cloudMesh.visible = bootTexMode === 'satellite';
    cloudMesh.renderOrder = 8;
    globeRoot.add(cloudMesh);

    const sunDir = keyLight.position.clone().normalize();
    const atmoGeo = new THREE.SphereGeometry(GLOBE_RADIUS * 1.045, 48, 36);
    const atmoMat = createAtmosphereMaterial(sunDir);
    const atmoMesh = new THREE.Mesh(atmoGeo, atmoMat);
    atmoMesh.renderOrder = 10;
    globeRoot.add(atmoMesh);

    const haloGeo = new THREE.SphereGeometry(GLOBE_RADIUS * 1.095, 48, 36);
    const haloMat = createOuterHaloMaterial(sunDir);
    const haloMesh = new THREE.Mesh(haloGeo, haloMat);
    haloMesh.renderOrder = 11;
    globeRoot.add(haloMesh);

    // "Ojo de Dios" 18-satellite orbital constellation + 3-laser triangulation lock
    const orbitalConstellation = new GodsEyeOrbitalConstellation(GLOBE_RADIUS);
    orbitalConstellation.setTargetLatLng(propsRef.current.activeSector.lat, propsRef.current.activeSector.lng);
    globeRoot.add(orbitalConstellation.group);

    // Optical 3D target-lock reticle on the Globe
    const globeReticle = new GodsEyeTargetReticle();
    globeReticle.group.renderOrder = 6;
    {
      const p0 = latLngToCartesian(propsRef.current.activeSector.lat, propsRef.current.activeSector.lng, GLOBE_RADIUS + 0.054);
      globeReticle.group.position.set(p0.x, p0.y, p0.z);
      _vec3.set(p0.x, p0.y, p0.z).normalize();
      globeReticle.group.quaternion.setFromUnitVectors(_up, _vec3);
    }
    globeRoot.add(globeReticle.group);

    const regionalTiles = new GlobeRegionalTileManager(GLOBE_RADIUS, maxAnisotropy, () => {
      requestRenderIfNeeded();
    });
    regionalTiles.setMode(bootTexMode);
    globeRoot.add(regionalTiles.group);

    globeRoot.add(globeSeismicLayer.group);
    globeRoot.add(globeWindLayer.group);

    const markersGroup = new THREE.Group();
    const routeGroup = new THREE.Group();
    globeRoot.add(markersGroup, routeGroup);

    // Live fly-along navigator beacon on the 3D globe
    const navMarkerGeo = new THREE.ConeGeometry(0.06, 0.16, 8);
    navMarkerGeo.rotateX(Math.PI / 2);
    const navMarkerMat = new THREE.MeshStandardMaterial({
      color: 0xfbbf24,
      emissive: 0xf59e0b,
      emissiveIntensity: 1.5,
      roughness: 0.2,
    });
    const navMarker = new THREE.Mesh(navMarkerGeo, navMarkerMat);
    navMarker.visible = false;
    globeRoot.add(navMarker);

    // --- GLOBAL STREAMING 3D TERRAIN & BUILDINGS CONTAINER ---
    const sectorContainer = new THREE.Group();
    sectorContainer.visible = false;
    scene.add(sectorContainer);

    const terrainSeismicLayer = new TerrainSeismicHeatmapLayer();
    sectorContainer.add(terrainSeismicLayer.group);

    const sectorReticle = new GodsEyeTargetReticle();
    sectorReticle.group.scale.setScalar(4.0);
    sectorContainer.add(sectorReticle.group);

    const positionGlobeReticle = (lat: number, lng: number) => {
      const pt = latLngToCartesian(lat, lng, GLOBE_RADIUS + 0.054);
      globeReticle.group.position.set(pt.x, pt.y, pt.z);
      _vec3.set(pt.x, pt.y, pt.z).normalize();
      globeReticle.group.quaternion.setFromUnitVectors(_up, _vec3);
      orbitalConstellation.setTargetLatLng(lat, lng);
      if (propsRef.current.viewportMode === 'globe') {
        triggerScanSweep(pt.x, pt.y, pt.z, 18.0);
      }
    };

    const interactables: THREE.Object3D[] = [];
    const animatedBeacons: Array<{ mesh: THREE.Mesh; baseScale: number; phase: number }> = [];
    const eventNodes: THREE.Group[] = [];
    const routePins: THREE.Mesh[] = [];
    const flyState = {
      active: false,
      dir: new THREE.Vector3(0, 0, 1),
      logAlt: Math.log(17),
      lookAt: new THREE.Vector3(),
      isSector: false,
      camPos: new THREE.Vector3(),
    };
    const flyAlongState = {
      curve: null as THREE.CatmullRomCurve3 | null,
      progress: 0,
      marker: navMarker,
      lastEmitMs: 0,
    };

    let tileStreamEpoch = 0;
    const startPlanetaryStream = (mode: GlobeTextureMode, tex: THREE.CanvasTexture) => {
      tileStreamEpoch += 1;
      const myEpoch = tileStreamEpoch;
      const canvas = tex.image as HTMLCanvasElement;
      void streamPlanetaryTilesIntoCanvas(
        mode,
        canvas,
        tex,
        () => myEpoch !== tileStreamEpoch || disposed,
        () => {
          requestRenderIfNeeded();
        }
      );
    };

    // Stream real-world planetary imagery immediately on startup
    startPlanetaryStream(bootTexMode, initialTex.colorMap);

    const sharedHitGeo = new THREE.SphereGeometry(0.28, 10, 10);
    const sharedHitMat = new THREE.MeshBasicMaterial({ visible: false });
    const sharedDisasterRingGeo = new THREE.RingGeometry(0.085, 0.112, 28);
    sharedDisasterRingGeo.rotateX(-Math.PI / 2);
    const sharedDisasterPillarCritGeo = new THREE.CylinderGeometry(0.008, 0.022, 0.62, 8);
    sharedDisasterPillarCritGeo.translate(0, 0.31, 0);
    const sharedDisasterPillarStdGeo = new THREE.CylinderGeometry(0.006, 0.018, 0.42, 8);
    sharedDisasterPillarStdGeo.translate(0, 0.21, 0);
    const sharedConflictRingGeo = new THREE.RingGeometry(0.16, 0.20, 28);
    sharedConflictRingGeo.rotateX(-Math.PI / 2);
    const sharedConflictCoreGeo = new THREE.OctahedronGeometry(0.08, 0);

    const sharedGeometries = new Set<THREE.BufferGeometry>([
      sharedHitGeo,
      sharedDisasterRingGeo,
      sharedDisasterPillarCritGeo,
      sharedDisasterPillarStdGeo,
      sharedConflictRingGeo,
      sharedConflictCoreGeo,
    ]);

    const sharedDisasterMats = new Map<number, { ring: THREE.MeshBasicMaterial; pillar: THREE.MeshStandardMaterial }>();
    for (const color of [0xef4444, 0xf97316, 0xf59e0b]) {
      sharedDisasterMats.set(color, {
        ring: new THREE.MeshBasicMaterial({
          color,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.88,
        }),
        pillar: new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 1.1,
          roughness: 0.3,
        }),
      });
    }
    const sharedConflictRingMat = new THREE.MeshBasicMaterial({
      color: 0xf43f5e,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.78,
    });
    const sharedConflictCoreMat = new THREE.MeshStandardMaterial({
      color: 0xfb7185,
      emissive: 0xe11d48,
      emissiveIntensity: 1.0,
      roughness: 0.25,
    });
    const sharedMaterials = new Set<THREE.Material>([
      sharedHitMat,
      sharedConflictRingMat,
      sharedConflictCoreMat,
      ...Array.from(sharedDisasterMats.values()).flatMap((pair) => [pair.ring, pair.pillar]),
    ]);

    const disposeGroupChildren = (grp: THREE.Group) => {
      const toRemove = [...grp.children];
      for (const child of toRemove) {
        child.traverse((obj) => {
          if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
            if (
              obj.geometry &&
              !sharedGeometries.has(obj.geometry) &&
              !obj.geometry.userData?.sharedAsset
            ) {
              obj.geometry.dispose();
            }
            if (Array.isArray(obj.material)) {
              obj.material.forEach((m) => {
                if (!sharedMaterials.has(m) && !m.userData?.sharedAsset) m.dispose();
              });
            } else if (
              obj.material &&
              !sharedMaterials.has(obj.material) &&
              !obj.material.userData?.sharedAsset
            ) {
              obj.material.dispose();
            }
          }
        });
        grp.remove(child);
      }
    };

    let cloudModeEnabled = bootTexMode === 'satellite';
    let activeTexMode: GlobeTextureMode = bootTexMode;
    let terrainStream: GlobalTerrainStreamManager | null = null;
    const setTextureMode = (mode: GlobeTextureMode) => {
      if (activeTexMode === mode) return;
      activeTexMode = mode;
      godsEyeUniforms.nightMode.value = mode === 'thermal' ? 1.0 : 0.0;
      godsEyeUniforms.godsEyeMode.value = mode === 'godseye' ? 1.0 : 0.0;

      const prevMap = earthMat.map;
      const prevBump = earthMat.bumpMap;
      const prevRough = earthMat.roughnessMap;
      const next = createGlobeTextures(mode, maxAnisotropy, !isSoftwareGl);
      earthMat.map = next.colorMap;
      earthMat.bumpMap = next.bumpMap;
      earthMat.roughnessMap = next.roughnessMap;
      earthMat.needsUpdate = true;
      prevMap?.dispose();
      prevBump?.dispose();
      prevRough?.dispose();

      regionalTiles.setMode(mode);
      startPlanetaryStream(mode, next.colorMap);
      terrainStream?.setTextureMode(mode);

      const isGodsEye = mode === 'godseye';
      scene.environmentIntensity = isGodsEye ? 0.36 : 1.0;
      keyLight.intensity = isGodsEye ? 1.25 : 2.2;

      const glowHex = mode === 'thermal' ? '#f59e0b' : mode === 'topo' ? '#38bdf8' : '#22d3ee';
      atmoMat.uniforms.glowColor.value.set(glowHex);
      haloMat.uniforms.glowColor.value.set(glowHex);
      cloudModeEnabled = mode === 'satellite';
      cloudMesh.visible = cloudModeEnabled;

      if (propsRef.current.viewportMode === 'sector3d') {
        triggerScanSweep(controls.target.x, controls.target.y, controls.target.z, 210);
      } else {
        triggerScanSweep(
          globeReticle.group.position.x,
          globeReticle.group.position.y,
          globeReticle.group.position.z,
          18.0
        );
      }
      requestRenderIfNeeded();
    };

    let lastEventsSignature = '';
    const rebuildEvents = (evs: GlobalEvent[], selectedId: string | null) => {
      const heatmapActive = propsRef.current.seismicHeatmapEnabled;
      let sig = `${selectedId ?? ''}|${heatmapActive ? 1 : 0}|${evs.length}|`;
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i];
        sig += `${e.id}:${e.lat.toFixed(2)},${e.lng.toFixed(2)};`;
      }
      if (sig === lastEventsSignature) return;
      lastEventsSignature = sig;

      disposeGroupChildren(markersGroup);
      interactables.length = 0;
      animatedBeacons.length = 0;
      eventNodes.length = 0;

      evs.forEach((ev, idx) => {
        if (ev.category === 'flight' || ev.category === 'ship') return;
        // Avoid clunky duplicate rings on earthquakes when the dedicated 24h seismic heatmap layer is active
        if (heatmapActive && ev.subtype === 'earthquake') return;

        const pos = latLngToCartesian(ev.lat, ev.lng, GLOBE_RADIUS + 0.058);
        const isSelected = ev.id === selectedId;

        const nodeGroup = new THREE.Group();
        nodeGroup.position.set(pos.x, pos.y, pos.z);

        _vec3.set(pos.x, pos.y, pos.z).normalize();
        nodeGroup.quaternion.setFromUnitVectors(_up, _vec3);

        if (ev.category === 'disaster') {
          const color =
            ev.severity === 'critical'
              ? 0xef4444
              : ev.severity === 'high'
                ? 0xf97316
                : 0xf59e0b;
          const mats = sharedDisasterMats.get(color)!;
          const ringMesh = new THREE.Mesh(sharedDisasterRingGeo, mats.ring);
          nodeGroup.add(ringMesh);
          animatedBeacons.push({ mesh: ringMesh, baseScale: isSelected ? 1.5 : 1.0, phase: idx * 0.7 });

          const pillarGeo =
            ev.severity === 'critical' ? sharedDisasterPillarCritGeo : sharedDisasterPillarStdGeo;
          nodeGroup.add(new THREE.Mesh(pillarGeo, mats.pillar));
        } else {
          const ringMesh = new THREE.Mesh(sharedConflictRingGeo, sharedConflictRingMat);
          nodeGroup.add(ringMesh);
          animatedBeacons.push({ mesh: ringMesh, baseScale: isSelected ? 1.45 : 1.0, phase: idx * 0.9 });

          const core = new THREE.Mesh(sharedConflictCoreGeo, sharedConflictCoreMat);
          core.position.y = 0.22;
          nodeGroup.add(core);
        }

        const hitProxy = new THREE.Mesh(sharedHitGeo, sharedHitMat);
        hitProxy.position.set(0, 0.1, 0);
        hitProxy.userData.eventData = ev;
        nodeGroup.add(hitProxy);
        interactables.push(hitProxy);

        markersGroup.add(nodeGroup);
        eventNodes.push(nodeGroup);
      });
    };

    const rebuildRouteArc = (route: PredictiveRouteResult | null) => {
      disposeGroupChildren(routeGroup);
      routePins.length = 0;
      flyAlongState.curve = null;
      flyAlongState.progress = 0;
      flyAlongState.marker.visible = false;

      if (!route || route.polylinePath.length < 2) return;

      const spanKm = haversineKm(route.origin, route.destination);
      const isLocalOrRegional = spanKm < 450;
      const count = Math.min(96, route.polylinePath.length);
      const pts: THREE.Vector3[] = [];

      for (let i = 0; i < count; i++) {
        const idx = Math.floor((i / (count - 1)) * (route.polylinePath.length - 1));
        const p = route.polylinePath[idx];
        const lift = isLocalOrRegional
          ? 0.000045
          : Math.sin((i / (count - 1)) * Math.PI) * 0.55 + 0.04;
        const c = latLngToCartesian(p.lat, p.lng, GLOBE_RADIUS + lift);
        pts.push(new THREE.Vector3(c.x, c.y, c.z));
      }

      const curve = new THREE.CatmullRomCurve3(pts);
      flyAlongState.curve = curve;

      const tubeRadius = clamp(spanKm / 48000, 0.00009, 0.045);

      const tubeGeo = new THREE.TubeGeometry(curve, Math.max(48, count * 2), tubeRadius, 8, false);
      const tubeMat = new THREE.MeshStandardMaterial({
        color: 0x22d3ee,
        emissive: 0x06b6d4,
        emissiveIntensity: 1.5,
        roughness: 0.2,
      });
      const tubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
      tubeMesh.renderOrder = 3;
      routeGroup.add(tubeMesh);

      // Unit-radius pin geometry scaled dynamically by camera altitude in tick()
      const pinGeo = new THREE.SphereGeometry(1, 14, 14);
      const pinLift = isLocalOrRegional ? 0.00005 : 0.045;
      const origC = latLngToCartesian(route.origin.lat, route.origin.lng, GLOBE_RADIUS + pinLift);
      const destC = latLngToCartesian(route.destination.lat, route.destination.lng, GLOBE_RADIUS + pinLift);
      const origPin = new THREE.Mesh(
        pinGeo,
        new THREE.MeshStandardMaterial({ color: 0x10b981, emissive: 0x059669, emissiveIntensity: 1.4 })
      );
      origPin.position.set(origC.x, origC.y, origC.z);
      origPin.scale.setScalar(0.0003);
      origPin.renderOrder = 4;
      const destPin = new THREE.Mesh(
        pinGeo,
        new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xd97706, emissiveIntensity: 1.4 })
      );
      destPin.position.set(destC.x, destC.y, destC.z);
      destPin.scale.setScalar(0.0003);
      destPin.renderOrder = 4;
      routeGroup.add(origPin, destPin);
      routePins.push(origPin, destPin);
    };

    let anchorCoord = { lat: propsRef.current.activeSector.lat, lng: propsRef.current.activeSector.lng };
    let preserveSectorCameraOffset = false;
    let lastPanStreamMs = 0;

    const rebuildSector = (preset: SectorPreset, route: PredictiveRouteResult | null) => {
      if (!terrainStream) {
        anchorCoord = { lat: preset.lat, lng: preset.lng };
        terrainStream = new GlobalTerrainStreamManager({
          lat: preset.lat,
          lng: preset.lng,
          textureMode: propsRef.current.textureMode,
          verticalExaggeration: propsRef.current.terrainExaggeration,
          qualityTier: currentQualityTier,
          maxAnisotropy,
          shadowsEnabled: activeQualitySpec.shadowsEnabled,
          isSoftwareGl,
          uniforms: godsEyeUniforms,
          route,
          onStatsChange: (stats) => {
            callbacksRef.current.onTerrainStatsChange?.(stats);
          },
          onAnchorReady: (worldCenter) => {
            if (!preserveSectorCameraOffset) {
              flyState.active = true;
              flyState.isSector = true;
              flyState.lookAt.set(worldCenter.x, worldCenter.y + 1.2, worldCenter.z);
              flyState.camPos.set(worldCenter.x + 30, worldCenter.y + 22, worldCenter.z + 32);
            }
            preserveSectorCameraOffset = false;
            if (terrainStream && propsRef.current.seismicMetrics) {
              terrainSeismicLayer.syncLocalQuakes(
                propsRef.current.seismicQuakes24h,
                propsRef.current.seismicMetrics,
                propsRef.current.seismicHeatmapEnabled,
                (lat, lng) => terrainStream!.latLngToWorldXZ(lat, lng),
                (x, z) => terrainStream!.sampleHeightAtWorldXZ(x, z)
              );
            }
            triggerScanSweep(worldCenter.x, worldCenter.y, worldCenter.z, 210);
            requestRenderIfNeeded();
          },
          onAssetUpdated: () => {
            requestRenderIfNeeded();
          },
        });
        sectorContainer.add(terrainStream.root);
        return;
      }

      terrainStream.setTextureMode(propsRef.current.textureMode);
      terrainStream.setVerticalExaggeration(propsRef.current.terrainExaggeration);
      terrainStream.updateRoute(route);

      const jumpKm = haversineKm(anchorCoord, { lat: preset.lat, lng: preset.lng });
      if (jumpKm > 45) {
        // Far jump across planet: reset floating origin safely
        anchorCoord = { lat: preset.lat, lng: preset.lng };
        preserveSectorCameraOffset = false;
        terrainStream.setAnchor(preset.lat, preset.lng);
      } else if (jumpKm > 0.08) {
        // Continuous regional move within 45 km: keep streamed world intact & glide camera smoothly
        const [wx, wz] = terrainStream.latLngToWorldXZ(preset.lat, preset.lng);
        terrainStream.updateFocusLatLng(preset.lat, preset.lng);
        const wy = terrainStream.sampleHeightAtWorldXZ(wx, wz);
        if (!preserveSectorCameraOffset) {
          _vec3.copy(camera.position).sub(controls.target);
          const dist = clamp(_vec3.length(), 14, 95);
          if (_vec3.lengthSq() < 0.1) _vec3.set(28, 20, 30);
          _vec3.normalize().multiplyScalar(dist);
          flyState.active = true;
          flyState.isSector = true;
          flyState.lookAt.set(wx, wy + 1.2, wz);
          flyState.camPos.set(wx + _vec3.x, wy + Math.max(12, _vec3.y), wz + _vec3.z);
        }
        preserveSectorCameraOffset = false;
        triggerScanSweep(wx, wy, wz, 210);
      }
    };

    const syncViewportMode = (mode: ViewportMode, sector: SectorPreset, isModeSwitch: boolean) => {
      const isSector = mode === 'sector3d';
      globeRoot.visible = !isSector;
      stars.visible = !isSector;
      sectorContainer.visible = isSector;

      if (isSector) {
        godsEyeUniforms.horizonFadeRadius.value = 560.0;
        camera.near = 0.08;
        camera.far = 1100;
        camera.updateProjectionMatrix();
        scene.fog = new THREE.FogExp2('#06090f', 0.0014);
        controls.enablePan = true;
        controls.minDistance = 1.6;
        controls.maxDistance = 280;
        controls.maxPolarAngle = Math.PI * 0.485;
        controls.rotateSpeed = 0.72;
        controls.zoomSpeed = 0.95;
        if (isModeSwitch && !preserveSectorCameraOffset && terrainStream) {
          const [wx, wz] = terrainStream.latLngToWorldXZ(sector.lat, sector.lng);
          const wy = terrainStream.sampleHeightAtWorldXZ(wx, wz);
          flyState.active = true;
          flyState.isSector = true;
          flyState.camPos.set(wx + 34, wy + 26, wz + 36);
          flyState.lookAt.set(wx, wy + 1.2, wz);
          triggerScanSweep(wx, wy, wz, 260);
        }
      } else {
        godsEyeUniforms.horizonFadeRadius.value = 0.0;
        preserveSectorCameraOffset = false;
        keyLight.position.set(42, 48, 34);
        keyLight.target.position.set(0, 0, 0);
        keyLight.target.updateMatrixWorld();
        camera.near = 0.25;
        camera.far = 400;
        camera.updateProjectionMatrix();
        scene.fog = new THREE.FogExp2('#06090f', 0.004);
        controls.enablePan = false;
        controls.minDistance = GLOBE_RADIUS + 0.00012;
        controls.maxDistance = 44;
        controls.maxPolarAngle = Math.PI;
        positionGlobeReticle(sector.lat, sector.lng);
        const c = latLngToCartesian(sector.lat, sector.lng, 1);
        flyState.active = true;
        flyState.isSector = false;
        flyState.dir.set(c.x, c.y, c.z).normalize();
        flyState.logAlt = Math.log(Math.max(1.5, sector.zoomDistance - GLOBE_RADIUS));
        flyState.lookAt.set(0, 0, 0);
      }
    };

    const applyQualityTier = (nextTier: QualityTier) => {
      if (nextTier === currentQualityTier) return;
      currentQualityTier = nextTier;
      activeQualitySpec = getQualitySpecForTier(
        nextTier,
        isSoftwareGl,
        window.devicePixelRatio || 1
      );
      renderer.setPixelRatio(activeQualitySpec.pixelRatioCap);
      renderer.shadowMap.enabled = activeQualitySpec.shadowsEnabled;
      terrainStream?.setQualityTier(currentQualityTier, activeQualitySpec.shadowsEnabled);
    };

    sceneHandleRef.current = {
      renderer,
      scene,
      camera,
      controls,
      globeRoot,
      sectorContainer,
      earthMat,
      markersGroup,
      routeGroup,
      interactables,
      animatedBeacons,
      flyState,
      flyAlongState,
      isSoftwareGl,
      maxAnisotropy,
      setTextureMode,
      setVerticalExaggeration: (exag) => {
        terrainStream?.setVerticalExaggeration(exag);
      },
      setQualityPreference: (pref) => {
        if (pref === 'auto') {
          applyQualityTier(isSoftwareGl ? 'eco' : 'ultra');
        } else {
          applyQualityTier(isSoftwareGl ? 'eco' : pref);
        }
      },
      rebuildEvents,
      rebuildRouteArc,
      rebuildSector,
      syncViewportMode,
      syncSeismicHeatmap: (enabled, quakes, metrics) => {
        globeSeismicLayer.setEnabled(enabled);
        if (metrics) {
          globeSeismicLayer.setData(quakes, metrics);
          if (terrainStream) {
            terrainSeismicLayer.syncLocalQuakes(
              quakes,
              metrics,
              enabled,
              (lat, lng) => terrainStream!.latLngToWorldXZ(lat, lng),
              (x, z) => terrainStream!.sampleHeightAtWorldXZ(x, z)
            );
          }
        } else {
          terrainSeismicLayer.group.visible = false;
        }
        requestRenderIfNeeded();
      },
      syncWindLayer: (enabled, field) => {
        globeWindLayer.setEnabled(enabled);
        if (field) {
          globeWindLayer.setData(field);
        }
        requestRenderIfNeeded();
      },
      resetFlyAlong: () => {
        flyAlongState.progress = 0;
        flyAlongState.lastEmitMs = 0;
      },
      prefetchTarget: (lat, lng, targetDist) => {
        regionalTiles.prefetchTarget(lat, lng, targetDist);
      },
      setReticleTarget: (lat, lng) => {
        positionGlobeReticle(lat, lng);
      },
      requestRender: requestRenderIfNeeded,
      applyZoomAction: (action, fallbackLat, fallbackLng) => {
        if (propsRef.current.viewportMode === 'sector3d') {
          _vec3.copy(camera.position).sub(controls.target);
          if (action === 'street') {
            let hx = _vec3.x;
            let hz = _vec3.z;
            const hLen = Math.hypot(hx, hz);
            if (hLen < 0.01) {
              hx = 0.72;
              hz = 0.69;
            } else {
              hx /= hLen;
              hz /= hLen;
            }
            flyState.isSector = true;
            flyState.camPos.set(
              controls.target.x + hx * 13.5,
              controls.target.y + 5.8,
              controls.target.z + hz * 13.5
            );
            flyState.lookAt.copy(controls.target);
            flyState.active = true;
            requestRenderIfNeeded();
            return;
          }
          const dist = Math.max(1.6, _vec3.length());
          const nextDist = clamp(dist * (action === 'in' ? 0.65 : 1.45), 1.6, 235);
          _vec3.normalize().multiplyScalar(nextDist).add(controls.target);
          flyState.isSector = true;
          flyState.camPos.copy(_vec3);
          flyState.lookAt.copy(controls.target);
          flyState.active = true;
          requestRenderIfNeeded();
          return;
        }
        const curAlt = Math.max(0.00012, camera.position.length() - GLOBE_RADIUS);
        const sub = cartesianToLatLng(camera.position.x, camera.position.y, camera.position.z);
        if (action === 'street') {
          let targetLat = fallbackLat;
          let targetLng = fallbackLng;
          if (flyState.active && !flyState.isSector) {
            const dest = cartesianToLatLng(flyState.dir.x, flyState.dir.y, flyState.dir.z);
            targetLat = dest.lat;
            targetLng = dest.lng;
          } else if (curAlt <= 5.5) {
            targetLat = sub.lat;
            targetLng = sub.lng;
          }
          const c = latLngToCartesian(targetLat, targetLng, 1);
          const targetAlt = 0.00054; // ~344m z=18 city-block map tile view
          regionalTiles.prefetchTarget(targetLat, targetLng, GLOBE_RADIUS + targetAlt);
          positionGlobeReticle(targetLat, targetLng);
          flyState.isSector = false;
          flyState.dir.set(c.x, c.y, c.z).normalize();
          flyState.logAlt = Math.log(targetAlt);
          flyState.lookAt.set(0, 0, 0);
          flyState.active = true;
          requestRenderIfNeeded();
          return;
        }
        const factor = action === 'in' ? 0.45 : 2.2;
        const nextAlt = clamp(curAlt * factor, 0.00012, 34.0);
        regionalTiles.prefetchTarget(sub.lat, sub.lng, GLOBE_RADIUS + nextAlt);
        flyState.isSector = false;
        flyState.dir.copy(camera.position).normalize();
        flyState.logAlt = Math.log(nextAlt);
        flyState.lookAt.set(0, 0, 0);
        flyState.active = true;
        requestRenderIfNeeded();
      },
    };

    const onControlChange = () => {
      requestRenderIfNeeded();
    };
    controls.addEventListener('change', onControlChange);

    const onControlStart = () => {
      flyState.active = false;
      preserveSectorCameraOffset = false;
      if (propsRef.current.viewportMode === 'globe') {
        callbacksRef.current.onUserInteract?.();
      }
      requestRenderIfNeeded();
    };
    controls.addEventListener('start', onControlStart);

    // Worldwide continuous panning in Terreno 3D without snapping camera or tearing down chunks
    const onControlEnd = () => {
      if (propsRef.current.viewportMode !== 'sector3d' || !terrainStream || flyState.active) {
        return;
      }
      terrainStream.updateFocusWorldXZ(controls.target.x, controls.target.z);
      requestRenderIfNeeded();
    };
    controls.addEventListener('end', onControlEnd);

    // Raycast click/tap on globe surface (pickMode) or event markers, plus dblclick teleport on Terreno 3D
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerDownPos = { x: 0, y: 0 };
    let lastCursorCoordMs = 0;
    let lastCursorHoverMs = 0;
    let lastCamCoordMs = 0;
    let lastEmittedCoordSig = '';

    const emitLiveCoords = (coords: LiveTerrainCoords) => {
      const sig = `${coords.source}|${coords.lat.toFixed(5)}|${coords.lng.toFixed(5)}|${coords.groundElevM}|${coords.cameraAltM}`;
      if (sig === lastEmittedCoordSig) return;
      lastEmittedCoordSig = sig;
      callbacksRef.current.onLiveTerrainCoordsChange?.(coords);
    };

    const onPointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
    };

    const onPointerMove = (e: PointerEvent) => {
      if (propsRef.current.viewportMode !== 'sector3d' || !terrainStream) return;
      const now = performance.now();
      if (now - lastCursorCoordMs < 110) return;
      lastCursorCoordMs = now;

      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const hit = terrainStream.raycastTerrain(raycaster);
      if (hit) {
        const rawElev = terrainStream.sampleElevationMetersAtWorldXZ(hit.point.x, hit.point.z);
        const groundElevM = rawElev !== null ? Math.round(rawElev) : 0;
        const targetY = terrainStream.sampleHeightAtWorldXZ(controls.target.x, controls.target.z);
        const cameraAltM = terrainStream.getCameraAltitudeMeters(camera.position.y, targetY);
        lastCursorHoverMs = now;
        emitLiveCoords({
          lat: hit.lat,
          lng: hit.lng,
          groundElevM,
          cameraAltM,
          source: 'cursor',
        });
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const dx = e.clientX - pointerDownPos.x;
      const dy = e.clientY - pointerDownPos.y;
      if (dx * dx + dy * dy > 36) return;

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      if (propsRef.current.viewportMode === 'sector3d') {
        if (!terrainStream) return;
        const localQuakeHits = raycaster.intersectObjects(terrainSeismicLayer.getPickables(), false);
        if (localQuakeHits.length > 0) {
          const quake = localQuakeHits[0].object.userData.quake24h as SeismicQuake24h | undefined;
          if (quake) {
            callbacksRef.current.onSelectQuake24h?.(quake);
            requestRenderIfNeeded();
          }
        }
        return;
      }

      if (propsRef.current.viewportMode !== 'globe') return;

      if (propsRef.current.pickMode !== 'none') {
        const globeHits = raycaster.intersectObject(earthMesh, false);
        if (globeHits.length > 0) {
          const pt = globeHits[0].point;
          const { lat, lng } = cartesianToLatLng(pt.x, pt.y, pt.z);
          positionGlobeReticle(lat, lng);
          callbacksRef.current.onPickGlobePoint(lat, lng);
          requestRenderIfNeeded();
        }
        return;
      }

      const hits = raycaster.intersectObjects(interactables, false);
      if (hits.length > 0) {
        const ev = hits[0].object.userData.eventData as GlobalEvent | undefined;
        if (ev) {
          positionGlobeReticle(ev.lat, ev.lng);
          callbacksRef.current.onSelectEvent(ev);
          requestRenderIfNeeded();
          return;
        }
      }

      // Check 24h seismic heatmap pins, rings, or thermal halos on the 3D globe
      const quakePickables = globeSeismicLayer.getPickables();
      if (quakePickables.length > 0) {
        const qHits = raycaster.intersectObjects(quakePickables, false);
        if (qHits.length > 0) {
          const quake = globeSeismicLayer.resolveQuakeHit(qHits[0]);
          if (quake) {
            positionGlobeReticle(quake.lat, quake.lng);
            callbacksRef.current.onSelectQuake24h?.(quake);
            requestRenderIfNeeded();
            return;
          }
        }
      }

      if (propsRef.current.seismicHeatmapEnabled) {
        const globeHits = raycaster.intersectObject(earthMesh, false);
        if (globeHits.length > 0) {
          const pt = globeHits[0].point;
          const { lat, lng } = cartesianToLatLng(pt.x, pt.y, pt.z);
          const alt = Math.max(0.01, camera.position.length() - GLOBE_RADIUS);
          const maxDeg = clamp(alt * 0.28, 0.28, 3.6);
          const nearestQuake = globeSeismicLayer.findNearestQuakeByLatLng(lat, lng, maxDeg);
          if (nearestQuake) {
            positionGlobeReticle(nearestQuake.lat, nearestQuake.lng);
            callbacksRef.current.onSelectQuake24h?.(nearestQuake);
            requestRenderIfNeeded();
          }
        }
      }
    };

    const onDoubleClick = (e: MouseEvent) => {
      if (propsRef.current.viewportMode !== 'sector3d' || !terrainStream) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = terrainStream.raycastTerrain(raycaster);
      if (hit) {
        const pt = hit.point;
        _vec3.copy(camera.position).sub(controls.target);
        flyState.isSector = true;
        flyState.lookAt.set(pt.x, pt.y + 1.2, pt.z);
        flyState.camPos.set(pt.x + _vec3.x, pt.y + Math.max(8, _vec3.y), pt.z + _vec3.z);
        flyState.active = true;
        terrainStream.updateFocusLatLng(hit.lat, hit.lng);
        triggerScanSweep(pt.x, pt.y, pt.z, 210);
        preserveSectorCameraOffset = true;
        callbacksRef.current.onTerrainRelocate?.(hit.lat, hit.lng, false);
        requestRenderIfNeeded();
      }
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('dblclick', onDoubleClick);

    // Altitude-exponential wheel zoom so descending from 10,000 km down to 80 m sidewalk is silky-smooth
    const onWheel = (e: WheelEvent) => {
      if (propsRef.current.viewportMode !== 'globe') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      flyState.active = false;
      callbacksRef.current.onUserInteract?.();
      const curAlt = Math.max(0.00012, camera.position.length() - GLOBE_RADIUS);
      const factor = e.deltaY > 0 ? 1.26 : 0.78;
      const nextAlt = clamp(curAlt * factor, 0.00012, 34.0);
      camera.position.setLength(GLOBE_RADIUS + nextAlt);
      requestRenderIfNeeded();
    };
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false, capture: true });

    const onContextLost = (e: Event) => {
      e.preventDefault();
      setContextLost(true);
    };
    const onContextRestored = () => {
      setContextLost(false);
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

    const onResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      requestRenderIfNeeded();
    };
    window.addEventListener('resize', onResize);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    let frameId = 0;
    const startTime = performance.now();
    let prevTime = startTime;
    let lastAltEmitMs = 0;

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    const onVisibilityChange = () => {
      const hidden = document.visibilityState === 'hidden';
      loopPaused = hidden;
      if (!hidden && !disposed) {
        prevTime = performance.now();
        cancelAnimationFrame(frameId);
        clearTimeout(frameId);
        clearTimeout(swTimerId);
        swTimerId = 0;
        if (isSoftwareGl) {
          requestRenderIfNeeded();
        } else {
          tick();
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    let smoothedFrameMs = 16.6;
    let lastQualityEvalMs = startTime;

    function tick() {
      if (disposed || loopPaused) return;
      if (isSoftwareGl) {
        swRenderBusy = true;
        swDirty = false;
      }
      const now = performance.now();
      const rawFrameMs = now - prevTime;
      const delta = Math.min(0.1, rawFrameMs / 1000);
      const elapsed = (now - startTime) / 1000;
      prevTime = now;
      godsEyeUniforms.time.value = elapsed;

      if (!isSoftwareGl && rawFrameMs > 2 && rawFrameMs < 160 && propsRef.current.qualityPreference === 'auto') {
        smoothedFrameMs = smoothedFrameMs * 0.92 + rawFrameMs * 0.08;
        if (now - lastQualityEvalMs > 3200) {
          lastQualityEvalMs = now;
          const stepped = stepAdaptiveQualityTier(currentQualityTier, smoothedFrameMs, isSoftwareGl);
          if (stepped !== currentQualityTier) {
            applyQualityTier(stepped);
          }
        }
      }

      if (scanAnimActive) {
        const scanElapsed = (now - scanAnimStartMs) / 1000;
        const duration = 2.1;
        if (scanElapsed >= duration) {
          scanAnimActive = false;
          godsEyeUniforms.scanActive.value = 0;
        } else {
          const p = scanElapsed / duration;
          godsEyeUniforms.scanRadius.value = p * scanAnimMaxRadius;
          godsEyeUniforms.scanActive.value = Math.sin(p * Math.PI);
        }
      }

      cloudMesh.rotation.y += delta * 0.01;

      if (propsRef.current.viewportMode === 'globe') {
        const camDist = camera.position.length();
        const altitude = Math.max(0.00008, camDist - GLOBE_RADIUS);

        // Dynamic near clipping plane prevents z-fighting and ground clipping down to ~76m altitude
        const desiredNear = clamp(altitude * 0.12, 0.00002, 0.25);
        if (Math.abs(camera.near - desiredNear) > desiredNear * 0.15) {
          camera.near = desiredNear;
          camera.updateProjectionMatrix();
        }

        // Scale rotation speed with altitude so street-block panning feels natural at z=19
        controls.rotateSpeed = clamp(altitude / 14, 0.000018, 0.76);

        // Fade out clouds and atmosphere shell as user descends below cloud deck to read real-world streets
        cloudMat.opacity = clamp((camDist - 10.45) / 1.4, 0, 0.36);
        cloudMesh.visible = cloudModeEnabled && altitude > 0.12;
        atmoMesh.visible = altitude > 0.55;
        haloMesh.visible = altitude > 0.55;

        orbitalConstellation.update(elapsed, altitude, activeTexMode === 'godseye');
        globeSeismicLayer.update(elapsed, altitude);
        _vec3.copy(camera.position).normalize();
        globeWindLayer.update(delta, altitude, _vec3.x, _vec3.y, _vec3.z);
        globeReticle.group.visible = altitude > 0.006;
        if (globeReticle.group.visible) {
          globeReticle.group.scale.setScalar(clamp(altitude * 0.11, 0.00025, 0.55));
          globeReticle.update(elapsed);
        }

        // Scale event beacons, route pins & fly-along beacon proportionally with camera altitude
        const eventZoomScale = clamp(altitude / 8.5, 0.012, 0.58);
        for (let i = 0; i < eventNodes.length; i++) {
          eventNodes[i].scale.setScalar(eventZoomScale);
        }

        const pinScale = clamp(altitude * 0.007, 0.000001, 0.12);
        for (let i = 0; i < routePins.length; i++) {
          routePins[i].scale.setScalar(pinScale);
        }
        flyAlongState.marker.scale.setScalar(clamp(altitude * 0.15, 0.00018, 0.9));

        // Update curved high-resolution regional map tiles under camera view
        const subSat = cartesianToLatLng(camera.position.x, camera.position.y, camera.position.z);
        const remainingLogAlt = flyState.active ? Math.abs(Math.log(altitude) - flyState.logAlt) : 0;
        const remainingDir = flyState.active
          ? _vec3.copy(camera.position).normalize().distanceTo(flyState.dir)
          : 0;
        const isFastFlight = flyState.active && (remainingLogAlt > 0.75 || remainingDir > 0.045);
        const tileZoom = regionalTiles.updateForCamera(camDist, subSat.lat, subSat.lng, isFastFlight);

        if (now - lastAltEmitMs > 250) {
          lastAltEmitMs = now;
          callbacksRef.current.onAltitudeChange?.({
            altitudeMeters: Math.round(altitude * 637100),
            tileZoom,
            lat: subSat.lat,
            lng: subSat.lng,
          });
        }

        // Guided 3D Route Fly-Along along real-world globe streets
        if (propsRef.current.flyAlongActive && flyAlongState.curve) {
          flyAlongState.marker.visible = true;
          flyAlongState.progress += delta * 0.075;
          if (flyAlongState.progress >= 1) {
            flyAlongState.progress = 1;
            callbacksRef.current.onFlyAlongProgress(1);
            callbacksRef.current.onFlyAlongComplete();
          } else {
            if (now - flyAlongState.lastEmitMs > 300) {
              flyAlongState.lastEmitMs = now;
              callbacksRef.current.onFlyAlongProgress(flyAlongState.progress);
            }
          }

          const pt = flyAlongState.curve.getPointAt(flyAlongState.progress);
          const aheadT = Math.min(1, flyAlongState.progress + 0.015);
          const aheadPt = flyAlongState.curve.getPointAt(aheadT);

          flyAlongState.marker.position.copy(pt);
          flyAlongState.marker.lookAt(aheadPt);

          const route = propsRef.current.activeRoute;
          const spanKm = route ? haversineKm(route.origin, route.destination) : 20;
          const camAlt = clamp(spanKm / 140, 0.0009, 2.2);
          const normal = _vec3.copy(pt).normalize();
          camera.position.lerp(normal.multiplyScalar(GLOBE_RADIUS + camAlt), 0.14);
          controls.target.set(0, 0, 0);
        }
      } else if (propsRef.current.viewportMode === 'sector3d') {
        const sectorDist = camera.position.distanceTo(controls.target);
        const desiredNear = clamp(sectorDist * 0.035, 0.05, 0.25);
        if (Math.abs(camera.near - desiredNear) > desiredNear * 0.18) {
          camera.near = desiredNear;
          camera.updateProjectionMatrix();
        }
        controls.rotateSpeed = 0.72;

        if (terrainStream) {
          terrainStream.stepFrame();
          if (now - lastPanStreamMs > 320) {
            lastPanStreamMs = now;
            terrainStream.updateFocusWorldXZ(controls.target.x, controls.target.z);
          }
          const ty = terrainStream.sampleHeightAtWorldXZ(controls.target.x, controls.target.z);
          godsEyeUniforms.focusPoint.value.set(controls.target.x, ty, controls.target.z);
          keyLight.position.set(controls.target.x + 42, ty + 54, controls.target.z + 34);
          keyLight.target.position.set(controls.target.x, ty, controls.target.z);
          keyLight.target.updateMatrixWorld();
          sectorReticle.group.position.set(controls.target.x, ty + 0.16, controls.target.z);
          sectorReticle.update(elapsed);

          if (now - lastCamCoordMs > 220 && now - lastCursorHoverMs > 1800) {
            lastCamCoordMs = now;
            const ll = terrainStream.worldXZToLatLng(controls.target.x, controls.target.z);
            const rawElev = terrainStream.sampleElevationMetersAtWorldXZ(
              controls.target.x,
              controls.target.z
            );
            const groundElevM = rawElev !== null ? Math.round(rawElev) : 0;
            const cameraAltM = terrainStream.getCameraAltitudeMeters(camera.position.y, ty);
            emitLiveCoords({
              lat: ll.lat,
              lng: ll.lng,
              groundElevM,
              cameraAltM,
              source: 'camera',
            });
          }
        }
      }

      if (
        !isSoftwareGl &&
        propsRef.current.autoRotate &&
        propsRef.current.viewportMode === 'globe' &&
        !flyState.active &&
        !propsRef.current.flyAlongActive
      ) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.45;
      } else {
        controls.autoRotate = false;
      }

      if (flyState.active && !propsRef.current.flyAlongActive) {
        if (flyState.isSector) {
          const k = 5.5;
          camera.position.x = THREE.MathUtils.damp(camera.position.x, flyState.camPos.x, k, delta);
          camera.position.y = THREE.MathUtils.damp(camera.position.y, flyState.camPos.y, k, delta);
          camera.position.z = THREE.MathUtils.damp(camera.position.z, flyState.camPos.z, k, delta);

          controls.target.x = THREE.MathUtils.damp(controls.target.x, flyState.lookAt.x, k, delta);
          controls.target.y = THREE.MathUtils.damp(controls.target.y, flyState.lookAt.y, k, delta);
          controls.target.z = THREE.MathUtils.damp(controls.target.z, flyState.lookAt.z, k, delta);

          if (camera.position.distanceTo(flyState.camPos) < 0.04) {
            flyState.active = false;
          }
        } else {
          const curDist = camera.position.length();
          const curAlt = Math.max(0.0001, curDist - GLOBE_RADIUS);
          const curLogAlt = Math.log(curAlt);
          const nextLogAlt = THREE.MathUtils.damp(curLogAlt, flyState.logAlt, 9.6, delta);
          const nextDist = GLOBE_RADIUS + Math.exp(nextLogAlt);

          const tDir = 1 - Math.exp(-10.5 * delta);
          _vec3.copy(camera.position).normalize().lerp(flyState.dir, tDir).normalize();
          camera.position.copy(_vec3.multiplyScalar(nextDist));

          controls.target.x = THREE.MathUtils.damp(controls.target.x, 0, 8.5, delta);
          controls.target.y = THREE.MathUtils.damp(controls.target.y, 0, 8.5, delta);
          controls.target.z = THREE.MathUtils.damp(controls.target.z, 0, 8.5, delta);

          const dirAngle = _vec3.copy(camera.position).normalize().distanceTo(flyState.dir);
          if (Math.abs(nextLogAlt - flyState.logAlt) < 0.045 && dirAngle < 0.003) {
            camera.position.copy(flyState.dir).multiplyScalar(GLOBE_RADIUS + Math.exp(flyState.logAlt));
            flyState.active = false;
          }
        }
      }

      for (let i = 0; i < animatedBeacons.length; i++) {
        const b = animatedBeacons[i];
        const s = b.baseScale * (1 + 0.25 * Math.sin(elapsed * 3.2 + b.phase));
        b.mesh.scale.set(s, 1, s);
      }

      controls.update();
      renderer.render(scene, camera);

      if (isSoftwareGl) {
        const keepStepping =
          flyState.active ||
          scanAnimActive ||
          propsRef.current.flyAlongActive ||
          (propsRef.current.viewportMode === 'globe' && propsRef.current.windLayerEnabled) ||
          (propsRef.current.viewportMode === 'sector3d' && Boolean(terrainStream?.hasPendingWork()));
        afterDraw(() => {
          swRenderBusy = false;
          if (!disposed && !loopPaused && (swDirty || keepStepping)) {
            requestRenderIfNeeded();
          }
        });
      } else {
        frameId = requestAnimationFrame(tick);
      }
    }

    if (!loopPaused) tick();

    return () => {
      disposed = true;
      tileStreamEpoch += 1;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      clearTimeout(swTimerId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('resize', onResize);
      controls.removeEventListener('change', onControlChange);
      controls.removeEventListener('start', onControlStart);
      controls.removeEventListener('end', onControlEnd);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('dblclick', onDoubleClick);
      renderer.domElement.removeEventListener('wheel', onWheel, { capture: true });
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);

      controls.dispose();
      regionalTiles.dispose();
      globeSeismicLayer.dispose();
      globeWindLayer.dispose();
      terrainSeismicLayer.dispose();
      orbitalConstellation.dispose();
      globeReticle.dispose();
      sectorReticle.dispose();
      disposeGroupChildren(markersGroup);
      disposeGroupChildren(routeGroup);
      for (const g of sharedGeometries) g.dispose();
      for (const m of sharedMaterials) m.dispose();
      terrainStream?.dispose();
      navMarkerGeo.dispose();
      navMarkerMat.dispose();
      earthGeo.dispose();
      earthMat.map?.dispose();
      earthMat.bumpMap?.dispose();
      earthMat.roughnessMap?.dispose();
      earthMat.dispose();
      cloudGeo.dispose();
      cloudTex.dispose();
      cloudMat.dispose();
      atmoGeo.dispose();
      atmoMat.dispose();
      haloGeo.dispose();
      haloMat.dispose();
      starGeo.dispose();
      starSprite.dispose();
      starMat.dispose();
      envTarget.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      sceneHandleRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneHandleRef.current?.setTextureMode(textureMode);
  }, [textureMode]);

  useEffect(() => {
    sceneHandleRef.current?.setVerticalExaggeration(terrainExaggeration);
  }, [terrainExaggeration]);

  useEffect(() => {
    sceneHandleRef.current?.setQualityPreference(qualityPreference);
  }, [qualityPreference]);

  useEffect(() => {
    sceneHandleRef.current?.rebuildEvents(events, selectedEvent?.id ?? null);
    sceneHandleRef.current?.syncSeismicHeatmap(
      seismicHeatmapEnabled,
      seismicQuakes24h,
      seismicMetrics
    );
  }, [events, selectedEvent?.id, seismicHeatmapEnabled, seismicQuakes24h, seismicMetrics]);

  useEffect(() => {
    sceneHandleRef.current?.syncWindLayer(windLayerEnabled, windField);
  }, [windLayerEnabled, windField]);

  useEffect(() => {
    sceneHandleRef.current?.rebuildRouteArc(activeRoute);
    if (viewportMode === 'sector3d') {
      sceneHandleRef.current?.rebuildSector(activeSector, activeRoute);
    }
    sceneHandleRef.current?.requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoute]);

  useEffect(() => {
    const handle = sceneHandleRef.current;
    if (!handle) return;
    const isModeSwitch = prevViewportModeRef.current !== viewportMode;
    prevViewportModeRef.current = viewportMode;
    if (viewportMode === 'sector3d') {
      handle.rebuildSector(activeSector, activeRoute);
    }
    handle.syncViewportMode(viewportMode, activeSector, isModeSwitch);
    handle.requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportMode, activeSector.lat, activeSector.lng]);

  useEffect(() => {
    if (flyAlongActive && sceneHandleRef.current) {
      if (sceneHandleRef.current.flyAlongState.progress >= 0.99) {
        sceneHandleRef.current.resetFlyAlong();
      }
      sceneHandleRef.current.requestRender();
    }
  }, [flyAlongActive]);

  useEffect(() => {
    const handle = sceneHandleRef.current;
    if (!handle || !focusTarget || viewportMode !== 'globe') return;

    const dist = focusTarget.zoomDistance ?? 19.5;
    const alt = Math.max(0.00012, dist - GLOBE_RADIUS);
    handle.prefetchTarget(focusTarget.lat, focusTarget.lng, dist);
    handle.setReticleTarget(focusTarget.lat, focusTarget.lng);
    const c = latLngToCartesian(focusTarget.lat, focusTarget.lng, 1);
    handle.flyState.isSector = false;
    handle.flyState.dir.set(c.x, c.y, c.z).normalize();
    handle.flyState.logAlt = Math.log(alt);
    handle.flyState.lookAt.set(0, 0, 0);
    handle.flyState.active = true;
    handle.requestRender();
  }, [focusTarget, viewportMode]);

  useEffect(() => {
    const handle = sceneHandleRef.current;
    if (!handle || !zoomSignal || viewportMode === 'maps') return;
    handle.applyZoomAction(zoomSignal.action, activeSector.lat, activeSector.lng);
  }, [zoomSignal, viewportMode, activeSector.lat, activeSector.lng]);

  return (
    <div className="relative w-full h-full bg-[#06090f] overflow-hidden">
      <div
        ref={mountRef}
        className={`w-full h-full ${
          pickMode !== 'none' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
        }`}
        aria-label="Mapa 3D WebGL interactivo de Aetheria Global"
      />
      {contextLost && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#06090f]/95 z-30 p-6 text-center">
          <div className="max-w-md border border-white/10 bg-[#0d131f] rounded-xl p-6">
            <h2 className="font-display text-lg font-semibold text-white mb-2">
              Contexto WebGL pausado
            </h2>
            <p className="text-sm text-slate-300">
              El acelerador gráfico liberó la memoria de video temporalmente. Recarga o restaura la pestaña para reanudar el renderizado 3D.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
