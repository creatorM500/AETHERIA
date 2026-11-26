import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_HARD_PRUNE_MB,
  CLIENT_SOFT_PRUNE_MB,
  computePruneEvictionCount,
  estimateClientFootprintMb,
  evaluateMemoryBudget,
  getCoveringTier2Key,
  HARD_MEMORY_CEILING_MB,
  planTerrainChunkEviction,
  selectLruEvictionKeys,
  SERVER_HARD_PRUNE_MB,
  SERVER_SOFT_PRUNE_MB,
  type TerrainChunkEvictionCandidate,
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

test('planTerrainChunkEviction never evicts active Tier-2 horizon tiles or uncovered Tier-1 tiles', () => {
  assert.equal(getCoveringTier2Key(5016, 7360), '12/1254/1840');

  const chunks: TerrainChunkEvictionCandidate[] = [
    {
      key: '14/5000/7300',
      tier: 1,
      tx: 5000,
      ty: 7300,
      isCoreTile: false,
      dist2: 18,
      lastUsedMs: 10,
      desired: false,
      hasVectorMeshes: true,
    },
    {
      key: '14/5016/7360',
      tier: 1,
      tx: 5016,
      ty: 7360,
      isCoreTile: true,
      dist2: 0,
      lastUsedMs: 50,
      desired: true,
      hasVectorMeshes: true,
    },
    {
      key: '14/5019/7363',
      tier: 1,
      tx: 5019,
      ty: 7363,
      isCoreTile: false,
      dist2: 18,
      lastUsedMs: 20,
      desired: true,
      hasVectorMeshes: true,
    },
    {
      key: '14/5020/7364',
      tier: 1,
      tx: 5020,
      ty: 7364,
      isCoreTile: false,
      dist2: 20,
      lastUsedMs: 15,
      desired: true,
      hasVectorMeshes: true,
    },
    {
      key: '12/1254/1840',
      tier: 2,
      tx: 1254,
      ty: 1840,
      isCoreTile: false,
      dist2: 0,
      lastUsedMs: 30,
      desired: true,
      hasVectorMeshes: false,
    },
  ];

  // Soft prune only drops stale off-viewport tiles, never desired visible tiles
  const softPlan = planTerrainChunkEviction(chunks, 3, false);
  assert.deepEqual(softPlan.evictKeys, ['14/5000/7300']);
  assert.deepEqual(softPlan.stripVectorMeshKeys, []);

  // Critical prune strips outer vector meshes and ONLY drops outer Tier-1 covered by Tier-2 (12/1254/1840 -> covers 5019/7363, NOT 5020/7364)
  const criticalPlan = planTerrainChunkEviction(chunks, 2, true);
  assert.deepEqual(criticalPlan.evictKeys, ['14/5000/7300', '14/5019/7363']);
  assert.ok(!criticalPlan.evictKeys.includes('12/1254/1840'));
  assert.ok(!criticalPlan.evictKeys.includes('14/5016/7360'));
  assert.ok(!criticalPlan.evictKeys.includes('14/5020/7364'));
  assert.deepEqual(criticalPlan.stripVectorMeshKeys, ['14/5020/7364', '14/5019/7363']);
});

