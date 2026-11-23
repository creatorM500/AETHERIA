import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ALERT_RULES,
  evaluateTelemetryAlerts,
  isMeteorologicalEvent,
  resolveAlertReferencePoint,
  sanitizeAlertRules,
} from './alertRules.ts';
import type { GlobalEvent, SeismicQuake24h } from './types.ts';

const SAMPLE_QUAKES: SeismicQuake24h[] = [
  {
    id: 'usgs-q1',
    lat: 35.68,
    lng: 139.75,
    magnitude: 6.2,
    depthKm: 24,
    place: 'Near East Coast of Honshu, Japan',
    occurredAtMs: 1_730_000_000_000,
    timestamp: '2026-11-22T10:00:00.000Z',
    tsunami: true,
    significance: 610,
  },
  {
    id: 'usgs-q2',
    lat: 19.3,
    lng: -99.1,
    magnitude: 4.3,
    depthKm: 12,
    place: 'Ciudad de México, México',
    occurredAtMs: 1_730_000_100_000,
    timestamp: '2026-11-22T10:05:00.000Z',
    tsunami: false,
    significance: 240,
  },
];

const SAMPLE_EVENTS: GlobalEvent[] = [
  {
    // Duplicate of usgs-q1 to ensure deduplication across feeds
    id: 'usgs-q1',
    category: 'disaster',
    subtype: 'earthquake',
    title: 'Sismo M6.2 · Japan',
    region: 'Honshu, Japan',
    lat: 35.68,
    lng: 139.75,
    severity: 'critical',
    magnitude: 6.2,
    depthKm: 24,
    timestamp: '2026-11-22T10:00:00.000Z',
    source: 'USGS Live Feed',
    summary: 'Sismo en tiempo real M6.2.',
  },
  {
    id: 'nhc-storm1',
    category: 'disaster',
    subtype: 'storm',
    title: 'Huracán Aurelia (Cat 3)',
    region: 'Golfo de México',
    lat: 21.1,
    lng: -96.5,
    severity: 'critical',
    timestamp: '2026-11-22T10:10:00.000Z',
    source: 'NOAA NHC Live',
    summary: 'Vientos sostenidos de 115 nudos.',
    radiusKm: 260,
  },
  {
    id: 'gdacs-flood-far',
    category: 'disaster',
    subtype: 'flood',
    title: 'Inundación Severa · Asia',
    region: 'Bangladesh',
    lat: 23.7,
    lng: 90.4,
    severity: 'critical',
    timestamp: '2026-11-22T10:12:00.000Z',
    source: 'GDACS Live Alert',
    summary: 'Desbordamiento severo.',
  },
  {
    id: 'eonet-storm-mod',
    category: 'disaster',
    subtype: 'storm',
    title: 'Tormenta Moderada Local',
    region: 'Puebla',
    lat: 19.04,
    lng: -98.2,
    severity: 'moderate',
    timestamp: '2026-11-22T10:14:00.000Z',
    source: 'NASA EONET Live',
    summary: 'Tormenta moderada.',
  },
];

test('evaluateTelemetryAlerts triggers seismic alerts above threshold and deduplicates across feeds', () => {
  const rules = sanitizeAlertRules({
    ...DEFAULT_ALERT_RULES,
    seismicMinMagnitude: 5.0,
    meteorologicalEnabled: false,
  });

  const result = evaluateTelemetryAlerts({
    events: SAMPLE_EVENTS,
    seismicQuakes24h: SAMPLE_QUAKES,
    rules,
    seenRuleKeys: new Set(),
    nowMs: 1_730_000_200_000,
  });

  assert.equal(result.preview.matchingSeismicCount, 1);
  assert.equal(result.preview.strongestSeismicMag, 6.2);
  assert.equal(result.newNotifications.length, 1);
  assert.equal(result.newNotifications[0].eventId, 'usgs-q1');
  assert.equal(result.newNotifications[0].ruleType, 'seismic');
  assert.match(result.newNotifications[0].message, /Aviso tsunami/);

  // Re-evaluating with seenRuleKeys avoids duplicate alert spam
  const secondPass = evaluateTelemetryAlerts({
    events: SAMPLE_EVENTS,
    seismicQuakes24h: SAMPLE_QUAKES,
    rules,
    seenRuleKeys: new Set(result.matchedRuleKeys),
    nowMs: 1_730_000_215_000,
  });
  assert.equal(secondPass.newNotifications.length, 0);
  assert.equal(secondPass.preview.matchingSeismicCount, 1);
});

