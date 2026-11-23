import { calculateBearingDeg, haversineKm, interpolateGreatCircle } from '../shared/geo.ts';
import { computeDynamicHeatScale } from '../shared/seismicHeat.ts';
import type {
  EventCategory,
  GlobalEvent,
  SeismicHeatmap24hResponse,
  SeismicQuake24h,
  SeverityLevel,
  WorldFeedResponse,
} from '../shared/types.ts';
import { queryDisasterHistory, recordLiveDisasters } from './disasterHistory.ts';

interface CachedFeed {
  fetchedAt: number;
  baseDisasters: GlobalEvent[];
  baseFlights: GlobalEvent[];
  baseShips: GlobalEvent[];
  baseConflicts: GlobalEvent[];
  sources: string[];
}

let cache: CachedFeed | null = null;
let inFlightRefresh: Promise<CachedFeed> | null = null;
const CACHE_TTL_MS = 12_000;

async function fetchWithTimeout(url: string, timeoutMs = 3200): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AetheriaGlobal/1.0 (live-geospatial-telemetry)' },
    });
  } finally {
    clearTimeout(timer);
  }
}

function mapEarthquakeSeverity(mag: number): SeverityLevel {
  if (mag >= 6.0) return 'critical';
  if (mag >= 4.8) return 'high';
  if (mag >= 3.5) return 'moderate';
  return 'low';
}

const FALLBACK_DISASTERS: GlobalEvent[] = [
  {
    id: 'usgs-fallback-1',
    category: 'disaster',
    subtype: 'earthquake',
    title: 'Sismo M5.4 · Anillo de Fuego del Pacífico',
    region: 'Pacífico Oeste',
    lat: 36.22,
    lng: 141.18,
    severity: 'high',
    magnitude: 5.4,
    timestamp: new Date().toISOString(),
    source: 'USGS Telemetry',
    summary: 'Actividad sísmica en zona de subducción; monitoreo continuo.',
    radiusKm: 110,
  },
];

interface CorridorSeed {
  id: string;
  callsign: string;
  airlineOrType: string;
  from: { lat: number; lng: number; label: string };
  to: { lat: number; lng: number; label: string };
  speedKts: number;
  altitudeKm: number;
  phase: number;
}

const FLIGHT_CORRIDORS: CorridorSeed[] = [
  {
    id: 'flt-amx021',
    callsign: 'AMX 021 · B787-9',
    airlineOrType: 'Aeroméxico',
    from: { lat: 19.436, lng: -99.072, label: 'MEX' },
    to: { lat: 40.498, lng: -3.567, label: 'MAD' },
    speedKts: 492,
    altitudeKm: 11.4,
    phase: 0.18,
  },
  {
    id: 'flt-baw117',
    callsign: 'BAW 117 · A350-1000',
    airlineOrType: 'British Airways',
    from: { lat: 51.47, lng: -0.454, label: 'LHR' },
    to: { lat: 40.641, lng: -73.778, label: 'JFK' },
    speedKts: 486,
    altitudeKm: 11.9,
    phase: 0.42,
  },
  {
    id: 'flt-ana006',
    callsign: 'ANA 006 · B777-300ER',
    airlineOrType: 'All Nippon Airways',
    from: { lat: 35.764, lng: 140.386, label: 'NRT' },
    to: { lat: 33.941, lng: -118.408, label: 'LAX' },
    speedKts: 505,
    altitudeKm: 11.2,
    phase: 0.61,
  },
  {
    id: 'flt-uae354',
    callsign: 'UAE 354 · A380-800',
    airlineOrType: 'Emirates',
    from: { lat: 25.253, lng: 55.365, label: 'DXB' },
    to: { lat: 1.364, lng: 103.991, label: 'SIN' },
    speedKts: 498,
    altitudeKm: 12.1,
    phase: 0.31,
  },
  {
    id: 'flt-afr454',
    callsign: 'AFR 454 · B777-200',
    airlineOrType: 'Air France',
    from: { lat: 49.009, lng: 2.547, label: 'CDG' },
    to: { lat: -23.435, lng: -46.473, label: 'GRU' },
    speedKts: 489,
    altitudeKm: 11.5,
    phase: 0.55,
  },
  {
    id: 'flt-lan801',
    callsign: 'LAN 801 · B787-9',
    airlineOrType: 'LATAM',
    from: { lat: -33.393, lng: -70.785, label: 'SCL' },
    to: { lat: -36.848, lng: 174.763, label: 'AKL' },
    speedKts: 496,
    altitudeKm: 11.6,
    phase: 0.82,
  },
];

