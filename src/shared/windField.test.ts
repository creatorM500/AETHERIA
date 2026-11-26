import test from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCartesian } from './geo.ts';
import {
  buildAtmosphericBaselineWindField,
  classifyCycloneCategory,
  computeCycloneVorticityScale,
  computeWindAdvectionScale,
  computeWindFieldMetrics,
  estimateCentralPressureHpa,
  extractCycloneVorticesFromEvents,
  getEffectiveWindLegendMetrics,
  meteorologicalToUV,
  prepareCycloneVortices,
  samplePreparedCycloneAtNormal,
  sampleWindFieldAtLatLng,
  sampleWindFieldWithCyclones,
  tangentEastNorthAtNormal,
  uvToSpeedAndDirection,
  windSpeedToColorRGB,
  type CycloneSampleResult,
} from './windField.ts';
import type { GlobalEvent } from './types.ts';

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

test('extractCycloneVorticesFromEvents and sampleWindFieldWithCyclones enforce real scale, Rankine eyewall, and Coriolis direction', () => {
  const calmField = {
    minLat: -90,
    maxLat: 90,
    latStepDeg: 180,
    minLng: -180,
    lngStepDeg: 180,
    rows: 2,
    cols: 2,
    uGrid: [0, 0, 0, 0],
    vGrid: [0, 0, 0, 0],
  };

  const mockEvents: GlobalEvent[] = [
    {
      id: 'gdacs-TC-1001352',
      category: 'disaster',
      subtype: 'storm',
      title: 'Tropical Cyclone 03-20262027-27 (Activo)',
      region: 'Indian Ocean',
      lat: -9.35,
      lng: 78.29,
      severity: 'moderate',
      maxWindKmh: 90,
      radiusKm: 260,
      timestamp: '2026-11-24T06:00:00Z',
      source: 'GDACS Live Alert',
      summary: 'Active tropical cyclone',
    },
    {
      id: 'nhc-al05',
      category: 'disaster',
      subtype: 'storm',
      title: 'Hurricane Test',
      region: 'North Atlantic',
      lat: 22.0,
      lng: -68.0,
      severity: 'critical',
      maxWindKmh: 180,
      radiusKm: 360,
      timestamp: '2026-11-24T06:00:00Z',
      source: 'NOAA NHC Live',
      summary: 'Major hurricane',
    },
    {
      id: 'eq-ignored',
      category: 'disaster',
      subtype: 'earthquake',
      title: 'M5.9 Quake',
      region: 'Pacific',
      lat: 10,
      lng: 120,
      severity: 'high',
      timestamp: '2026-11-24T06:00:00Z',
      source: 'USGS',
      summary: 'Earthquake',
    },
  ];

  const specs = extractCycloneVorticesFromEvents(mockEvents);
  assert.equal(specs.length, 2);
  assert.equal(specs[0].spinSign, -1); // Southern Hemisphere = clockwise
  assert.equal(specs[1].spinSign, 1);  // Northern Hemisphere = counter-clockwise
  assert.equal(specs[0].radiusKm, 260);
  assert.equal(specs[1].radiusKm, 360);

  const prepared = prepareCycloneVortices(specs);

  // Calm eye center vs strong eyewall
  const shEye = sampleWindFieldWithCyclones(calmField, prepared, -9.35, 78.29);
  const shEyewall = sampleWindFieldWithCyclones(calmField, prepared, -9.35, 78.29 + 0.52); // ~57 km East (near coreRadiusKm)
  assert.ok(shEye.speedMs < 1.0, `Expected calm eye, got ${shEye.speedMs}`);
  assert.ok(shEyewall.speedMs > 20.0, `Expected strong eyewall wind, got ${shEyewall.speedMs}`);

  // Southern Hemisphere CW rotation: East of eye blows South (vNorth < 0) and spirals inward (uEast < 0)
  assert.ok(shEyewall.vNorthMs < -15, `Southern cyclone East edge must blow South, got vNorth=${shEyewall.vNorthMs}`);
  assert.ok(shEyewall.uEastMs < -2, `Cyclone boundary layer must converge inward, got uEast=${shEyewall.uEastMs}`);

  // Northern Hemisphere CCW rotation: East of eye blows North (vNorth > 0) and spirals inward (uEast < 0)
  const nhEyewall = sampleWindFieldWithCyclones(calmField, prepared, 22.0, -68.0 + 0.72);
  assert.ok(nhEyewall.vNorthMs > 30, `Northern cyclone East edge must blow North, got vNorth=${nhEyewall.vNorthMs}`);
  assert.ok(nhEyewall.uEastMs < -5, `Northern cyclone must converge inward, got uEast=${nhEyewall.uEastMs}`);

  // Outer influence boundary fades smoothly to 0 beyond ~1.55 * radiusKm (~403 km = ~3.65° for SH cyclone)
  const shFar = sampleWindFieldWithCyclones(calmField, prepared, -9.35, 78.29 + 4.5);
  assert.equal(shFar.speedMs, 0);

  // Legend metrics pick up the stronger cyclone peak when higher than global grid
  const baseline = buildAtmosphericBaselineWindField(1_700_000_000_000);
  const legend = getEffectiveWindLegendMetrics(baseline, specs);
  assert.equal(legend.activeCycloneCount, 2);
  assert.ok(legend.maxSpeedKmh >= 180);
  assert.equal(legend.peakPoint?.lat, 22);
});

