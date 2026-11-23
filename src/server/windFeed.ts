import type { GlobalWindFieldResponse } from '../shared/types.ts';
import {
  buildAtmosphericBaselineWindField,
  computeWindFieldMetrics,
  meteorologicalToUV,
} from '../shared/windField.ts';

const GRID_MIN_LAT = -75;
const GRID_MAX_LAT = 75;
const GRID_LAT_STEP = 15;
const GRID_MIN_LNG = -180;
const GRID_LNG_STEP = 20;
const GRID_ROWS = 11; // -75 .. +75
const GRID_COLS = 18; // -180 .. +160

const WIND_CACHE_TTL_MS = 600_000; // 10 minutes

let cachedWind: { fetchedAt: number; payload: GlobalWindFieldResponse } | null = null;
let inflightWind: Promise<GlobalWindFieldResponse> | null = null;

interface OpenMeteoPointResult {
  latitude?: number;
  longitude?: number;
  current?: {
    time?: string;
    wind_speed_10m?: number | null;
    wind_direction_10m?: number | null;
  };
}

export async function getGlobalWindField(): Promise<GlobalWindFieldResponse> {
  const now = Date.now();
  if (cachedWind && now - cachedWind.fetchedAt < WIND_CACHE_TTL_MS) {
    return cachedWind.payload;
  }
  if (inflightWind) {
    return inflightWind;
  }

  inflightWind = (async () => {
    const qLats: number[] = [];
    const qLngs: number[] = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      const lat = GRID_MIN_LAT + r * GRID_LAT_STEP;
      for (let c = 0; c < GRID_COLS; c++) {
        const lng = GRID_MIN_LNG + c * GRID_LNG_STEP;
        qLats.push(lat);
        qLngs.push(lng);
      }
    }

    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${qLats.join(',')}` +
        `&longitude=${qLngs.join(',')}` +
        `&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5500);
      let res: Response;
      try {
        res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'AetheriaGlobal/1.0 (wind-telemetry)' },
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        const raw = (await res.json()) as OpenMeteoPointResult[] | OpenMeteoPointResult;
        const list = Array.isArray(raw) ? raw : [raw];
        if (list.length === GRID_ROWS * GRID_COLS) {
          const uGrid = new Array<number>(GRID_ROWS * GRID_COLS);
          const vGrid = new Array<number>(GRID_ROWS * GRID_COLS);
          let validCount = 0;

          for (let i = 0; i < list.length; i++) {
            const speed = list[i]?.current?.wind_speed_10m;
            const dir = list[i]?.current?.wind_direction_10m;
            if (typeof speed === 'number' && Number.isFinite(speed) && typeof dir === 'number' && Number.isFinite(dir)) {
              const { uEastMs, vNorthMs } = meteorologicalToUV(speed, dir);
              uGrid[i] = Number(uEastMs.toFixed(3));
              vGrid[i] = Number(vNorthMs.toFixed(3));
              validCount++;
            } else {
              uGrid[i] = 0;
              vGrid[i] = 0;
            }
          }

          if (validCount > GRID_ROWS * GRID_COLS * 0.7) {
            const metrics = computeWindFieldMetrics(
              GRID_MIN_LAT,
              GRID_LAT_STEP,
              GRID_MIN_LNG,
              GRID_LNG_STEP,
              GRID_ROWS,
              GRID_COLS,
              uGrid,
              vGrid
            );
            const payload: GlobalWindFieldResponse = {
              minLat: GRID_MIN_LAT,
              maxLat: GRID_MAX_LAT,
              latStepDeg: GRID_LAT_STEP,
              minLng: GRID_MIN_LNG,
              lngStepDeg: GRID_LNG_STEP,
              rows: GRID_ROWS,
              cols: GRID_COLS,
              uGrid,
              vGrid,
              metrics,
              source: 'Open-Meteo Live 10m Global',
              updatedAt: new Date(now).toISOString(),
            };
            cachedWind = { fetchedAt: Date.now(), payload };
            return payload;
          }
        }
      }
    } catch (err) {
      console.warn('Open-Meteo global wind fetch fallback:', err instanceof Error ? err.message : err);
    }

    const fallback = buildAtmosphericBaselineWindField(now);
    cachedWind = { fetchedAt: Date.now() - WIND_CACHE_TTL_MS + 60_000, payload: fallback };
    return fallback;
  })();

  try {
    return await inflightWind;
  } finally {
    inflightWind = null;
  }
}
