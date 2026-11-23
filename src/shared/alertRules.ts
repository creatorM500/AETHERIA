import { clamp, haversineKm, SECTOR_PRESETS } from './geo.ts';
import type {
  AlertEvaluationPreview,
  AlertRuleConfig,
  ClientAlertNotification,
  GlobalEvent,
  SectorPreset,
  SeismicQuake24h,
  SeverityLevel,
} from './types.ts';

export const ALERT_RULES_STORAGE_KEY = 'aetheria.alertRules.v1';
export const ALERT_INBOX_STORAGE_KEY = 'aetheria.alertInbox.v1';
export const ALERT_SEEN_KEYS_STORAGE_KEY = 'aetheria.alertSeenKeys.v1';

export const DEFAULT_ALERT_RULES: AlertRuleConfig = {
  seismicEnabled: true,
  seismicMinMagnitude: 5.0,
  seismicUseRadius: false,
  seismicRadiusKm: 1500,
  meteorologicalEnabled: true,
  meteorologicalRadiusKm: 1200,
  meteorologicalMinSeverity: 'high',
  referencePoint: {
    lat: SECTOR_PRESETS[0].lat,
    lng: SECTOR_PRESETS[0].lng,
    label: SECTOR_PRESETS[0].name,
    mode: 'active-sector',
  },
  browserNotificationsEnabled: false,
};

function severityRank(severity: SeverityLevel): number {
  switch (severity) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'moderate':
      return 2;
    default:
      return 1;
  }
}

export function seismicMagnitudeToSeverity(mag: number): SeverityLevel {
  if (mag >= 6.0) return 'critical';
  if (mag >= 4.8) return 'high';
  if (mag >= 3.5) return 'moderate';
  return 'low';
}

export function sanitizeAlertRules(raw: unknown): AlertRuleConfig {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_ALERT_RULES,
      referencePoint: { ...DEFAULT_ALERT_RULES.referencePoint },
    };
  }
  const r = raw as Partial<AlertRuleConfig>;
  const ref = r.referencePoint;
  const mode =
    ref?.mode === 'active-sector' || ref?.mode === 'geolocation' || ref?.mode === 'custom'
      ? ref.mode
      : DEFAULT_ALERT_RULES.referencePoint.mode;

  const lat = Number(ref?.lat);
  const lng = Number(ref?.lng);

  return {
    seismicEnabled:
      typeof r.seismicEnabled === 'boolean' ? r.seismicEnabled : DEFAULT_ALERT_RULES.seismicEnabled,
    seismicMinMagnitude: Number.isFinite(Number(r.seismicMinMagnitude))
      ? Number(clamp(Number(r.seismicMinMagnitude), 2.0, 8.5).toFixed(1))
      : DEFAULT_ALERT_RULES.seismicMinMagnitude,
    seismicUseRadius:
      typeof r.seismicUseRadius === 'boolean'
        ? r.seismicUseRadius
        : DEFAULT_ALERT_RULES.seismicUseRadius,
    seismicRadiusKm: Number.isFinite(Number(r.seismicRadiusKm))
      ? Math.round(clamp(Number(r.seismicRadiusKm), 50, 10000))
      : DEFAULT_ALERT_RULES.seismicRadiusKm,
    meteorologicalEnabled:
      typeof r.meteorologicalEnabled === 'boolean'
        ? r.meteorologicalEnabled
        : DEFAULT_ALERT_RULES.meteorologicalEnabled,
    meteorologicalRadiusKm: Number.isFinite(Number(r.meteorologicalRadiusKm))
      ? Math.round(clamp(Number(r.meteorologicalRadiusKm), 50, 10000))
      : DEFAULT_ALERT_RULES.meteorologicalRadiusKm,
    meteorologicalMinSeverity:
      r.meteorologicalMinSeverity === 'critical' ? 'critical' : 'high',
    referencePoint: {
      lat: Number.isFinite(lat) ? clamp(lat, -85, 85) : DEFAULT_ALERT_RULES.referencePoint.lat,
      lng: Number.isFinite(lng) ? clamp(lng, -180, 180) : DEFAULT_ALERT_RULES.referencePoint.lng,
      label:
        typeof ref?.label === 'string' && ref.label.trim().length > 0
          ? ref.label.trim().slice(0, 64)
          : DEFAULT_ALERT_RULES.referencePoint.label,
      mode,
    },
    browserNotificationsEnabled:
      typeof r.browserNotificationsEnabled === 'boolean'
        ? r.browserNotificationsEnabled
        : DEFAULT_ALERT_RULES.browserNotificationsEnabled,
  };
}