test('dynamic cyclone vorticityScale and radius-adjusted spiral curvature reflect pressure and category', () => {
  assert.equal(classifyCycloneCategory(75), 0);
  assert.equal(classifyCycloneCategory(125), 1);
  assert.equal(classifyCycloneCategory(190), 3);
  assert.equal(classifyCycloneCategory(260), 5);
  assert.equal(classifyCycloneCategory(90, undefined, 'Hurricane Alpha Cat 4'), 4);
  assert.equal(classifyCycloneCategory(90, 2), 2);

  // Explicit pressure, text hPa hint, and Atkinson-Holliday estimation
  assert.equal(estimateCentralPressureHpa(180, 938), 938);
  assert.equal(estimateCentralPressureHpa(180, undefined, 'Central pressure 952 hPa'), 952);
  const tsPressure = estimateCentralPressureHpa(65);
  const cat4Pressure = estimateCentralPressureHpa(230);
  assert.ok(tsPressure >= 990 && tsPressure <= 1008);
  assert.ok(cat4Pressure >= 900 && cat4Pressure <= 945);
  assert.ok(cat4Pressure < tsPressure);

  const lowVort = computeCycloneVorticityScale(998, 0, 320);
  const highVort = computeCycloneVorticityScale(918, 4, 240);
  assert.ok(highVort > lowVort * 1.8, `Expected Cat4/918hPa vorticity (${highVort}) >> TS/998hPa (${lowVort})`);

  const events: GlobalEvent[] = [
    {
      id: 'storm-ts',
      category: 'disaster',
      subtype: 'storm',
      title: 'Tropical Storm Weak',
      region: 'Ocean',
      lat: 15.0,
      lng: -50.0,
      severity: 'moderate',
      maxWindKmh: 75,
      centralPressureHpa: 1001,
      cycloneCategory: 0,
      radiusKm: 320,
      timestamp: '2026-11-24T06:00:00Z',
      source: 'GDACS',
      summary: 'Weak tropical storm',
    },
    {
      id: 'storm-cat5',
      category: 'disaster',
      subtype: 'storm',
      title: 'Hurricane Apex Cat 5',
      region: 'Ocean',
      lat: 15.0,
      lng: -70.0,
      severity: 'critical',
      maxWindKmh: 265,
      centralPressureHpa: 904,
      cycloneCategory: 5,
      radiusKm: 240,
      timestamp: '2026-11-24T06:00:00Z',
      source: 'NOAA NHC',
      summary: 'Extreme Cat 5 hurricane 904 hPa',
    },
  ];

  const prepared = prepareCycloneVortices(extractCycloneVorticesFromEvents(events));
  assert.equal(prepared.length, 2);
  const [weak, strong] = prepared;
  assert.ok(strong.vorticityScale > weak.vorticityScale);

  const sampleWeak: CycloneSampleResult = {
    vx: 0,
    vy: 0,
    vz: 0,
    blendWeight: 0,
    speedMs: 0,
    vorticityScale: 0,
    spiralCurvature: 0,
  };
  const sampleStrong: CycloneSampleResult = { ...sampleWeak };

  // Sample at 45% of each storm's real radiusKm to compare radius-adjusted spiral curvature
  const weakMidPt = latLngToCartesian(weak.lat, weak.lng + (weak.radiusKm * 0.45) / 107.5, 1);
  const strongMidPt = latLngToCartesian(strong.lat, strong.lng + (strong.radiusKm * 0.45) / 107.5, 1);

  assert.equal(
    samplePreparedCycloneAtNormal(weak, weakMidPt.x, weakMidPt.y, weakMidPt.z, sampleWeak),
    true
  );
  assert.equal(
    samplePreparedCycloneAtNormal(strong, strongMidPt.x, strongMidPt.y, strongMidPt.z, sampleStrong),
    true
  );

  // Stronger, lower-pressure cyclone has higher vorticityScale, higher wind speed, and tighter circular pitch (lower radial/tangential ratio)
  assert.ok(sampleStrong.vorticityScale > sampleWeak.vorticityScale);
  assert.ok(sampleStrong.speedMs > sampleWeak.speedMs * 2);
  assert.ok(
    sampleStrong.spiralCurvature > 0.1 && sampleStrong.spiralCurvature < sampleWeak.spiralCurvature,
    `Expected tighter Cat5 spiral curvature (${sampleStrong.spiralCurvature}) < TS (${sampleWeak.spiralCurvature})`
  );

  // Outer band of same cyclone spirals inward more sharply relative to tangential flow than inner eyewall
  const strongOuterPt = latLngToCartesian(strong.lat, strong.lng + (strong.radiusKm * 1.1) / 107.5, 1);
  const sampleStrongOuter: CycloneSampleResult = { ...sampleWeak };
  assert.equal(
    samplePreparedCycloneAtNormal(
      strong,
      strongOuterPt.x,
      strongOuterPt.y,
      strongOuterPt.z,
      sampleStrongOuter
    ),
    true
  );
  assert.ok(sampleStrongOuter.spiralCurvature > sampleStrong.spiralCurvature);
});

test('computeWindAdvectionScale preserves physical speed across altitudes so closer zoom feels faster, not slower', () => {
  const closeAlt = 2.0;
  const midAlt = 11.0;
  const farAlt = 22.0;

  const sClose = computeWindAdvectionScale(closeAlt);
  const sMid = computeWindAdvectionScale(midAlt);
  const sFar = computeWindAdvectionScale(farAlt);

  // Geographic angular speed must not speed up when zooming out or slow down when zooming in
  assert.equal(sClose, sMid);
  assert.equal(sMid, sFar);

  // Apparent screen-space speed (~ scale / altitude) must be strictly faster closer up and slower farther away
  assert.ok(sClose / closeAlt > sMid / midAlt);
  assert.ok(sMid / midAlt > sFar / farAlt);
});



