import { haversineKm } from './geo.ts';
import type {
  CycloneVortexSpec,
  GlobalEvent,
  GlobalWeatherRadarResponse,
  GlobalWindFieldResponse,
  SeismicQuake24h,
  TerrainHudStats,
  ZoneBriefingCycloneThreat,
  ZoneBriefingEventItem,
  ZoneBriefingReport,
  ZoneBriefingThreatLevel,
} from './types.ts';
import {
  computeCycloneForecastCone,
  sampleWeatherRadarAtLatLng,
  superposeCyclonesOnWeather,
} from './weatherRadar.ts';
import {
  prepareCycloneVortices,
  sampleWindFieldWithCyclones,
} from './windField.ts';

export interface ComputeZoneBriefingInput {
  zoneLabel: string;
  lat: number;
  lng: number;
  radiusKm: number;
  events: readonly GlobalEvent[];
  seismicQuakes24h: readonly SeismicQuake24h[];
  windField: GlobalWindFieldResponse | null;
  radarField: GlobalWeatherRadarResponse | null;
  cyclones: readonly CycloneVortexSpec[];
  terrainStats: TerrainHudStats | null;
  solarPhaseLabel: string;
  nowMs?: number;
}

/**
 * Pure operational briefing engine aggregating real-time geospatial telemetry,
 * 24h seismic activity, cyclone forecast cones, atmospheric radar & wind,
 * and terrain profile within `radiusKm` of `(lat, lng)`.
 */
