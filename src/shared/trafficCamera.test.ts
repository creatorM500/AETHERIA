import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrafficCameraFeedPoint,
  findNearestRoadInNormalizedTile,
  getRoadClassMetadata,
} from './trafficCamera.ts';
import type { TerrainRoadPolyline } from './types.ts';

test('findNearestRoadInNormalizedTile snaps clicks onto closest road centerline and computes bearing', () => {
  const roads: TerrainRoadPolyline[] = [
    {
      id: 'r-primary',
      kind: 'primary',
      name: 'Paseo de la Reforma',
      widthM: 11,
      coords: [
        [0.2, 0.8],
        [0.8, 0.2],
      ],
    },
    {
      id: 'r-minor',
      kind: 'residential',
      widthM: 6,
      coords: [
        [0.1, 0.1],
        [0.9, 0.1],
      ],
    },
  ];

  // Point very close to diagonal primary road (0.5, 0.5)
  const hit = findNearestRoadInNormalizedTile(roads, 0.51, 0.49, 0.08);
  assert.ok(hit, 'Expected snap onto diagonal primary road');
  assert.equal(hit.road.id, 'r-primary');
  assert.ok(Math.abs(hit.u - 0.5) < 0.03);
  assert.ok(Math.abs(hit.v - 0.5) < 0.03);
  // Northeast direction (+x, -y in tile space) should be ~45 deg
  assert.ok(hit.bearingDeg >= 40 && hit.bearingDeg <= 50, `Expected ~45 deg, got ${hit.bearingDeg}`);

  // Far away point outside snap radius returns null
  const miss = findNearestRoadInNormalizedTile(roads, 0.9, 0.9, 0.05);
  assert.equal(miss, null);
});

test('buildTrafficCameraFeedPoint builds realistic camera metadata and reflects nearby alerts', () => {
  const motorway: TerrainRoadPolyline = {
    id: 'm1',
    kind: 'motorway',
    name: 'Autopista Central',
    ref: 'A-1',
    widthM: 14.5,
    coords: [
      [0.2, 0.5],
      [0.8, 0.5],
    ],
  };

  const meta = getRoadClassMetadata('motorway');
  assert.equal(meta.lanes, 4);

  const quietCam = buildTrafficCameraFeedPoint({
    road: motorway,
    lat: 19.4326,
    lng: -99.1332,
    elevationM: 2240,
    bearingDeg: 90,
    events: [],
    nowMs: Date.UTC(2026, 5, 21, 18, 0, 0),
  });

  assert.match(quietCam.cameraCode, /^CAM-\d{4}$/);
  assert.equal(quietCam.roadName, 'Autopista Central');
  assert.equal(quietCam.lanes, 4);
  assert.equal(quietCam.solarPhase, 'day');

  const incidentCam = buildTrafficCameraFeedPoint({
    road: motorway,
    lat: 19.4326,
    lng: -99.1332,
    elevationM: 2240,
    bearingDeg: 90,
    events: [
      {
        id: 'ev-1',
        category: 'disaster',
        subtype: 'storm',
        title: 'Tormenta eléctrica local',
        region: 'CDMX',
        severity: 'high',
        lat: 19.45,
        lng: -99.14,
        timestamp: new Date().toISOString(),
        summary: 'Lluvia intensa',
        source: 'GDACS',
      },
    ],
    nowMs: Date.UTC(2026, 5, 21, 18, 0, 0),
  });

  assert.equal(incidentCam.nearbyAlertTitle, 'Tormenta eléctrica local');
  assert.ok(incidentCam.congestionPct > quietCam.congestionPct);
  assert.ok(incidentCam.avgSpeedKmh <= quietCam.avgSpeedKmh);
});