const SHIP_CORRIDORS: CorridorSeed[] = [
  {
    id: 'ais-maersk-suez',
    callsign: 'MV Maersk Sentosa · Portacontenedores',
    airlineOrType: 'AIS Cargo',
    from: { lat: 29.966, lng: 32.549, label: 'Suez' },
    to: { lat: 12.6, lng: 43.33, label: 'Bab el-Mandeb' },
    speedKts: 19.4,
    altitudeKm: 0,
    phase: 0.35,
  },
  {
    id: 'ais-msc-gibraltar',
    callsign: 'MSC Gülsün · Ultra Large Container',
    airlineOrType: 'AIS Cargo',
    from: { lat: 35.95, lng: -5.55, label: 'Gibraltar' },
    to: { lat: 51.92, lng: 4.13, label: 'Rotterdam' },
    speedKts: 18.2,
    altitudeKm: 0,
    phase: 0.52,
  },
  {
    id: 'ais-ever-malacca',
    callsign: 'Ever Apex · Buque Mercante',
    airlineOrType: 'AIS Cargo',
    from: { lat: 1.26, lng: 103.82, label: 'Singapur' },
    to: { lat: 6.1, lng: 95.3, label: 'Estrecho de Malaca' },
    speedKts: 20.1,
    altitudeKm: 0,
    phase: 0.44,
  },
  {
    id: 'ais-panama-pacific',
    callsign: 'Cosco Pacific · Panamax',
    airlineOrType: 'AIS Cargo',
    from: { lat: 8.88, lng: -79.55, label: 'Canal de Panamá' },
    to: { lat: 33.72, lng: -118.27, label: 'Los Ángeles' },
    speedKts: 17.8,
    altitudeKm: 0,
    phase: 0.29,
  },
  {
    id: 'ais-hormuz-tanker',
    callsign: 'VLCC Pioneer · Petrolero',
    airlineOrType: 'AIS Tanker',
    from: { lat: 26.56, lng: 56.25, label: 'Ormuz' },
    to: { lat: 19.07, lng: 72.87, label: 'Mumbai' },
    speedKts: 14.5,
    altitudeKm: 0,
    phase: 0.22,
  },
  {
    id: 'ais-veracruz',
    callsign: 'Torm Atlantic · Quimiquero',
    airlineOrType: 'AIS Tanker',
    from: { lat: 19.2, lng: -96.13, label: 'Veracruz' },
    to: { lat: 29.73, lng: -95.26, label: 'Houston' },
    speedKts: 15.8,
    altitudeKm: 0,
    phase: 0.58,
  },
];

interface ConflictTemplate extends GlobalEvent {
  keywords: RegExp;
}

const CONFLICT_TEMPLATES: ConflictTemplate[] = [
  {
    id: 'conf-easteurope',
    category: 'conflict',
    subtype: 'airspace-restricted',
    title: 'Zona de Conflicto · Europa del Este',
    region: 'Frente Este / Mar Negro',
    lat: 48.1,
    lng: 35.4,
    severity: 'critical',
    timestamp: new Date().toISOString(),
    source: 'Global Security Monitor',
    summary: 'Restricción de espacio aéreo civil y alertas activas en corredor terrestre.',
    radiusKm: 320,
    keywords: /\b(ukrain|russia|kyiv|moscow|black sea|crimea|donetsk|kharkiv)\b/i,
  },
  {
    id: 'conf-redsea',
    category: 'conflict',
    subtype: 'maritime-advisory',
    title: 'Alerta Marítima · Mar Rojo y Yemen',
    region: 'Corredor Mar Rojo',
    lat: 14.35,
    lng: 42.65,
    severity: 'critical',
    timestamp: new Date().toISOString(),
    source: 'Maritime Advisory',
    summary: 'Riesgo alto para tráfico comercial AIS; desvío recomendado en Bab el-Mandeb.',
    radiusKm: 260,
    keywords: /\b(yemen|red sea|houthi|aden|bab el-mandeb)\b/i,
  },
  {
    id: 'conf-levant',
    category: 'conflict',
    subtype: 'security-zone',
    title: 'Zona de Tensión · Levante Mediterráneo',
    region: 'Oriente Próximo',
    lat: 33.15,
    lng: 35.65,
    severity: 'high',
    timestamp: new Date().toISOString(),
    source: 'Global Security Monitor',
    summary: 'Monitoreo continuo de corredores fronterizos y desvíos de aviación.',
    radiusKm: 190,
    keywords: /\b(gaza|israel|lebanon|syria|iran|middle east|beirut)\b/i,
  },
  {
    id: 'conf-sudan',
    category: 'conflict',
    subtype: 'civil-conflict',
    title: 'Crisis Activa · Valle del Nilo / Jartum',
    region: 'Sudán',
    lat: 15.5,
    lng: 32.55,
    severity: 'high',
    timestamp: new Date().toISOString(),
    source: 'Global Security Monitor',
    summary: 'Interrupciones de infraestructura y corredores humanitarios en monitoreo.',
    radiusKm: 220,
    keywords: /\b(sudan|khartoum|darfur)\b/i,
  },
  {
    id: 'conf-myanmar',
    category: 'conflict',
    subtype: 'humanitarian-alert',
    title: 'Crisis de Seguridad · Myanmar / Bahía de Bengala',
    region: 'Sudeste Asiático',
    lat: 19.75,
    lng: 96.1,
    severity: 'high',
    timestamp: new Date().toISOString(),
    source: 'Global Security Monitor',
    summary: 'Alertas humanitarias y corredores fronterizos bajo monitoreo internacional.',
    radiusKm: 210,
    keywords: /\b(myanmar|rohingya|rakhine)\b/i,
  },
  {
    id: 'conf-scs',
    category: 'conflict',
    subtype: 'maritime-dispute',
    title: 'Fricción Marítima · Mar de China Meridional',
    region: 'Indo-Pacífico',
    lat: 11.4,
    lng: 114.6,
    severity: 'moderate',
    timestamp: new Date().toISOString(),
    source: 'Maritime Advisory',
    summary: 'Vigilancia naval intensiva en rutas comerciales del Indo-Pacífico.',
    radiusKm: 280,
    keywords: /\b(south china sea|taiwan|philippines|strait)\b/i,
  },
];

