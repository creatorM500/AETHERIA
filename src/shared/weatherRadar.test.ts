import assert from 'node:assert/strict';
import test from 'node:test';
import type { CycloneVortexSpec } from './types.ts';
import {
  buildAtmosphericBaselineRadarField,
  computeCycloneForecastCone,
  encodePrecipNorm,
  extractIsobarSegments,
  precipMmHToRGBA,
  sampleWeatherRadarAtLatLng,
  superposeCyclonesOnWeather,
} from './weatherRadar.ts';
import { buildAtmosphericBaselineWindField } from './windField.ts';

test('baseline radar field produces valid grid dimensions and barometric range', () => {
  const field = buildAtmosphericBaselineRadarField(1_760_000_000_000);
  assert.equal(field.rows, 11);
  assert.equal(field.cols, 18);
  assert.equal(field.precipGrid.length, 198);
  assert.equal(field.pressureGrid.length, 198);
  assert.equal(field.cloudGrid.length, 198);
  assert.ok(field.metrics.minPressureHpa >= 970 && field.metrics.minPressureHpa <= 1015);
  assert.ok(field.metrics.maxPressureHpa >= 1010 && field.metrics.maxPressureHpa <= 1040);
  assert.ok(field.metrics.maxPrecipMmH >= 0);
});

test('sampleWeatherRadarAtLatLng wraps cleanly across ±180 antimeridian', () => {
  const field = buildAtmosphericBaselineRadarField(1_760_000_000_000);
  const left = sampleWeatherRadarAtLatLng(field, 18, -179.9);
  const right = sampleWeatherRadarAtLatLng(field, 18, 179.9);
  assert.ok(Math.abs(left.pressureHpa - right.pressureHpa) < 1.5);
  assert.ok(Math.abs(left.precipMmH - right.precipMmH) < 1.5);
});

test('superposeCyclonesOnWeather creates deep barometric well and eyewall precipitation', () => {
  const field = buildAtmosphericBaselineRadarField(1_760_000_000_000);
  const cyclone: CycloneVortexSpec = {
    id: 'cyc-test-1',
    title: 'Huracán Alpha',
    lat: 21.5,
    lng: -79.0,
    radiusKm: 320,
    coreRadiusKm: 42,
    outerInfluenceKm: 540,
    maxWindMs: 56,
    centralPressureHpa: 948,
    cycloneCategory: 3,
    vorticityScale: 1.9,
    spinSign: 1,
  };

  const baseAtEye = sampleWeatherRadarAtLatLng(field, 21.5, -79.0);
  const atEye = superposeCyclonesOnWeather(baseAtEye, [cyclone], 21.5, -79.0);
  assert.ok(atEye.pressureHpa < 970, `Expected deep pressure < 970 hPa, got ${atEye.pressureHpa}`);

  const atEyewall = superposeCyclonesOnWeather(
    sampleWeatherRadarAtLatLng(field, 21.9, -79.0),
    [cyclone],
    21.9,
    -79.0
  );
  assert.ok(
    atEyewall.precipMmH > 20,
    `Expected intense eyewall rain > 20 mm/h, got ${atEyewall.precipMmH}`
  );
});

test('extractIsobarSegments generates closed/continuous contour segments across pressure levels', () => {
  const field = buildAtmosphericBaselineRadarField(1_760_000_000_000);
  const segs = extractIsobarSegments(field, [], [996, 1004, 1012, 1020]);
  assert.ok(segs.length > 40, `Expected > 40 isobar segments, got ${segs.length}`);
  for (const s of segs) {
    assert.ok(Number.isFinite(s.lat1) && Number.isFinite(s.lng1));
    assert.ok(Number.isFinite(s.lat2) && Number.isFinite(s.lng2));
    assert.ok(Math.abs(s.lng1 - s.lng2) < 90, 'Isobar segments must not jump across antimeridian');
  }
});

test('computeCycloneForecastCone builds 72h waypoints with expanding uncertainty radius', () => {
  const windField = buildAtmosphericBaselineWindField(1_760_000_000_000);
  const cyclone: CycloneVortexSpec = {
    id: 'cyc-caribbean',
    title: 'Ciclón Tropical Test',
    lat: 19.2,
    lng: -74.5,
    radiusKm: 300,
    coreRadiusKm: 40,
    outerInfluenceKm: 520,
    maxWindMs: 48,
    centralPressureHpa: 965,
    cycloneCategory: 2,
    vorticityScale: 1.6,
    spinSign: 1,
  };

  const cone = computeCycloneForecastCone(cyclone, windField, 72);
  assert.equal(cone.waypoints.length, 7);
  assert.equal(cone.waypoints[0].hoursAhead, 0);
  assert.equal(cone.waypoints[6].hoursAhead, 72);
  assert.ok(
    cone.waypoints[6].coneRadiusKm > cone.waypoints[0].coneRadiusKm * 3,
    'Uncertainty radius must expand monotonically over 72h'
  );
  assert.equal(cone.leftEdge.length, 7);
  assert.equal(cone.rightEdge.length, 7);
  assert.ok(cone.conePolygon.length >= 18);
});

test('precipMmHToRGBA maps dry air transparent and storm eyewall opaque vivid', () => {
  assert.equal(precipMmHToRGBA(0.05)[3], 0);
  const mod = precipMmHToRGBA(6.5);
  assert.ok(mod[3] > 100);
  const core = precipMmHToRGBA(55);
  assert.ok(core[3] > 210);
});

test('encodePrecipNorm preserves light-rain dynamic range and saturates smoothly at extreme core rates', () => {
  assert.equal(encodePrecipNorm(0), 0);
  const light = encodePrecipNorm(0.5);
  const mod = encodePrecipNorm(6);
  const heavy = encodePrecipNorm(28);
  const extreme = encodePrecipNorm(72);
  assert.ok(light > 0.08 && light < 0.25);
  assert.ok(mod > light && mod < heavy);
  assert.ok(heavy > mod && heavy < 0.92);
  assert.equal(extreme, 1);
  assert.equal(encodePrecipNorm(120), 1);
});