export function resolveAlertReferencePoint(
  rules: AlertRuleConfig,
  activeSector?: Pick<SectorPreset, 'lat' | 'lng' | 'name'> | null
): { lat: number; lng: number; label: string } {
  if (rules.referencePoint.mode === 'active-sector' && activeSector) {
    return {
      lat: activeSector.lat,
      lng: activeSector.lng,
      label: activeSector.name,
    };
  }
  return {
    lat: rules.referencePoint.lat,
    lng: rules.referencePoint.lng,
    label: rules.referencePoint.label,
  };
}

export function isMeteorologicalEvent(ev: GlobalEvent): boolean {
  if (ev.category !== 'disaster') return false;
  if (ev.subtype === 'storm' || ev.subtype === 'flood') return true;
  if (ev.subtype === 'earthquake' || ev.subtype === 'volcano' || ev.subtype === 'iceberg') {
    return false;
  }
  return /(tormenta|cicl[oó]n|hurac[aá]n|tif[oó]n|temporal|inundaci[oó]n|storm|typhoon|hurricane|cyclone|flood|monsoon)/i.test(
    `${ev.title} ${ev.summary}`
  );
}

export function matchesMeteorologicalSeverity(
  severity: SeverityLevel,
  minSeverity: AlertRuleConfig['meteorologicalMinSeverity']
): boolean {
  if (minSeverity === 'critical') {
    return severity === 'critical';
  }
  return severity === 'high' || severity === 'critical';
}

interface UnifiedSeismicCandidate {
  id: string;
  lat: number;
  lng: number;
  magnitude: number;
  depthKm?: number;
  place: string;
  occurredAt: string;
  occurredAtMs: number;
  source: string;
  tsunami?: boolean;
}

export interface EvaluateTelemetryAlertsInput {
  events: GlobalEvent[];
  seismicQuakes24h: SeismicQuake24h[];
  rules: AlertRuleConfig;
  activeSector?: Pick<SectorPreset, 'lat' | 'lng' | 'name'> | null;
  seenRuleKeys: ReadonlySet<string>;
  nowMs?: number;
}

export interface EvaluateTelemetryAlertsOutput {
  newNotifications: ClientAlertNotification[];
  preview: AlertEvaluationPreview;
  matchedRuleKeys: string[];
}

