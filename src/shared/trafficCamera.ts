import { clamp, haversineKm } from './geo.ts';
import {
  classifySolarPhase,
  computeSolarElevationDeg,
  computeSubSolarPoint,
} from './solarPosition.ts';
import type {
  GlobalEvent,
  TerrainRoadKind,
  TerrainRoadPolyline,
  TrafficCameraFeedPoint,
} from './types.ts';

export interface RoadSnapCandidate {
  road: TerrainRoadPolyline;
  u: number;
  v: number;
  distNorm: number;
  bearingDeg: number;
}

/**
 * Computes road-class display defaults (Spanish label, lane count, speed limit).
 */
export function getRoadClassMetadata(kind: TerrainRoadKind): {
  defaultLabel: string;
  badgeLabel: string;
  lanes: number;
  speedLimitKmh: number;
} {
  switch (kind) {
    case 'motorway':
      return { defaultLabel: 'Autopista Principal', badgeLabel: 'Autopista', lanes: 4, speedLimitKmh: 110 };
    case 'primary':
      return { defaultLabel: 'Vía Primaria', badgeLabel: 'Primaria', lanes: 3, speedLimitKmh: 70 };
    case 'secondary':
      return { defaultLabel: 'Avenida Secundaria', badgeLabel: 'Secundaria', lanes: 2, speedLimitKmh: 50 };
    case 'rail':
      return { defaultLabel: 'Corredor Ferroviario', badgeLabel: 'Vía férrea', lanes: 2, speedLimitKmh: 85 };
    case 'residential':
    default:
      return { defaultLabel: 'Calle Urbana', badgeLabel: 'Calle', lanes: 2, speedLimitKmh: 40 };
  }
}

/**
 * Finds the nearest road polyline segment inside a normalized [0..1] tile space to `(targetU, targetV)`.
 * Returns projected `[u, v]`, normalized distance, and azimuth bearing in degrees (`0..360`).
 */
export function findNearestRoadInNormalizedTile(
  roads: readonly TerrainRoadPolyline[],
  targetU: number,
  targetV: number,
  maxDistNorm: number
): RoadSnapCandidate | null {
  let best: RoadSnapCandidate | null = null;
  let bestDistSq = maxDistNorm * maxDistNorm;

  for (let i = 0; i < roads.length; i++) {
    const road = roads[i];
    const coords = road.coords;
    if (!coords || coords.length < 2) continue;

    // Slight priority bias for named or arterial roads when multiple streets overlap an intersection
    const kindBonus =
      road.kind === 'motorway'
        ? 0.85
        : road.kind === 'primary'
          ? 0.90
          : road.kind === 'secondary'
            ? 0.95
            : 1.0;

    for (let k = 0; k < coords.length - 1; k++) {
      const ax = coords[k][0];
      const ay = coords[k][1];
      const bx = coords[k + 1][0];
      const by = coords[k + 1][1];

      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 1e-12) {
        t = clamp(((targetU - ax) * dx + (targetV - ay) * dy) / lenSq, 0, 1);
      }

      const px = ax + dx * t;
      const py = ay + dy * t;
      const dSqRaw = (targetU - px) * (targetU - px) + (targetV - py) * (targetV - py);
      const weightedDistSq = dSqRaw * kindBonus;

      if (dSqRaw <= maxDistNorm * maxDistNorm && weightedDistSq < bestDistSq) {
        bestDistSq = weightedDistSq;
        // East = +dx, North = -dy (tile V grows southward)
        const rad = Math.atan2(dx, -dy);
        const bearingDeg = ((rad * 180) / Math.PI + 360) % 360;
        best = {
          road,
          u: px,
          v: py,
          distNorm: Math.sqrt(dSqRaw),
          bearingDeg: Math.round(bearingDeg),
        };
      }
    }
  }

  return best;
}

/**
 * Synthesizes a deterministic, time-aware and incident-aware traffic camera model
 * anchored at an exact OSM road point `(lat, lng)`.
 */
