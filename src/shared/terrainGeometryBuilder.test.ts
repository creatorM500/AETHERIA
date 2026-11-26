import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinateQuery } from './geo.ts';
import {
  buildAllChunkGeometriesRaw,
  buildChunkBuildingsRaw,
  buildChunkRoadsRaw,
  buildChunkWaterRaw,
  estimateRawBuffersByteLength,
  type RawIndexedBuffers,
} from './terrainGeometryBuilder.ts';
import { carveCoastalWaterElevations } from './terrainMath.ts';
import type { TerrainChunkPayload } from './types.ts';

function assertValidRawBuffers(
  buf: RawIndexedBuffers | null,
  label: string
) {
  assert.ok(buf, `${label} should be non-null`);
  assert.ok(buf.vertexCount > 0, `${label} must emit vertices`);
  assert.ok(buf.indexCount > 0 && buf.indexCount % 3 === 0, `${label} must emit valid triangles`);

  for (let i = 0; i < buf.pos.length; i++) {
    assert.ok(Number.isFinite(buf.pos[i]), `${label} pos[${i}] must be finite`);
    assert.ok(Number.isFinite(buf.norm[i]), `${label} norm[${i}] must be finite`);
    assert.ok(Number.isFinite(buf.col[i]), `${label} col[${i}] must be finite`);
  }
  for (let i = 0; i < buf.indexCount; i++) {
    assert.ok(buf.index[i] < buf.vertexCount, `${label} index[${i}] out of bounds`);
  }
}

test('parseCoordinateQuery parses signed, space-separated, and directional coordinates safely', () => {
  assert.deepEqual(parseCoordinateQuery('19.4326, -99.1332'), { lat: 19.4326, lng: -99.1332 });
  assert.deepEqual(parseCoordinateQuery('35.6762 139.6503'), { lat: 35.6762, lng: 139.6503 });
  assert.deepEqual(parseCoordinateQuery('33.8688° S, 151.2093° E'), {
    lat: -33.8688,
    lng: 151.2093,
  });
  assert.equal(parseCoordinateQuery('Tokio Shibuya'), null);
  assert.equal(parseCoordinateQuery('92.5, 10.0'), null);
  assert.equal(parseCoordinateQuery('10.0, 195.0'), null);
});

test('buildChunkBuildingsRaw generates pitched gable/hipped roofs on small homes and multi-tier setbacks on towers', () => {
  const smallHomes = Array.from({ length: 8 }, (_, idx) => ({
    id: `home-${idx}`,
    outer: [
      [0.1 + idx * 0.08, 0.2],
      [0.14 + idx * 0.08, 0.2],
      [0.14 + idx * 0.08, 0.25],
      [0.1 + idx * 0.08, 0.25],
    ] as Array<[number, number]>,
    heightM: 8.5,
    minHeightM: 0,
  }));

  const tallTower = {
    id: 'supertall-1',
    outer: [
      [0.5, 0.6],
      [0.62, 0.6],
      [0.62, 0.72],
      [0.5, 0.72],
    ] as Array<[number, number]>,
    heightM: 120,
    minHeightM: 0,
  };

  const res = buildChunkBuildingsRaw({
    buildings: [...smallHomes, tallTower],
    elevationsM: [10, 10, 10, 10],
    rows: 2,
    cols: 2,
    minElevationM: 10,
    baseElevationM: 10,
    spanMetersX: 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
    metersToSceneY: 48 / 2400,
    seedOffset: 7,
    includeHoles: true,
  });

  assert.equal(res.builtCount, 9);
  assertValidRawBuffers(res.stdGeo, 'stdGeo');
  assertValidRawBuffers(res.towerGeo, 'towerGeo');

  // Verify tall tower with >= 70m emits multi-tier setback + crown (more than a plain 8-vert box)
  assert.ok(
    res.towerGeo!.vertexCount > 36,
    `expected multi-tier tower setbacks (>36 verts), got ${res.towerGeo!.vertexCount}`
  );
  // Verify compact attribute storage (Int8Array normals + Uint8Array colors) cuts vertex bloat by 50%
  assert.ok(res.stdGeo!.norm instanceof Int8Array, 'stdGeo.norm must be compact Int8Array');
  assert.ok(res.stdGeo!.col instanceof Uint8Array, 'stdGeo.col must be compact Uint8Array');
  assert.ok(res.towerGeo!.norm instanceof Int8Array, 'towerGeo.norm must be compact Int8Array');
  assert.ok(res.towerGeo!.col instanceof Uint8Array, 'towerGeo.col must be compact Uint8Array');

  const stdBytes = estimateRawBuffersByteLength(res.stdGeo);
  const legacyFloatBytes = res.stdGeo!.vertexCount * 36 + res.stdGeo!.indexCount * 2;
  assert.ok(
    stdBytes <= legacyFloatBytes * 0.6,
    `expected compact byte size (${stdBytes}) <= 60% of legacy Float32 size (${legacyFloatBytes})`
  );

  // Verify pitched roofs produce sloped roof normals (ny between 0.1 and 0.99 in normalized Int8 space)
  let hasSlopedNormal = false;
  const n = res.stdGeo!.norm;
  for (let i = 0; i < n.length; i += 3) {
    const ny = n[i + 1] / 127;
    if (ny > 0.1 && ny < 0.98) {
      hasSlopedNormal = true;
      break;
    }
  }
  assert.ok(hasSlopedNormal, 'expected pitched residential roof normals in stdGeo');
});