export function evaluateTelemetryAlerts({
  events,
  seismicQuakes24h,
  rules,
  activeSector,
  seenRuleKeys,
  nowMs = Date.now(),
}: EvaluateTelemetryAlertsInput): EvaluateTelemetryAlertsOutput {
  const ref = resolveAlertReferencePoint(rules, activeSector);

  // Merge 24h USGS catalog + live GlobalEvent earthquakes, deduplicated by event ID
  const quakeMap = new Map<string, UnifiedSeismicCandidate>();
  for (const q of seismicQuakes24h) {
    quakeMap.set(q.id, {
      id: q.id,
      lat: q.lat,
      lng: q.lng,
      magnitude: q.magnitude,
      depthKm: q.depthKm,
      place: q.place,
      occurredAt: q.timestamp,
      occurredAtMs: q.occurredAtMs,
      source: 'USGS Telemetry 24h',
      tsunami: q.tsunami,
    });
  }
  for (const ev of events) {
    if (ev.subtype !== 'earthquake') continue;
    if (quakeMap.has(ev.id)) continue;
    const mag = typeof ev.magnitude === 'number' ? ev.magnitude : 0;
    const tsMs = Date.parse(ev.timestamp);
    quakeMap.set(ev.id, {
      id: ev.id,
      lat: ev.lat,
      lng: ev.lng,
      magnitude: mag,
      depthKm: ev.depthKm,
      place: ev.region || ev.title,
      occurredAt: ev.timestamp,
      occurredAtMs: Number.isFinite(tsMs) ? tsMs : nowMs,
      source: ev.source,
    });
  }

  const matchedNotifications: ClientAlertNotification[] = [];
  const matchedRuleKeys: string[] = [];
  let matchingSeismicCount = 0;
  let matchingMeteoCount = 0;
  let strongestSeismicMag: number | null = null;
  let nearestMeteoKm: number | null = null;

  if (rules.seismicEnabled) {
    for (const q of quakeMap.values()) {
      if (q.magnitude < rules.seismicMinMagnitude) continue;
      const distKm = Math.round(haversineKm(ref, { lat: q.lat, lng: q.lng }));
      if (rules.seismicUseRadius && distKm > rules.seismicRadiusKm) continue;

      matchingSeismicCount += 1;
      if (strongestSeismicMag === null || q.magnitude > strongestSeismicMag) {
        strongestSeismicMag = q.magnitude;
      }

      const ruleKey = `seismic:${q.id}`;
      matchedRuleKeys.push(ruleKey);
      if (seenRuleKeys.has(ruleKey)) continue;

      const sev = seismicMagnitudeToSeverity(q.magnitude);
      const tsunamiTag = q.tsunami ? ' · Aviso tsunami' : '';
      const distTag = rules.seismicUseRadius ? ` · a ${distKm} km de ${ref.label}` : '';
      matchedNotifications.push({
        id: `${ruleKey}:${nowMs}`,
        ruleKey,
        eventId: q.id,
        ruleType: 'seismic',
        title: `Sismo M${q.magnitude.toFixed(1)} · ${q.place}`,
        message: `Supera umbral M${rules.seismicMinMagnitude.toFixed(1)}${
          q.depthKm !== undefined ? ` · Prof. ${q.depthKm} km` : ''
        }${distTag}${tsunamiTag}`,
        severity: sev,
        lat: q.lat,
        lng: q.lng,
        magnitude: q.magnitude,
        depthKm: q.depthKm,
        distanceKm: distKm,
        subtype: 'earthquake',
        source: q.source,
        occurredAt: q.occurredAt,
        triggeredAtMs: nowMs,
        read: false,
      });
    }
  }

  if (rules.meteorologicalEnabled) {
    for (const ev of events) {
      if (!isMeteorologicalEvent(ev)) continue;
      if (!matchesMeteorologicalSeverity(ev.severity, rules.meteorologicalMinSeverity)) continue;

      const distKm = Math.round(haversineKm(ref, { lat: ev.lat, lng: ev.lng }));
      if (distKm > rules.meteorologicalRadiusKm) continue;

      matchingMeteoCount += 1;
      if (nearestMeteoKm === null || distKm < nearestMeteoKm) {
        nearestMeteoKm = distKm;
      }

      const ruleKey = `meteorological:${ev.id}`;
      matchedRuleKeys.push(ruleKey);
      if (seenRuleKeys.has(ruleKey)) continue;

      const sevText = ev.severity === 'critical' ? 'Crítico' : 'Alto';
      matchedNotifications.push({
        id: `${ruleKey}:${nowMs}`,
        ruleKey,
        eventId: ev.id,
        ruleType: 'meteorological',
        title: ev.title,
        message: `Evento meteorológico ${sevText} a ${distKm.toLocaleString('es-ES')} km de ${ref.label} (radio ${rules.meteorologicalRadiusKm.toLocaleString('es-ES')} km)`,
        severity: ev.severity,
        lat: ev.lat,
        lng: ev.lng,
        distanceKm: distKm,
        subtype: ev.subtype,
        source: ev.source,
        occurredAt: ev.timestamp,
        triggeredAtMs: nowMs,
        read: false,
      });
    }
  }

  matchedNotifications.sort((a, b) => {
    const sevDiff = severityRank(b.severity) - severityRank(a.severity);
    if (sevDiff !== 0) return sevDiff;
    const magDiff = (b.magnitude ?? 0) - (a.magnitude ?? 0);
    if (magDiff !== 0) return magDiff;
    return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
  });

  return {
    newNotifications: matchedNotifications,
    preview: {
      matchingSeismicCount,
      matchingMeteoCount,
      strongestSeismicMag,
      nearestMeteoKm,
    },
    matchedRuleKeys,
  };
}
