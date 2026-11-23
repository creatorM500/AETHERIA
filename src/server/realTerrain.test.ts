import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSingleTileWindow,
  computeTerrainTileWindow,
  decodeTerrariumPixel,
  despikeDemTile256,
  despikeElevationGrid,
  elevationToSceneY,
  getQualitySpecForTier,
  getTileNeighborhoodCoords,
  isKnownBelowSeaBasin,
  latLngToTileWindowUV,
  sampleElevationGrid,
  sampleTileAreaFiltered,
  sceneXZToLatLng,
  stepAdaptiveQualityTier,
  uvToSceneXZ,
} from '../shared/terrainMath.ts';
import { buildChunkBuildingsFast } from '../three/fastBuildingExtruder.ts';
import {
  classifyRoadKind,
  classifyWaterKind,
  inferBuildingHeightM,
  ringSignedArea,
} from './realTerrain.ts';

test('decodeTerrariumPixel converts RGB encoding into exact elevation meters', () => {
  // Sea level (0m) = 32768 -> R=128, G=0, B=0
  assert.equal(decodeTerrariumPixel(128, 0, 0), 0);
  // 2240m (CDMX approx): 32768 + 2240 = 35008 = 136*256 + 192
  assert.equal(decodeTerrariumPixel(136, 192, 0), 2240);
  // Sub-sea level (-50m): 32718 = 127*256 + 206
  assert.equal(decodeTerrariumPixel(127, 206, 0), -50);
});

test('computeTerrainTileWindow keeps target coordinate inside the inner 50% of the 2x2 window', () => {
  const win = computeTerrainTileWindow(19.4326, -99.1332, 14, 96);
  const [u, v] = latLngToTileWindowUV(19.4326, -99.1332, win);
  assert.ok(u >= 0.25 && u <= 0.75, `expected u in [0.25, 0.75], got ${u}`);
  assert.ok(v >= 0.25 && v <= 0.75, `expected v in [0.25, 0.75], got ${v}`);
  assert.ok(win.spanMetersX > 3000 && win.spanMetersX < 6000);
});

test('uvToSceneXZ and sceneXZToLatLng round-trip geographic coordinates cleanly', () => {
  const win = computeTerrainTileWindow(19.4326, -99.1332, 14, 96);
  const [u, v] = latLngToTileWindowUV(19.4326, -99.1332, win);
  const [x, z] = uvToSceneXZ(u, v, win.sceneWidth, win.sceneDepth);
  const back = sceneXZToLatLng(x, z, win);
  assert.ok(Math.abs(back.lat - 19.4326) < 1e-4);
  assert.ok(Math.abs(back.lng - (-99.1332)) < 1e-4);

  const [wx, nz] = uvToSceneXZ(0, 0, 100, 80);
  assert.equal(wx, -50);
  assert.equal(nz, -40);
  const [ex, sz] = uvToSceneXZ(1, 1, 100, 80);
  assert.equal(ex, 50);
  assert.equal(sz, 40);
});

test('sampleElevationGrid interpolates bilinearly across DEM cells', () => {
  const grid = [
    100, 200,
    300, 500,
  ];
  assert.equal(sampleElevationGrid(grid, 2, 2, 0, 0), 100);
  assert.equal(sampleElevationGrid(grid, 2, 2, 1, 0), 200);
  assert.equal(sampleElevationGrid(grid, 2, 2, 0, 1), 300);
  assert.equal(sampleElevationGrid(grid, 2, 2, 1, 1), 500);
  assert.equal(sampleElevationGrid(grid, 2, 2, 0.5, 0.5), 275);
});

test('elevationToSceneY preserves metric vertical scaling relative to base elevation', () => {
  const y = elevationToSceneY(2340, 2240, 4800, 96, 1.5);
  // 100m * (96/4800) * 1.5 = 3.0 scene units
  assert.ok(Math.abs(y - 3.0) < 1e-6);
});