test('buildChunkRoadsRaw drapes vector road ribbons onto terrain elevations with valid UVs', () => {
  const roadsGeo = buildChunkRoadsRaw({
    roads: [
      {
        id: 'road-mw',
        kind: 'motorway',
        widthM: 16,
        coords: [
          [0.05, 0.5],
          [0.5, 0.52],
          [0.95, 0.48],
        ],
      },
      {
        id: 'road-res',
        kind: 'residential',
        widthM: 6,
        coords: [
          [0.2, 0.1],
          [0.2, 0.9],
        ],
      },
    ],
    elevationsM: [
      0, 20, 40,
      5, 25, 45,
      10, 30, 50,
    ],
    rows: 3,
    cols: 3,
    baseElevationM: 0,
    metersToSceneY: 48 / 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
  });

  assertValidRawBuffers(roadsGeo, 'roadsGeo');
  assert.ok(roadsGeo!.uv && roadsGeo!.uv.length === roadsGeo!.vertexCount * 2);
});

test('buildChunkWaterRaw generates coastal sea surface below 0.35m, skips high inland terrain, and builds rivers/lakes', () => {
  // 1. Coastal tile reaching <= 0.35m
  const coastalWater = buildChunkWaterRaw({
    waterFeatures: [
      {
        id: 'canal-1',
        kind: 'canal',
        isPolygon: false,
        widthM: 22,
        rings: [
          [
            [0.2, 0.2],
            [0.8, 0.8],
          ],
        ],
      },
      {
        id: 'lagoon-1',
        kind: 'lake',
        isPolygon: true,
        rings: [
          [
            [0.55, 0.55],
            [0.75, 0.55],
            [0.75, 0.75],
            [0.55, 0.75],
          ],
        ],
      },
    ],
    elevationsM: [
      -2, -1, 12,
      -1, 0.1, 18,
      8, 15, 25,
    ],
    rows: 3,
    cols: 3,
    minElevationM: -2,
    baseElevationM: -2,
    metersToSceneY: 48 / 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
    isCoastalTile: true,
  });

  assertValidRawBuffers(coastalWater, 'coastalWater');

  // 2. High inland tile with zero water features must return null (no accidental flooding)
  const dryMountain = buildChunkWaterRaw({
    waterFeatures: [],
    elevationsM: [2240, 2260, 2250, 2290],
    rows: 2,
    cols: 2,
    minElevationM: 2240,
    baseElevationM: 2240,
    metersToSceneY: 48 / 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
    isCoastalTile: true,
  });
  assert.equal(dryMountain, null);
});

