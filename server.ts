import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { decodeEncodedPolyline } from './src/shared/geo.ts';
import {
  computeLocalPredictiveRoute,
  predictTrafficProfile,
  scoreRouteHazardProximity,
} from './src/shared/predictiveTraffic.ts';
import type {
  DisasterSubtype,
  EventCategory,
  LatLngPoint,
  McpJsonRpcRequest,
  NavigationStep,
  PredictiveRouteResult,
  TravelMode,
} from './src/shared/types.ts';
import { getEarthquakesLast24h, getWorldFeed } from './src/server/worldFeed.ts';
import { getGlobalWindField } from './src/server/windFeed.ts';
import {
  hydrateDisasterHistoryFromArchives,
  queryDisasterHistory,
} from './src/server/disasterHistory.ts';
import {
  getPlanetaryDemGrid,
  getRealTerrainForCoordinate,
  getTerrainChunkForTile,
} from './src/server/realTerrain.ts';
import { handleMcpRequest, MCP_SERVER_INFO, MCP_TOOLS } from './src/server/mcpServer.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;

function getMapsApiKey(): string {
  return (
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    ''
  ).trim();
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const CURATED_PLACES = [
  { name: 'Zócalo · Ciudad de México', address: 'Plaza de la Constitución, CDMX, México', lat: 19.4326, lng: -99.1332 },
  { name: 'Aeropuerto Internacional Benito Juárez (MEX)', address: 'Venustiano Carranza, CDMX, México', lat: 19.4361, lng: -99.0719 },
  { name: 'Santa Fe · Distrito Corporativo', address: 'Álvaro Obregón, CDMX, México', lat: 19.366, lng: -99.261 },
  { name: 'Polanco · Avenida Masaryk', address: 'Miguel Hidalgo, CDMX, México', lat: 19.4319, lng: -99.1924 },
  { name: 'Puerta del Sol · Madrid', address: 'Centro, Madrid, España', lat: 40.4168, lng: -3.7038 },
  { name: 'Aeropuerto Adolfo Suárez Madrid-Barajas', address: 'Barajas, Madrid, España', lat: 40.4983, lng: -3.5676 },
  { name: 'Estación de Tokio · Marunouchi', address: 'Chiyoda, Tokio, Japón', lat: 35.6812, lng: 139.7671 },
  { name: 'Shibuya Crossing · Tokio', address: 'Shibuya, Tokio, Japón', lat: 35.6595, lng: 139.7004 },
  { name: 'Times Square · Nueva York', address: 'Manhattan, NY, EE. UU.', lat: 40.758, lng: -73.9855 },
  { name: 'Aeropuerto JFK · Nueva York', address: 'Queens, NY, EE. UU.', lat: 40.6413, lng: -73.7781 },
  { name: 'Torre Eiffel · París', address: 'Champ de Mars, París, Francia', lat: 48.8584, lng: 2.2945 },
  { name: 'Puerto de Singapur', address: 'Tanjong Pagar, Singapur', lat: 1.2644, lng: 103.822 },
  { name: 'Canal de Panamá · Esclusas de Miraflores', address: 'Ciudad de Panamá, Panamá', lat: 8.9969, lng: -79.5914 },
];

function mapToRestTravelMode(mode: TravelMode): string {
  switch (mode) {
    case 'DRIVE':
      return 'DRIVE';
    case 'TRANSIT':
      return 'TRANSIT';
    case 'WALK':
      return 'WALK';
    case 'BICYCLE':
      return 'BICYCLE';
    default:
      return 'DRIVE';
  }
}

function parseGoogleDurationSeconds(dur?: string): number {
  if (!dur) return 0;
  const num = Number.parseFloat(dur.replace('s', ''));
  return Number.isFinite(num) ? Math.round(num) : 0;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'aetheria-global',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/config/maps', (_req, res) => {
    const key = getMapsApiKey();
    res.json({
      hasMapsKey: Boolean(key),
      apiKey: key || undefined,
    });
  });

  app.get('/api/world/events', async (req, res) => {
    try {
      const cat = String(req.query.category ?? 'all') as EventCategory | 'all';
      const feed = await getWorldFeed(cat);
      res.json(feed);
    } catch (error) {
      console.error('Error fetching world feed:', error);
      res.status(500).json({ error: 'No se pudo obtener la telemetría global.' });
    }
  });

  app.get('/api/earthquakes/24h', async (_req, res) => {
    try {
      const heatmap = await getEarthquakesLast24h();
      res.json(heatmap);
    } catch (error) {
      console.error('Error fetching 24h earthquakes:', error);
      res.status(500).json({ error: 'No se pudo obtener el mapa térmico sísmico de 24 horas.' });
    }
  });

  app.get('/api/wind/global', async (_req, res) => {
    try {
      const wind = await getGlobalWindField();
      res.json(wind);
    } catch (error) {
      console.error('Error fetching global wind field:', error);
      res.status(500).json({ error: 'No se pudo obtener la telemetría global de vientos.' });
    }
  });

  app.get('/api/disasters/history', async (req, res) => {
    try {
      const subtype = String(req.query.subtype ?? 'all') as DisasterSubtype | 'all';
      const status = String(req.query.status ?? 'all') as 'all' | 'active' | 'archived';
      const search = String(req.query.q ?? '');
      const limit = Number(req.query.limit ?? 120);
      await getWorldFeed('disaster').catch(() => null);
      const history = await queryDisasterHistory({ subtype, status, search, limit });
      res.json(history);
    } catch (error) {
      console.error('Error querying disaster history:', error);
      res.status(500).json({ error: 'No se pudo consultar el historial de desastres.' });
    }
  });

  app.post('/api/disasters/history/sync', async (req, res) => {
    try {
      const subtype = String(req.body?.subtype ?? 'all') as DisasterSubtype | 'all';
      const status = String(req.body?.status ?? 'all') as 'all' | 'active' | 'archived';
      const search = String(req.body?.q ?? '');
      await hydrateDisasterHistoryFromArchives(true);
      await getWorldFeed('disaster').catch(() => null);
      const history = await queryDisasterHistory({ subtype, status, search, limit: 150 });
      res.json(history);
    } catch (error) {
      console.error('Error syncing disaster history:', error);
      res.status(500).json({ error: 'No se pudo sincronizar el archivo histórico.' });
    }
  });

  app.get('/api/disasters/history/export', async (req, res) => {
    try {
      const subtype = String(req.query.subtype ?? 'all') as DisasterSubtype | 'all';
      const history = await queryDisasterHistory({ subtype, status: 'all', limit: 250 });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="aetheria-desastres-${subtype}.json"`
      );
      res.send(JSON.stringify(history, null, 2));
    } catch {
      res.status(500).json({ error: 'No se pudo exportar el historial.' });
    }
  });

  app.get('/api/terrain/real', async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ error: 'Coordenadas inválidas para Terreno 3D.' });
      return;
    }
    try {
      const gridSize = req.query.gridSize ? Number(req.query.gridSize) : 97;
      const maxBuildings = req.query.maxBuildings ? Number(req.query.maxBuildings) : 3800;
      const payload = await getRealTerrainForCoordinate({
        lat,
        lng,
        gridSize: Number.isFinite(gridSize) ? gridSize : 97,
        maxBuildings: Number.isFinite(maxBuildings) ? maxBuildings : 3800,
      });
      res.json(payload);
    } catch (error) {
      console.error('Real terrain fetch error:', error);
      res.status(500).json({ error: 'No se pudo generar el modelo de terreno 3D real.' });
    }
  });

  app.get('/api/terrain/chunk', async (req, res) => {
    const z = Number(req.query.z ?? 14);
    const tx = Number(req.query.tx);
    const ty = Number(req.query.ty);
    if (!Number.isFinite(z) || !Number.isFinite(tx) || !Number.isFinite(ty)) {
      res.status(400).json({ error: 'Parámetros de mosaico inválidos.' });
      return;
    }
    try {
      const gridSize = req.query.gridSize ? Number(req.query.gridSize) : undefined;
      const maxBuildings = req.query.maxBuildings ? Number(req.query.maxBuildings) : undefined;
      const includeBuildings = req.query.buildings !== '0';
      const chunk = await getTerrainChunkForTile({
        z,
        tx,
        ty,
        gridSize: gridSize && Number.isFinite(gridSize) ? gridSize : undefined,
        maxBuildings: maxBuildings && Number.isFinite(maxBuildings) ? maxBuildings : undefined,
        includeBuildings,
      });
      res.json(chunk);
    } catch (error) {
      console.error('Terrain chunk fetch error:', error);
      res.status(500).json({ error: 'No se pudo obtener el fragmento 3D.' });
    }
  });

  app.get('/api/terrain/planet-dem', async (_req, res) => {
    try {
      const dem = await getPlanetaryDemGrid();
      res.json(dem);
    } catch (error) {
      console.error('Planet DEM error:', error);
      res.status(500).json({ error: 'No se pudo obtener el relieve planetario.' });
    }
  });

  app.post('/api/places/search', async (req, res) => {
    const query = String(req.body?.query ?? '').trim();
    if (!query) {
      res.json({ places: CURATED_PLACES.slice(0, 6), source: 'curated' });
      return;
    }

    const mapsKey = getMapsApiKey();
    if (mapsKey) {
      try {
        const gRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': mapsKey,
            'X-Goog-FieldMask':
              'places.id,places.displayName,places.formattedAddress,places.location',
            'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
          },
          body: JSON.stringify({
            textQuery: query,
            languageCode: 'es',
            maxResultCount: 6,
          }),
        });

        if (gRes.status === 429) {
          res.status(200).json({
            places: CURATED_PLACES.filter((p) =>
              `${p.name} ${p.address}`.toLowerCase().includes(query.toLowerCase())
            ).slice(0, 6),
            source: 'curated-fallback',
            quotaExceeded: true,
          });
          return;
        }

        if (gRes.ok) {
          const payload = (await gRes.json()) as {
            places?: Array<{
              id?: string;
              displayName?: { text?: string };
              formattedAddress?: string;
              location?: { latitude?: number; longitude?: number };
            }>;
          };
          const mapped = (payload.places ?? [])
            .filter((p) => p.location?.latitude !== undefined && p.location?.longitude !== undefined)
            .map((p) => ({
              id: p.id,
              name: p.displayName?.text ?? query,
              address: p.formattedAddress ?? '',
              lat: p.location!.latitude!,
              lng: p.location!.longitude!,
            }));

          if (mapped.length > 0) {
            res.json({ places: mapped, source: 'google-places-api' });
            return;
          }
        }
      } catch (err) {
        console.warn('Places API proxy fallback:', err);
      }
    }

    // Key-free real global geocoding via OpenStreetMap Nominatim
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '6');
      url.searchParams.set('accept-language', 'es');
      const nRes = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'AetheriaGlobal/1.0 (geospatial-telemetry-app)',
        },
        signal: AbortSignal.timeout(3500),
      });
      if (nRes.ok) {
        const items = (await nRes.json()) as Array<{
          place_id?: number;
          name?: string;
          display_name?: string;
          lat?: string;
          lon?: string;
        }>;
        const mapped = items
          .map((item) => {
            const lat = Number.parseFloat(item.lat ?? '');
            const lng = Number.parseFloat(item.lon ?? '');
            const display = item.display_name ?? query;
            const shortName = item.name || display.split(',')[0]?.trim() || query;
            return {
              id: item.place_id ? `osm-${item.place_id}` : undefined,
              name: shortName,
              address: display,
              lat,
              lng,
            };
          })
          .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

        if (mapped.length > 0) {
          res.json({ places: mapped, source: 'openstreetmap-nominatim' });
          return;
        }
      }
    } catch {
      // Fallback to curated global hubs below
    }

    const q = query.toLowerCase();
    const matched = CURATED_PLACES.filter(
      (p) => p.name.toLowerCase().includes(q) || p.address.toLowerCase().includes(q)
    );
    res.json({
      places: (matched.length > 0 ? matched : CURATED_PLACES).slice(0, 6),
      source: 'curated',
    });
  });

  app.get('/api/places/reverse', async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.status(400).json({ error: 'Coordenadas inválidas' });
      return;
    }

    try {
      const url = new URL('https://nominatim.openstreetmap.org/reverse');
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('lat', String(lat));
      url.searchParams.set('lon', String(lng));
      url.searchParams.set('accept-language', 'es');
      const rRes = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'AetheriaGlobal/1.0 (geospatial-telemetry-app)',
        },
        signal: AbortSignal.timeout(3000),
      });
      if (rRes.ok) {
        const data = (await rRes.json()) as {
          name?: string;
          display_name?: string;
        };
        const label =
          data.name ||
          data.display_name?.split(',').slice(0, 2).join(', ').trim() ||
          `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
        res.json({ label, address: data.display_name ?? label, lat, lng });
        return;
      }
    } catch {
      // Fallback to coordinate label
    }
    res.json({
      label: `Punto (${lat.toFixed(3)}, ${lng.toFixed(3)})`,
      address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      lat,
      lng,
    });
  });

  app.post('/api/navigation/predict', async (req, res) => {
    try {
      const origin = req.body?.origin as LatLngPoint | undefined;
      const destination = req.body?.destination as LatLngPoint | undefined;
      const originLabel = String(req.body?.originLabel ?? 'Origen');
      const destinationLabel = String(req.body?.destinationLabel ?? 'Destino');
      const travelMode = (req.body?.travelMode as TravelMode | undefined) ?? 'DRIVE';
      const departureOffsetHours = Number(req.body?.departureOffsetHours ?? 0);
      const avoidHazards = Boolean(req.body?.avoidHazards ?? true);

      if (
        !origin ||
        !destination ||
        !Number.isFinite(origin.lat) ||
        !Number.isFinite(origin.lng) ||
        !Number.isFinite(destination.lat) ||
        !Number.isFinite(destination.lng)
      ) {
        res.status(400).json({ error: 'Se requieren coordenadas válidas de origen y destino.' });
        return;
      }

      const feed = await getWorldFeed('all');
      const mapsKey = getMapsApiKey();

      // Try real Google Maps Routes API when key is present and departure is immediate/future
      if (mapsKey) {
        try {
          const restMode = mapToRestTravelMode(travelMode);
          const isMotor = restMode === 'DRIVE';
          const futureDeparture =
            departureOffsetHours > 0
              ? new Date(Date.now() + departureOffsetHours * 3600 * 1000 + 30_000).toISOString()
              : undefined;

          const body: Record<string, unknown> = {
            origin: {
              location: { latLng: { latitude: origin.lat, longitude: origin.lng } },
            },
            destination: {
              location: { latLng: { latitude: destination.lat, longitude: destination.lng } },
            },
            travelMode: restMode,
            languageCode: 'es',
          };

          if (isMotor) {
            body.routingPreference = 'TRAFFIC_AWARE_OPTIMAL';
            if (futureDeparture) body.departureTime = futureDeparture;
          }

          const gRes = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': mapsKey,
              'X-Goog-FieldMask':
                'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration',
              'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
            },
            body: JSON.stringify(body),
          });

          if (gRes.status === 429) {
            const fallback = computeLocalPredictiveRoute({
              origin,
              destination,
              originLabel,
              destinationLabel,
              travelMode,
              departureOffsetHours,
              avoidHazards,
              activeEvents: feed.events,
            });
            res.json({ ...fallback, quotaExceeded: true });
            return;
          }

          if (gRes.ok) {
            const gJson = (await gRes.json()) as {
              routes?: Array<{
                distanceMeters?: number;
                duration?: string;
                staticDuration?: string;
                polyline?: { encodedPolyline?: string };
                legs?: Array<{
                  steps?: Array<{
                    distanceMeters?: number;
                    staticDuration?: string;
                    navigationInstruction?: { instructions?: string; maneuver?: string };
                  }>;
                }>;
              }>;
            };
            const firstRoute = gJson.routes?.[0];
            if (firstRoute?.polyline?.encodedPolyline) {
              const decoded = decodeEncodedPolyline(firstRoute.polyline.encodedPolyline);
              const hazardAlerts = scoreRouteHazardProximity(decoded, feed.events, 120);
              const prediction = predictTrafficProfile({
                lat: (origin.lat + destination.lat) / 2,
                lng: (origin.lng + destination.lng) / 2,
                travelMode,
                departureOffsetHours,
                hazardCountNearCorridor: hazardAlerts.length,
              });

              const rawSteps = firstRoute.legs?.[0]?.steps ?? [];
              const steps: NavigationStep[] = rawSteps.slice(0, 14).map((s) => ({
                instruction: s.navigationInstruction?.instructions || 'Continuar por la ruta',
                distanceMeters: s.distanceMeters ?? 0,
                durationSeconds: parseGoogleDurationSeconds(s.staticDuration),
                maneuver: s.navigationInstruction?.maneuver || 'STRAIGHT',
              }));

              const result: PredictiveRouteResult = {
                originLabel,
                destinationLabel,
                origin,
                destination,
                travelMode,
                distanceMeters: firstRoute.distanceMeters ?? 0,
                staticDurationSeconds: parseGoogleDurationSeconds(firstRoute.staticDuration),
                predictedDurationSeconds:
                  parseGoogleDurationSeconds(firstRoute.duration) ||
                  parseGoogleDurationSeconds(firstRoute.staticDuration),
                congestionIndex: prediction.congestionIndex,
                optimalDepartureWindow: prediction.optimalDepartureWindow,
                mlConfidence: prediction.mlConfidence,
                modelSummary:
                  'Ruta calculada con Google Maps Routes API (tráfico real) y enriquecida con modelo temporal ML.',
                source: 'google-routes-api',
                polylinePath: decoded,
                encodedPolyline: firstRoute.polyline.encodedPolyline,
                steps,
                hourlyForecast: prediction.hourlyForecast,
                hazardAlerts,
              };
              res.json(result);
              return;
            }
          }
        } catch (err) {
          console.warn('Google Routes API fallback to predictive ML engine:', err);
        }
      }

      // Key-free real street routing via OSRM + ML predictive traffic enrichment
      if (travelMode !== 'TRANSIT') {
        try {
          const osrmProfile =
            travelMode === 'WALK' ? 'foot' : travelMode === 'BICYCLE' ? 'bike' : 'driving';
          const osrmUrl = `https://router.project-osrm.org/route/v1/${osrmProfile}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&steps=true`;
          const oRes = await fetch(osrmUrl, {
            signal: AbortSignal.timeout(4000),
          });
          if (oRes.ok) {
            const oJson = (await oRes.json()) as {
              code?: string;
              routes?: Array<{
                distance?: number;
                duration?: number;
                geometry?: { coordinates?: Array<[number, number]> };
                legs?: Array<{
                  steps?: Array<{
                    distance?: number;
                    duration?: number;
                    name?: string;
                    maneuver?: { type?: string; modifier?: string };
                  }>;
                }>;
              }>;
            };
            const first = oJson.routes?.[0];
            const coords = first?.geometry?.coordinates ?? [];
            if (oJson.code === 'Ok' && first && coords.length >= 2) {
              const polylinePath: LatLngPoint[] = coords.map(([lng, lat]) => ({ lat, lng }));
              const hazardAlerts = scoreRouteHazardProximity(polylinePath, feed.events, 120);
              const prediction = predictTrafficProfile({
                lat: (origin.lat + destination.lat) / 2,
                lng: (origin.lng + destination.lng) / 2,
                travelMode,
                departureOffsetHours,
                hazardCountNearCorridor: hazardAlerts.length,
              });

              const staticSeconds = Math.max(60, Math.round(first.duration ?? 60));
              const trafficMultiplier = 1 + (prediction.congestionIndex / 100) * 0.65;
              const hazardPenalty = avoidHazards ? 1 + hazardAlerts.length * 0.08 : 1;
              const predictedSeconds = Math.round(
                staticSeconds * trafficMultiplier * hazardPenalty
              );

              const rawSteps = first.legs?.[0]?.steps ?? [];
              const steps: NavigationStep[] = rawSteps.slice(0, 14).map((s) => {
                const mType = s.maneuver?.type ?? 'continue';
                const mod = s.maneuver?.modifier ?? '';
                const road = s.name ? ` por ${s.name}` : '';
                const action =
                  mType === 'depart'
                    ? 'Inicia el recorrido'
                    : mType === 'arrive'
                      ? 'Llega al destino'
                      : mod.includes('left')
                        ? 'Gira a la izquierda'
                        : mod.includes('right')
                          ? 'Gira a la derecha'
                          : 'Continúa';
                return {
                  instruction: `${action}${road}`,
                  distanceMeters: Math.round(s.distance ?? 0),
                  durationSeconds: Math.round(s.duration ?? 0),
                  maneuver: mType.toUpperCase(),
                };
              });

              const result: PredictiveRouteResult = {
                originLabel,
                destinationLabel,
                origin,
                destination,
                travelMode,
                distanceMeters: Math.round(first.distance ?? 0),
                staticDurationSeconds: staticSeconds,
                predictedDurationSeconds: predictedSeconds,
                congestionIndex: prediction.congestionIndex,
                optimalDepartureWindow: prediction.optimalDepartureWindow,
                mlConfidence: prediction.mlConfidence,
                modelSummary:
                  'Ruta vial real (OSRM sin API key) enriquecida con modelo ML de tráfico y detección de riesgos.',
                source: 'osrm-ml-engine',
                polylinePath,
                steps,
                hourlyForecast: prediction.hourlyForecast,
                hazardAlerts,
              };
              res.json(result);
              return;
            }
          }
        } catch {
          // Fallback to local predictive engine below
        }
      }

      const fallback = computeLocalPredictiveRoute({
        origin,
        destination,
        originLabel,
        destinationLabel,
        travelMode,
        departureOffsetHours,
        avoidHazards,
        activeEvents: feed.events,
      });
      res.json(fallback);
    } catch (error) {
      console.error('Route prediction error:', error);
      res.status(500).json({ error: 'Error al calcular la ruta predictiva.' });
    }
  });

  function buildLocalGeospatialBrief(
    prompt: string,
    feed: Awaited<ReturnType<typeof getWorldFeed>>
  ): string {
    const disasters = feed.events.filter((e) => e.category === 'disaster');
    const conflicts = feed.events.filter((e) => e.category === 'conflict');
    const flights = feed.events.filter((e) => e.category === 'flight');
    const ships = feed.events.filter((e) => e.category === 'ship');

    const topDisaster =
      [...disasters].sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0))[0] ?? disasters[0];
    const topConflict =
      conflicts.find((c) => c.severity === 'critical') ?? conflicts[0];
    const busiestFlight = flights[0];
    const keyShip = ships[0];

    const bullets = [
      `• Situación Sísmica y Natural (${disasters.length} activos): ${
        topDisaster
          ? `${topDisaster.title} en ${topDisaster.region} (${topDisaster.lat.toFixed(2)}, ${topDisaster.lng.toFixed(2)}) — ${topDisaster.summary}`
          : 'Sin eventos críticos registrados.'
      }`,
      `• Zonas de Tensión y Conflicto (${conflicts.length} corredores): ${
        topConflict
          ? `${topConflict.title} (${topConflict.lat.toFixed(2)}, ${topConflict.lng.toFixed(2)}, severidad ${topConflict.severity}). Se recomienda margen de desvío aéreo/marítimo.`
          : 'Sin alertas críticas de conflicto.'
      }`,
      `• Tráfico Aéreo y Marítimo (${flights.length} vuelos · ${ships.length} buques): ${
        busiestFlight
          ? `Vuelo destacado ${busiestFlight.title} (${busiestFlight.lat.toFixed(2)}, ${busiestFlight.lng.toFixed(2)})`
          : 'Corredores aéreos estables'
      }${keyShip ? `; buque ${keyShip.title} en tránsito.` : '.'}`,
      `• Recomendación operativa ("${prompt.slice(0, 64)}${prompt.length > 64 ? '…' : ''}"): Prioriza rutas con "Evitar riesgos" activado en el Asistente de Navegación ML o consulta el endpoint /mcp para automatizar filtros geoespaciales.`,
    ];

    return `Síntesis Geoespacial Local (${feed.summary.total} señales en vivo):\n\n${bullets.join('\n')}`;
  }

  app.post('/api/ai/analyze', async (req, res) => {
    const prompt = String(req.body?.prompt ?? '').trim();
    if (!prompt) {
      res.status(400).json({ error: 'Escribe una consulta para el análisis geoespacial.' });
      return;
    }

    try {
      const feed = await getWorldFeed('all');
      const ai = getGeminiClient();

      if (!ai) {
        res.json({
          analysis: buildLocalGeospatialBrief(prompt, feed),
          model: 'motor-tactico-local',
          eventsAnalyzed: feed.summary.total,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      try {
        const compactContext = {
          summary: feed.summary,
          disasters: feed.events.filter((e) => e.category === 'disaster').slice(0, 8),
          conflicts: feed.events.filter((e) => e.category === 'conflict').slice(0, 6),
          flights: feed.events.filter((e) => e.category === 'flight').slice(0, 8),
          ships: feed.events.filter((e) => e.category === 'ship').slice(0, 8),
        };

        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Consulta del operador: ${prompt}\n\nTelemetría global en tiempo real (JSON):\n${JSON.stringify(compactContext)}`,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction:
              'Eres un analista geoespacial y de movilidad global en español. Responde de forma concisa, táctica y útil usando exclusivamente los datos de telemetría en tiempo real proporcionados. Incluye coordenadas aproximadas, impacto en rutas aéreas/marítimas/terrestres y recomendaciones accionables en máximo 4 viñetas claras.',
          },
        });

        res.json({
          analysis: response.text ?? buildLocalGeospatialBrief(prompt, feed),
          model: 'gemini-4-hydrogen',
          eventsAnalyzed: feed.summary.total,
          timestamp: new Date().toISOString(),
        });
      } catch {
        res.json({
          analysis: buildLocalGeospatialBrief(prompt, feed),
          model: 'motor-tactico-local',
          eventsAnalyzed: feed.summary.total,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error('Analysis feed error:', error);
      res.status(500).json({ error: 'No se pudo obtener la telemetría para el análisis.' });
    }
  });

  // Model Context Protocol (MCP) Endpoints
  app.get('/api/mcp/tools', (_req, res) => {
    res.json({
      server: MCP_SERVER_INFO,
      endpoint: '/mcp',
      tools: MCP_TOOLS,
    });
  });

  app.get('/mcp', (_req, res) => {
    res.json({
      protocol: 'Model Context Protocol (JSON-RPC 2.0 over HTTP)',
      server: MCP_SERVER_INFO,
      toolsCount: MCP_TOOLS.length,
      tools: MCP_TOOLS.map((t) => t.name),
    });
  });

  app.post('/mcp', async (req, res) => {
    try {
      const body = req.body as McpJsonRpcRequest;
      const result = await handleMcpRequest(body);
      res.json(result);
    } catch (error) {
      console.error('MCP RPC error:', error);
      res.status(500).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        error: { code: -32603, message: 'Internal MCP server error' },
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Aetheria Global server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
