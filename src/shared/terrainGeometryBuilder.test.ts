import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinateQuery } from './geo.ts';
import {
  buildAllChunkGeometriesRaw,
  buildChunkBuildingsRaw,
  buildChunkRoadsRaw,
  buildChunkWaterRaw,
} from './terrainGeometryBuilder.ts';
import type { TerrainChunkPayload } from './types.ts';

function assertValidRawBuffers(
  buf: {
    pos: Float32Array;
    norm: Float32Array;
    col: Float32Array;
    uv?: Float32Array;
    index: Uint16Array | Uint32Array;
    vertexCount: number;
    indexCount: number;
  } | null,
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
  // Verify pitched roofs produce sloped roof normals (ny between 0.1 and 0.99)
  let hasSlopedNormal = false;
  const n = res.stdGeo!.norm;
  for (let i = 0; i < n.length; i += 3) {
    if (n[i + 1] > 0.1 && n[i + 1] < 0.98) {
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