test('buildAllChunkGeometriesRaw combines buildings, roads, and water cleanly for worker pipeline', () => {
  const payload: TerrainChunkPayload = {
    zoom: 14,
    tx: 4820,
    ty: 6155,
    bounds: { north: 40.72, south: 40.70, east: -73.99, west: -74.01 },
    spanMetersX: 2400,
    spanMetersZ: 2400,
    rows: 3,
    cols: 3,
    elevationsM: [
      0, 3, 12,
      0, 4, 15,
      0, 5, 18,
    ],
    minElevationM: 0,
    maxElevationM: 18,
    buildings: [
      {
        id: 'b-tower',
        outer: [
          [0.45, 0.45],
          [0.55, 0.45],
          [0.55, 0.55],
          [0.45, 0.55],
        ],
        heightM: 92,
        minHeightM: 0,
      },
    ],
    roads: [
      {
        id: 'r-1',
        kind: 'primary',
        widthM: 10,
        coords: [
          [0.1, 0.5],
          [0.9, 0.5],
        ],
      },
    ],
    waterFeatures: [
      {
        id: 'w-river',
        kind: 'river',
        isPolygon: false,
        widthM: 24,
        rings: [
          [
            [0.15, 0.1],
            [0.15, 0.9],
          ],
        ],
      },
    ],
    demSource: 'terrarium-dem',
    buildingsSource: 'versatiles-osm',
  };

  const out = buildAllChunkGeometriesRaw({
    payload,
    baseElevationM: 0,
    metersToSceneY: 48 / 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
    seedOffset: 42,
    includeHoles: true,
    includeRoadsAndWater: true,
  });

  assert.equal(out.builtCount, 1);
  assertValidRawBuffers(out.towerGeo, 'combined.towerGeo');
  assertValidRawBuffers(out.roadsGeo, 'combined.roadsGeo');
  assertValidRawBuffers(out.waterGeo, 'combined.waterGeo');
});