export function buildTrafficCameraFeedPoint(input: {
  road: TerrainRoadPolyline;
  lat: number;
  lng: number;
  elevationM: number;
  bearingDeg: number;
  events: readonly GlobalEvent[];
  nowMs?: number;
}): TrafficCameraFeedPoint {
  const { road, lat, lng, elevationM, bearingDeg, events, nowMs = Date.now() } = input;
  const meta = getRoadClassMetadata(road.kind);

  const latHash = Math.abs(Math.round(lat * 10000));
  const lngHash = Math.abs(Math.round(lng * 10000));
  const hash = ((latHash * 73856093) ^ (lngHash * 19349663)) >>> 0;
  const cameraCode = `CAM-${String(1000 + (hash % 9000))}`;

  // Solar phase at road coordinates
  const subSolar = computeSubSolarPoint(nowMs);
  const solarElev = computeSolarElevationDeg(lat, lng, subSolar.sunDir);
  const solarPhase = classifySolarPhase(solarElev);

  // Approximate local hour for diurnal traffic rush curve
  const utcDate = new Date(nowMs);
  const utcHours = utcDate.getUTCHours() + utcDate.getUTCMinutes() / 60;
  const localHour = (((utcHours + lng / 15) % 24) + 24) % 24;

  const morningPeak = Math.exp(-Math.pow((localHour - 8.5) / 2.2, 2));
  const eveningPeak = Math.exp(-Math.pow((localHour - 18.0) / 2.6, 2));
  const middayFactor = localHour >= 7 && localHour <= 21 ? 0.36 : 0.10;
  const spatialWave = ((hash % 100) / 100) * 0.24;

  let congestionRatio = clamp(
    middayFactor + 0.44 * Math.max(morningPeak, eveningPeak) + spatialWave - 0.1,
    0.06,
    0.94
  );

  // Check nearby disasters or security alerts impacting road flow
  let nearbyAlertTitle: string | undefined;
  let nearestAlertDist = Infinity;
  for (const ev of events) {
    if (ev.category === 'flight' || ev.category === 'ship') continue;
    const dKm = haversineKm({ lat, lng }, { lat: ev.lat, lng: ev.lng });
    if (dKm <= 25 && dKm < nearestAlertDist) {
      nearestAlertDist = dKm;
      nearbyAlertTitle = ev.title;
    }
  }
  if (nearbyAlertTitle) {
    congestionRatio = clamp(congestionRatio + 0.28, 0.2, 0.96);
  }

  const congestionPct = Math.round(congestionRatio * 100);
  const avgSpeedKmh = Math.max(
    road.kind === 'rail' ? 28 : 11,
    Math.round(meta.speedLimitKmh * (1 - 0.68 * congestionRatio))
  );

  const baseCapacityPerLane =
    road.kind === 'motorway'
      ? 1850
      : road.kind === 'primary'
        ? 1100
        : road.kind === 'secondary'
          ? 760
          : road.kind === 'rail'
            ? 24
            : 380;

  const estimatedFlowVph = Math.round(
    meta.lanes * baseCapacityPerLane * (0.18 + 0.72 * congestionRatio)
  );

  const roadName =
    road.name?.trim() ||
    (road.ref?.trim() ? `${meta.defaultLabel} ${road.ref.trim()}` : meta.defaultLabel);

  return {
    id: `${road.id}:${lat.toFixed(5)}:${lng.toFixed(5)}`,
    cameraCode,
    roadName,
    roadKind: road.kind,
    roadRef: road.ref,
    lat: Number(lat.toFixed(5)),
    lng: Number(lng.toFixed(5)),
    elevationM: Math.round(elevationM),
    bearingDeg,
    lanes: meta.lanes,
    speedLimitKmh: meta.speedLimitKmh,
    estimatedFlowVph,
    congestionPct,
    avgSpeedKmh,
    solarPhase,
    nearbyAlertTitle,
  };
}