test('lowering seismic threshold surfaces previously skipped earthquakes immediately', () => {
  const seen = new Set(['seismic:usgs-q1']);
  const loweredRules = sanitizeAlertRules({
    ...DEFAULT_ALERT_RULES,
    seismicMinMagnitude: 4.0,
    meteorologicalEnabled: false,
  });

  const result = evaluateTelemetryAlerts({
    events: SAMPLE_EVENTS,
    seismicQuakes24h: SAMPLE_QUAKES,
    rules: loweredRules,
    seenRuleKeys: seen,
    nowMs: 1_730_000_300_000,
  });

  assert.equal(result.preview.matchingSeismicCount, 2);
  assert.equal(result.newNotifications.length, 1);
  assert.equal(result.newNotifications[0].eventId, 'usgs-q2');
});

test('meteorological proximity rule filters by critical/high severity and km radius from active sector', () => {
  const cdmxSector = { name: 'Ciudad de México', lat: 19.4326, lng: -99.1332 };
  const rules = sanitizeAlertRules({
    ...DEFAULT_ALERT_RULES,
    seismicEnabled: false,
    meteorologicalEnabled: true,
    meteorologicalRadiusKm: 600,
    meteorologicalMinSeverity: 'high',
    referencePoint: { ...DEFAULT_ALERT_RULES.referencePoint, mode: 'active-sector' },
  });

  const result = evaluateTelemetryAlerts({
    events: SAMPLE_EVENTS,
    seismicQuakes24h: SAMPLE_QUAKES,
    rules,
    activeSector: cdmxSector,
    seenRuleKeys: new Set(),
    nowMs: 1_730_000_400_000,
  });

  // Only nhc-storm1 is within 600 km of CDMX AND high/critical (eonet-storm-mod is moderate; gdacs-flood-far is >15000km)
  assert.equal(result.preview.matchingMeteoCount, 1);
  assert.equal(result.newNotifications.length, 1);
  assert.equal(result.newNotifications[0].eventId, 'nhc-storm1');
  assert.ok((result.newNotifications[0].distanceKm ?? 0) < 400);
});

test('isMeteorologicalEvent identifies storms and floods while excluding volcanoes and quakes', () => {
  assert.equal(isMeteorologicalEvent(SAMPLE_EVENTS[1]), true);
  assert.equal(isMeteorologicalEvent(SAMPLE_EVENTS[2]), true);
  assert.equal(isMeteorologicalEvent(SAMPLE_EVENTS[0]), false);
  assert.equal(
    isMeteorologicalEvent({
      id: 'volc-1',
      category: 'disaster',
      subtype: 'volcano',
      title: 'Erupción Volcán Popocatépetl',
      region: 'México',
      lat: 19.02,
      lng: -98.62,
      severity: 'high',
      timestamp: '2026-11-22T10:00:00.000Z',
      source: 'NASA EONET',
      summary: 'Actividad volcánica.',
    }),
    false
  );
});

test('sanitizeAlertRules clamps invalid ranges and resolveAlertReferencePoint respects custom vs active-sector', () => {
  const clamped = sanitizeAlertRules({
    seismicMinMagnitude: 99,
    meteorologicalRadiusKm: -50,
    referencePoint: { lat: 200, lng: -400, label: '  Custom Base  ', mode: 'custom' },
  });
  assert.equal(clamped.seismicMinMagnitude, 8.5);
  assert.equal(clamped.meteorologicalRadiusKm, 50);
  assert.equal(clamped.referencePoint.lat, 85);
  assert.equal(clamped.referencePoint.lng, -180);

  const resolved = resolveAlertReferencePoint(clamped, { name: 'Tokio', lat: 35.67, lng: 139.65 });
  assert.equal(resolved.label, 'Custom Base');
  assert.equal(resolved.lat, 85);
});