function propagateCorridor(seed: CorridorSeed, category: 'flight' | 'ship', nowMs: number): GlobalEvent {
  const arc = interpolateGreatCircle(seed.from, seed.to, 40);
  const periodMs = category === 'flight' ? 180_000 : 420_000;
  const rawProgress = (seed.phase + (nowMs % periodMs) / periodMs) % 1;
  const idxFloat = rawProgress * (arc.length - 1);
  const i0 = Math.floor(idxFloat);
  const i1 = Math.min(arc.length - 1, i0 + 1);
  const frac = idxFloat - i0;

  const lat = Number((arc[i0].lat + (arc[i1].lat - arc[i0].lat) * frac).toFixed(4));
  const lng = Number((arc[i0].lng + (arc[i1].lng - arc[i0].lng) * frac).toFixed(4));
  const headingDeg = Math.round(calculateBearingDeg(arc[i0], arc[Math.min(arc.length - 1, i0 + 2)]));
  const totalKm = Math.round(haversineKm(seed.from, seed.to));

  return {
    id: seed.id,
    category,
    subtype: category === 'flight' ? 'aircraft' : 'vessel',
    title: seed.callsign,
    region: `${seed.from.label} → ${seed.to.label}`,
    lat,
    lng,
    altitudeKm: seed.altitudeKm,
    headingDeg,
    speedKts: seed.speedKts,
    severity: 'low',
    timestamp: new Date(nowMs).toISOString(),
    source: category === 'flight' ? 'Corredor Transoceánico' : 'AIS Maritime Corridor',
    summary:
      category === 'flight'
        ? `${seed.airlineOrType} · Ruta ${seed.from.label}-${seed.to.label} (${totalKm} km) · FL${Math.round(seed.altitudeKm * 32.8)}`
        : `${seed.airlineOrType} · Travesía ${seed.from.label}-${seed.to.label} (${totalKm} km) a ${seed.speedKts} nudos`,
    destinationLat: seed.to.lat,
    destinationLng: seed.to.lng,
    destinationLabel: seed.to.label,
  };
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

async function fetchLiveUsgsEarthquakes(now: number): Promise<GlobalEvent[]> {
  // Use 2.5_day feed (~110ms) and sort newest + largest first
  const res = await fetchWithTimeout(
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    2800
  );
  if (!res.ok) return [];
  const json = (await res.json()) as {
    features?: Array<{
      id: string;
      properties: {
        mag?: number;
        place?: string;
        time?: number;
        url?: string;
        tsunami?: number;
        felt?: number | null;
        magType?: string;
        sig?: number;
        alert?: string | null;
      };
      geometry?: { coordinates?: [number, number, number] };
    }>;
  };
  const features = [...(json.features ?? [])]
    .filter((f) => f.geometry?.coordinates && (f.properties.mag ?? 0) >= 3.0)
    .sort((a, b) => (b.properties.time ?? 0) - (a.properties.time ?? 0))
    .slice(0, 12);

  return features.map((f) => {
    const coords = f.geometry!.coordinates!;
    const p = f.properties;
    const mag = Number((p.mag ?? 3.5).toFixed(1));
    const depthKm = Math.max(1, Math.round(coords[2] ?? 10));
    return {
      id: `usgs-${f.id}`,
      category: 'disaster' as const,
      subtype: 'earthquake',
      title: `Sismo M${mag} · ${p.place ?? 'Zona Sísmica'}`,
      region: p.place ?? 'Global',
      lat: Number(coords[1].toFixed(4)),
      lng: Number(coords[0].toFixed(4)),
      severity: mapEarthquakeSeverity(mag),
      magnitude: mag,
      depthKm,
      alertLevel: p.alert ?? undefined,
      timestamp: new Date(p.time ?? now).toISOString(),
      source: 'USGS Live Feed',
      sourceUrl: p.url,
      summary: `Sismo en tiempo real M${mag} a ${depthKm} km de profundidad.`,
      radiusKm: Math.round(45 + mag * 14),
      rawDetails: {
        usgsId: f.id,
        magType: p.magType ?? null,
        tsunamiFlag: p.tsunami ?? 0,
        feltReports: p.felt ?? 0,
        significance: p.sig ?? null,
      },
    };
  });
}

async function fetchLiveNasaEonet(now: number): Promise<GlobalEvent[]> {
  const res = await fetchWithTimeout(
    'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=7&limit=20',
    3200
  );
  if (!res.ok) return [];
  const json = (await res.json()) as {
    events?: Array<{
      id: string;
      title: string;
      categories?: Array<{ id: string; title: string }>;
      geometry?: Array<{ date: string; coordinates: [number, number] }>;
    }>;
  };
  const results: GlobalEvent[] = [];
  for (const ev of json.events ?? []) {
    // Skip planned prescribed agricultural/forestry burns
    if (/prescribed\s+fire/i.test(ev.title)) continue;
    const g = ev.geometry?.[ev.geometry.length - 1];
    if (!g || !Array.isArray(g.coordinates) || g.coordinates.length < 2) continue;
    const ageMs = now - new Date(g.date ?? now).getTime();
    if (ageMs > 7 * 86_400_000) continue;

    const catId = (ev.categories?.[0]?.id ?? 'wildfires').toLowerCase();
    const subtype = catId.includes('storm')
      ? 'storm'
      : catId.includes('volcano')
        ? 'volcano'
        : catId.includes('flood')
          ? 'flood'
          : catId.includes('ice')
            ? 'iceberg'
            : 'wildfire';
    results.push({
      id: `eonet-${ev.id}`,
      category: 'disaster',
      subtype,
      title: ev.title,
      region: ev.categories?.[0]?.title ?? 'Evento Natural',
      lat: Number(g.coordinates[1].toFixed(4)),
      lng: Number(g.coordinates[0].toFixed(4)),
      severity: subtype === 'storm' || subtype === 'volcano' ? 'high' : 'moderate',
      timestamp: g.date ?? new Date(now).toISOString(),
      source: 'NASA EONET Live',
      summary: `Evento natural activo monitoreado por satélite (${ev.categories?.[0]?.title ?? subtype}).`,
      radiusKm: subtype === 'storm' ? 200 : 75,
    });
  }
  return results.slice(0, 10);
}

async function fetchLiveGdacsDisasters(now: number): Promise<GlobalEvent[]> {
  // EVENTS4APP returns exclusively currently active global emergencies (iscurrent=true)
  const res = await fetchWithTimeout(
    'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP',
    3200
  );
  if (!res.ok) return [];
  const json = (await res.json()) as {
    features?: Array<{
      geometry?: { coordinates?: [number, number] };
      properties?: {
        eventid?: number;
        eventtype?: string;
        name?: string;
        description?: string;
        htmldescription?: string;
        alertlevel?: string;
        country?: string;
        iscurrent?: string | boolean;
        todate?: string;
        fromdate?: string;
      };
    }>;
  };
  const maxAgeMs = 7 * 86_400_000;
  const current = [...(json.features ?? [])]
    .filter((f) => {
      const p = f.properties;
      if (!p || !Array.isArray(f.geometry?.coordinates) || f.geometry!.coordinates!.length < 2) {
        return false;
      }
      if (String(p.iscurrent) !== 'true') return false;
      const et = String(p.eventtype ?? '').toUpperCase();
      // USGS covers live earthquakes; skip multi-year droughts
      if (et === 'EQ' || et === 'DR') return false;
      const ts = new Date(p.todate ?? p.fromdate ?? 0).getTime();
      return Number.isFinite(ts) && now - ts <= maxAgeMs;
    })
    .sort((a, b) => {
      const ta = new Date(a.properties?.todate ?? a.properties?.fromdate ?? 0).getTime();
      const tb = new Date(b.properties?.todate ?? b.properties?.fromdate ?? 0).getTime();
      return tb - ta;
    })
    .slice(0, 10);

  return current.map((f, idx) => {
    const p = f.properties!;
    const coords = f.geometry!.coordinates!;
    const et = String(p.eventtype ?? 'TC').toUpperCase();
    const subtype =
      et === 'TC'
        ? 'storm'
        : et === 'FL'
          ? 'flood'
          : et === 'VO'
            ? 'volcano'
            : 'wildfire';
    const level = String(p.alertlevel ?? 'Green');
    const severity: SeverityLevel =
      level === 'Red' ? 'critical' : level === 'Orange' ? 'high' : 'moderate';
    const levelLabel =
      level === 'Red' ? 'Alerta Roja' : level === 'Orange' ? 'Alerta Naranja' : 'Activo';
    return {
      id: `gdacs-${et}-${p.eventid ?? idx}`,
      category: 'disaster' as const,
      subtype,
      title: `${p.name || p.description || 'Alerta GDACS'} (${levelLabel})`,
      region: p.country || 'Alerta Global ONU/GDACS',
      country: p.country || undefined,
      lat: Number(coords[1].toFixed(4)),
      lng: Number(coords[0].toFixed(4)),
      severity,
      alertLevel: level,
      timestamp: p.todate ?? p.fromdate ?? new Date(now).toISOString(),
      source: 'GDACS Live Alert',
      summary: (p.htmldescription || p.description || 'Alerta activa en curso de desastre natural GDACS.')
        .replace(/<[^>]+>/g, '')
        .trim(),
      radiusKm: subtype === 'storm' ? 230 : 120,
      rawDetails: {
        gdacsEventId: p.eventid ?? null,
        eventType: et,
        fromDate: p.fromdate ?? null,
        toDate: p.todate ?? null,
      },
    };
  });
}

async function fetchLiveNhcCyclones(now: number): Promise<GlobalEvent[]> {
  const res = await fetchWithTimeout('https://www.nhc.noaa.gov/CurrentStorms.json', 2200);
  if (!res.ok) return [];
  const json = (await res.json()) as {
    activeStorms?: Array<{
      id?: string;
      name?: string;
      classification?: string;
      intensity?: string;
      latitudeNumeric?: number;
      longitudeNumeric?: number;
      movementDir?: number;
      movementSpeed?: number;
      lastUpdate?: string;
    }>;
  };
  return (json.activeStorms ?? [])
    .filter((s) => typeof s.latitudeNumeric === 'number' && typeof s.longitudeNumeric === 'number')
    .map((s, idx) => ({
      id: `nhc-${s.id ?? idx}`,
      category: 'disaster' as const,
      subtype: 'storm',
      title: `${s.classification ?? 'Ciclón'} ${s.name ?? 'Activo'}`,
      region: 'NOAA National Hurricane Center',
      lat: Number(s.latitudeNumeric!.toFixed(4)),
      lng: Number(s.longitudeNumeric!.toFixed(4)),
      severity: 'critical' as const,
      speedKts: s.movementSpeed,
      headingDeg: s.movementDir,
      timestamp: s.lastUpdate ?? new Date(now).toISOString(),
      source: 'NOAA NHC Live',
      summary: `Vientos sostenidos de ${s.intensity ?? '—'} nudos monitoreados por NOAA NHC.`,
      radiusKm: 260,
    }));
}

interface AdsbAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | 'ground';
  gs?: number;
  track?: number;
  lat?: number;
  lon?: number;
}

