import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDisasterSubtype,
  sanitizeHistoryLimit,
  sanitizeHistoryStatus,
  sanitizeHistorySubtype,
} from './disasterHistory.ts';
import { MCP_TOOLS, handleMcpRequest } from './mcpServer.ts';
import { toIsoTimestampOrFallback } from './worldFeed.ts';

test('normalizeDisasterSubtype maps all 6 natural disaster categories accurately', () => {
  assert.equal(normalizeDisasterSubtype('earthquake'), 'earthquake');
  assert.equal(normalizeDisasterSubtype('EQ'), 'earthquake');
  assert.equal(normalizeDisasterSubtype('severeStorms'), 'storm');
  assert.equal(normalizeDisasterSubtype('TC'), 'storm');
  assert.equal(normalizeDisasterSubtype('wildfires'), 'wildfire');
  assert.equal(normalizeDisasterSubtype('WF'), 'wildfire');
  assert.equal(normalizeDisasterSubtype('floods'), 'flood');
  assert.equal(normalizeDisasterSubtype('FL'), 'flood');
  assert.equal(normalizeDisasterSubtype('volcanoes'), 'volcano');
  assert.equal(normalizeDisasterSubtype('VO'), 'volcano');
  assert.equal(normalizeDisasterSubtype('seaLakeIce'), 'iceberg');
  assert.equal(normalizeDisasterSubtype('iceberg'), 'iceberg');
});

test('history query sanitizers reject path traversal, NaN limits, and invalid enums', () => {
  assert.equal(sanitizeHistoryLimit('abc', 100), 100);
  assert.equal(sanitizeHistoryLimit(Number.NaN, 50), 50);
  assert.equal(sanitizeHistoryLimit(-5), 1);
  assert.equal(sanitizeHistoryLimit(999), 250);
  assert.equal(sanitizeHistoryLimit(undefined, 75), 75);

  assert.equal(sanitizeHistorySubtype('../etc/passwd'), 'all');
  assert.equal(sanitizeHistorySubtype('EQ'), 'all');
  assert.equal(sanitizeHistorySubtype('earthquake'), 'earthquake');

  assert.equal(sanitizeHistoryStatus('active'), 'active');
  assert.equal(sanitizeHistoryStatus('archived'), 'archived');
  assert.equal(sanitizeHistoryStatus('bogus'), 'all');
});

test('toIsoTimestampOrFallback handles valid dates and prevents RangeError on malformed inputs', () => {
  const fallbackMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const fallbackIso = new Date(fallbackMs).toISOString();

  assert.equal(
    toIsoTimestampOrFallback('2026-05-01T12:30:00Z', fallbackMs),
    '2026-05-01T12:30:00.000Z'
  );
  assert.equal(
    toIsoTimestampOrFallback('Fri, 01 May 2026 12:30:00 GMT', fallbackMs),
    '2026-05-01T12:30:00.000Z'
  );
  assert.equal(toIsoTimestampOrFallback(fallbackMs, 0), fallbackIso);
  assert.equal(toIsoTimestampOrFallback('not-a-valid-date', fallbackMs), fallbackIso);
  assert.equal(toIsoTimestampOrFallback('', fallbackMs), fallbackIso);
  assert.equal(toIsoTimestampOrFallback(Number.NaN, fallbackMs), fallbackIso);
});

test('MCP server exposes query_disaster_history with all subtype filters', async () => {
  const tool = MCP_TOOLS.find((t) => t.name === 'query_disaster_history');
  assert.ok(tool, 'query_disaster_history tool must be registered');

  const listRes = (await handleMcpRequest({
    jsonrpc: '2.0',
    id: 42,
    method: 'tools/list',
  })) as { result?: { tools: Array<{ name: string }> } };

  assert.ok(
    listRes.result?.tools.some((t) => t.name === 'query_disaster_history'),
    'tools/list should include query_disaster_history'
  );
});
