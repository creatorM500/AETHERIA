import assert from 'node:assert/strict';
import test from 'node:test';
import type { GlobalEvent, SeismicQuake24h } from './types.ts';
import { buildAtmosphericBaselineRadarField } from './weatherRadar.ts';
import { buildAtmosphericBaselineWindField, extractCycloneVorticesFromEvents } from './windField.ts';
import { computeZoneBriefingReport, formatZoneBriefingText } from './zoneBriefing.ts';

test('computeZoneBriefingReport evaluates stable zone with zero nearby hazards', () => {
  const windField = buildAtmosphericBaselineWindField(1_760_000_000_000);
  const radarField = buildAtmosphericBaselineRadarField(1_760_000_000_000);

  const report = computeZoneBriefingReport({
    zoneLabel: 'Zúrich',
    lat: 47.3769,
    lng: 8.5417,
    radiusKm: 500,
    events: [],
    seismicQuakes24h: [],
    windField,
    radarField,
    cyclones: [],
    terrainStats: null,
    solarPhaseLabel: 'Día',
    nowMs: 1_760_000_000_000,
  });

  assert.equal(report.threatLevel, 'Estable');
  assert.ok(report.atmosphere.pressureHpa >= 970 && report.atmosphere.pressureHpa <= 1040);
  assert.equal(report.counts.totalEventsInZone, 0);
  assert.equal(report.seismic24h.countInZone, 0);
  const txt = formatZoneBriefingText(report);
  assert.ok(txt.includes('ZÚRICH'));
  assert.ok(txt.includes('Estable'));
});

test('computeZoneBriefingReport elevates threat to Crítico when cyclone cone and critical events intersect zone', () => {
  const windField = buildAtmosphericBaselineWindField(1_760_000_000_000);
  const radarField = buildAtmosphericBaselineRadarField(1_760_000_000_000);

  const events: GlobalEvent[] = [
    {
      id: 'cyc-havana',
      category: 'disaster',
      subtype: 'storm',
      title: 'Huracán Delta Cat 3',
      region: 'Caribe Occidental',
      lat: 21.8,
      lng: -81.9,
      maxWindKmh: 195,
      centralPressureHpa: 952,
      cycloneCategory: 3,
      severity: 'critical',
      timestamp: new Date(1_760_000_000_000).toISOString(),
      source: 'GDACS',
      summary: 'Huracán intenso aproximándose al occidente de Cuba',
      radiusKm: 340,
    },
    {
      id: 'conf-test',
      category: 'conflict',
      subtype: 'maritime',
      title: 'Restricción marítima sectorial',
      region: 'Estrecho',
      lat: 23.0,
      lng: -82.2,
      severity: 'high',
      timestamp: new Date(1_760_000_000_000).toISOString(),
      source: 'OSINT',
      summary: 'Corredor restringido',
    },
  ];

  const quakes: SeismicQuake24h[] = [
    {
      id: 'q1',
      lat: 22.9,
      lng: -82.1,
      magnitude: 4.8,
      depthKm: 12,
      place: 'West of Havana',
      occurredAtMs: 1_760_000_000_000,
      timestamp: new Date(1_760_000_000_000).toISOString(),
      tsunami: false,
      significance: 320,
    },
  ];

  const cyclones = extractCycloneVorticesFromEvents(events);
  const report = computeZoneBriefingReport({
    zoneLabel: 'La Habana',
    lat: 23.135,
    lng: -82.345,
    radiusKm: 500,
    events,
    seismicQuakes24h: quakes,
    windField,
    radarField,
    cyclones,
    terrainStats: {
      loading: false,
      stage: 'ready',
      minElevationM: 0,
      maxElevationM: 92,
      buildingsCount: 113419,
      spanKm: 48,
      demSource: 'terrarium-dem',
      buildingsSource: 'versatiles-osm',
      qualityTier: 'balanced',
    },
    solarPhaseLabel: 'Día',
    nowMs: 1_760_000_000_000,
  });

  assert.equal(report.threatLevel, 'Crítico');
  assert.ok(report.threatScore >= 68);
  assert.equal(report.cyclones.length, 1);
  assert.equal(report.cyclones[0].coneInterceptsZone, true);
  assert.equal(report.seismic24h.maxMagnitude, 4.8);
  assert.equal(report.terrain.buildingsCount, 113419);
});