async function fetchLiveAdsbHub(
  hubLabel: string,
  lat: number,
  lng: number,
  limit: number,
  now: number
): Promise<GlobalEvent[]> {
  const res = await fetchWithTimeout(
    `https://api.adsb.lol/v2/point/${lat}/${lng}/250`,
    2600
  );
  if (!res.ok) return [];
  const json = (await res.json()) as { ac?: AdsbAircraft[] };
  const airborne = (json.ac ?? [])
    .filter(
      (a) =>
        typeof a.lat === 'number' &&
        typeof a.lon === 'number' &&
        typeof a.alt_baro === 'number' &&
        a.alt_baro > 1500 &&
        (a.flight ?? a.r ?? '').trim().length > 0
    )
    .slice(0, limit);

  return airborne.map((a) => {
    const callsign = (a.flight ?? a.r ?? a.hex ?? 'AIR').trim();
    const altKm = Number((((a.alt_baro as number) * 0.3048) / 1000).toFixed(1));
    const speedKts = Math.round(a.gs ?? 420);
    const heading = Math.round(a.track ?? 90);
    const model = a.t ? ` · ${a.t}` : '';
    return {
      id: `adsb-${a.hex ?? callsign}`,
      category: 'flight' as const,
      subtype: 'aircraft',
      title: `${callsign}${model}`,
      region: `${hubLabel} (ADS-B)`,
      lat: Number(a.lat!.toFixed(4)),
      lng: Number(a.lon!.toFixed(4)),
      altitudeKm: altKm,
      headingDeg: heading,
      speedKts,
      severity: 'low' as const,
      timestamp: new Date(now).toISOString(),
      source: 'ADSB.lol Live Radar',
      summary: `Vuelo real en aire · ${speedKts} kts · Alt ${Math.round((a.alt_baro as number) * 0.3048)} m · Rumbo ${heading}°`,
    };
  });
}

