import { clamp, latLngToCartesian } from './geo.ts';
import type {
  CycloneVortexSpec,
  GlobalEvent,
  GlobalWindFieldResponse,
  WindFieldMetrics,
  WindPeakPoint,
} from './types.ts';

export const EARTH_RADIUS_KM = 6371;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

const CYCLONE_TITLE_RE =
  /cicl[oó]n|cyclone|hurricane|hurac[aá]n|typhoon|tif[oó]n|tropical\s+(storm|depression|cyclone)|tormenta\s+tropical/i;

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

export interface PreparedCycloneVortex extends CycloneVortexSpec {
  cx: number;
  cy: number;
  cz: number;
  cosMaxAngle: number;
  outerAngleRad: number;
  nominalAngleRad: number;
}

export interface CycloneSampleResult {
  vx: number;
  vy: number;
  vz: number;
  blendWeight: number;
  speedMs: number;
  vorticityScale: number;
  spiralCurvature: number;
}

/**
 * Classifies Saffir-Simpson cyclone category (0 = Tropical Storm/Depression, 1..5 = Hurricane/Typhoon Cat 1-5)
 * using explicit category, title/summary text hints, or sustained wind speed (km/h).
 */
export function classifyCycloneCategory(
  maxWindKmh: number,
  explicitCategory?: number,
  textHint?: string
): 0 | 1 | 2 | 3 | 4 | 5 {
  if (typeof explicitCategory === 'number' && Number.isFinite(explicitCategory)) {
    const rounded = Math.round(clamp(explicitCategory, 0, 5));
    return rounded as 0 | 1 | 2 | 3 | 4 | 5;
  }

  if (textHint) {
    const m = textHint.match(/\b(?:cat(?:egor[yía]+)?\.?\s*)([1-5])\b/i);
    if (m) {
      return Number(m[1]) as 1 | 2 | 3 | 4 | 5;
    }
  }

  const safeKmh = Number.isFinite(maxWindKmh) ? Math.max(0, maxWindKmh) : 0;
  if (safeKmh >= 252) return 5;
  if (safeKmh >= 209) return 4;
  if (safeKmh >= 178) return 3;
  if (safeKmh >= 154) return 2;
  if (safeKmh >= 119) return 1;
  return 0;
}

/**
 * Estimates central barometric pressure (hPa) from explicit pressure, text hints (hPa/mb),
 * or the Atkinson-Holliday (1977) tropical cyclone pressure-wind relation.
 */
export function estimateCentralPressureHpa(
  maxWindKmh: number,
  explicitPressureHpa?: number,
  textHint?: string
): number {
  if (
    typeof explicitPressureHpa === 'number' &&
    Number.isFinite(explicitPressureHpa) &&
    explicitPressureHpa >= 850 &&
    explicitPressureHpa <= 1030
  ) {
    return Math.round(clamp(explicitPressureHpa, 870, 1015));
  }

  if (textHint) {
    const m = textHint.match(/\b(\d{3,4})\s*(?:hpa|mb)\b/i);
    if (m) {
      const parsed = Number(m[1]);
      if (Number.isFinite(parsed) && parsed >= 850 && parsed <= 1020) {
        return Math.round(clamp(parsed, 870, 1015));
      }
    }
  }

  const safeKmh = Number.isFinite(maxWindKmh) ? Math.max(35, maxWindKmh) : 65;
  const windKts = clamp(safeKmh / 1.852, 20, 190);
  const estimated = 1010 - Math.pow(windKts / 6.7, 1 / 0.644);
  return Math.round(clamp(estimated, 870, 1012));
}

/**
 * Computes a dynamic vorticity (rotational spin) scalar from central barometric pressure deficit,
 * Saffir-Simpson category, and physical radius compactness.
 */
export function computeCycloneVorticityScale(
  centralPressureHpa: number,
  cycloneCategory: 0 | 1 | 2 | 3 | 4 | 5,
  radiusKm: number
): number {
  const safePressure = Number.isFinite(centralPressureHpa)
    ? clamp(centralPressureHpa, 870, 1015)
    : 998;
  const pressureDeficit = clamp((1013 - safePressure) / 55, 0.12, 2.15);
  const categoryFactor = 0.85 + clamp(cycloneCategory, 0, 5) * 0.22;
  const radiusCompactness = clamp(260 / Math.max(140, radiusKm), 0.72, 1.35);

  const rawScale =
    (0.46 + pressureDeficit * 0.58) *
    (0.68 + categoryFactor * 0.34) *
    radiusCompactness;

  return Number(clamp(rawScale, 0.55, 2.85).toFixed(3));
}

