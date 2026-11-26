import type { GlobalWeatherRadarResponse } from '../shared/types.ts';
import {
  buildAtmosphericBaselineRadarField,
  computeWeatherRadarMetrics,
  WEATHER_RADAR_GRID_SPEC,
} from '../shared/weatherRadar.ts';

const RADAR_CACHE_TTL_MS = 600_000; // 10 minutes

let cachedRadar: { fetchedAt: number; payload: GlobalWeatherRadarResponse } | null = null;
let inflightRadar: Promise<GlobalWeatherRadarResponse> | null = null;

interface OpenMeteoRadarPointResult {
  current?: {
    precipitation?: number | null;
    pressure_msl?: number | null;
    cloud_cover?: number | null;
  };
}

/**
 * Fetches global live precipitation (mm/h), mean sea-level barometric pressure (hPa),
 * and cloud cover (%) across the 11x18 planetary synoptic grid via Open-Meteo,
 * with deterministic synoptic fallback on transient network failures.
 */
export async function getGlobalWeatherRadar(): Promise<GlobalWeatherRadarResponse> {
  const now = Date.now();
  if (cachedRadar && now - cachedRadar.fetchedAt < RADAR_CACHE_TTL_MS) {
    return cachedRadar.payload;
  }
  if (inflightRadar) {
    return inflightRadar;
  }

  inflightRadar = (async () => {
    const { minLat, maxLat, latStepDeg, minLng, lngStepDeg, rows, cols } =
      WEATHER_RADAR_GRID_SPEC;
    const qLats: number[] = [];
    const qLngs: number[] = [];
    for (let r = 0; r < rows; r++) {
      const lat = minLat + r * latStepDeg;
      for (let c = 0; c < cols; c++) {
        const lng = minLng + c * lngStepDeg;
        qLats.push(lat);
        qLngs.push(lng);
      }
    }

    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${qLats.join(',')}` +
        `&longitude=${qLngs.join(',')}` +
        `&current=precipitation,pressure_msl,cloud_cover`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5500);
      let res: Response;
      try {
        res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'AetheriaGlobal/1.0 (weather-radar)' },
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        const raw = (await res.json()) as OpenMeteoRadarPointResult[] | OpenMeteoRadarPointResult;
        const list = Array.isArray(raw) ? raw : [raw];
        if (list.length === rows * cols) {
          const precipGrid = new Array<number>(rows * cols);
          const pressureGrid = new Array<number>(rows * cols);
          const cloudGrid = new Array<number>(rows * cols);
          let validCount = 0;

          for (let i = 0; i < list.length; i++) {
            const pMsl = list[i]?.current?.pressure_msl;
            const precip = list[i]?.current?.precipitation;
            const cloud = list[i]?.current?.cloud_cover;
            if (typeof pMsl === 'number' && Number.isFinite(pMsl)) {
              pressureGrid[i] = Number(pMsl.toFixed(1));
              precipGrid[i] =
                typeof precip === 'number' && Number.isFinite(precip)
                  ? Number(Math.max(0, precip).toFixed(2))
                  : 0;
              cloudGrid[i] =
                typeof cloud === 'number' && Number.isFinite(cloud)
                  ? Math.round(Math.min(100, Math.max(0, cloud)))
                  : 30;
              validCount++;
            } else {
              pressureGrid[i] = 1013.2;
              precipGrid[i] = 0;
              cloudGrid[i] = 25;
            }
          }

          if (validCount > rows * cols * 0.7) {
            const metrics = computeWeatherRadarMetrics(
              minLat,
              latStepDeg,
              minLng,
              lngStepDeg,
              rows,
              cols,
              precipGrid,
              pressureGrid
            );
            const payload: GlobalWeatherRadarResponse = {
              minLat,
              maxLat,
              latStepDeg,
              minLng,
              lngStepDeg,
              rows,
              cols,
              precipGrid,
              pressureGrid,
              cloudGrid,
              metrics,
              source: 'Open-Meteo Live Synoptic Radar',
              updatedAt: new Date(now).toISOString(),
            };
            cachedRadar = { fetchedAt: Date.now(), payload };
            return payload;
          }
        }
      }
    } catch (err) {
      console.warn(
        'Open-Meteo weather radar fetch fallback:',
        err instanceof Error ? err.message : err
      );
    }

    const fallback = buildAtmosphericBaselineRadarField(now);
    cachedRadar = { fetchedAt: Date.now() - RADAR_CACHE_TTL_MS + 60_000, payload: fallback };
    return fallback;
  })();

  try {
    return await inflightRadar;
  } finally {
    inflightRadar = null;
  }
}