async function fetchLiveAisVessels(now: number): Promise<GlobalEvent[]> {
  const res = await fetchWithTimeout('https://meri.digitraffic.fi/api/ais/v1/locations', 2800);
  if (!res.ok) return [];
  const json = (await res.json()) as {
    dataUpdatedTime?: string;
    features?: Array<{
      mmsi?: number;
      geometry?: { coordinates?: [number, number] };
      properties?: {
        mmsi?: number;
        sog?: number;
        cog?: number;
        heading?: number;
        timestampExternal?: number;
      };
    }>;
  };
  const moving = (json.features ?? [])
    .filter(
      (f) =>
        Array.isArray(f.geometry?.coordinates) &&
        f.geometry!.coordinates!.length >= 2 &&
        (f.properties?.sog ?? 0) >= 6
    )
    .slice(0, 10);

  return moving.map((f, idx) => {
    const [lng, lat] = f.geometry!.coordinates!;
    const p = f.properties ?? {};
    const mmsi = p.mmsi ?? f.mmsi ?? idx;
    const speedKts = Number((p.sog ?? 10).toFixed(1));
    const heading = Math.round(p.heading && p.heading < 360 ? p.heading : p.cog ?? 0);
    return {
      id: `ais-live-${mmsi}`,
      category: 'ship' as const,
      subtype: 'vessel',
      title: `Buque MMSI ${mmsi}`,
      region: 'Mar Báltico / Norte (AIS Live)',
      lat: Number(lat.toFixed(4)),
      lng: Number(lng.toFixed(4)),
      altitudeKm: 0,
      headingDeg: heading,
      speedKts,
      severity: 'low' as const,
      timestamp: p.timestampExternal
        ? new Date(p.timestampExternal).toISOString()
        : json.dataUpdatedTime ?? new Date(now).toISOString(),
      source: 'Digitraffic AIS Live',
      summary: `Buque real en navegación · ${speedKts} nudos · Rumbo ${heading}°`,
    };
  });
}

