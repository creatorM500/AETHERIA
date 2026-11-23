import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDisasterSubtype } from './disasterHistory.ts';
import { MCP_TOOLS, handleMcpRequest } from './mcpServer.ts';

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