export function computeZoneBriefingReport(
  input: ComputeZoneBriefingInput
): ZoneBriefingReport {
  const {
    zoneLabel,
    lat,
    lng,
    radiusKm,
    events,
    seismicQuakes24h,
    windField,
    radarField,
    cyclones,
    terrainStats,
    solarPhaseLabel,
    nowMs = Date.now(),
  } = input;

  const center = { lat, lng };
  const preparedCyclones = prepareCycloneVortices(cyclones);

  // 1. Sample live atmospheric conditions at zone center
  const windSample = windField
    ? sampleWindFieldWithCyclones(windField, preparedCyclones, lat, lng)
    : { uEastMs: 0, vNorthMs: 0, speedMs: 0, speedKmh: 0 };

  const baseRadar = radarField
    ? sampleWeatherRadarAtLatLng(radarField, lat, lng)
    : { precipMmH: 0, pressureHpa: 1013, cloudPct: 25 };
  const atmoCombined = superposeCyclonesOnWeather(baseRadar, cyclones, lat, lng);

  // 2. Evaluate events inside operational radius
  const nearbyEvents: ZoneBriefingEventItem[] = [];
  let disasterCount = 0;
  let conflictCount = 0;
  let criticalEvents = 0;
  let highEvents = 0;

  for (const ev of events) {
    if (ev.category === 'flight' || ev.category === 'ship') continue;
    const distanceKm = haversineKm(center, { lat: ev.lat, lng: ev.lng });
    if (distanceKm > radiusKm) continue;

    if (ev.category === 'disaster') disasterCount += 1;
    if (ev.category === 'conflict') conflictCount += 1;
    if (ev.severity === 'critical') criticalEvents += 1;
    else if (ev.severity === 'high') highEvents += 1;

    nearbyEvents.push({
      id: ev.id,
      category: ev.category,
      subtype: ev.subtype,
      title: ev.title,
      region: ev.region,
      severity: ev.severity,
      lat: ev.lat,
      lng: ev.lng,
      distanceKm: Math.round(distanceKm),
      magnitude: ev.magnitude,
      summary: ev.summary,
    });
  }

  nearbyEvents.sort((a, b) => {
    const sevWeight = (s: ZoneBriefingEventItem['severity']) =>
      s === 'critical' ? 0 : s === 'high' ? 1 : s === 'moderate' ? 2 : 3;
    const sw = sevWeight(a.severity) - sevWeight(b.severity);
    if (sw !== 0) return sw;
    return a.distanceKm - b.distanceKm;
  });

  // 3. Evaluate 24h seismicity inside operational radius
  let seismicCount = 0;
  let maxMagnitude: number | null = null;
  let nearestKm: number | null = null;
  let strongestPlace: string | null = null;

  for (const q of seismicQuakes24h) {
    const dKm = haversineKm(center, { lat: q.lat, lng: q.lng });
    if (dKm > radiusKm) continue;
    seismicCount += 1;
    if (nearestKm === null || dKm < nearestKm) {
      nearestKm = Math.round(dKm);
    }
    if (maxMagnitude === null || q.magnitude > maxMagnitude) {
      maxMagnitude = Number(q.magnitude.toFixed(1));
      strongestPlace = q.place;
    }
  }

  // 4. Evaluate active cyclones & 72h forecast cone intercept
  const cycloneThreats: ZoneBriefingCycloneThreat[] = [];
  for (const c of cyclones) {
    const dNow = haversineKm(center, { lat: c.lat, lng: c.lng });
    const cone = computeCycloneForecastCone(c, windField, 72);
    let minConeDist = dNow;
    let coneIntercepts = dNow <= radiusKm + c.outerInfluenceKm * 0.65;

    for (const wp of cone.waypoints) {
      const dw = haversineKm(center, { lat: wp.lat, lng: wp.lng });
      if (dw < minConeDist) minConeDist = dw;
      if (dw <= radiusKm + wp.coneRadiusKm) {
        coneIntercepts = true;
      }
    }

    if (dNow <= Math.max(radiusKm * 1.5, 1600) || coneIntercepts) {
      cycloneThreats.push({
        id: c.id,
        title: c.title,
        cycloneCategory: c.cycloneCategory,
        centralPressureHpa: c.centralPressureHpa,
        maxWindKmh: Math.round(c.maxWindMs * 3.6),
        distanceKm: Math.round(dNow),
        minForecastDistanceKm: Math.round(minConeDist),
        coneInterceptsZone: coneIntercepts,
        lat: c.lat,
        lng: c.lng,
      });
    }
  }
  cycloneThreats.sort((a, b) => a.minForecastDistanceKm - b.minForecastDistanceKm);

  // 5. Compute weighted operational threat posture (0..100)
  let threatScore = 0;
  const factors: string[] = [];

  if (criticalEvents > 0) {
    threatScore += Math.min(48, criticalEvents * 26);
    factors.push(`${criticalEvents} evento${criticalEvents > 1 ? 's' : ''} crítico${criticalEvents > 1 ? 's' : ''} activo${criticalEvents > 1 ? 's' : ''} en radio.`);
  }
  if (highEvents > 0) {
    threatScore += Math.min(24, highEvents * 10);
  }
  if (conflictCount > 0) {
    threatScore += Math.min(28, conflictCount * 12);
    factors.push(`${conflictCount} corredor${conflictCount > 1 ? 'es' : ''} de tensión geopolítica cercano${conflictCount > 1 ? 's' : ''}.`);
  }

  const primaryCyclone = cycloneThreats[0];
  if (primaryCyclone?.coneInterceptsZone) {
    const catScore = 24 + primaryCyclone.cycloneCategory * 8;
    threatScore += catScore;
    factors.push(
      `Cono de trayectoria ciclónica (${primaryCyclone.title}, ${primaryCyclone.centralPressureHpa} hPa) intersecta la zona a ${primaryCyclone.minForecastDistanceKm} km.`
    );
  }

  if (maxMagnitude !== null) {
    if (maxMagnitude >= 6.0) {
      threatScore += 36;
      factors.push(`Sismo mayor M${maxMagnitude.toFixed(1)} en las últimas 24 h (${strongestPlace ?? 'zona'}).`);
    } else if (maxMagnitude >= 4.5) {
      threatScore += 18;
      factors.push(`Actividad sísmica moderada hasta M${maxMagnitude.toFixed(1)} (${seismicCount} sismos/24h).`);
    } else if (seismicCount >= 6) {
      threatScore += 10;
      factors.push(`Enjambre sísmico menor: ${seismicCount} eventos en 24 h.`);
    }
  }

  const windKmh = Math.round(windSample.speedKmh);
  const precipMmH = Number(atmoCombined.precipMmH.toFixed(1));
  const pressureHpa = Math.round(atmoCombined.pressureHpa);

  if (windKmh >= 65 || precipMmH >= 15 || pressureHpa <= 995) {
    threatScore += 18;
    factors.push(
      `Condición meteorológica severa: ${windKmh} km/h · ${precipMmH} mm/h · ${pressureHpa} hPa.`
    );
  } else if (precipMmH >= 4) {
    threatScore += 8;
    factors.push(`Precipitación activa en radar (${precipMmH} mm/h).`);
  }

  if (factors.length === 0) {
    factors.push(
      `Sin alertas críticas en ${radiusKm} km; atmósfera en ${pressureHpa} hPa y viento de ${windKmh} km/h.`
    );
  }

  const clampedScore = Math.min(100, Math.round(threatScore));
  const threatLevel: ZoneBriefingThreatLevel =
    clampedScore >= 68
      ? 'Crítico'
      : clampedScore >= 40
        ? 'Elevado'
        : clampedScore >= 18
          ? 'Vigilancia'
          : 'Estable';

  const summaryLine =
    threatLevel === 'Estable'
      ? `Entorno operativo estable en ${zoneLabel} (${radiusKm} km).`
      : `Postura ${threatLevel.toLowerCase()} en ${zoneLabel}: ${
          nearbyEvents.length
        } señal${nearbyEvents.length === 1 ? '' : 'es'}, ${seismicCount} sismo${
          seismicCount === 1 ? '' : 's'
        }/24h${primaryCyclone?.coneInterceptsZone ? ' y seguimiento ciclónico activo' : ''}.`;

  return {
    zoneLabel,
    lat: Number(lat.toFixed(4)),
    lng: Number(lng.toFixed(4)),
    radiusKm,
    generatedAtIso: new Date(nowMs).toISOString(),
    threatLevel,
    threatScore: clampedScore,
    summaryLine,
    factors,
    atmosphere: {
      windKmh,
      pressureHpa,
      precipMmH,
      cloudPct: Math.round(atmoCombined.cloudPct),
      solarPhaseLabel,
    },
    seismic24h: {
      countInZone: seismicCount,
      maxMagnitude,
      nearestKm,
      strongestPlace,
    },
    counts: {
      disasters: disasterCount,
      conflicts: conflictCount,
      totalEventsInZone: nearbyEvents.length,
    },
    cyclones: cycloneThreats,
    nearbyEvents: nearbyEvents.slice(0, 12),
    terrain: {
      minElevationM: terrainStats?.minElevationM ?? 0,
      maxElevationM: terrainStats?.maxElevationM ?? 0,
      buildingsCount: terrainStats?.buildingsCount ?? 0,
      available: Boolean(terrainStats && !terrainStats.loading),
    },
  };
}

