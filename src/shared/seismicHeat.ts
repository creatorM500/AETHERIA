import { clamp } from './geo.ts';
import type { SeismicHeatScaleMetrics, SeismicQuake24h } from './types.ts';

export const HOURS_24_MS = 24 * 3600 * 1000;

export interface NormalizedHeatPoint {
  quake: SeismicQuake24h;
  /** Combined magnitude + recency energy intensity in [0.05, 1.0] */
  heatWeight01: number;
  /** Recency decay weight in [0.42, 1.0] across the last 24 hours */
  recencyWeight: number;
  /** Dynamic color RGB [0..1] along the active thermal ramp */
  rgb: [number, number, number];
}

const HEAT_RAMP_STOPS: Array<{ t: number; rgb: [number, number, number] }> = [
  { t: 0.0, rgb: [0.03, 0.25, 0.45] },  // Deep teal-blue baseline
  { t: 0.2, rgb: [0.02, 0.71, 0.83] },  // Cyan (#06b6d4)
  { t: 0.42, rgb: [0.13, 0.77, 0.37] }, // Emerald (#22c55e)
  { t: 0.62, rgb: [0.98, 0.8, 0.08] },  // Solar yellow (#facc15)
  { t: 0.8, rgb: [0.98, 0.45, 0.09] },  // Molten orange (#f97316)
  { t: 0.93, rgb: [0.94, 0.27, 0.27] }, // Crimson (#ef4444)
  { t: 1.0, rgb: [1.0, 0.94, 0.82] },   // Incandescent peak core
];

/**
 * Samples the continuous dynamic thermal color gradient at t in [0, 1].
 */
export function sampleDynamicHeatColor(t01: number): [number, number, number] {
  const t = clamp(t01, 0, 1);
  for (let i = 0; i < HEAT_RAMP_STOPS.length - 1; i++) {
    const a = HEAT_RAMP_STOPS[i];
    const b = HEAT_RAMP_STOPS[i + 1];
    if (t <= b.t) {
      const f = (t - a.t) / Math.max(1e-5, b.t - a.t);
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
      ];
    }
  }
  return [...HEAT_RAMP_STOPS[HEAT_RAMP_STOPS.length - 1].rgb];
}

/**
 * Filters raw quakes strictly to the trailing 24-hour window and computes
 * dynamic thermal scale bounds adapted to the currently active seismic range.
 */
export function computeDynamicHeatScale(
  rawQuakes: SeismicQuake24h[],
  nowMs = Date.now()
): { quakes24h: SeismicQuake24h[]; metrics: SeismicHeatScaleMetrics } {
  const cutoffMs = nowMs - HOURS_24_MS;
  const quakes24h = rawQuakes
    .filter(
      (q) =>
        Number.isFinite(q.lat) &&
        Number.isFinite(q.lng) &&
        Number.isFinite(q.magnitude) &&
        q.occurredAtMs >= cutoffMs &&
        q.occurredAtMs <= nowMs + 60_000
    )
    .sort((a, b) => b.magnitude - a.magnitude || b.occurredAtMs - a.occurredAtMs);

  if (quakes24h.length === 0) {
    return {
      quakes24h: [],
      metrics: {
        count24h: 0,
        minMag: 1.0,
        midMag: 3.5,
        maxMag: 6.0,
        peakDensityScore: 0,
        peakQuake: null,
        windowStartIso: new Date(cutoffMs).toISOString(),
        windowEndIso: new Date(nowMs).toISOString(),
      },
    };
  }

  let observedMin = Infinity;
  let observedMax = -Infinity;
  let peakQuake = quakes24h[0];
  for (const q of quakes24h) {
    if (q.magnitude < observedMin) observedMin = q.magnitude;
    if (q.magnitude > observedMax) {
      observedMax = q.magnitude;
      peakQuake = q;
    }
  }

  // Ensure a meaningful dynamic span (at least 2.5 magnitude units) while anchoring to live extremes
  const minMag = Number(Math.max(0, Math.min(observedMin, observedMax - 2.5)).toFixed(1));
  const maxMag = Number(Math.max(observedMax, minMag + 2.5).toFixed(1));
  const midMag = Number(((minMag + maxMag) * 0.5).toFixed(1));

  return {
    quakes24h,
    metrics: {
      count24h: quakes24h.length,
      minMag,
      midMag,
      maxMag,
      peakDensityScore: 1,
      peakQuake,
      windowStartIso: new Date(cutoffMs).toISOString(),
      windowEndIso: new Date(nowMs).toISOString(),
    },
  };
}

/**
 * Computes each earthquake's normalized intensity [0, 1] against the dynamic 24h window,
 * blending logarithmic seismic energy release with 24h temporal recency.
 */
