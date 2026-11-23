import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDynamicHeatScale,
  HOURS_24_MS,
  normalizeQuakesForDynamicHeat,
  rasterizeEquirectangularHeatField,
  sampleDynamicHeatColor,
} from './seismicHeat.ts';
import type { SeismicQuake24h } from './types.ts';

function makeQuake(partial: Partial<SeismicQuake24h> & { id: string }): SeismicQuake24h {
  const now = 1_750_000_000_000;
  return {
    lat: 35.6,
    lng: 139.7,
    magnitude: 3.0,
    depthKm: 12,
    place: 'Test Zone',
    occurredAtMs: now - 3600_000,
    timestamp: new Date(now - 3600_000).toISOString(),
    tsunami: false,
    significance: 120,
    ...partial,
  };
}

test('computeDynamicHeatScale strictly filters events older than 24 hours', () => {
  const now = 1_750_000_000_000;
  const quakes: SeismicQuake24h[] = [
    makeQuake({ id: 'q-recent-big', magnitude: 5.8, occurredAtMs: now - 2 * 3600_000 }),
    makeQuake({ id: 'q-recent-small', magnitude: 1.6, occurredAtMs: now - 20 * 3600_000 }),
    makeQuake({ id: 'q-expired', magnitude: 7.2, occurredAtMs: now - HOURS_24_MS - 10_000 }),
  ];

  const { quakes24h, metrics } = computeDynamicHeatScale(quakes, now);
  assert.equal(quakes24h.length, 2);
  assert.equal(metrics.count24h, 2);
  assert.equal(metrics.peakQuake?.id, 'q-recent-big');
  assert.ok(metrics.maxMag >= 5.8);
  assert.ok(metrics.minMag <= 1.6);
});

test('normalizeQuakesForDynamicHeat weights higher magnitude & more recent quakes hotter', () => {
  const now = 1_750_000_000_000;
  const qHot = makeQuake({ id: 'hot', magnitude: 6.1, depthKm: 10, occurredAtMs: now - 10 * 60_000 });
  const qMid = makeQuake({ id: 'mid', magnitude: 3.4, depthKm: 15, occurredAtMs: now - 4 * 3600_000 });
  const qOld = makeQuake({ id: 'old', magnitude: 3.4, depthKm: 15, occurredAtMs: now - 22 * 3600_000 });

  const { quakes24h, metrics } = computeDynamicHeatScale([qHot, qMid, qOld], now);
  const normalized = normalizeQuakesForDynamicHeat(quakes24h, metrics, now);
  const byId = new Map(normalized.map((n) => [n.quake.id, n]));

  assert.ok(byId.get('hot')!.heatWeight01 > byId.get('mid')!.heatWeight01);
  assert.ok(byId.get('mid')!.heatWeight01 > byId.get('old')!.heatWeight01);
});

test('sampleDynamicHeatColor transitions smoothly from cool cyan to hot crimson/white', () => {
  const cool = sampleDynamicHeatColor(0.1);
  const warm = sampleDynamicHeatColor(0.8);
  const peak = sampleDynamicHeatColor(1.0);
  assert.ok(cool[2] > cool[0], 'cool end has higher blue than red');
  assert.ok(warm[0] > warm[2], 'warm end has higher red than blue');
  assert.ok(peak[0] > 0.9 && peak[1] > 0.85, 'peak hotspot is bright incandescent');
});

