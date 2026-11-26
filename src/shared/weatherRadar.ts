import { clamp, haversineKm } from './geo.ts';
import type {
  CycloneForecastCone,
  CycloneForecastWaypoint,
  CycloneVortexSpec,
  GlobalWeatherRadarResponse,
  GlobalWindFieldResponse,
  IsobarContourSegment,
  LatLngPoint,
  WeatherRadarMetrics,
  WeatherRadarPeakPoint,
} from './types.ts';
import {
  EARTH_RADIUS_KM,
  prepareCycloneVortices,
  sampleWindFieldAtLatLng,
} from './windField.ts';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export const DEFAULT_ISOBAR_LEVELS_HPA = [980, 988, 996, 1004, 1012, 1020, 1026] as const;

export const PRECIP_LOG_MAX_MMH = 72;

export function encodePrecipNorm(mmH: number): number {
  if (!Number.isFinite(mmH) || mmH <= 0) return 0;
  return clamp(Math.log1p(mmH) / Math.log1p(PRECIP_LOG_MAX_MMH), 0, 1);
}

export const WEATHER_RADAR_GRID_SPEC = {
  minLat: -75,
  maxLat: 75,
  latStepDeg: 15,
  minLng: -180,
  lngStepDeg: 20,
  rows: 11,
  cols: 18,
} as const;

export function wrapLngDeg(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

export function computeWeatherRadarMetrics(
  minLat: number,
  latStepDeg: number,
  minLng: number,
  lngStepDeg: number,
  rows: number,
  cols: number,
  precipGrid: number[],
  pressureGrid: number[]
): WeatherRadarMetrics {
  const total = rows * cols;
  if (total === 0) {
    return {
      gridRows: rows,
      gridCols: cols,
      sampleCount: 0,
      minPressureHpa: 1013,
      maxPressureHpa: 1013,
      avgPressureHpa: 1013,
      maxPrecipMmH: 0,
      peakPrecipPoint: null,
    };
  }

  let minP = Infinity;
  let maxP = -Infinity;
  let sumP = 0;
  let maxPrecip = -1;
  let peakPrecipPoint: WeatherRadarPeakPoint | null = null;

  for (let r = 0; r < rows; r++) {
    const lat = minLat + r * latStepDeg;
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const p = Number.isFinite(pressureGrid[idx]) ? pressureGrid[idx] : 1013.2;
      const rain = Number.isFinite(precipGrid[idx]) ? Math.max(0, precipGrid[idx]) : 0;
      if (p < minP) minP = p;
      if (p > maxP) maxP = p;
      sumP += p;
      if (rain > maxPrecip) {
        maxPrecip = rain;
        const lng = minLng + c * lngStepDeg;
        peakPrecipPoint = {
          lat: Number(lat.toFixed(2)),
          lng: Number(lng.toFixed(2)),
          precipMmH: Number(rain.toFixed(1)),
          pressureHpa: Math.round(p),
        };
      }
    }
  }

  return {
    gridRows: rows,
    gridCols: cols,
    sampleCount: total,
    minPressureHpa: Math.round(minP === Infinity ? 1013 : minP),
    maxPressureHpa: Math.round(maxP === -Infinity ? 1013 : maxP),
    avgPressureHpa: Math.round(sumP / total),
    maxPrecipMmH: Number(Math.max(0, maxPrecip).toFixed(1)),
    peakPrecipPoint,
  };
}

/**
 * Deterministic global synoptic radar + sea-level pressure baseline used when
 * Open-Meteo is temporarily unavailable or while initializing telemetry.
 */