test('adaptive quality tier steps smoothly with hysteresis and locks eco on software GL', () => {
  assert.equal(stepAdaptiveQualityTier('ultra', 32, false), 'balanced');
  assert.equal(stepAdaptiveQualityTier('ultra', 18, false), 'ultra');
  assert.equal(stepAdaptiveQualityTier('balanced', 36, false), 'eco');
  assert.equal(stepAdaptiveQualityTier('balanced', 15, false), 'ultra');
  assert.equal(stepAdaptiveQualityTier('ultra', 10, true), 'eco');

  const ecoSpec = getQualitySpecForTier('ultra', true, 2);
  assert.equal(ecoSpec.tier, 'eco');
  assert.equal(ecoSpec.shadowsEnabled, false);
});

test('ringSignedArea distinguishes clockwise outer rings from counter-clockwise holes', () => {
  const outer: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const hole: Array<[number, number]> = [[0.2, 0.2], [0.2, 0.8], [0.8, 0.8], [0.8, 0.2]];
  assert.ok(ringSignedArea(outer) > 0);
  assert.ok(ringSignedArea(hole) < 0);
});

test('inferBuildingHeightM honors explicit heights, levels, and area-based fallback', () => {
  assert.equal(inferBuildingHeightM(142, 0, 1e-5, 1), 142);
  assert.equal(inferBuildingHeightM(0, 5, 1e-5, 1), 17);
  const smallH = inferBuildingHeightM(0, 0, 2e-6, 3);
  const largeH = inferBuildingHeightM(0, 0, 6e-5, 3);
  assert.ok(largeH > smallH, `expected large footprint (${largeH}m) > small footprint (${smallH}m)`);
});

test('computeSingleTileWindow and getTileNeighborhoodCoords cover globe tiles center-first with antimeridian wraparound', () => {
  const win = computeSingleTileWindow(14, 3678, 7291);
  assert.ok(win.spanMetersX > 1500 && win.spanMetersX < 3000);
  assert.ok(win.bounds.north > win.bounds.south);

  const ring = getTileNeighborhoodCoords(0, 0, 14, 1);
  // Top edge (dy = -1) is clamped out, horizontal wraps across 0 <-> 16383
  assert.equal(ring.length, 6);
  assert.equal(ring[0].tx, 0);
  assert.equal(ring[0].ty, 0);
  assert.ok(ring.some((r) => r.tx === 16383 && r.ty === 0));
});

test('buildChunkBuildingsFast extrudes houses and towers with courtyard holes and grounded sloped bases', () => {
  const result = buildChunkBuildingsFast({
    buildings: [
      {
        id: 'house-1',
        outer: [
          [0.2, 0.2],
          [0.3, 0.2],
          [0.3, 0.3],
          [0.2, 0.3],
        ],
        holes: [
          [
            [0.23, 0.23],
            [0.27, 0.23],
            [0.27, 0.27],
            [0.23, 0.27],
          ],
        ],
        heightM: 9.5,
        minHeightM: 0,
      },
      {
        id: 'tower-1',
        outer: [
          [0.5, 0.5],
          [0.6, 0.5],
          [0.6, 0.6],
          [0.5, 0.6],
        ],
        heightM: 84,
        minHeightM: 0,
      },
    ],
    elevationsM: [100, 140, 100, 140],
    rows: 2,
    cols: 2,
    minElevationM: 100,
    spanMetersX: 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
  });

  assert.equal(result.builtCount, 2);
  assert.ok(result.stdGeo && result.stdGeo.attributes.position.count > 0);
  assert.ok(result.towerGeo && result.towerGeo.attributes.position.count > 0);

  for (const geo of [result.stdGeo!, result.towerGeo!]) {
    const pos = geo.attributes.position.array as Float32Array;
    const norm = geo.attributes.normal.array as Float32Array;
    for (let i = 0; i < pos.length; i++) {
      assert.ok(Number.isFinite(pos[i]), 'vertex position should be finite');
      assert.ok(Number.isFinite(norm[i]), 'vertex normal should be finite');
    }
    geo.dispose();
  }
});

test('getTileNeighborhoodCoords radius 3 emits 49 center-first tiles for 160k+ urban coverage', () => {
  const ring = getTileNeighborhoodCoords(3678, 7291, 14, 3);
  assert.equal(ring.length, 49);
  assert.equal(ring[0].dist2, 0);
  assert.equal(ring[0].tx, 3678);
  assert.equal(ring[0].ty, 7291);
  // Outer corners have dist2 = 3^2 + 3^2 = 18
  assert.equal(ring[ring.length - 1].dist2, 18);
});

