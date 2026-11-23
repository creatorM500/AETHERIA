import { clamp } from './geo.ts';
import type {
  GlobalWindFieldResponse,
  WindFieldMetrics,
  WindPeakPoint,
} from './types.ts';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Converts meteorological wind (speed in m/s and direction FROM in degrees clockwise from North)
 * into Eastward (uEastMs) and Northward (vNorthMs) velocity components.
 * Example: 0° (North wind, blowing South) -> u=0, v=-speed;
 *          270° (West wind, blowing East) -> u=+speed, v=0.
 */
export function meteorologicalToUV(
  speedMs: number,
  directionFromDeg: number
): { uEastMs: number; vNorthMs: number } {
  const safeSpeed = Number.isFinite(speedMs) ? Math.max(0, speedMs) : 0;
  const rad = (Number.isFinite(directionFromDeg) ? directionFromDeg : 0) * DEG_TO_RAD;
  const uEastMs = -safeSpeed * Math.sin(rad);
  const vNorthMs = -safeSpeed * Math.cos(rad);
  return {
    uEastMs: Math.abs(uEastMs) < 1e-9 ? 0 : uEastMs,
    vNorthMs: Math.abs(vNorthMs) < 1e-9 ? 0 : vNorthMs,
  };
}

/**
 * Converts East/North velocity components (m/s) back into speed and meteorological direction.
 */
export function uvToSpeedAndDirection(
  uEastMs: number,
  vNorthMs: number
): { speedMs: number; speedKmh: number; directionFromDeg: number; bearingToDeg: number } {
  const speedMs = Math.hypot(uEastMs, vNorthMs);
  const speedKmh = speedMs * 3.6;
  const bearingToDeg = ((Math.atan2(uEastMs, vNorthMs) * RAD_TO_DEG) % 360 + 360) % 360;
  const directionFromDeg = (bearingToDeg + 180) % 360;
  return { speedMs, speedKmh, directionFromDeg, bearingToDeg };
}

/**
 * Computes unit East and unit North tangent vectors at a normalized point (nx, ny, nz)
 * on the Y-up globe sphere, matching latLngToCartesian() in geo.ts.
 */
export function tangentEastNorthAtNormal(
  nx: number,
  ny: number,
  nz: number
): { ex: number; ey: number; ez: number; northX: number; northY: number; northZ: number } {
  // In geo.ts: dP/d(lng) is proportional to (nz, 0, -nx) = up x n
  let ex = nz;
  const ey = 0;
  let ez = -nx;
  const eLen = Math.hypot(ex, ez);
  if (eLen > 1e-7) {
    ex /= eLen;
    ez /= eLen;
  } else {
    ex = 1;
    ez = 0;
  }

  // North = n x east (points toward +lat)
  let northX = ny * ez - nz * ey;
  let northY = nz * ex - nx * ez;
  let northZ = nx * ey - ny * ex;
  const nLen = Math.hypot(northX, northY, northZ);
  if (nLen > 1e-7) {
    northX /= nLen;
    northY /= nLen;
    northZ /= nLen;
  } else {
    northX = 0;
    northY = 1;
    northZ = 0;
  }

  return { ex, ey, ez, northX, northY, northZ };
}

/**
 * Bilinearly samples East/North wind velocity (m/s) at any (lat, lng) on the planet,
 * seamlessly wrapping across the +-180° antimeridian.
 */
