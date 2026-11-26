import { clamp, latLngToCartesian, normalizeLngDeg } from './geo.ts';

const J2000_UTC_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const MS_PER_DAY = 86_400_000;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export type SolarPhase = 'day' | 'twilight' | 'night';

export interface SubSolarPoint {
  lat: number;
  lng: number;
  declinationDeg: number;
  rightAscensionDeg: number;
  gmstDeg: number;
  sunDir: { x: number; y: number; z: number };
  utcLabel: string;
}

/**
 * Computes the real-time sub-solar geographic coordinate (lat, lng) and 3D unit vector
 * from UTC epoch milliseconds using standard low-precision solar ephemeris (accurate < 0.02°).
 */
export function computeSubSolarPoint(nowMs = Date.now()): SubSolarPoint {
  const safeMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const days = (safeMs - J2000_UTC_MS) / MS_PER_DAY;

  // Mean solar longitude & mean anomaly (deg)
  const meanLonDeg = ((280.460 + 0.9856474 * days) % 360 + 360) % 360;
  const meanAnomalyRad =
    (((357.528 + 0.9856003 * days) % 360 + 360) % 360) * DEG_TO_RAD;

  // Apparent ecliptic longitude & obliquity of the ecliptic
  const eclipticLonRad =
    (meanLonDeg +
      1.915 * Math.sin(meanAnomalyRad) +
      0.020 * Math.sin(2 * meanAnomalyRad)) *
    DEG_TO_RAD;
  const obliquityRad = (23.439 - 0.0000004 * days) * DEG_TO_RAD;

  const sinDec = clamp(Math.sin(obliquityRad) * Math.sin(eclipticLonRad), -1, 1);
  const declinationDeg = Math.asin(sinDec) * RAD_TO_DEG;

  const rightAscensionDeg =
    Math.atan2(
      Math.cos(obliquityRad) * Math.sin(eclipticLonRad),
      Math.cos(eclipticLonRad)
    ) * RAD_TO_DEG;

  // Greenwich Mean Sidereal Time (deg)
  const gmstDeg = ((280.46061837 + 360.98564736629 * days) % 360 + 360) % 360;

  // Sub-solar longitude = Right Ascension - GMST normalized to [-180, 180]
  const lng = normalizeLngDeg(rightAscensionDeg - gmstDeg);
  const lat = declinationDeg;
  const sunDir = latLngToCartesian(lat, lng, 1);

  const d = new Date(safeMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');

  return {
    lat,
    lng,
    declinationDeg,
    rightAscensionDeg,
    gmstDeg,
    sunDir,
    utcLabel: `${hh}:${mm} UTC`,
  };
}

/**
 * Computes solar elevation angle (degrees above/below local horizon) at any (lat, lng).
 */
export function computeSolarElevationDeg(
  lat: number,
  lng: number,
  sunDir: { x: number; y: number; z: number }
): number {
  const p = latLngToCartesian(lat, lng, 1);
  const dot = clamp(p.x * sunDir.x + p.y * sunDir.y + p.z * sunDir.z, -1, 1);
  return Math.asin(dot) * RAD_TO_DEG;
}

/**
 * Classifies local solar phase from elevation angle (day > 0.5°, twilight -12°..0.5°, night < -12°).
 */
export function classifySolarPhase(elevationDeg: number): SolarPhase {
  if (elevationDeg > 0.5) return 'day';
  if (elevationDeg >= -12.0) return 'twilight';
  return 'night';
}