async function fetchLiveConflictEnrichment(now: number): Promise<{
  conflicts: GlobalEvent[];
  liveMatched: boolean;
}> {
  const baseConflicts: GlobalEvent[] = CONFLICT_TEMPLATES.map(
    ({ keywords: _kw, ...rest }) => ({
      ...rest,
      timestamp: new Date(now).toISOString(),
    })
  );

  try {
    const res = await fetchWithTimeout('https://feeds.bbci.co.uk/news/world/rss.xml', 2500);
    if (!res.ok) return { conflicts: baseConflicts, liveMatched: false };
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?(?:<pubDate>([\s\S]*?)<\/pubDate>)?[\s\S]*?<\/item>/g)].map(
      (m) => ({
        title: decodeXmlEntities(m[1] ?? ''),
        pubDate: m[2] ? new Date(decodeXmlEntities(m[2])).toISOString() : new Date(now).toISOString(),
      })
    );

    let matchedAny = false;
    const enriched = CONFLICT_TEMPLATES.map(({ keywords, ...ev }) => {
      const hit = items.find((it) => keywords.test(it.title));
      if (hit) {
        matchedAny = true;
        return {
          ...ev,
          timestamp: hit.pubDate,
          source: 'BBC World / Security Monitor',
          summary: `${hit.title} — ${ev.summary}`,
        };
      }
      return {
        ...ev,
        timestamp: new Date(now).toISOString(),
      };
    });
    return { conflicts: enriched, liveMatched: matchedAny };
  } catch {
    return { conflicts: baseConflicts, liveMatched: false };
  }
}