export function normalizeQuakesForDynamicHeat(
  quakes24h: SeismicQuake24h[],
  metrics: SeismicHeatScaleMetrics,
  nowMs = Date.now()
): NormalizedHeatPoint[] {
  const span = Math.max(1.5, metrics.maxMag - metrics.minMag);
  return quakes24h.map((quake) => {
    const magNorm = clamp((quake.magnitude - metrics.minMag) / span, 0, 1);
    // Logarithmic seismic energy curve gives M5-M7 events strong thermal dominance over M1 swarms
    const energyCurve = Math.pow(magNorm, 1.35);
    const ageRatio = clamp((nowMs - quake.occurredAtMs) / HOURS_24_MS, 0, 1);
    const recencyWeight = 1.0 - ageRatio * 0.45;
    // Shallow quakes (< 35km) slightly hotter surface expression than deep 400km mantle events
    const depthFactor = 1.0 - clamp(quake.depthKm / 500, 0, 0.22);
    const heatWeight01 = clamp((0.12 + energyCurve * 0.88) * recencyWeight * depthFactor, 0.06, 1.0);
    return {
      quake,
      heatWeight01,
      recencyWeight,
      rgb: sampleDynamicHeatColor(heatWeight01),
    };
  });
}

/**
 * Rasterizes overlapping 24h seismic events into an equirectangular scalar density buffer
 * (Uint8Array, [0..255]) with cos(latitude) spherical radius compensation and ±180° antimeridian wrap.
 * Output orientation matches Three.js SphereGeometry DataTexture(flipY = false) UV mapping (row 0 = -90° South Pole, row H-1 = +90° North Pole).
 */
export function rasterizeEquirectangularHeatField(
  points: NormalizedHeatPoint[],
  width = 720,
  height = 360
): { field: Uint8Array; maxRawDensity: number } {
  const len = width * height;
  const accumSum = new Float32Array(len);
  const accumMax = new Float32Array(len);
  if (points.length === 0) {
    return { field: new Uint8Array(len), maxRawDensity: 0 };
  }

  const resScale = height / 180;

  for (let pIdx = 0; pIdx < points.length; pIdx++) {
    const pt = points[pIdx];
    const { lat, lng, magnitude } = pt.quake;

    // Equirectangular UV matching Three.js SphereGeometry:
    // u = (lng + 180) / 360, v (bottom-up for DataTexture flipY=false) = (lat + 90) / 180
    const u = ((lng + 180) % 360 + 360) % 360 / 360;
    const v = clamp((lat + 90) / 180, 0, 1);
    const cx = u * (width - 1);
    const cy = v * (height - 1);

    // Smooth Gaussian kernel scaled by texture resolution (sigmaY in [3.8..9.6] px at 720x360)
    const sigmaY = clamp((1.85 + Math.max(0, magnitude - 1.0) * 0.46) * resScale, 1.85 * resScale, 5.0 * resScale);
    const cosLat = Math.max(0.24, Math.cos((lat * Math.PI) / 180));
    const sigmaX = clamp(sigmaY / cosLat, sigmaY, width * 0.10);

    const radY = Math.ceil(sigmaY * 3.1);
    const radX = Math.ceil(sigmaX * 3.1);
    const invTwoSigX2 = 1 / (2 * sigmaX * sigmaX);
    const invTwoSigY2 = 1 / (2 * sigmaY * sigmaY);

    // Non-linear seismic energy curve ensures M5-M7 earthquakes dominate M1-M2 micro-tremor swarms
    const amp = 0.065 + Math.pow(pt.heatWeight01, 2.15) * 2.85;

    const minY = Math.max(0, Math.floor(cy - radY));
    const maxY = Math.min(height - 1, Math.ceil(cy + radY));
    const minX = Math.floor(cx - radX);
    const maxX = Math.ceil(cx + radX);

    for (let y = minY; y <= maxY; y++) {
      const dy = y - cy;
      const gy = dy * dy * invTwoSigY2;
      if (gy > 9.5) continue;
      const rowOffset = y * width;

      for (let rx = minX; rx <= maxX; rx++) {
        const dx = rx - cx;
        const gx = dx * dx * invTwoSigX2;
        const distTerm = gx + gy;
        if (distTerm > 9.5) continue;
        // Wrap horizontally across ±180° Pacific antimeridian cleanly
        const wx = ((rx % width) + width) % width;
        const contrib = amp * Math.exp(-distTerm);
        const idx = rowOffset + wx;
        accumSum[idx] += contrib;
        if (contrib > accumMax[idx]) {
          accumMax[idx] = contrib;
        }
      }
    }
  }

  const combined = new Float32Array(len);
  let maxRawDensity = 0;
  for (let i = 0; i < len; i++) {
    const peak = accumMax[i];
    if (peak <= 0) continue;
    const overlap = Math.max(0, accumSum[i] - peak);
    // Swarms warm clusters smoothly (up to +0.62) without overpowering a single major M6+ event
    const val = peak + Math.min(0.62, Math.log1p(overlap) * 0.28);
    combined[i] = val;
    if (val > maxRawDensity) maxRawDensity = val;
  }

  const field = new Uint8Array(len);
  if (maxRawDensity <= 1e-6) {
    return { field, maxRawDensity: 0 };
  }

  const normDenom = Math.log1p(Math.max(0.9, maxRawDensity) * 1.4);
  for (let i = 0; i < len; i++) {
    const val = combined[i];
    if (val <= 0.004) continue;
    const scaled = clamp(Math.log1p(val * 1.4) / normDenom, 0, 1);
    field[i] = Math.round(Math.pow(scaled, 0.85) * 255);
  }

  return { field, maxRawDensity };
}