test('rasterizeEquirectangularHeatField accumulates swarm overlap and wraps ±180 antimeridian', () => {
  const now = 1_750_000_000_000;
  const quakes: SeismicQuake24h[] = [
    makeQuake({ id: 'fiji-west', lat: 0, lng: 179.5, magnitude: 5.2, occurredAtMs: now - 1000 }),
    makeQuake({ id: 'fiji-east', lat: 0, lng: -179.5, magnitude: 5.1, occurredAtMs: now - 1000 }),
    makeQuake({ id: 'isolated', lat: -30, lng: 0, magnitude: 2.2, occurredAtMs: now - 1000 }),
  ];

  const { quakes24h, metrics } = computeDynamicHeatScale(quakes, now);
  const pts = normalizeQuakesForDynamicHeat(quakes24h, metrics, now);
  const { field, maxRawDensity } = rasterizeEquirectangularHeatField(pts, 180, 90);

  assert.ok(maxRawDensity > 0);
  // Equatorial antimeridian row (y = 45, x = 0 and x = 179) should both show strong heat from wrap-around
  const wrapLeft = field[45 * 180 + 0];
  const wrapRight = field[45 * 180 + 179];
  const quietOcean = field[80 * 180 + 90];
  assert.ok(wrapLeft > 120, `expected strong heat at left antimeridian seam, got ${wrapLeft}`);
  assert.ok(wrapRight > 120, `expected strong heat at right antimeridian seam, got ${wrapRight}`);
  assert.equal(quietOcean, 0);
});

test('rasterizeEquirectangularHeatField places northern quakes at higher row index than southern quakes for flipY=false DataTexture', () => {
  const now = 1_750_000_000_000;
  const quakes: SeismicQuake24h[] = [
    makeQuake({ id: 'north-ca', lat: 36, lng: -120, magnitude: 5.5, occurredAtMs: now - 1000 }),
    makeQuake({ id: 'south-cl', lat: -36, lng: -72, magnitude: 5.5, occurredAtMs: now - 1000 }),
  ];

  const { quakes24h, metrics } = computeDynamicHeatScale(quakes, now);
  const pts = normalizeQuakesForDynamicHeat(quakes24h, metrics, now);
  const width = 360;
  const height = 180;
  const { field } = rasterizeEquirectangularHeatField(pts, width, height);

  const yNorth = Math.round(((36 + 90) / 180) * (height - 1));
  const xCa = Math.round(((-120 + 180) / 360) * (width - 1));
  const ySouth = Math.round(((-36 + 90) / 180) * (height - 1));
  const xCl = Math.round(((-72 + 180) / 360) * (width - 1));

  assert.ok(yNorth > ySouth, 'northern latitude maps to larger v/row index');
  assert.ok(field[yNorth * width + xCa] > 180, 'California hotspot sits in northern row');
  assert.equal(field[ySouth * width + xCa], 0, 'southern reflection of California must remain cold');
  assert.ok(field[ySouth * width + xCl] > 180, 'Chile hotspot sits in southern row');
});

test('rasterizeEquirectangularHeatField keeps isolated M6.8 hotter than dense M1.2 micro-quake swarm', () => {
  const now = 1_750_000_000_000;
  const microSwarm: SeismicQuake24h[] = Array.from({ length: 30 }, (_, i) =>
    makeQuake({
      id: `micro-${i}`,
      lat: 36.0,
      lng: -118.0,
      magnitude: 1.2,
      occurredAtMs: now - 600_000,
    })
  );
  const majorPeak = makeQuake({
    id: 'major-peak',
    lat: -7.7,
    lng: 127.5,
    magnitude: 6.8,
    occurredAtMs: now - 3600_000,
  });

  const all = [...microSwarm, majorPeak];
  const { quakes24h, metrics } = computeDynamicHeatScale(all, now);
  const pts = normalizeQuakesForDynamicHeat(quakes24h, metrics, now);
  const width = 360;
  const height = 180;
  const { field } = rasterizeEquirectangularHeatField(pts, width, height);

  const ySwarm = Math.round(((36.0 + 90) / 180) * (height - 1));
  const xSwarm = Math.round(((-118.0 + 180) / 360) * (width - 1));
  const yMajor = Math.round(((-7.7 + 90) / 180) * (height - 1));
  const xMajor = Math.round(((127.5 + 180) / 360) * (width - 1));

  const swarmVal = field[ySwarm * width + xSwarm];
  const majorVal = field[yMajor * width + xMajor];
  assert.ok(majorVal >= 240, `expected M6.8 peak near 255, got ${majorVal}`);
  assert.ok(majorVal > swarmVal + 40, `expected major M6.8 (${majorVal}) hotter than M1.2 swarm (${swarmVal})`);
});