async function refreshExternalFeeds(): Promise<CachedFeed> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = (async () => {
    const [
      usgsRes,
      eonetRes,
      gdacsRes,
      nhcRes,
      adsbCdmx,
      adsbNyc,
      adsbMad,
      adsbTok,
      aisRes,
      conflictRes,
    ] = await Promise.allSettled([
      fetchLiveUsgsEarthquakes(now),
      fetchLiveNasaEonet(now),
      fetchLiveGdacsDisasters(now),
      fetchLiveNhcCyclones(now),
      fetchLiveAdsbHub('CDMX', 19.43, -99.13, 6, now),
      fetchLiveAdsbHub('NYC', 40.71, -74.0, 6, now),
      fetchLiveAdsbHub('Madrid', 40.42, -3.7, 5, now),
      fetchLiveAdsbHub('Tokio', 35.66, 139.7, 5, now),
      fetchLiveAisVessels(now),
      fetchLiveConflictEnrichment(now),
    ]);

    const sources: string[] = [];
    const disasters: GlobalEvent[] = [];

    if (nhcRes.status === 'fulfilled' && nhcRes.value.length > 0) {
      disasters.push(...nhcRes.value);
      sources.push('NOAA NHC');
    }
    if (gdacsRes.status === 'fulfilled' && gdacsRes.value.length > 0) {
      disasters.push(...gdacsRes.value);
      sources.push('GDACS ONU');
    }
    if (usgsRes.status === 'fulfilled' && usgsRes.value.length > 0) {
      disasters.push(...usgsRes.value);
      sources.push('USGS Live');
    }
    if (eonetRes.status === 'fulfilled' && eonetRes.value.length > 0) {
      const uniqueEonet = eonetRes.value.filter(
        (ev) =>
          !disasters.some(
            (existing) =>
              existing.subtype === ev.subtype &&
              Math.abs(existing.lat - ev.lat) < 1.5 &&
              Math.abs(existing.lng - ev.lng) < 1.5
          )
      );
      if (uniqueEonet.length > 0) {
        disasters.push(...uniqueEonet);
        sources.push('NASA EONET');
      }
    }
    if (disasters.length === 0) {
      disasters.push(...FALLBACK_DISASTERS);
      sources.push('USGS/EONET Baseline');
    } else {
      disasters.sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      try {
        recordLiveDisasters(disasters);
      } catch (err) {
        console.warn('Disaster history record error:', err);
      }
    }

    const flights: GlobalEvent[] = [];
    for (const hub of [adsbCdmx, adsbNyc, adsbMad, adsbTok]) {
      if (hub.status === 'fulfilled' && hub.value.length > 0) {
        flights.push(...hub.value);
      }
    }
    if (flights.length > 0) {
      sources.push('ADSB.lol Radar');
    }

    const ships: GlobalEvent[] = [];
    if (aisRes.status === 'fulfilled' && aisRes.value.length > 0) {
      ships.push(...aisRes.value);
      sources.push('Digitraffic AIS');
    }

    const conflicts =
      conflictRes.status === 'fulfilled'
        ? conflictRes.value.conflicts
        : CONFLICT_TEMPLATES.map(({ keywords: _kw, ...rest }) => ({
            ...rest,
            timestamp: new Date(now).toISOString(),
          }));
    if (conflictRes.status === 'fulfilled' && conflictRes.value.liveMatched) {
      sources.push('BBC World Monitor');
    } else {
      sources.push('Security Monitor');
    }

    const nextCache: CachedFeed = {
      fetchedAt: Date.now(),
      baseDisasters: disasters,
      baseFlights: flights,
      baseShips: ships,
      baseConflicts: conflicts,
      sources,
    };
    cache = nextCache;
    return nextCache;
  })();

  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

