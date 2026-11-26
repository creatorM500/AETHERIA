import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySolarPhase,
  computeSolarElevationDeg,
  computeSubSolarPoint,
} from './solarPosition.ts';

test('computeSubSolarPoint tracks solstices, equinoxes, and UTC rotation accurately', () => {
  // June Solstice ~2026-06-21 12:00 UTC: Sun near Tropic of Cancer (+23.4°) and Prime Meridian (~0°)
  const juneSolstice = computeSubSolarPoint(Date.UTC(2026, 5, 21, 12, 0, 0));
  assert.ok(
    juneSolstice.lat > 23.0 && juneSolstice.lat < 23.6,
    `Expected June solstice lat ~23.4°, got ${juneSolstice.lat}`
  );
  assert.ok(
    Math.abs(juneSolstice.lng) < 2.0,
    `Expected solar noon near 0° lng at 12:00 UTC, got ${juneSolstice.lng}`
  );
  assert.equal(juneSolstice.utcLabel, '12:00 UTC');

  // December Solstice ~2026-12-21 12:00 UTC: Sun near Tropic of Capricorn (-23.4°)
  const decSolstice = computeSubSolarPoint(Date.UTC(2026, 11, 21, 12, 0, 0));
  assert.ok(
    decSolstice.lat < -23.0 && decSolstice.lat > -23.6,
    `Expected Dec solstice lat ~-23.4°, got ${decSolstice.lat}`
  );

  // March Equinox ~2026-03-20 14:46 UTC: Sun crosses equator (~0° lat) around -41° W
  const marchEquinox = computeSubSolarPoint(Date.UTC(2026, 2, 20, 14, 46, 0));
  assert.ok(
    Math.abs(marchEquinox.lat) < 0.6,
    `Expected equinox lat near 0°, got ${marchEquinox.lat}`
  );

  // At 00:00 UTC, solar noon is near the antimeridian (±180°)
  const midnightUtc = computeSubSolarPoint(Date.UTC(2026, 8, 22, 0, 0, 0));
  assert.ok(
    Math.abs(midnightUtc.lng) > 175,
    `Expected solar noon near ±180° at 00:00 UTC, got ${midnightUtc.lng}`
  );

  // At 18:00 UTC, solar noon is near -90° W (Americas)
  const eighteenUtc = computeSubSolarPoint(Date.UTC(2026, 8, 22, 18, 0, 0));
  assert.ok(
    eighteenUtc.lng > -95 && eighteenUtc.lng < -85,
    `Expected solar noon near -90° at 18:00 UTC, got ${eighteenUtc.lng}`
  );

  // Sun unit vector has unit length
  const mag = Math.hypot(eighteenUtc.sunDir.x, eighteenUtc.sunDir.y, eighteenUtc.sunDir.z);
  assert.ok(Math.abs(mag - 1) < 1e-6);
});

test('computeSolarElevationDeg and classifySolarPhase distinguish zenith day, terminator twilight, and midnight', () => {
  const subSolar = computeSubSolarPoint(Date.UTC(2026, 8, 22, 12, 0, 0)); // Equinox ~0° lat, ~2° E lng

  const noonElev = computeSolarElevationDeg(subSolar.lat, subSolar.lng, subSolar.sunDir);
  assert.ok(noonElev > 89.5, `Expected ~90° at sub-solar point, got ${noonElev}`);
  assert.equal(classifySolarPhase(noonElev), 'day');

  // 92° away from sub-solar point lies just past sunset inside twilight
  const twilightElev = computeSolarElevationDeg(0, subSolar.lng + 93, subSolar.sunDir);
  assert.ok(twilightElev < 0 && twilightElev > -6, `Expected twilight angle, got ${twilightElev}`);
  assert.equal(classifySolarPhase(twilightElev), 'twilight');

  // Antipode is midnight (-90° elevation)
  const antipodeLng = subSolar.lng >= 0 ? subSolar.lng - 180 : subSolar.lng + 180;
  const midnightElev = computeSolarElevationDeg(-subSolar.lat, antipodeLng, subSolar.sunDir);
  assert.ok(midnightElev < -89, `Expected ~-90° at antipode, got ${midnightElev}`);
  assert.equal(classifySolarPhase(midnightElev), 'night');
});

test('computeDayNightTransitionState smoothly interpolates Day <-> Night and staggers city lights', async () => {
  const { computeDayNightTransitionState } = await import('./solarPosition.ts');

  const start = computeDayNightTransitionState(0, true, 0.08, 1.0);
  assert.ok(start.nextProgress > 0 && start.nextProgress < 0.15);
  assert.ok(start.terminatorMix < start.nextProgress, 'Smootherstep eases in gently');
  assert.equal(start.nightLightsMix, 0, 'City lights wait until dusk deepens');
  assert.equal(start.settled, false);

  let p = 0;
  let lastMix = 0;
  for (let i = 0; i < 20; i++) {
    const step = computeDayNightTransitionState(p, true, 0.06, 0.95);
    assert.ok(step.terminatorMix >= lastMix);
    lastMix = step.terminatorMix;
    p = step.nextProgress;
  }
  const doneOn = computeDayNightTransitionState(p, true, 0.06, 0.95);
  assert.equal(doneOn.nextProgress, 1);
  assert.equal(doneOn.terminatorMix, 1);
  assert.equal(doneOn.nightLightsMix, 1);
  assert.equal(doneOn.settled, true);

  let q = 1;
  for (let i = 0; i < 20; i++) {
    q = computeDayNightTransitionState(q, false, 0.06, 0.95).nextProgress;
  }
  const doneOff = computeDayNightTransitionState(q, false, 0.06, 0.95);
  assert.equal(doneOff.nextProgress, 0);
  assert.equal(doneOff.terminatorMix, 0);
  assert.equal(doneOff.nightLightsMix, 0);
  assert.equal(doneOff.settled, true);
});