test('buildChunkWaterRaw deduplicates overlapping MVT ocean/bay polygons and keeps offshore depth uniform', () => {
  const flatOceanElev = new Array<number>(5 * 5).fill(0);
  const coastalDemFallback = buildChunkWaterRaw({
    waterFeatures: [],
    elevationsM: flatOceanElev,
    rows: 5,
    cols: 5,
    minElevationM: 0,
    baseElevationM: -5,
    metersToSceneY: 48 / 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
    isCoastalTile: true,
  });
  const mvtOceanOnly = buildChunkWaterRaw({
    waterFeatures: [
      {
        id: 'ocean-1',
        kind: 'ocean',
        isPolygon: true,
        rings: [[[0, 0], [1, 0], [1, 1], [0, 1]]],
      },
    ],
    elevationsM: flatOceanElev,
    rows: 5,
    cols: 5,
    minElevationM: 0,
    baseElevationM: -5,
    metersToSceneY: 48 / 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
    isCoastalTile: true,
  });
  const withRedundantBay = buildChunkWaterRaw({
    waterFeatures: [
      {
        id: 'ocean-1',
        kind: 'ocean',
        isPolygon: true,
        rings: [[[0, 0], [1, 0], [1, 1], [0, 1]]],
      },
      {
        id: 'bay-1',
        kind: 'river',
        isPolygon: true,
        rings: [[[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]],
      },
    ],
    elevationsM: flatOceanElev,
    rows: 5,
    cols: 5,
    minElevationM: 0,
    baseElevationM: -5,
    metersToSceneY: 48 / 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
    isCoastalTile: true,
  });

  assertValidRawBuffers(coastalDemFallback, 'coastalDemFallback');
  assertValidRawBuffers(mvtOceanOnly, 'mvtOceanOnly');
  assertValidRawBuffers(withRedundantBay, 'withRedundantBay');
  // Overlapping tidal bay/river polygons inside MVT ocean must NOT stack duplicate coplanar triangles
  assert.equal(withRedundantBay!.indexCount, mvtOceanOnly!.indexCount);
  // Open 0m ocean far from land must stay deep navy (>= 0.8), not shallow cyan (~0.11)
  assert.ok(coastalDemFallback!.col[0] >= 0.8, `expected deep ocean depth >= 0.8, got ${coastalDemFallback!.col[0]}`);
  assert.ok(mvtOceanOnly!.col[0] >= 0.8, `expected MVT ocean depth >= 0.8, got ${mvtOceanOnly!.col[0]}`);
});

test('buildAllChunkGeometriesRaw builds Tier-2 coastal ocean water when includeWater is enabled', () => {
  const tier2Payload: TerrainChunkPayload = {
    zoom: 12,
    tx: 1110,
    ty: 1777,
    bounds: { north: 23.2, south: 23.1, east: -82.3, west: -82.4 },
    spanMetersX: 9600,
    spanMetersZ: 9600,
    rows: 4,
    cols: 4,
    elevationsM: new Array<number>(16).fill(0),
    minElevationM: 0,
    maxElevationM: 0,
    buildings: [],
    roads: [],
    waterFeatures: [],
    demSource: 'terrarium-dem',
    buildingsSource: 'none',
  };

  const out = buildAllChunkGeometriesRaw({
    payload: tier2Payload,
    baseElevationM: -5,
    metersToSceneY: 48 / 2400,
    chunkWidth: 192,
    chunkDepth: 192,
    verticalExaggeration: 1.5,
    seedOffset: 1,
    includeHoles: false,
    includeRoadsAndWater: false,
    includeWater: true,
  });

  assert.equal(out.stdGeo, null);
  assert.equal(out.towerGeo, null);
  assert.equal(out.roadsGeo, null);
  assertValidRawBuffers(out.waterGeo, 'tier2.waterGeo');
});

test('carveCoastalWaterElevations depresses smeared harbor channel DEM while preserving high cliffs and land', () => {
  // 5x5 grid with a narrow +2.2m/+16.5m smeared channel down the middle column (u=0.5) and +45m sea cliff at (row=0, col=2)
  const elev = [
    22, 34, 45, 34, 22,
    10, 4, 16.5, 4, 10,
    9, 3, 1.8, 3, 9,
    9, 3, 2.4, 3, 9,
    10, 5, 2.0, 5, 10,
  ];
  const harborPoly = {
    id: 'harbor-channel',
    kind: 'ocean' as const,
    isPolygon: true,
    rings: [
      [
        [0.42, -0.02],
        [0.58, -0.02],
        [0.58, 1.02],
        [0.42, 1.02],
      ] as Array<[number, number]>,
    ],
  };

  const carved = carveCoastalWaterElevations(elev, 5, 5, [harborPoly]);
  // +45m cliff stays untouched (> 32m maxCarveElevM)
  assert.equal(carved[0 * 5 + 2], 45);
  // Interior high land untouched; low 1-ring quay wall softened below raw +4m
  assert.equal(carved[2 * 5 + 0], 9);
  assert.ok(carved[2 * 5 + 1] <= 2.0 && carved[2 * 5 + 1] >= 1.2);
  // Smeared channel vertices inside the harbor polygon (including +16.5m DSM smear) are carved to -4.5m
  assert.equal(carved[1 * 5 + 2], -4.5);
  assert.equal(carved[2 * 5 + 2], -4.5);
  assert.equal(carved[3 * 5 + 2], -4.5);
  assert.equal(carved[4 * 5 + 2], -4.5);
});

test('buildChunkWaterRaw clips buffered MVT ocean harbor polygons strictly inside chunk bounds and deduplicates inner docks', () => {
  const elev = new Array<number>(5 * 5).fill(3.0);
  // Depress center channel below sea level
  for (let r = 0; r < 5; r++) elev[r * 5 + 2] = -2.2;

  const water = buildChunkWaterRaw({
    waterFeatures: [
      {
        id: 'harbor-ocean',
        kind: 'ocean',
        isPolygon: true,
        rings: [
          [
            [0.35, -0.05],
            [0.65, -0.05],
            [0.65, 1.05],
            [0.35, 1.05],
          ],
        ],
      },
      {
        id: 'inner-dock-dup',
        kind: 'lake',
        isPolygon: true,
        rings: [
          [
            [0.44, 0.3],
            [0.56, 0.3],
            [0.56, 0.5],
            [0.44, 0.5],
          ],
        ],
      },
    ],
    elevationsM: elev,
    rows: 5,
    cols: 5,
    minElevationM: -2.2,
    baseElevationM: -2.2,
    metersToSceneY: 48 / 2400,
    chunkWidth: 48,
    chunkDepth: 48,
    verticalExaggeration: 1.5,
    isCoastalTile: true,
  });

  assertValidRawBuffers(water, 'harborWater');
  // Every emitted vertex must stay strictly within [-chunkWidth/2..+chunkWidth/2] after unit-square clipping
  for (let i = 0; i < water!.vertexCount; i++) {
    const x = water!.pos[i * 3];
    const z = water!.pos[i * 3 + 2];
    assert.ok(x >= -24.0001 && x <= 24.0001, `x=${x} out of chunk bounds`);
    assert.ok(z >= -24.0001 && z <= 24.0001, `z=${z} out of chunk bounds`);
  }
});