export function buildAtmosphericBaselineRadarField(
  nowMs = Date.now()
): GlobalWeatherRadarResponse {
  const { minLat, latStepDeg, minLng, lngStepDeg, rows, cols } = WEATHER_RADAR_GRID_SPEC;
  const precipGrid = new Array<number>(rows * cols);
  const pressureGrid = new Array<number>(rows * cols);
  const cloudGrid = new Array<number>(rows * cols);
  const phaseHours = (nowMs / 3_600_000) * 0.25;

  for (let r = 0; r < rows; r++) {
    const lat = minLat + r * latStepDeg;
    const absLat = Math.abs(lat);
    const latRad = lat * DEG_TO_RAD;

    // Subtropical highs (~30°), equatorial trough (~4°), subpolar lows (~58°)
    const subtropicalHigh = Math.exp(-Math.pow((absLat - 30) / 14, 2)) * 9.5;
    const polarLow = Math.exp(-Math.pow((absLat - 58) / 13, 2)) * 13.5;
    const itczTrough = Math.exp(-Math.pow((lat - 4) / 9, 2)) * 5.2;

    const itczRain = Math.exp(-Math.pow((lat - 5) / 7.5, 2)) * 7.8;
    const stormBeltRain = Math.exp(-Math.pow((absLat - 50) / 11, 2)) * 6.4;

    for (let c = 0; c < cols; c++) {
      const lng = minLng + c * lngStepDeg;
      const lngRad = lng * DEG_TO_RAD;
      const idx = r * cols + c;

      const rossby =
        Math.sin(lngRad * 3 + latRad * 2.1 + phaseHours * 0.45) * 4.8 +
        Math.cos(lngRad * 2 - latRad * 3.0 - phaseHours * 0.3) * 3.2;

      const pressure = clamp(
        1013.2 + subtropicalHigh - polarLow - itczTrough + rossby,
        972,
        1036
      );

      const rainWave = Math.max(0, Math.sin(lngRad * 4 + latRad * 3 + phaseHours * 0.6));
      const troughBoost = clamp((1008 - pressure) / 18, 0, 1) * 5.8;
      const precip = clamp(
        (itczRain + stormBeltRain) * (0.38 + 0.62 * rainWave) + troughBoost - 1.1,
        0,
        36
      );

      const cloud = clamp(18 + precip * 4.5 + clamp((1014 - pressure) * 2.2, 0, 42), 5, 98);

      pressureGrid[idx] = Number(pressure.toFixed(1));
      precipGrid[idx] = Number(precip.toFixed(2));
      cloudGrid[idx] = Math.round(cloud);
    }
  }

  return {
    ...WEATHER_RADAR_GRID_SPEC,
    precipGrid,
    pressureGrid,
    cloudGrid,
    metrics: computeWeatherRadarMetrics(
      minLat,
      latStepDeg,
      minLng,
      lngStepDeg,
      rows,
      cols,
      precipGrid,
      pressureGrid
    ),
    source: 'baseline-sinoptico-global',
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function catmullRom1D(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Antimeridian-safe C1-smooth bicubic Catmull-Rom sampler for global precipitation (mm/h),
 * sea-level pressure (hPa), and cloud cover (%). Eliminates coarse 15°x20° grid kinks on isobars.
 */
export function sampleWeatherRadarAtLatLng(
  field: Pick<
    GlobalWeatherRadarResponse,
    | 'minLat'
    | 'latStepDeg'
    | 'minLng'
    | 'lngStepDeg'
    | 'rows'
    | 'cols'
    | 'precipGrid'
    | 'pressureGrid'
    | 'cloudGrid'
  >,
  lat: number,
  lng: number
): { precipMmH: number; pressureHpa: number; cloudPct: number } {
  const { minLat, latStepDeg, minLng, lngStepDeg, rows, cols, precipGrid, pressureGrid, cloudGrid } =
    field;
  if (rows <= 0 || cols <= 0 || pressureGrid.length < rows * cols) {
    return { precipMmH: 0, pressureHpa: 1013.2, cloudPct: 25 };
  }

  const maxGridLat = minLat + (rows - 1) * latStepDeg;
  const clampedLat = clamp(lat, minLat, maxGridLat);
  const fy = latStepDeg > 0 ? (clampedLat - minLat) / latStepDeg : 0;
  const r1 = Math.min(rows - 1, Math.max(0, Math.floor(fy)));
  const r0 = Math.max(0, r1 - 1);
  const r2 = Math.min(rows - 1, r1 + 1);
  const r3 = Math.min(rows - 1, r1 + 2);
  const wy = fy - r1;

  const wrappedDelta = ((((lng - minLng) % 360) + 360) % 360);
  const fx = lngStepDeg > 0 ? wrappedDelta / lngStepDeg : 0;
  const c1 = Math.floor(fx) % cols;
  const c0 = (c1 - 1 + cols) % cols;
  const c2 = (c1 + 1) % cols;
  const c3 = (c1 + 2) % cols;
  const wx = fx - Math.floor(fx);

  const rowIndices = [r0, r1, r2, r3];
  const colIndices = [c0, c1, c2, c3];

  const sampleBicubic = (arr: number[], fallback: number, minVal: number, maxVal: number): number => {
    if (arr.length < rows * cols) return fallback;
    let y0 = 0;
    let y1 = 0;
    let y2 = 0;
    let y3 = 0;
    for (let ri = 0; ri < 4; ri++) {
      const base = rowIndices[ri] * cols;
      const val = catmullRom1D(
        arr[base + colIndices[0]],
        arr[base + colIndices[1]],
        arr[base + colIndices[2]],
        arr[base + colIndices[3]],
        wx
      );
      if (ri === 0) y0 = val;
      else if (ri === 1) y1 = val;
      else if (ri === 2) y2 = val;
      else y3 = val;
    }
    return clamp(catmullRom1D(y0, y1, y2, y3, wy), minVal, maxVal);
  };

  return {
    precipMmH: sampleBicubic(precipGrid, 0, 0, 200),
    pressureHpa: sampleBicubic(pressureGrid, 1013.2, 860, 1055),
    cloudPct: sampleBicubic(cloudGrid, 25, 0, 100),
  };
}

/**
 * Superposes active tropical cyclones onto the background synoptic weather field:
 * carves realistic Holland-profile barometric pressure wells around each eye and
 * synthesizes eyewall + logarithmic spiral rainbands matching real storm scale.
 */
export function superposeCyclonesOnWeather(
  base: { precipMmH: number; pressureHpa: number; cloudPct: number },
  cyclones: readonly CycloneVortexSpec[],
  lat: number,
  lng: number
): { precipMmH: number; pressureHpa: number; cloudPct: number } {
  if (cyclones.length === 0) return base;

  let pressureHpa = base.pressureHpa;
  let precipMmH = base.precipMmH;
  let cloudPct = base.cloudPct;

  for (let i = 0; i < cyclones.length; i++) {
    const cyc = cyclones[i];
    if (Math.abs(lat - cyc.lat) > 14) continue;
    const dKm = haversineKm({ lat, lng }, { lat: cyc.lat, lng: cyc.lng });
    if (dKm >= cyc.outerInfluenceKm) continue;

    // Barometric Holland pressure funnel
    const ambientRef = Math.max(cyc.centralPressureHpa + 8, base.pressureHpa);
    const deficit = Math.max(0, ambientRef - cyc.centralPressureHpa);
    const rmw = Math.max(22, cyc.coreRadiusKm);
    const holland = Math.exp(-Math.pow(rmw / Math.max(8, dKm), 1.05));
    const outerTaper = clamp(
      1 - Math.pow(dKm / Math.max(1, cyc.outerInfluenceKm), 1.45),
      0,
      1
    );
    const funnelPressure = cyc.centralPressureHpa + deficit * holland;
    pressureHpa = Math.min(
      pressureHpa,
      base.pressureHpa * (1 - outerTaper) + funnelPressure * outerTaper
    );

    // Eyewall heavy convective ring + multi-arm logarithmic spiral rainbands
    const eyeNorm = dKm / rmw;
    const eyewall = Math.exp(-Math.pow((eyeNorm - 1.02) / 0.52, 2));
    const dLng = wrapLngDeg(lng - cyc.lng) * Math.cos(cyc.lat * DEG_TO_RAD);
    const dLat = lat - cyc.lat;
    const theta = Math.atan2(dLat, dLng);
    const spiralPhase =
      theta * 2 - cyc.spinSign * Math.log(Math.max(1, dKm) / rmw) * 2.45;
    const primaryArm = Math.pow(0.5 + 0.5 * Math.cos(spiralPhase), 2.15);
    const secondaryArm = Math.pow(0.5 + 0.5 * Math.cos(spiralPhase * 1.5 - 0.85), 2.8);
    const bandMask = primaryArm * 0.68 + secondaryArm * 0.32;
    const radialEnvelope =
      dKm < cyc.coreRadiusKm * 0.42
        ? 0.18
        : clamp(1 - (dKm - cyc.coreRadiusKm) / Math.max(1, cyc.outerInfluenceKm - cyc.coreRadiusKm), 0, 1);

    const catBoost = 34 + cyc.cycloneCategory * 11.5;
    const cycRain =
      eyewall * catBoost + bandMask * radialEnvelope * (18 + cyc.cycloneCategory * 5.0);

    precipMmH = Math.max(precipMmH, cycRain + base.precipMmH * 0.25);
    cloudPct = Math.max(cloudPct, clamp(58 + radialEnvelope * 40, 0, 99));
  }

  return {
    precipMmH: Math.max(0, precipMmH),
    pressureHpa: clamp(pressureHpa, 880, 1045),
    cloudPct: clamp(cloudPct, 0, 100),
  };
}

/**
 * Maps precipitation rate (mm/h) to a meteorological Doppler RGBA [0..255] tuple.
 * Transparent below 0.25 mm/h so clear skies expose terrain and night lights cleanly.
 */
export function precipMmHToRGBA(mmH: number): [number, number, number, number] {
  if (!Number.isFinite(mmH) || mmH < 0.25) {
    return [0, 0, 0, 0];
  }
  const stops: Array<{ v: number; rgba: [number, number, number, number] }> = [
    { v: 0.25, rgba: [56, 189, 248, 36] },   // Trace mist: atmospheric sky cyan
    { v: 1.4, rgba: [16, 185, 129, 108] },   // Light rain: crisp Doppler emerald
    { v: 4.8, rgba: [132, 204, 22, 152] },   // Moderate rain: chartreuse-green
    { v: 11.5, rgba: [250, 204, 21, 186] },  // Heavy rain: amber gold
    { v: 22.0, rgba: [249, 115, 22, 212] },  // Intense storm: vivid orange
    { v: 38.0, rgba: [239, 68, 68, 228] },   // Extreme squall: crimson
    { v: 62.0, rgba: [232, 121, 249, 244] }, // Cyclone eyewall core: magenta-violet
  ];

  if (mmH >= stops[stops.length - 1].v) {
    return [...stops[stops.length - 1].rgba];
  }

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (mmH <= b.v) {
      const f = (mmH - a.v) / Math.max(1e-6, b.v - a.v);
      return [
        Math.round(a.rgba[0] + (b.rgba[0] - a.rgba[0]) * f),
        Math.round(a.rgba[1] + (b.rgba[1] - a.rgba[1]) * f),
        Math.round(a.rgba[2] + (b.rgba[2] - a.rgba[2]) * f),
        Math.round(a.rgba[3] + (b.rgba[3] - a.rgba[3]) * f),
      ];
    }
  }
  return [232, 121, 249, 244];
}

/**
 * Extracts clean sea-level isobar contour line segments via Marching Squares across
 * a 2.5° lat x 3° lng global mesh, incorporating tropical cyclone low-pressure wells.
 */
export function extractIsobarSegments(
  field: GlobalWeatherRadarResponse,
  cyclones: readonly CycloneVortexSpec[] = [],
  levelsHpa: readonly number[] = DEFAULT_ISOBAR_LEVELS_HPA
): IsobarContourSegment[] {
  const minLat = -75;
  const maxLat = 75;
  const latStep = 2.5;
  const lngStep = 3;
  const rows = Math.floor((maxLat - minLat) / latStep) + 1; // 61
  const cols = Math.floor(360 / lngStep); // 120

  const pGrid = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const lat = minLat + r * latStep;
    for (let c = 0; c < cols; c++) {
      const lng = -180 + c * lngStep;
      const base = sampleWeatherRadarAtLatLng(field, lat, lng);
      const combined = superposeCyclonesOnWeather(base, cyclones, lat, lng);
      pGrid[r * cols + c] = combined.pressureHpa;
    }
  }

  const segments: IsobarContourSegment[] = [];

  const interpEdge = (
    latA: number,
    lngA: number,
    vA: number,
    latB: number,
    lngB: number,
    vB: number,
    iso: number
  ): [number, number] => {
    const denom = vB - vA;
    const t = Math.abs(denom) < 1e-6 ? 0.5 : clamp((iso - vA) / denom, 0, 1);
    return [latA + (latB - latA) * t, wrapLngDeg(lngA + (lngB - lngA) * t)];
  };

  for (let r = 0; r < rows - 1; r++) {
    const lat0 = minLat + r * latStep;
    const lat1 = lat0 + latStep;

    for (let c = 0; c < cols; c++) {
      const cNext = (c + 1) % cols;
      const lng0 = -180 + c * lngStep;
      const lng1 = lng0 + lngStep; // Keep continuous local cell width for interpolation

      // Corners: bl(lat0,lng0), br(lat0,lng1), tr(lat1,lng1), tl(lat1,lng0)
      const vBL = pGrid[r * cols + c];
      const vBR = pGrid[r * cols + cNext];
      const vTR = pGrid[(r + 1) * cols + cNext];
      const vTL = pGrid[(r + 1) * cols + c];

      const minCell = Math.min(vBL, vBR, vTR, vTL);
      const maxCell = Math.max(vBL, vBR, vTR, vTL);

      for (let li = 0; li < levelsHpa.length; li++) {
        const iso = levelsHpa[li];
        if (iso <= minCell || iso > maxCell) continue;

        let mask = 0;
        if (vBL >= iso) mask |= 1;
        if (vBR >= iso) mask |= 2;
        if (vTR >= iso) mask |= 4;
        if (vTL >= iso) mask |= 8;
        if (mask === 0 || mask === 15) continue;

        const bottom = () => interpEdge(lat0, lng0, vBL, lat0, lng1, vBR, iso);
        const right = () => interpEdge(lat0, lng1, vBR, lat1, lng1, vTR, iso);
        const top = () => interpEdge(lat1, lng0, vTL, lat1, lng1, vTR, iso);
        const left = () => interpEdge(lat0, lng0, vBL, lat1, lng0, vTL, iso);

        const pushSeg = (p1: [number, number], p2: [number, number]) => {
          // Guard antimeridian wrap artifacts by keeping segments local to the 6° cell
          if (Math.abs(p1[1] - p2[1]) > 180) return;
          segments.push({
            lat1: p1[0],
            lng1: p1[1],
            lat2: p2[0],
            lng2: p2[1],
            levelHpa: iso,
          });
        };

        switch (mask) {
          case 1:
          case 14:
            pushSeg(left(), bottom());
            break;
          case 2:
          case 13:
            pushSeg(bottom(), right());
            break;
          case 3:
          case 12:
            pushSeg(left(), right());
            break;
          case 4:
          case 11:
            pushSeg(right(), top());
            break;
          case 5: {
            const center = (vBL + vBR + vTR + vTL) * 0.25;
            if (center >= iso) {
              pushSeg(left(), top());
              pushSeg(bottom(), right());
            } else {
              pushSeg(left(), bottom());
              pushSeg(right(), top());
            }
            break;
          }
          case 6:
          case 9:
            pushSeg(bottom(), top());
            break;
          case 7:
          case 8:
            pushSeg(left(), top());
            break;
          case 10: {
            const center = (vBL + vBR + vTR + vTL) * 0.25;
            if (center >= iso) {
              pushSeg(left(), bottom());
              pushSeg(right(), top());
            } else {
              pushSeg(left(), top());
              pushSeg(bottom(), right());
            }
            break;
          }
        }
      }
    }
  }

  return segments;
}

function offsetLatLngKm(
  lat: number,
  lng: number,
  bearingRad: number,
  distKm: number
): LatLngPoint {
  const latRad = lat * DEG_TO_RAD;
  const angDist = distKm / EARTH_RADIUS_KM;
  const nextLatRad = Math.asin(
    clamp(
      Math.sin(latRad) * Math.cos(angDist) +
        Math.cos(latRad) * Math.sin(angDist) * Math.cos(bearingRad),
      -1,
      1
    )
  );
  const dLngRad = Math.atan2(
    Math.sin(bearingRad) * Math.sin(angDist) * Math.cos(latRad),
    Math.cos(angDist) - Math.sin(latRad) * Math.sin(nextLatRad)
  );
  return {
    lat: clamp(nextLatRad * RAD_TO_DEG, -82, 82),
    lng: wrapLngDeg(lng + dLngRad * RAD_TO_DEG),
  };
}

/**
 * Generates an NHC-style 72-hour tropical cyclone steering forecast track & expanding
 * cone of uncertainty driven by environmental steering flow from the global wind field
 * plus planetary Coriolis beta-drift.
 */
export function computeCycloneForecastCone(
  cyclone: CycloneVortexSpec,
  windField: GlobalWindFieldResponse | null,
  horizonHours = 72
): CycloneForecastCone {
  const stepHours = 12;
  const numSteps = Math.max(2, Math.round(horizonHours / stepHours));
  const waypoints: CycloneForecastWaypoint[] = [];

  let curLat = cyclone.lat;
  let curLng = cyclone.lng;
  const initialWindKmh = Math.round(cyclone.maxWindMs * 3.6);
  const initialPressureHpa = cyclone.centralPressureHpa;
  const hemiPoleSign = cyclone.lat >= 0 ? 1 : -1;

  for (let s = 0; s <= numSteps; s++) {
    const hoursAhead = s * stepHours;
    // NHC 12h/24h/36h/48h/72h expanding cone radii (~50 km -> ~290 km)
    const coneRadiusKm = Math.round(
      Math.max(26, cyclone.coreRadiusKm * 0.65) + hoursAhead * 3.65
    );
    const decayFactor = 1 - (hoursAhead / 140) * 0.22;
    const projectedWindKmh = Math.round(Math.max(55, initialWindKmh * decayFactor));
    const projectedPressureHpa = Math.round(
      clamp(initialPressureHpa + (1010 - initialPressureHpa) * (hoursAhead / 160) * 0.35, 890, 1012)
    );

    waypoints.push({
      hoursAhead,
      lat: Number(curLat.toFixed(3)),
      lng: Number(curLng.toFixed(3)),
      coneRadiusKm,
      projectedWindKmh,
      projectedPressureHpa,
    });

    if (s < numSteps) {
      // Sample environmental steering wind slightly ahead & average
      const env = windField
        ? sampleWindFieldAtLatLng(windField, curLat, curLng)
        : {
            uEastMs: Math.abs(curLat) < 26 ? -5.8 : 7.2,
            vNorthMs: hemiPoleSign * 2.2,
            speedMs: 6.2,
            speedKmh: 22.3,
          };

      // Planetary beta-drift steers tropical cyclones poleward & slightly westward/eastward with latitude
      const tradeBias = clamp((24 - Math.abs(curLat)) / 18, -1, 1);
      const uSteerMs = env.uEastMs * 0.62 - tradeBias * 2.4;
      const vSteerMs = env.vNorthMs * 0.58 + hemiPoleSign * 2.1;
      const steerSpeedMs = clamp(Math.hypot(uSteerMs, vSteerMs), 4.2, 10.5); // ~15-38 km/h
      const bearingRad = Math.atan2(uSteerMs, vSteerMs);
      const stepKm = steerSpeedMs * 3.6 * stepHours;
      const nextPt = offsetLatLngKm(curLat, curLng, bearingRad, stepKm);
      curLat = nextPt.lat;
      curLng = nextPt.lng;
    }
  }

  const leftEdge: LatLngPoint[] = [];
  const rightEdge: LatLngPoint[] = [];

  for (let i = 0; i < waypoints.length; i++) {
    const prev = waypoints[Math.max(0, i - 1)];
    const next = waypoints[Math.min(waypoints.length - 1, i + 1)];
    const dLat = next.lat - prev.lat;
    const dLng = wrapLngDeg(next.lng - prev.lng) * Math.cos(waypoints[i].lat * DEG_TO_RAD);
    const trackBearing = Math.atan2(dLng, dLat);

    const wp = waypoints[i];
    leftEdge.push(offsetLatLngKm(wp.lat, wp.lng, trackBearing - Math.PI / 2, wp.coneRadiusKm));
    rightEdge.push(offsetLatLngKm(wp.lat, wp.lng, trackBearing + Math.PI / 2, wp.coneRadiusKm));
  }

  // Semicircular cap around the final 72h uncertainty circle + closed perimeter
  const lastWp = waypoints[waypoints.length - 1];
  const prevWp = waypoints[waypoints.length - 2] ?? lastWp;
  const finalBearing = Math.atan2(
    wrapLngDeg(lastWp.lng - prevWp.lng) * Math.cos(lastWp.lat * DEG_TO_RAD),
    lastWp.lat - prevWp.lat
  );
  const capPoints: LatLngPoint[] = [];
  for (let k = 1; k <= 5; k++) {
    const ang = finalBearing - Math.PI / 2 + (k / 6) * Math.PI;
    capPoints.push(offsetLatLngKm(lastWp.lat, lastWp.lng, ang, lastWp.coneRadiusKm));
  }

  const conePolygon: LatLngPoint[] = [
    ...leftEdge,
    ...capPoints,
    ...[...rightEdge].reverse(),
  ];

  return {
    cycloneId: cyclone.id,
    title: cyclone.title,
    cycloneCategory: cyclone.cycloneCategory,
    waypoints,
    leftEdge,
    rightEdge,
    conePolygon,
  };
}

/**
 * Convenience helper converting windField + cyclones to prepared vortices.
 */
export function buildForecastConesForCyclones(
  cyclones: readonly CycloneVortexSpec[],
  windField: GlobalWindFieldResponse | null
): CycloneForecastCone[] {
  return cyclones.map((c) => computeCycloneForecastCone(c, windField));
}

export function prepareCyclonesSafe(cyclones: readonly CycloneVortexSpec[]) {
  return prepareCycloneVortices(cyclones);
}
