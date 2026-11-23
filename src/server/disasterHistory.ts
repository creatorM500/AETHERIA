import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DisasterHistoryRecord,
  DisasterHistoryResponse,
  DisasterSubtype,
  GlobalEvent,
  SeverityLevel,
} from '../shared/types.ts';

const DATA_DIR = path.resolve(process.cwd(), '.aetheria-data');
const DB_PATH = path.join(DATA_DIR, 'disaster-history.db');

let dbInstance: DatabaseSync | null = null;
let lastArchiveHydrateMs = 0;
let hydratingPromise: Promise<void> | null = null;
const ARCHIVE_HYDRATE_TTL_MS = 10 * 60 * 1000;

export function normalizeDisasterSubtype(raw?: string): DisasterSubtype {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('eq') || s.includes('earth') || s.includes('quake') || s.includes('sismo')) {
    return 'earthquake';
  }
  if (s.includes('tc') || s.includes('storm') || s.includes('cyclone') || s.includes('hurric')) {
    return 'storm';
  }
  if (s.includes('fl') || s.includes('flood') || s.includes('inund')) {
    return 'flood';
  }
  if (s.includes('vo') || s.includes('volc')) {
    return 'volcano';
  }
  if (s.includes('ice') || s.includes('sea')) {
    return 'iceberg';
  }
  return 'wildfire';
}