/**
 * Formats an operational zone briefing into clean plain text for clipboard export.
 */
export function formatZoneBriefingText(report: ZoneBriefingReport): string {
  const lines = [
    `BRIEFING OPERATIVO AETHERIA · ${report.zoneLabel.toUpperCase()}`,
    `Coordenadas: ${report.lat.toFixed(4)}°, ${report.lng.toFixed(4)}° · Radio: ${report.radiusKm} km`,
    `Nivel de riesgo: ${report.threatLevel} (${report.threatScore}/100) · ${report.generatedAtIso}`,
    `Resumen: ${report.summaryLine}`,
    `Atmósfera: Viento ${report.atmosphere.windKmh} km/h | Presión ${report.atmosphere.pressureHpa} hPa | Lluvia ${report.atmosphere.precipMmH} mm/h | Ciclo solar: ${report.atmosphere.solarPhaseLabel}`,
    `Sismicidad 24h: ${report.seismic24h.countInZone} eventos${
      report.seismic24h.maxMagnitude !== null ? ` (Máx M${report.seismic24h.maxMagnitude.toFixed(1)})` : ''
    }`,
    '',
    'Factores clave:',
    ...report.factors.map((f) => `- ${f}`),
  ];

  if (report.nearbyEvents.length > 0) {
    lines.push('', 'Señales en zona:');
    for (const ev of report.nearbyEvents.slice(0, 5)) {
      lines.push(`- [${ev.severity.toUpperCase()}] ${ev.title} (${ev.distanceKm} km)`);
    }
  }

  return lines.join('\n');
}