export async function getWorldFeed(categoryFilter?: EventCategory | 'all'): Promise<WorldFeedResponse> {
  const feed = await refreshExternalFeeds();
  const now = Date.now();

  const corridorFlights = FLIGHT_CORRIDORS.map((c) => propagateCorridor(c, 'flight', now));
  const flights = [...feed.baseFlights, ...corridorFlights];
  const corridorShips = SHIP_CORRIDORS.map((c) => propagateCorridor(c, 'ship', now));
  const ships = [...feed.baseShips, ...corridorShips];
  const disasters = feed.baseDisasters;
  const conflicts = feed.baseConflicts;

  const allEvents = [...disasters, ...flights, ...ships, ...conflicts];
  const filtered =
    categoryFilter && categoryFilter !== 'all'
      ? allEvents.filter((e) => e.category === categoryFilter)
      : allEvents;

  return {
    events: filtered,
    summary: {
      total: allEvents.length,
      disasters: disasters.length,
      flights: flights.length,
      ships: ships.length,
      conflicts: conflicts.length,
      updatedAt: new Date(now).toISOString(),
      sources: feed.sources,
    },
  };
}

let cachedQuakes24h: { fetchedAt: number; payload: SeismicHeatmap24hResponse } | null = null;
let inflightQuakes24h: Promise<SeismicHeatmap24hResponse> | null = null;
const QUAKES_24H_TTL_MS = 180_000;

export async function getEarthquakesLast24h(): Promise<SeismicHeatmap24hResponse> {
  const now = Date.now();
  if (cachedQuakes24h && now - cachedQuakes24h.fetchedAt < QUAKES_24H_TTL_MS) {
    return cachedQuakes24h.payload;
  }
  if (inflightQuakes24h) {
    return inflightQuakes24h;
  }

  inflightQuakes24h = (async () => {
    const rawQuakes: SeismicQuake24h[] = [];
    let sourceLabel = 'USGS all_day (24h)';

    try {
      const res = await fetchWithTimeout(
        'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
        4500
      );
      if (res.ok) {
        const json = (await res.json()) as {
          features?: Array<{
            id: string;
            properties?: {
              mag?: number | null;
              place?: string | null;
              time?: number | null;
              tsunami?: number | null;
              sig?: number | null;
              url?: string | null;
            };
            geometry?: { coordinates?: [number, number, number] };
          }>;
        };

        for (const f of json.features ?? []) {
          const coords = f.geometry?.coordinates;
          const p = f.properties;
          if (!coords || coords.length < 2 || !p) continue;
          const lat = Number(coords[1]);
          const lng = Number(coords[0]);
          const mag = Number(p.mag ?? 0);
          const occurredAtMs = Number(p.time ?? 0);
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(mag) || !occurredAtMs) {
            continue;
          }
          rawQuakes.push({
            id: `usgs-${f.id}`,
            lat: Number(lat.toFixed(4)),
            lng: Number(lng.toFixed(4)),
            magnitude: Number(Math.max(0, mag).toFixed(1)),
            depthKm: Math.max(0, Math.round(coords[2] ?? 10)),
            place: p.place?.trim() || 'Zona Sísmica Global',
            occurredAtMs,
            timestamp: new Date(occurredAtMs).toISOString(),
            tsunami: Boolean(p.tsunami),
            significance: Math.max(0, Math.round(p.sig ?? mag * 50)),
            sourceUrl: p.url ?? undefined,
          });
        }
      }
    } catch {
      // Fall through to SQLite historical disaster fallback
    }

    if (rawQuakes.length === 0) {
      try {
        const hist = await queryDisasterHistory({ subtype: 'earthquake', status: 'all', limit: 250 });
        for (const r of hist.records) {
          const ts = new Date(r.occurredAt).getTime();
          if (Number.isFinite(ts) && now - ts <= 24 * 3600 * 1000) {
            rawQuakes.push({
              id: r.id,
              lat: r.lat,
              lng: r.lng,
              magnitude: Number((r.magnitude ?? 4.0).toFixed(1)),
              depthKm: Math.max(0, Math.round(r.depthKm ?? 10)),
              place: r.region || r.title,
              occurredAtMs: ts,
              timestamp: r.occurredAt,
              tsunami: false,
              significance: Math.round((r.magnitude ?? 4) * 60),
              sourceUrl: r.sourceUrl,
            });
          }
        }
        if (rawQuakes.length > 0) {
          sourceLabel = 'Archivo Sísmico 24h';
        }
      } catch {
        // Keep empty if DB also unavailable
      }
    }

    const { quakes24h, metrics } = computeDynamicHeatScale(rawQuakes, now);
    const payload: SeismicHeatmap24hResponse = {
      quakes: quakes24h,
      metrics,
      source: sourceLabel,
      updatedAt: new Date(now).toISOString(),
    };
    cachedQuakes24h = { fetchedAt: Date.now(), payload };
    return payload;
  })();

  try {
    return await inflightQuakes24h;
  } finally {
    inflightQuakes24h = null;
  }
}
