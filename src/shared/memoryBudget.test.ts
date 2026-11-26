import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_HARD_PRUNE_MB,
  CLIENT_SOFT_PRUNE_MB,
  computePruneEvictionCount,
  estimateClientFootprintMb,
  evaluateMemoryBudget,
  HARD_MEMORY_CEILING_MB,
  selectLruEvictionKeys,
  SERVER_HARD_PRUNE_MB,
  SERVER_SOFT_PRUNE_MB,
} from './memoryBudget.ts';

test('evaluateMemoryBudget classifies normal, soft, and critical pressure below 500 MB ceiling', () => {
  const normal = evaluateMemoryBudget(180, SERVER_SOFT_PRUNE_MB, SERVER_HARD_PRUNE_MB);
  assert.equal(normal.pressure, 'normal');
  assert.equal(normal.pruneFraction, 0);
  assert.equal(normal.dropIdleLayers, false);
  assert.equal(normal.ceilingMb, HARD_MEMORY_CEILING_MB);
  assert.ok(normal.headroomMb > 300);

  const soft = evaluateMemoryBudget(345, SERVER_SOFT_PRUNE_MB, SERVER_HARD_PRUNE_MB);
  assert.equal(soft.pressure, 'soft');
  assert.ok(soft.pruneFraction >= 0.35 && soft.pruneFraction <= 0.7);
  assert.equal(soft.dropIdleLayers, true);

  const critical = evaluateMemoryBudget(445, CLIENT_SOFT_PRUNE_MB, CLIENT_HARD_PRUNE_MB);
  assert.equal(critical.pressure, 'critical');
  assert.equal(critical.pruneFraction, 0.85);
  assert.equal(critical.dropIdleLayers, true);
});

test('estimateClientFootprintMb reflects idle layers and active terrain/cache allocations accurately', () => {
  const leanStartupMb = estimateClientFootprintMb({
    jsHeapMb: 58,
    terrainChunks: 0,
    regionalTextures: 0,
    cachedCanvases: 1,
    windActive: false,
    radarActive: false,
    seismicActive: false,
    hasPlanetDem: true,
    baseTexturePx: 2048,
  });

  const heavyLoadedMb = estimateClientFootprintMb({
    jsHeapMb: 190,
    terrainChunks: 72,
    regionalTextures: 90,
    cachedCanvases: 14,
    windActive: true,
    radarActive: true,
    seismicActive: true,
    hasPlanetDem: true,
    baseTexturePx: 4096,
  });

  assert.ok(leanStartupMb < 160, `Expected lean startup <160 MB, got ${leanStartupMb}`);
  assert.ok(heavyLoadedMb > leanStartupMb + 200, `Expected heavy scene footprint >360 MB, got ${heavyLoadedMb}`);
});

test('computePruneEvictionCount respects pruneFraction and minKeep bounds', () => {
  assert.equal(computePruneEvictionCount(10, 0, 0), 0);
  assert.equal(computePruneEvictionCount(4, 0.5, 4), 0);
  assert.equal(computePruneEvictionCount(10, 0.5, 2), 5);
  assert.equal(computePruneEvictionCount(10, 0.9, 4), 6);
});

test('selectLruEvictionKeys evicts oldest unprotected entries first', () => {
  const entries: Array<[string, { lastUsedMs: number; core?: boolean }]> = [
    ['k1', { lastUsedMs: 100, core: true }],
    ['k2', { lastUsedMs: 150 }],
    ['k3', { lastUsedMs: 300 }],
    ['k4', { lastUsedMs: 200 }],
    ['k5', { lastUsedMs: 400 }],
  ];

  const victims = selectLruEvictionKeys(entries, 3, (_k, v) => Boolean(v.core));
  assert.deepEqual(victims, ['k2', 'k4']);
});