/**
 * Extracts active tropical cyclones / severe atmospheric vortices from live events,
 * preserving their physical radiusKm, sustained wind intensity, central pressure, category, and vorticity scale.
 */
export function extractCycloneVorticesFromEvents(
  events: readonly GlobalEvent[]
): CycloneVortexSpec[] {
  const out: CycloneVortexSpec[] = [];
  for (const ev of events) {
    if (ev.category !== 'disaster') continue;
    const isStormSubtype = ev.subtype === 'storm';
    const textHint = `${ev.title} ${ev.summary}`;
    const isCycloneTitle = CYCLONE_TITLE_RE.test(ev.title) || CYCLONE_TITLE_RE.test(ev.summary);
    if (!isStormSubtype && !isCycloneTitle) continue;
    if (!Number.isFinite(ev.lat) || !Number.isFinite(ev.lng)) continue;

    // Parse sustained wind from explicit maxWindKmh, speedKts, or summary/title text
    let windKmh = typeof ev.maxWindKmh === 'number' && ev.maxWindKmh > 0 ? ev.maxWindKmh : 0;
    if (windKmh <= 0 && typeof ev.speedKts === 'number' && ev.speedKts >= 25) {
      windKmh = ev.speedKts * 1.852;
    }
    if (windKmh <= 0) {
      const m = textHint.match(/(\d+(?:\.\d+)?)\s*(km\/h|kmh|nudos|knots|kts|kt)/i);
      if (m) {
        const val = Number(m[1]);
        const unit = m[2].toLowerCase();
        if (Number.isFinite(val) && val > 0) {
          windKmh = unit.includes('km') ? val : val * 1.852;
        }
      }
    }
    if (windKmh <= 0) {
      windKmh = ev.severity === 'critical' ? 185 : ev.severity === 'high' ? 115 : 74;
    }

    const maxWindMs = clamp(windKmh / 3.6, 17.5, 85.0);
    const effectiveWindKmh = maxWindMs * 3.6;

    const rawPressure =
      typeof ev.centralPressureHpa === 'number'
        ? ev.centralPressureHpa
        : typeof ev.rawDetails?.pressureHpa === 'number'
          ? ev.rawDetails.pressureHpa
          : typeof ev.rawDetails?.centralPressure === 'number'
            ? ev.rawDetails.centralPressure
            : undefined;

    const cycloneCategory = classifyCycloneCategory(
      effectiveWindKmh,
      ev.cycloneCategory,
      textHint
    );
    const centralPressureHpa = estimateCentralPressureHpa(
      effectiveWindKmh,
      rawPressure,
      textHint
    );

    const radiusKm = clamp(
      typeof ev.radiusKm === 'number' && ev.radiusKm > 0
        ? ev.radiusKm
        : 185 + effectiveWindKmh * 1.15,
      160,
      620
    );
    const coreRatio = clamp(0.24 - cycloneCategory * 0.014, 0.15, 0.24);
    const coreRadiusKm = clamp(radiusKm * coreRatio, 24, 78);
    const outerInfluenceKm = radiusKm * 1.55;
    const vorticityScale = computeCycloneVorticityScale(
      centralPressureHpa,
      cycloneCategory,
      radiusKm
    );
    // Coriolis rotation: CCW (+1) in Northern Hemisphere, CW (-1) in Southern Hemisphere
    const spinSign: 1 | -1 = ev.lat >= 0 ? 1 : -1;

    out.push({
      id: ev.id,
      title: ev.title,
      lat: ev.lat,
      lng: ev.lng,
      radiusKm,
      coreRadiusKm,
      outerInfluenceKm,
      maxWindMs,
      centralPressureHpa,
      cycloneCategory,
      vorticityScale,
      spinSign,
    });
  }
  return out;
}

export function prepareCycloneVortices(
  vortices: readonly CycloneVortexSpec[]
): PreparedCycloneVortex[] {
  return vortices.map((v) => {
    const c = latLngToCartesian(v.lat, v.lng, 1);
    const outerAngleRad = v.outerInfluenceKm / EARTH_RADIUS_KM;
    const nominalAngleRad = v.radiusKm / EARTH_RADIUS_KM;
    return {
      ...v,
      cx: c.x,
      cy: c.y,
      cz: c.z,
      cosMaxAngle: Math.cos(Math.min(Math.PI, outerAngleRad * 1.02)),
      outerAngleRad,
      nominalAngleRad,
    };
  });
}