function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS disaster_history (
      id TEXT PRIMARY KEY,
      subtype TEXT NOT NULL,
      title TEXT NOT NULL,
      region TEXT NOT NULL,
      country TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      severity TEXT NOT NULL,
      magnitude REAL,
      depth_km REAL,
      speed_kts REAL,
      heading_deg REAL,
      radius_km REAL,
      alert_level TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      source_url TEXT,
      summary TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      observations_count INTEGER NOT NULL DEFAULT 1,
      raw_data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_disaster_subtype_time
      ON disaster_history(subtype, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_disaster_status_time
      ON disaster_history(status, occurred_at DESC);
  `);
  dbInstance = db;
  return db;
}

interface UpsertInput {
  id: string;
  subtype: DisasterSubtype;
  title: string;
  region: string;
  country?: string | null;
  lat: number;
  lng: number;
  severity: SeverityLevel;
  magnitude?: number | null;
  depthKm?: number | null;
  speedKts?: number | null;
  headingDeg?: number | null;
  radiusKm?: number | null;
  alertLevel?: string | null;
  status: 'active' | 'archived';
  source: string;
  sourceUrl?: string | null;
  summary: string;
  occurredAt: string;
  rawData: Record<string, unknown>;
}

function upsertBatch(items: UpsertInput[], markMissingActiveAsArchived = false): void {
  if (items.length === 0 && !markMissingActiveAsArchived) return;
  const db = getDb();
  const nowIso = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO disaster_history (
      id, subtype, title, region, country, lat, lng, severity,
      magnitude, depth_km, speed_kts, heading_deg, radius_km, alert_level,
      status, source, source_url, summary, occurred_at, first_seen_at, last_seen_at,
      observations_count, raw_data
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      1, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      subtype = excluded.subtype,
      title = excluded.title,
      region = excluded.region,
      country = COALESCE(excluded.country, disaster_history.country),
      lat = excluded.lat,
      lng = excluded.lng,
      severity = excluded.severity,
      magnitude = COALESCE(excluded.magnitude, disaster_history.magnitude),
      depth_km = COALESCE(excluded.depth_km, disaster_history.depth_km),
      speed_kts = COALESCE(excluded.speed_kts, disaster_history.speed_kts),
      heading_deg = COALESCE(excluded.heading_deg, disaster_history.heading_deg),
      radius_km = COALESCE(excluded.radius_km, disaster_history.radius_km),
      alert_level = COALESCE(excluded.alert_level, disaster_history.alert_level),
      status = CASE
        WHEN excluded.status = 'active' THEN 'active'
        WHEN disaster_history.status = 'active' THEN 'active'
        ELSE 'archived'
      END,
      source = excluded.source,
      source_url = COALESCE(excluded.source_url, disaster_history.source_url),
      summary = excluded.summary,
      occurred_at = excluded.occurred_at,
      last_seen_at = excluded.last_seen_at,
      observations_count = disaster_history.observations_count + 1,
      raw_data = excluded.raw_data
  `);

  db.exec('BEGIN');
  try {
    for (const item of items) {
      stmt.run(
        item.id,
        item.subtype,
        item.title,
        item.region,
        item.country ?? null,
        item.lat,
        item.lng,
        item.severity,
        item.magnitude ?? null,
        item.depthKm ?? null,
        item.speedKts ?? null,
        item.headingDeg ?? null,
        item.radiusKm ?? null,
        item.alertLevel ?? null,
        item.status,
        item.source,
        item.sourceUrl ?? null,
        item.summary,
        item.occurredAt,
        nowIso,
        nowIso,
        JSON.stringify(item.rawData)
      );
    }

    if (markMissingActiveAsArchived && items.length > 0) {
      const activeIds = new Set(items.map((i) => i.id));
      const currentlyActive = db
        .prepare(`SELECT id FROM disaster_history WHERE status = 'active'`)
        .all() as Array<{ id: string }>;
      const archiveStmt = db.prepare(
        `UPDATE disaster_history SET status = 'archived' WHERE id = ?`
      );
      for (const row of currentlyActive) {
        if (!activeIds.has(row.id)) {
          archiveStmt.run(row.id);
        }
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Persists all currently active natural disasters from live telemetry feeds,
 * automatically transitioning disappeared events into archived history while keeping all data.
 */
export function recordLiveDisasters(events: GlobalEvent[]): void {
  const disasters = events.filter((e) => e.category === 'disaster');
  if (disasters.length === 0) return;

  const batch: UpsertInput[] = disasters.map((ev) => ({
    id: ev.id,
    subtype: normalizeDisasterSubtype(ev.subtype),
    title: ev.title,
    region: ev.region,
    country: ev.country ?? null,
    lat: ev.lat,
    lng: ev.lng,
    severity: ev.severity,
    magnitude: ev.magnitude ?? null,
    depthKm: ev.depthKm ?? null,
    speedKts: ev.speedKts ?? null,
    headingDeg: ev.headingDeg ?? null,
    radiusKm: ev.radiusKm ?? null,
    alertLevel: ev.alertLevel ?? null,
    status: 'active',
    source: ev.source,
    sourceUrl: ev.sourceUrl ?? null,
    summary: ev.summary,
    occurredAt: ev.timestamp,
    rawData: {
      ...(ev.rawDetails ?? {}),
      recordedCategory: ev.category,
      subtype: ev.subtype,
      coordinates: { lat: ev.lat, lng: ev.lng },
      magnitude: ev.magnitude ?? null,
      depthKm: ev.depthKm ?? null,
      speedKts: ev.speedKts ?? null,
      headingDeg: ev.headingDeg ?? null,
      radiusKm: ev.radiusKm ?? null,
      alertLevel: ev.alertLevel ?? null,
    },
  }));

  upsertBatch(batch, true);
}

async function fetchJsonTimeout(url: string, timeoutMs = 4500): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'AetheriaGlobal/1.0 (disaster-history-archiver)' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function mapMagSeverity(mag: number): SeverityLevel {
  if (mag >= 6.0) return 'critical';
  if (mag >= 4.8) return 'high';
  if (mag >= 3.5) return 'moderate';
  return 'low';
}

/**
 * Hydrates historical natural disasters across all 6 categories from USGS 30-day archive,
 * GDACS historical/closed alerts, and NASA EONET 45-day open+closed archive.
 */
export async function hydrateDisasterHistoryFromArchives(force = false): Promise<void> {
  const db = getDb();
  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM disaster_history`)
    .get() as { total: number };
  const now = Date.now();

  if (!force && countRow.total >= 25 && now - lastArchiveHydrateMs < ARCHIVE_HYDRATE_TTL_MS) {
    return;
  }
  if (hydratingPromise) {
    return hydratingPromise;
  }

  hydratingPromise = (async () => {
    const [usgsMonth, gdacsSearch, eonetArchive, eonetGeoArchive] = await Promise.all([
      fetchJsonTimeout(
        'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.geojson',
        4500
      ),
      fetchJsonTimeout(
        'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=EQ;TC;FL;VO;WF&alertlevel=Red;Orange',
        5000
      ),
      fetchJsonTimeout(
        'https://eonet.gsfc.nasa.gov/api/v3/events?status=all&days=45&limit=50',
        5000
      ),
      fetchJsonTimeout(
        'https://eonet.gsfc.nasa.gov/api/v3/events?category=seaLakeIce&days=14&limit=12',
        4000
      ),
    ]);

    const items: UpsertInput[] = [];

    // 1. USGS 30-day significant earthquakes archive
    const usgsFeatures = (
      usgsMonth as {
        features?: Array<{
          id: string;
          properties: {
            mag?: number;
            place?: string;
            time?: number;
            tsunami?: number;
            felt?: number | null;
            cdi?: number | null;
            mmi?: number | null;
            alert?: string | null;
            url?: string;
            title?: string;
            magType?: string;
            sig?: number;
          };
          geometry?: { coordinates?: [number, number, number] };
        }>;
      } | null
    )?.features;

    for (const f of (usgsFeatures ?? []).slice(0, 45)) {
      const coords = f.geometry?.coordinates;
      if (!coords || coords.length < 2) continue;
      const p = f.properties;
      const mag = Number((p.mag ?? 4.5).toFixed(1));
      const depthKm = Math.max(1, Math.round(coords[2] ?? 10));
      const ts = p.time ?? now;
      const ageMs = now - ts;
      items.push({
        id: `usgs-${f.id}`,
        subtype: 'earthquake',
        title: `Sismo M${mag} · ${p.place ?? 'Zona Sísmica'}`,
        region: p.place ?? 'Global',
        lat: Number(coords[1].toFixed(4)),
        lng: Number(coords[0].toFixed(4)),
        severity: mapMagSeverity(mag),
        magnitude: mag,
        depthKm,
        radiusKm: Math.round(45 + mag * 14),
        alertLevel: p.alert ?? undefined,
        status: ageMs <= 2.5 * 86_400_000 ? 'active' : 'archived',
        source: 'USGS Earthquake Archive',
        sourceUrl: p.url ?? null,
        summary: `Sismo M${mag} (${p.magType ?? 'mw'}) a ${depthKm} km de profundidad${p.felt ? ` · ${p.felt} reportes percibidos` : ''}${p.tsunami ? ' · Alerta tsunami evaluada' : ''}.`,
        occurredAt: new Date(ts).toISOString(),
        rawData: {
          usgsId: f.id,
          magnitude: mag,
          magType: p.magType ?? null,
          depthKm,
          significance: p.sig ?? null,
          feltReports: p.felt ?? 0,
          cdi: p.cdi ?? null,
          mmi: p.mmi ?? null,
          tsunamiFlag: p.tsunami ?? 0,
          pagerAlert: p.alert ?? null,
          place: p.place ?? null,
        },
      });
    }

    // 2. GDACS historical Red/Orange archive (cyclones, floods, volcanoes, wildfires, earthquakes)
    const gdacsFeatures = (
      gdacsSearch as {
        features?: Array<{
          geometry?: { coordinates?: [number, number] };
          properties?: {
            eventid?: number;
            eventtype?: string;
            name?: string;
            description?: string;
            htmldescription?: string;
            alertlevel?: string;
            alertscore?: number;
            country?: string;
            iso3?: string;
            iscurrent?: string | boolean;
            fromdate?: string;
            todate?: string;
            severitydata?: Record<string, unknown>;
            url?: { report?: string };
          };
        }>;
      } | null
    )?.features;

    for (const [idx, f] of (gdacsFeatures ?? []).slice(0, 45).entries()) {
      const p = f.properties;
      const coords = f.geometry?.coordinates;
      if (!p || !coords || coords.length < 2) continue;
      const et = String(p.eventtype ?? 'TC').toUpperCase();
      const subtype = normalizeDisasterSubtype(et);
      const level = String(p.alertlevel ?? 'Orange');
      const severity: SeverityLevel =
        level === 'Red' ? 'critical' : level === 'Orange' ? 'high' : 'moderate';
      const isCurrent = String(p.iscurrent) === 'true';
      const occurredAt = p.todate ?? p.fromdate ?? new Date(now).toISOString();
      const levelLabel =
        level === 'Red' ? 'Alerta Roja' : level === 'Orange' ? 'Alerta Naranja' : 'Activo';

      items.push({
        id: `gdacs-${et}-${p.eventid ?? idx}`,
        subtype,
        title: `${p.name || p.description || 'Evento GDACS'} (${levelLabel})`,
        region: p.country || 'Archivo Global ONU/GDACS',
        country: p.country || null,
        lat: Number(coords[1].toFixed(4)),
        lng: Number(coords[0].toFixed(4)),
        severity,
        radiusKm: subtype === 'storm' ? 230 : 120,
        alertLevel: level,
        status: isCurrent ? 'active' : 'archived',
        source: 'GDACS ONU Archive',
        sourceUrl: p.url?.report ?? null,
        summary: (p.htmldescription || p.description || 'Registro histórico GDACS.')
          .replace(/<[^>]+>/g, '')
          .trim(),
        occurredAt,
        rawData: {
          gdacsEventId: p.eventid ?? null,
          eventType: et,
          alertLevel: level,
          alertScore: p.alertscore ?? null,
          country: p.country ?? null,
          iso3: p.iso3 ?? null,
          isCurrent,
          fromDate: p.fromdate ?? null,
          toDate: p.todate ?? null,
          severityData: p.severitydata ?? null,
        },
      });
    }

    // 3. NASA EONET 45-day open + closed archive + seaLakeIce/volcanoes/floods
    const eonetPrimary =
      (
        eonetArchive as {
          events?: Array<{
            id: string;
            title: string;
            closed?: string | null;
            link?: string;
            categories?: Array<{ id: string; title: string }>;
            sources?: Array<{ id: string; url?: string }>;
            geometry?: Array<{
              date: string;
              coordinates: [number, number];
              magnitudeValue?: number | null;
              magnitudeUnit?: string | null;
            }>;
          }>;
        } | null
      )?.events ?? [];
    const eonetSecondary =
      (
        eonetGeoArchive as {
          events?: typeof eonetPrimary;
        } | null
      )?.events ?? [];
    const eonetEvents = [...eonetPrimary, ...eonetSecondary];

    for (const ev of eonetEvents ?? []) {
      const g = ev.geometry?.[ev.geometry.length - 1];
      if (!g || !Array.isArray(g.coordinates) || g.coordinates.length < 2) continue;
      const catId = ev.categories?.[0]?.id ?? 'wildfires';
      const subtype = normalizeDisasterSubtype(catId);
      const isClosed = Boolean(ev.closed);
      const magVal = typeof g.magnitudeValue === 'number' ? g.magnitudeValue : null;
      const isWind = /kts|kt/i.test(g.magnitudeUnit ?? '');

      items.push({
        id: `eonet-${ev.id}`,
        subtype,
        title: ev.title,
        region: ev.categories?.[0]?.title ?? 'Archivo Satelital NASA EONET',
        lat: Number(g.coordinates[1].toFixed(4)),
        lng: Number(g.coordinates[0].toFixed(4)),
        severity: subtype === 'storm' || subtype === 'volcano' ? 'high' : 'moderate',
        speedKts: isWind && magVal !== null ? magVal : null,
        radiusKm: subtype === 'storm' ? 200 : 75,
        status: isClosed || now - new Date(g.date).getTime() > 7 * 86_400_000 ? 'archived' : 'active',
        source: 'NASA EONET Archive',
        sourceUrl: ev.sources?.[0]?.url ?? ev.link ?? null,
        summary: `Registro satelital NASA EONET (${ev.categories?.[0]?.title ?? subtype})${magVal !== null ? ` · Intensidad ${magVal} ${g.magnitudeUnit ?? ''}`.trim() : ''}${isClosed ? ' · Evento finalizado' : ''}.`,
        occurredAt: g.date ?? ev.closed ?? new Date(now).toISOString(),
        rawData: {
          eonetId: ev.id,
          categoryId: catId,
          categoryTitle: ev.categories?.[0]?.title ?? null,
          closedAt: ev.closed ?? null,
          trackPointsCount: ev.geometry?.length ?? 1,
          firstTrackDate: ev.geometry?.[0]?.date ?? null,
          latestTrackDate: g.date,
          magnitudeValue: magVal,
          magnitudeUnit: g.magnitudeUnit ?? null,
          externalSources: ev.sources ?? [],
        },
      });
    }

    upsertBatch(items, false);
    lastArchiveHydrateMs = Date.now();
  })();

  try {
    await hydratingPromise;
  } finally {
    hydratingPromise = null;
  }
}

export interface QueryDisasterHistoryOptions {
  subtype?: DisasterSubtype | 'all';
  status?: 'all' | 'active' | 'archived';
  search?: string;
  limit?: number;
}

export async function queryDisasterHistory(
  options: QueryDisasterHistoryOptions = {}
): Promise<DisasterHistoryResponse> {
  await hydrateDisasterHistoryFromArchives(false);
  const db = getDb();

  const countsBySubtype: Record<DisasterSubtype | 'all', number> = {
    all: 0,
    earthquake: 0,
    storm: 0,
    wildfire: 0,
    flood: 0,
    volcano: 0,
    iceberg: 0,
  };

  const countRows = db
    .prepare(`SELECT subtype, COUNT(*) as cnt FROM disaster_history GROUP BY subtype`)
    .all() as Array<{ subtype: string; cnt: number }>;

  for (const row of countRows) {
    const key = normalizeDisasterSubtype(row.subtype);
    countsBySubtype[key] += row.cnt;
    countsBySubtype.all += row.cnt;
  }

  const statusRows = db
    .prepare(`SELECT status, COUNT(*) as cnt FROM disaster_history GROUP BY status`)
    .all() as Array<{ status: string; cnt: number }>;
  let activeCount = 0;
  let archivedCount = 0;
  for (const row of statusRows) {
    if (row.status === 'active') activeCount = row.cnt;
    else archivedCount += row.cnt;
  }

  const maxDateRow = db
    .prepare(`SELECT MAX(last_seen_at) as last_archived FROM disaster_history`)
    .get() as { last_archived: string | null };

  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (options.subtype && options.subtype !== 'all') {
    conditions.push('subtype = ?');
    params.push(options.subtype);
  }
  if (options.status && options.status !== 'all') {
    conditions.push('status = ?');
    params.push(options.status);
  }
  if (options.search && options.search.trim()) {
    const q = `%${options.search.trim().toLowerCase()}%`;
    conditions.push(
      `(LOWER(title) LIKE ? OR LOWER(region) LIKE ? OR LOWER(COALESCE(country, '')) LIKE ? OR LOWER(source) LIKE ? OR LOWER(summary) LIKE ?)`
    );
    params.push(q, q, q, q, q);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(250, options.limit ?? 100));
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT id, subtype, title, region, country, lat, lng, severity,
              magnitude, depth_km, speed_kts, heading_deg, radius_km, alert_level,
              status, source, source_url, summary, occurred_at, first_seen_at,
              last_seen_at, observations_count, raw_data
       FROM disaster_history
       ${whereClause}
       ORDER BY occurred_at DESC
       LIMIT ?`
    )
    .all(...params) as Array<{
    id: string;
    subtype: string;
    title: string;
    region: string;
    country: string | null;
    lat: number;
    lng: number;
    severity: string;
    magnitude: number | null;
    depth_km: number | null;
    speed_kts: number | null;
    heading_deg: number | null;
    radius_km: number | null;
    alert_level: string | null;
    status: string;
    source: string;
    source_url: string | null;
    summary: string;
    occurred_at: string;
    first_seen_at: string;
    last_seen_at: string;
    observations_count: number;
    raw_data: string;
  }>;

  const records: DisasterHistoryRecord[] = rows.map((r) => {
    let parsedRaw: Record<string, unknown> = {};
    try {
      parsedRaw = JSON.parse(r.raw_data) as Record<string, unknown>;
    } catch {
      parsedRaw = {};
    }
    return {
      id: r.id,
      subtype: normalizeDisasterSubtype(r.subtype),
      title: r.title,
      region: r.region,
      country: r.country ?? undefined,
      lat: r.lat,
      lng: r.lng,
      severity: (r.severity as SeverityLevel) || 'moderate',
      magnitude: r.magnitude ?? undefined,
      depthKm: r.depth_km ?? undefined,
      speedKts: r.speed_kts ?? undefined,
      headingDeg: r.heading_deg ?? undefined,
      radiusKm: r.radius_km ?? undefined,
      alertLevel: r.alert_level ?? undefined,
      status: r.status === 'active' ? 'active' : 'archived',
      source: r.source,
      sourceUrl: r.source_url ?? undefined,
      summary: r.summary,
      occurredAt: r.occurred_at,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      observationsCount: r.observations_count,
      rawData: parsedRaw,
    };
  });

  return {
    records,
    countsBySubtype,
    activeCount,
    archivedCount,
    totalSaved: countsBySubtype.all,
    lastArchivedAt: maxDateRow?.last_archived ?? null,
  };
}
