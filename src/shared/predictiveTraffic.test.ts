import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLocalPredictiveRoute,
  predictTrafficProfile,
  scoreRouteHazardProximity,
} from './predictiveTraffic.ts';
import type { GlobalEvent } from './types.ts';

test('predictTrafficProfile returns 6 hourly slots with valid ranges', () => {
  const profile = predictTrafficProfile({
    lat: 19.4326,
    lng: -99.1332,
    travelMode: 'DRIVE',
    departureOffsetHours: 0,
    referenceDate: new Date('2026-11-18T14:30:00Z'),
  });

  assert.equal(profile.hourlyForecast.length, 6);
  assert.ok(profile.congestionIndex >= 6 && profile.congestionIndex <= 97);
  assert.ok(profile.mlConfidence >= 0.7 && profile.mlConfidence <= 1.0);
  for (const slot of profile.hourlyForecast) {
    assert.ok(slot.predictedSpeedKmh > 0);
  }
});

test('scoreRouteHazardProximity detects disasters near route corridor', () => {
  const events: GlobalEvent[] = [
    {
      id: 'eq-1',
      category: 'disaster',
      subtype: 'earthquake',
      title: 'Sismo M5.8',
      region: 'Centro México',
      lat: 19.45,
      lng: -99.18,
      severity: 'high',
      timestamp: new Date().toISOString(),
      source: 'USGS',
      summary: 'Actividad sísmica',
      radiusKm: 60,
    },
    {
      id: 'fl-1',
      category: 'flight',
      subtype: 'commercial',
      title: 'AMX 401',
      region: 'CDMX',
      lat: 19.43,
      lng: -99.07,
      severity: 'low',
      timestamp: new Date().toISOString(),
      source: 'OpenSky',
      summary: 'Vuelo comercial',
    },
  ];

  const alerts = scoreRouteHazardProximity(
    [
      { lat: 19.43, lng: -99.13 },
      { lat: 19.44, lng: -99.2 },
    ],
    events,
    50
  );

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].eventId, 'eq-1');
});

test('computeLocalPredictiveRoute computes complete route with steps and forecast', () => {
  const route = computeLocalPredictiveRoute({
    origin: { lat: 19.4326, lng: -99.1332 },
    destination: { lat: 19.42, lng: -99.2 },
    originLabel: 'Zócalo CDMX',
    destinationLabel: 'Polanco',
    travelMode: 'DRIVE',
    avoidHazards: true,
    referenceDate: new Date('2026-11-18T18:00:00Z'),
  });

  assert.ok(route.distanceMeters > 1000);
  assert.ok(route.predictedDurationSeconds >= route.staticDurationSeconds);
  assert.ok(route.polylinePath.length >= 10);
  assert.equal(route.steps.length, 3);
  assert.equal(route.hourlyForecast.length, 6);
});