export function sampleWindFieldAtLatLng(
  field: Pick<
    GlobalWindFieldResponse,
    'minLat' | 'maxLat' | 'latStepDeg' | 'minLng' | 'lngStepDeg' | 'rows' | 'cols' | 'uGrid' | 'vGrid'
  >,
  lat: number,
  lng: number
): { uEastMs: number; vNorthMs: number; speedMs: number; speedKmh: number } {
  const { minLat, latStepDeg, minLng, lngStepDeg, rows, cols, uGrid, vGrid } = field;
  if (rows <= 0 || cols <= 0 || uGrid.length < rows * cols || vGrid.length < rows * cols) {
    return { uEastMs: 0, vNorthMs: 0, speedMs: 0, speedKmh: 0 };
  }

  const maxGridLat = minLat + (rows - 1) * latStepDeg;
  const clampedLat = clamp(lat, minLat, maxGridLat);
  const fy = latStepDeg > 0 ? (clampedLat - minLat) / latStepDeg : 0;
  const r0 = Math.min(rows - 1, Math.max(0, Math.floor(fy)));
  const r1 = Math.min(rows - 1, r0 + 1);
  const wy = fy - r0;

  // Wrap longitude smoothly into [0, 360) relative to minLng
  const wrappedDelta = ((((lng - minLng) % 360) + 360) % 360);
  const fx = lngStepDeg > 0 ? wrappedDelta / lngStepDeg : 0;
  const c0 = Math.floor(fx) % cols;
  const c1 = (c0 + 1) % cols;
  const wx = fx - Math.floor(fx);

  const i00 = r0 * cols + c0;
  const i10 = r0 * cols + c1;
  const i01 = r1 * cols + c0;
  const i11 = r1 * cols + c1;

  const u0 = uGrid[i00] + (uGrid[i10] - uGrid[i00]) * wx;
  const u1 = uGrid[i01] + (uGrid[i11] - uGrid[i01]) * wx;
  const uEastMs = u0 + (u1 - u0) * wy;

  const v0 = vGrid[i00] + (vGrid[i10] - vGrid[i00]) * wx;
  const v1 = vGrid[i01] + (vGrid[i11] - vGrid[i01]) * wx;
  const vNorthMs = v0 + (v1 - v0) * wy;

  const speedMs = Math.hypot(uEastMs, vNorthMs);
  return {
    uEastMs,
    vNorthMs,
    speedMs,
    speedKmh: speedMs * 3.6,
  };
}

const WIND_RAMP_STOPS: Array<{ t: number; rgb: [number, number, number] }> = [
  { t: 0.0, rgb: [0.09, 0.52, 0.85] }, // Calm breeze: cool azure
  { t: 0.22, rgb: [0.18, 0.83, 0.75] }, // Light-moderate: crisp cyan-teal
  { t: 0.45, rgb: [0.22, 0.84, 0.45] }, // Fresh wind: emerald
  { t: 0.68, rgb: [0.98, 0.80, 0.14] }, // Strong wind: solar gold
  { t: 0.86, rgb: [0.98, 0.45, 0.12] }, // Gale: vivid orange
  { t: 1.0, rgb: [1.0, 0.92, 0.78] }, // Storm / Jet core: incandescent white-gold
];

/**
 * Maps wind speed (m/s) to an RGB color tuple [0..1], calibrated against referenceMaxMs
 * (minimum 18 m/s ≈ 65 km/h) so both typical 10m global jets and hurricane-force winds span the full ramp.
 */
export function windSpeedToColorRGB(
  speedMs: number,
  referenceMaxMs = 24.0
): [number, number, number] {
  const denom = Math.max(18.0, referenceMaxMs);
  const t = clamp(speedMs / denom, 0, 1);
  for (let i = 0; i < WIND_RAMP_STOPS.length - 1; i++) {
    const a = WIND_RAMP_STOPS[i];
    const b = WIND_RAMP_STOPS[i + 1];
    if (t <= b.t) {
      const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
      ];
    }
  }
  const last = WIND_RAMP_STOPS[WIND_RAMP_STOPS.length - 1].rgb;
  return [last[0], last[1], last[2]];
}

/**
 * Computes summary metrics (min/avg/max km/h + peak grid location) for a wind field grid.
 */
