import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCartesian } from './geo.ts';
import {
  buildAtmosphericBaselineWindField,
  computeWindFieldMetrics,
  meteorologicalToUV,
  sampleWindFieldAtLatLng,
  tangentEastNorthAtNormal,
  uvToSpeedAndDirection,
  windSpeedToColorRGB,
} from './windField.ts';

test('meteorologicalToUV converts wind-from degrees into East/North components', () => {
  const fromNorth = meteorologicalToUV(10, 0);
  assert.ok(Math.abs(fromNorth.uEastMs) < 1e-6);
  assert.ok(Math.abs(fromNorth.vNorthMs - -10) < 1e-6);

  const fromWest = meteorologicalToUV(12, 270);
  assert.ok(Math.abs(fromWest.uEastMs - 12) < 1e-6);
  assert.ok(Math.abs(fromWest.vNorthMs) < 1e-6);

  const fromEast = meteorologicalToUV(8, 90);
  assert.ok(Math.abs(fromEast.uEastMs - -8) < 1e-6);
  assert.ok(Math.abs(fromEast.vNorthMs) < 1e-6);

  const roundTrip = uvToSpeedAndDirection(fromWest.uEastMs, fromWest.vNorthMs);
  assert.ok(Math.abs(roundTrip.speedMs - 12) < 1e-6);
  assert.ok(Math.abs(roundTrip.directionFromDeg - 270) < 1e-6);
  assert.ok(Math.abs(roundTrip.bearingToDeg - 90) < 1e-6);
});

test('tangentEastNorthAtNormal matches finite-difference derivatives of latLngToCartesian', () => {
  const testCoords = [
    { lat: 0, lng: 0 },
    { lat: 25, lng: -99 },
    { lat: -38, lng: 145 },
    { lat: 55, lng: 179 },
  ];

  for (const { lat, lng } of testCoords) {
    const p = latLngToCartesian(lat, lng, 1);
    const pEast = latLngToCartesian(lat, lng + 0.05, 1);
    const pNorth = latLngToCartesian(lat + 0.05, lng, 1);

    const basis = tangentEastNorthAtNormal(p.x, p.y, p.z);

    // Dot product with finite difference along +lng must be strongly positive
    const dEx = pEast.x - p.x;
    const dEy = pEast.y - p.y;
    const dEz = pEast.z - p.z;
    const dELen = Math.hypot(dEx, dEy, dEz);
    const eastAlignment = (basis.ex * dEx + basis.ey * dEy + basis.ez * dEz) / dELen;
    assert.ok(eastAlignment > 0.999, `East tangent alignment failed at (${lat},${lng}): ${eastAlignment}`);

    // Dot product with finite difference along +lat must be strongly positive
    const dNx = pNorth.x - p.x;
    const dNy = pNorth.y - p.y;
    const dNz = pNorth.z - p.z;
    const dNLen = Math.hypot(dNx, dNy, dNz);
    const northAlignment = (basis.northX * dNx + basis.northY * dNy + basis.northZ * dNz) / dNLen;
    assert.ok(northAlignment > 0.999, `North tangent alignment failed at (${lat},${lng}): ${northAlignment}`);

    // East and North must be orthogonal to radial normal and each other
    const dotEN = basis.ex * basis.northX + basis.ey * basis.northY + basis.ez * basis.northZ;
    assert.ok(Math.abs(dotEN) < 1e-6);
  }
});

test('sampleWindFieldAtLatLng interpolates bilinearly and wraps seamlessly across antimeridian', () => {
  const field = {
    minLat: -15,
    maxLat: 15,
    latStepDeg: 30,
    minLng: -180,
    lngStepDeg: 180,
    rows: 2,
    cols: 2,
    // col0 = -180°, col1 = 0°
    uGrid: [10, 20, 10, 20],
    vGrid: [-4, 4, 4, -4],
  };

  // Exactly at (-15, -180)
  const s00 = sampleWindFieldAtLatLng(field, -15, -180);
  assert.ok(Math.abs(s00.uEastMs - 10) < 1e-6);
  assert.ok(Math.abs(s00.vNorthMs - -4) < 1e-6);

  // Midpoint between 0° and +180° (wrapping across antimeridian to -180°)
  const sWrap = sampleWindFieldAtLatLng(field, -15, 90);
  assert.ok(Math.abs(sWrap.uEastMs - 15) < 1e-6);
  assert.ok(Math.abs(sWrap.vNorthMs - 0) < 1e-6);

  // Continuous across +179.9° -> -179.9°
  const sPos = sampleWindFieldAtLatLng(field, 0, 179.9);
  const sNeg = sampleWindFieldAtLatLng(field, 0, -179.9);
  assert.ok(Math.abs(sPos.uEastMs - sNeg.uEastMs) < 0.05);
  assert.ok(Math.abs(sPos.vNorthMs - sNeg.vNorthMs) < 0.05);
});

test('windSpeedToColorRGB and baseline generator produce valid finite metrics', () => {
  const calm = windSpeedToColorRGB(1);
  const gale = windSpeedToColorRGB(26);
  assert.ok(calm.every((c) => c >= 0 && c <= 1));
  assert.ok(gale.every((c) => c >= 0 && c <= 1));
  // Higher wind speed shifts from cool cyan/blue toward warm orange/white (higher red channel)
  assert.ok(gale[0] > calm[0]);

  const baseline = buildAtmosphericBaselineWindField(1_700_000_000_000);
  assert.equal(baseline.rows * baseline.cols, baseline.uGrid.length);
  assert.equal(baseline.metrics.sampleCount, baseline.rows * baseline.cols);
  assert.ok(baseline.metrics.maxSpeedKmh >= baseline.metrics.avgSpeedKmh);
  assert.ok(baseline.metrics.avgSpeedKmh >= baseline.metrics.minSpeedKmh);
  assert.ok(baseline.metrics.peakPoint !== null);

  const metricsCheck = computeWindFieldMetrics(
    baseline.minLat,
    baseline.latStepDeg,
    baseline.minLng,
    baseline.lngStepDeg,
    baseline.rows,
    baseline.cols,
    baseline.uGrid,
    baseline.vGrid
  );
  assert.equal(metricsCheck.maxSpeedKmh, baseline.metrics.maxSpeedKmh);
});