test('buildChunkBuildingsFast emits indexed Uint16/Uint32 quad & triangle footprints cleanly with includeHoles LOD', () => {
  const buildings = Array.from({ length: 4000 }, (_, i) => {
    const col = i % 64;
    const row = Math.floor(i / 64);
    const u0 = 0.02 + col * 0.014;
    const v0 = 0.02 + row * 0.014;
    const u1 = u0 + 0.01;
    const v1 = v0 + 0.01;
    // Mix CW/CCW quads, triangles, and courtyards
    const isTri = i % 9 === 0;
    return {
      id: `b-${i}`,
      outer: isTri
        ? ([[u0, v0], [u1, v0], [u0, v1]] as Array<[number, number]>)
        : i % 2 === 0
          ? ([[u0, v0], [u1, v0], [u1, v1], [u0, v1]] as Array<[number, number]>)
          : ([[u0, v0], [u0, v1], [u1, v1], [u1, v0]] as Array<[number, number]>),
      holes:
        i % 15 === 0
          ? [
              [
                [u0 + 0.002, v0 + 0.002],
                [u0 + 0.007, v0 + 0.002],
                [u0 + 0.007, v0 + 0.007],
                [u0 + 0.002, v0 + 0.007],
              ] as Array<[number, number]>,
            ]
          : undefined,
      heightM: 8 + (i % 12),
      minHeightM: 0,
    };
  });

  const withHoles = buildChunkBuildingsFast({
    buildings,
    elevationsM: [100, 110, 105, 115],
    rows: 2,
    cols: 2,
    minElevationM: 100,
    spanMetersX: 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
    includeHoles: true,
  });

  const noHoles = buildChunkBuildingsFast({
    buildings,
    elevationsM: [100, 110, 105, 115],
    rows: 2,
    cols: 2,
    minElevationM: 100,
    spanMetersX: 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
    includeHoles: false,
  });

  assert.equal(withHoles.builtCount, 4000);
  assert.equal(noHoles.builtCount, 4000);
  assert.ok(withHoles.stdGeo?.index, 'geometry should be indexed');
  assert.ok(noHoles.stdGeo?.index, 'no-holes geometry should be indexed');
  assert.ok(
    noHoles.stdGeo!.attributes.position.count < withHoles.stdGeo!.attributes.position.count,
    'omitting holes on distant Tier 1B chunks reduces vertex buffer size'
  );

  withHoles.stdGeo?.dispose();
  noHoles.stdGeo?.dispose();
});

test('despikeDemTile256 removes isolated coastal spikes, ringing, and -500m voids while preserving mountain ridges', () => {
  const tile = new Float32Array(256 * 256).fill(1.5);

  // Isolated 1px and 2x2 DSM/ringing spikes on flat coast (including border pixel x=0, y=40)
  tile[100 * 256 + 100] = 68;
  tile[120 * 256 + 120] = 46;
  tile[120 * 256 + 121] = 35;
  tile[121 * 256 + 120] = -106;
  tile[121 * 256 + 121] = 31;
  tile[40 * 256 + 0] = 52;
  // Isolated -500m void pit surrounded by flat land
  tile[160 * 256 + 160] = -500;
  tile[160 * 256 + 161] = -500;

  // Continuous sloped mountain ridge along rows 200..230
  for (let y = 195; y <= 235; y++) {
    for (let x = 30; x <= 110; x++) {
      const distFromRidge = Math.abs(y - 215);
      const ridgeH = Math.max(1.5, 180 - distFromRidge * 9);
      tile[y * 256 + x] = ridgeH;
    }
  }

  const clean = despikeDemTile256(tile, true);

  assert.ok(clean[100 * 256 + 100] < 6, `expected 1px spike flattened, got ${clean[100 * 256 + 100]}`);
  assert.ok(clean[120 * 256 + 120] < 8, `expected ringing cluster flattened, got ${clean[120 * 256 + 120]}`);
  assert.ok(clean[121 * 256 + 120] > -2, `expected negative ringing spike healed, got ${clean[121 * 256 + 120]}`);
  assert.ok(clean[40 * 256 + 0] < 6, `expected border spike flattened, got ${clean[40 * 256 + 0]}`);
  assert.ok(clean[160 * 256 + 160] > -2, `expected -500m land void healed, got ${clean[160 * 256 + 160]}`);
  assert.ok(clean[215 * 256 + 70] >= 174, `expected mountain ridge crest preserved, got ${clean[215 * 256 + 70]}`);
});