/**
 * Evaluates modified Rankine tangential wind + dynamic vorticity scaling + radius-adjusted
 * boundary-layer spiral convergence in 3D unit-sphere tangent coordinates at surface normal (px, py, pz).
 * Returns false if outside the cyclone's outer influence radius.
 */
export function samplePreparedCycloneAtNormal(
  vortex: PreparedCycloneVortex,
  px: number,
  py: number,
  pz: number,
  out: CycloneSampleResult
): boolean {
  const dot = clamp(px * vortex.cx + py * vortex.cy + pz * vortex.cz, -1, 1);
  if (dot < vortex.cosMaxAngle) {
    return false;
  }

  // Chord-based great-circle angle stays accurate even very close to the eye (alpha -> 0)
  const dx = px - vortex.cx;
  const dy = py - vortex.cy;
  const dz = pz - vortex.cz;
  const halfChord = Math.min(1, Math.hypot(dx, dy, dz) * 0.5);
  const angleRad = 2 * Math.asin(halfChord);
  const dKm = angleRad * EARTH_RADIUS_KM;

  if (dKm >= vortex.outerInfluenceKm) {
    return false;
  }

  // Outward tangent vector at P pointing directly away from cyclone eye C:
  // r_out = -C + (C · P) * P  (strictly orthogonal to P)
  let rx = -vortex.cx + dot * px;
  let ry = -vortex.cy + dot * py;
  let rz = -vortex.cz + dot * pz;
  const rLen = Math.hypot(rx, ry, rz);
  if (rLen < 1e-8) {
    // Calm eye center singularity
    out.vx = 0;
    out.vy = 0;
    out.vz = 0;
    out.blendWeight = 0.85;
    out.speedMs = 0;
    out.vorticityScale = vortex.vorticityScale;
    out.spiralCurvature = 0;
    return true;
  }
  const invR = 1 / rLen;
  rx *= invR;
  ry *= invR;
  rz *= invR;

  // Counter-clockwise unit tangent vector looking down onto P: t_ccw = P x r_out
  const tx = (py * rz - pz * ry) * vortex.spinSign;
  const ty = (pz * rx - px * rz) * vortex.spinSign;
  const tz = (px * ry - py * rx) * vortex.spinSign;

  // Dynamic rotational vorticity boost driven by central pressure deficit & category
  const vorticityMod = clamp(0.84 + vortex.vorticityScale * 0.20, 0.76, 1.38);

  let tanSpeed = 0;
  let outerFade = 1;
  if (dKm < vortex.coreRadiusKm) {
    const rRatio = dKm / Math.max(1e-3, vortex.coreRadiusKm);
    const coreExp = 1.22 + 0.12 * clamp(vortex.vorticityScale, 0.5, 2.5);
    tanSpeed = vortex.maxWindMs * vorticityMod * Math.pow(rRatio, coreExp);
  } else {
    const decayExp = 0.5 + clamp((vortex.vorticityScale - 1.0) * 0.06, -0.04, 0.12);
    const rankine =
      vortex.maxWindMs * vorticityMod * Math.pow(vortex.coreRadiusKm / dKm, decayExp);
    const fadeStart = vortex.radiusKm * 0.68;
    const tOut = clamp(
      (dKm - fadeStart) / Math.max(1e-3, vortex.outerInfluenceKm - fadeStart),
      0,
      1
    );
    outerFade = 1 - tOut * tOut * (3 - 2 * tOut);
    tanSpeed = rankine * outerFade;
  }

  // Radius-adjusted spiral inflow curvature:
  // Deep low-pressure / high-category cores maintain tighter, more circular eyewall flow,
  // while outer rainbands relative to real radiusKm pull inward along curved spiral arms.
  const eyeInflowFade =
    dKm < vortex.coreRadiusKm
      ? clamp((dKm / Math.max(1e-3, vortex.coreRadiusKm) - 0.16) / 0.84, 0, 1)
      : 1;
  const relRadius = clamp(dKm / Math.max(1, vortex.radiusKm), 0, 1.45);
  const baseInflowRatio = clamp(
    0.42 / Math.pow(Math.max(0.5, vortex.vorticityScale), 0.34),
    0.15,
    0.45
  );
  const spiralInflowRatio = baseInflowRatio * (0.72 + 0.48 * relRadius) * eyeInflowFade;
  const radialInflowSpeed = tanSpeed * spiralInflowRatio;

  out.vx = tx * tanSpeed - rx * radialInflowSpeed;
  out.vy = ty * tanSpeed - ry * radialInflowSpeed;
  out.vz = tz * tanSpeed - rz * radialInflowSpeed;
  out.speedMs = Math.hypot(tanSpeed, radialInflowSpeed);
  out.blendWeight =
    dKm < vortex.coreRadiusKm
      ? 0.94
      : clamp(outerFade * 0.94, 0, 0.94);
  out.vorticityScale = vortex.vorticityScale * outerFade;
  out.spiralCurvature = tanSpeed > 1e-4 ? radialInflowSpeed / tanSpeed : 0;
  return true;
}