export function computeWindFieldMetrics(
  minLat: number,
  latStepDeg: number,
  minLng: number,
  lngStepDeg: number,
  rows: number,
  cols: number,
  uGrid: number[],
  vGrid: number[]
): WindFieldMetrics {
  let minSpeedKmh = Infinity;
  let maxSpeedKmh = 0;
  let sumSpeedKmh = 0;
  let peakPoint: WindPeakPoint | null = null;
  const total = rows * cols;

  for (let r = 0; r < rows; r++) {
    const lat = minLat + r * latStepDeg;
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const u = uGrid[idx] ?? 0;
      const v = vGrid[idx] ?? 0;
      const { speedKmh, directionFromDeg } = uvToSpeedAndDirection(u, v);
      sumSpeedKmh += speedKmh;
      if (speedKmh < minSpeedKmh) minSpeedKmh = speedKmh;
      if (speedKmh >= maxSpeedKmh) {
        maxSpeedKmh = speedKmh;
        const lng = minLng + c * lngStepDeg;
        peakPoint = {
          lat: Number(lat.toFixed(2)),
          lng: Number(lng.toFixed(2)),
          speedKmh: Math.round(speedKmh),
          directionFromDeg: Math.round(directionFromDeg),
        };
      }
    }
  }

  if (total === 0) {
    return {
      gridRows: rows,
      gridCols: cols,
      sampleCount: 0,
      minSpeedKmh: 0,
      avgSpeedKmh: 0,
      maxSpeedKmh: 0,
      peakPoint: null,
    };
  }

  return {
    gridRows: rows,
    gridCols: cols,
    sampleCount: total,
    minSpeedKmh: Math.round(minSpeedKmh === Infinity ? 0 : minSpeedKmh),
    avgSpeedKmh: Math.round(sumSpeedKmh / total),
    maxSpeedKmh: Math.round(maxSpeedKmh),
    peakPoint,
  };
}

/**
 * Deterministic atmospheric circulation baseline (Hadley trade winds, mid-latitude westerlies,
 * polar easterlies & Rossby wave eddies) used only if the live Open-Meteo API is unreachable.
 */
export function buildAtmosphericBaselineWindField(nowMs = Date.now()): GlobalWindFieldResponse {
  const minLat = -75;
  const maxLat = 75;
  const latStepDeg = 15;
  const minLng = -180;
  const lngStepDeg = 20;
  const rows = 11;
  const cols = 18;
  const uGrid = new Array<number>(rows * cols);
  const vGrid = new Array<number>(rows * cols);

  const phaseHour = (nowMs / 3_600_000) * 0.15;

  for (let r = 0; r < rows; r++) {
    const lat = minLat + r * latStepDeg;
    const latRad = lat * DEG_TO_RAD;
    const absLat = Math.abs(lat);

    // Zonal flow profile: tropical trade easterlies (-), mid-lat westerlies (+), polar easterlies (-)
    let zonalBase = 0;
    if (absLat < 28) {
      zonalBase = -8.5 * Math.cos((absLat / 28) * (Math.PI * 0.5));
    } else if (absLat < 62) {
      zonalBase = 15.5 * Math.sin(((absLat - 28) / 34) * Math.PI);
    } else {
      zonalBase = -6.0 * Math.sin(((absLat - 62) / 28) * Math.PI);
    }

    for (let c = 0; c < cols; c++) {
      const lng = minLng + c * lngStepDeg;
      const lngRad = lng * DEG_TO_RAD;
      const rossby = Math.sin(lngRad * 3 + phaseHour + latRad * 1.4);
      const eddy = Math.cos(lngRad * 2 - phaseHour * 0.7 - latRad * 2.1);

      const u = zonalBase + rossby * 4.2;
      const v =
        (lat >= 0 ? -1 : 1) * (absLat < 30 ? 2.4 : -1.8) * Math.cos(latRad * 3) +
        eddy * 4.8;

      const idx = r * cols + c;
      uGrid[idx] = Number(u.toFixed(2));
      vGrid[idx] = Number(v.toFixed(2));
    }
  }

  const metrics = computeWindFieldMetrics(
    minLat,
    latStepDeg,
    minLng,
    lngStepDeg,
    rows,
    cols,
    uGrid,
    vGrid
  );

  return {
    minLat,
    maxLat,
    latStepDeg,
    minLng,
    lngStepDeg,
    rows,
    cols,
    uGrid,
    vGrid,
    metrics,
    source: 'Modelo Atmosférico Baseline',
    updatedAt: new Date(nowMs).toISOString(),
  };
}