test('sampleTileAreaFiltered matches shared edges identically across adjacent tiles and suppresses sub-grid bumps', () => {
  const tileA = new Float32Array(256 * 256).fill(2);
  const tileB = new Float32Array(256 * 256).fill(2);

  // Shared edge profile: east edge of tileA (x=255) == west edge of tileB (x=0)
  for (let y = 0; y < 256; y++) {
    const edgeElev = 2 + Math.sin(y / 30) * 14;
    tileA[y * 256 + 255] = edgeElev;
    tileB[y * 256 + 0] = edgeElev;
  }
  // Sub-grid 1px bump inside tileA interior
  tileA[128 * 256 + 128] = 45;

  const gridA = sampleTileAreaFiltered(tileA, 33);
  const gridB = sampleTileAreaFiltered(tileB, 33);

  for (let r = 0; r < 33; r++) {
    assert.equal(
      gridA[r * 33 + 32],
      gridB[r * 33 + 0],
      `shared tile edge row ${r} must match seamlessly`
    );
  }
  assert.ok(gridA[16 * 33 + 16] < 6, `trimmed footprint filter should reject isolated interior bump, got ${gridA[16 * 33 + 16]}`);
});

test('despikeElevationGrid removes isolated 1-vertex cones while leaving continuous ridges intact', () => {
  const rows = 9;
  const cols = 9;
  const grid = new Array<number>(rows * cols).fill(0);
  // Isolated 1-vertex pyramid at (2, 2)
  grid[2 * cols + 2] = 42;
  // Continuous ridge at row 6, cols 4..6
  grid[6 * cols + 4] = 42;
  grid[6 * cols + 5] = 45;
  grid[6 * cols + 6] = 42;

  const cleaned = despikeElevationGrid(grid, rows, cols);
  assert.ok(cleaned[2 * cols + 2] < 5, `isolated pyramid should be suppressed, got ${cleaned[2 * cols + 2]}`);
  assert.equal(cleaned[6 * cols + 5], 45, 'continuous ridge crest must remain intact');
});

test('isKnownBelowSeaBasin distinguishes inland depressions from open ocean', () => {
  assert.equal(isKnownBelowSeaBasin(31.5, 35.5), true); // Dead Sea
  assert.equal(isKnownBelowSeaBasin(36.2, -116.8), true); // Death Valley
  assert.equal(isKnownBelowSeaBasin(21.14, -86.746), false); // Cancun coast
  assert.equal(isKnownBelowSeaBasin(19.19, -96.11), false); // Veracruz coast
});

test('classifyRoadKind maps MVT street/rail classes to width and priority', () => {
  const mw = classifyRoadKind('motorway');
  const pri = classifyRoadKind('primary');
  const sec = classifyRoadKind('secondary');
  const res = classifyRoadKind('residential');
  const rail = classifyRoadKind('rail');

  assert.equal(mw?.kind, 'motorway');
  assert.ok((mw?.widthM ?? 0) > (pri?.widthM ?? 0));
  assert.equal(pri?.kind, 'primary');
  assert.equal(sec?.kind, 'secondary');
  assert.equal(res?.kind, 'residential');
  assert.equal(rail?.kind, 'rail');
  assert.equal(classifyRoadKind('footway'), null);
});

test('classifyWaterKind classifies ocean, river, canal, stream, and lake polygons/lines', () => {
  assert.equal(classifyWaterKind('ocean', true)?.kind, 'ocean');
  assert.equal(classifyWaterKind('river', false)?.kind, 'river');
  assert.equal(classifyWaterKind('canal', false)?.kind, 'canal');
  assert.equal(classifyWaterKind('stream', false)?.kind, 'stream');
  assert.equal(classifyWaterKind('pond', true)?.kind, 'lake');
  assert.equal(classifyWaterKind('swimming_pool', true), null);
});




