import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBearingDeg,
  cartesianToLatLng,
  decodeEncodedPolyline,
  haversineKm,
  interpolateGreatCircle,
  latLngToCartesian,
  latToTileY,
  lngToTileX,
  routeSpanToGlobeDistance,
  sampleTerrainElevation,
  tileXToLng,
  tileYToLat,
} from './geo.ts';

test('latLngToCartesian and cartesianToLatLng round-trip accurately', () => {
  const samples = [
    { lat: 19.4326, lng: -99.1332 },
    { lat: 35.6762, lng: 139.6503 },
    { lat: -33.8688, lng: 151.2093 },
    { lat: 51.5074, lng: -0.1278 },
  ];

  for (const s of samples) {
    const vec = latLngToCartesian(s.lat, s.lng, 10);
    const back = cartesianToLatLng(vec.x, vec.y, vec.z);
    assert.ok(Math.abs(back.lat - s.lat) < 1e-6, `lat mismatch for ${s.lat}`);
    assert.ok(Math.abs(back.lng - s.lng) < 1e-6, `lng mismatch for ${s.lng}`);
  }
});

test('haversineKm computes realistic distance between Mexico City and Madrid', () => {
  const cdmx = { lat: 19.4326, lng: -99.1332 };
  const madrid = { lat: 40.4168, lng: -3.7038 };
  const km = haversineKm(cdmx, madrid);
  assert.ok(km > 9000 && km < 9200, `Expected ~9070 km, got ${km}`);
});

test('interpolateGreatCircle returns endpoints and expected point count', () => {
  const arc = interpolateGreatCircle(
    { lat: 40.7128, lng: -74.006 },
    { lat: 51.5074, lng: -0.1278 },
    16
  );
  assert.equal(arc.length, 17);
  assert.ok(Math.abs(arc[0].lat - 40.7128) < 1e-3);
  assert.ok(Math.abs(arc[16].lat - 51.5074) < 1e-3);
});

test('calculateBearingDeg computes cardinal directions properly', () => {
  const north = calculateBearingDeg({ lat: 0, lng: 0 }, { lat: 10, lng: 0 });
  const east = calculateBearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: 10 });
  assert.ok(Math.abs(north - 0) < 1e-2 || Math.abs(north - 360) < 1e-2);
  assert.ok(Math.abs(east - 90) < 1);
});

test('decodeEncodedPolyline decodes standard Google polyline strings', () => {
  // Official Google sample polyline: _p~iF~ps|U_ulLnnqC_mqNvxq`@
  const pts = decodeEncodedPolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(pts.length, 3);
  assert.ok(Math.abs(pts[0].lat - 38.5) < 1e-4);
  assert.ok(Math.abs(pts[0].lng - -120.2) < 1e-4);
  assert.ok(Math.abs(pts[2].lat - 43.252) < 1e-4);
});

test('sampleTerrainElevation is deterministic and bounded above -0.4', () => {
  const h1 = sampleTerrainElevation(18, -22, 19.43, -99.13, 1.0);
  const h2 = sampleTerrainElevation(18, -22, 19.43, -99.13, 1.0);
  assert.equal(h1, h2);
  assert.ok(h1 >= -0.4);
});

test('Web Mercator tile conversions round-trip accurately', () => {
  const zoom = 12;
  const lat = 19.4326;
  const lng = -99.1332;
  const tx = lngToTileX(lng, zoom);
  const ty = latToTileY(lat, zoom);
  const backLng = tileXToLng(tx, zoom);
  const backLat = tileYToLat(ty, zoom);
  assert.ok(Math.abs(backLng - lng) < 1e-6);
  assert.ok(Math.abs(backLat - lat) < 1e-6);
});

test('routeSpanToGlobeDistance scales zoom altitude smoothly with distance', () => {
  const shortDist = routeSpanToGlobeDistance(
    { lat: 19.4326, lng: -99.1332 },
    { lat: 19.42, lng: -99.16 }
  );
  const longDist = routeSpanToGlobeDistance(
    { lat: 19.4326, lng: -99.1332 },
    { lat: 40.4168, lng: -3.7038 }
  );
  assert.ok(shortDist < 10.5);
  assert.ok(longDist >= 18);
});