const _scratchCycloneSample: CycloneSampleResult = {
  vx: 0,
  vy: 0,
  vz: 0,
  blendWeight: 0,
  speedMs: 0,
  vorticityScale: 0,
  spiralCurvature: 0,
};

/**
 * Samples global background wind at (lat, lng) combined with any active Rankine cyclone vortices.
 */
export function sampleWindFieldWithCyclones(
  field: Pick<
    GlobalWindFieldResponse,
    'minLat' | 'maxLat' | 'latStepDeg' | 'minLng' | 'lngStepDeg' | 'rows' | 'cols' | 'uGrid' | 'vGrid'
  >,
  cyclones: readonly PreparedCycloneVortex[],
  lat: number,
  lng: number
): { uEastMs: number; vNorthMs: number; speedMs: number; speedKmh: number } {
  const base = sampleWindFieldAtLatLng(field, lat, lng);
  if (cyclones.length === 0) {
    return base;
  }

  const p = latLngToCartesian(lat, lng, 1);
  let basis: ReturnType<typeof tangentEastNorthAtNormal> | null = null;
  let uEastMs = base.uEastMs;
  let vNorthMs = base.vNorthMs;

  for (let i = 0; i < cyclones.length; i++) {
    if (!samplePreparedCycloneAtNormal(cyclones[i], p.x, p.y, p.z, _scratchCycloneSample)) {
      continue;
    }
    if (!basis) {
      basis = tangentEastNorthAtNormal(p.x, p.y, p.z);
    }
    const cEast =
      _scratchCycloneSample.vx * basis.ex +
      _scratchCycloneSample.vy * basis.ey +
      _scratchCycloneSample.vz * basis.ez;
    const cNorth =
      _scratchCycloneSample.vx * basis.northX +
      _scratchCycloneSample.vy * basis.northY +
      _scratchCycloneSample.vz * basis.northZ;
    const w = _scratchCycloneSample.blendWeight;
    uEastMs = uEastMs * (1 - w) + cEast;
    vNorthMs = vNorthMs * (1 - w) + cNorth;
  }

  const speedMs = Math.hypot(uEastMs, vNorthMs);
  return {
    uEastMs,
    vNorthMs,
    speedMs,
    speedKmh: speedMs * 3.6,
  };
}

/**
 * Computes legend max speed & peak coordinate accounting for both the global wind grid
 * and any active tropical cyclones whose sustained winds exceed the grid peak.
 */
export function getEffectiveWindLegendMetrics(
  field: GlobalWindFieldResponse,
  cyclones: readonly CycloneVortexSpec[]
): { maxSpeedKmh: number; peakPoint: WindPeakPoint | null; activeCycloneCount: number } {
  let maxSpeedKmh = field.metrics.maxSpeedKmh;
  let peakPoint = field.metrics.peakPoint;

  for (const c of cyclones) {
    const cycKmh = Math.round(c.maxWindMs * 3.6);
    if (cycKmh > maxSpeedKmh) {
      maxSpeedKmh = cycKmh;
      peakPoint = {
        lat: Number(c.lat.toFixed(2)),
        lng: Number(c.lng.toFixed(2)),
        speedKmh: cycKmh,
        directionFromDeg: 0,
      };
    }
  }

  return {
    maxSpeedKmh,
    peakPoint,
    activeCycloneCount: cyclones.length,
  };
}

/**
 * Physical angular advection scale on the unit sphere (radians/sec per m/s).
 * Kept invariant with respect to camera altitude so real atmospheric velocity
 * never slows down when zooming in or accelerates unnaturally when zooming out;
 * apparent screen-space speed naturally scales as 1 / altitude.
 */
export const BASE_WIND_ADVECT_SCALE = 0.0056;

export function computeWindAdvectionScale(_altitudeUnits: number): number {
  return BASE_WIND_ADVECT_SCALE;
}

