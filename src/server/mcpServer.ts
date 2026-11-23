import { haversineKm } from '../shared/geo.ts';
import {
  computeLocalPredictiveRoute,
  predictTrafficProfile,
} from '../shared/predictiveTraffic.ts';
import type {
  DisasterSubtype,
  EventCategory,
  McpJsonRpcRequest,
  McpToolDefinition,
  TravelMode,
} from '../shared/types.ts';
import { queryDisasterHistory } from './disasterHistory.ts';
import { getWorldFeed } from './worldFeed.ts';

export const MCP_SERVER_INFO = {
  name: 'aetheria-global-mcp',
  version: '1.0.0',
  protocolVersion: '2024-11-05',
};

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'query_global_events',
    description:
      'Consulta eventos globales en tiempo real (desastres naturales, vuelos, barcos y zonas de conflicto) con filtros opcionales por categoría, severidad o radio geográfico.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['all', 'disaster', 'flight', 'ship', 'conflict'],
          description: 'Categoría de evento a consultar.',
        },
        lat: { type: 'number', description: 'Latitud central opcional para filtro radial.' },
        lng: { type: 'number', description: 'Longitud central opcional para filtro radial.' },
        radiusKm: { type: 'number', description: 'Radio máximo en km (por defecto 1500 km si hay lat/lng).' },
        limit: { type: 'number', description: 'Máximo de eventos a retornar (por defecto 20).' },
      },
    },
  },
  {
    name: 'track_flights_and_vessels',
    description:
      'Rastrea tráfico aéreo (ADS-B / corredores) y marítimo (AIS) cerca de una coordenada, devolviendo rumbo, velocidad en nudos y densidad de tránsito.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitud del punto de observación.' },
        lng: { type: 'number', description: 'Longitud del punto de observación.' },
        radiusKm: { type: 'number', description: 'Radio de barrido en kilómetros (por defecto 2000).' },
      },
      required: ['lat', 'lng'],
    },
  },
  {
    name: 'compute_predictive_route',
    description:
      'Calcula una ruta optimizada con predicción de tráfico basada en modelo temporal ML, evaluación de peligros activos cercanos y ETA estimado.',
    inputSchema: {
      type: 'object',
      properties: {
        originLat: { type: 'number' },
        originLng: { type: 'number' },
        destinationLat: { type: 'number' },
        destinationLng: { type: 'number' },
        travelMode: { type: 'string', enum: ['DRIVE', 'TRANSIT', 'WALK', 'BICYCLE'] },
        departureOffsetHours: { type: 'number', description: 'Horas futuras de salida (0-5).' },
        avoidHazards: { type: 'boolean' },
      },
      required: ['originLat', 'originLng', 'destinationLat', 'destinationLng'],
    },
  },
  {
    name: 'analyze_geospatial_risk',
    description:
      'Evalúa el índice de riesgo compuesto y congestión predictiva para una coordenada específica cruzando sismos, tormentas, conflictos y tráfico.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lng: { type: 'number' },
        radiusKm: { type: 'number' },
      },
      required: ['lat', 'lng'],
    },
  },
  {
    name: 'query_disaster_history',
    description:
      'Consulta el historial guardado en base de datos SQLite de desastres naturales por categoría (earthquake, storm, wildfire, flood, volcano, iceberg) con todos sus datos persistidos.',
    inputSchema: {
      type: 'object',
      properties: {
        subtype: {
          type: 'string',
          enum: ['all', 'earthquake', 'storm', 'wildfire', 'flood', 'volcano', 'iceberg'],
          description: 'Subcategoría del desastre natural.',
        },
        status: {
          type: 'string',
          enum: ['all', 'active', 'archived'],
          description: 'Filtrar entre activos actuales o históricos archivados.',
        },
        limit: { type: 'number', description: 'Máximo de registros (por defecto 25).' },
      },
    },
  },
];

function jsonRpcResult(id: string | number | null | undefined, result: unknown) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result,
  };
}

function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string
) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };
}

export async function handleMcpRequest(reqBody: McpJsonRpcRequest): Promise<unknown> {
  const { id, method, params } = reqBody;

  if (!method || reqBody.jsonrpc !== '2.0') {
    return jsonRpcError(id, -32600, 'Invalid JSON-RPC 2.0 request');
  }

  switch (method) {
    case 'initialize':
      return jsonRpcResult(id, {
        protocolVersion: MCP_SERVER_INFO.protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: {
          name: MCP_SERVER_INFO.name,
          version: MCP_SERVER_INFO.version,
        },
      });

    case 'notifications/initialized':
      return jsonRpcResult(id, {});

    case 'ping':
      return jsonRpcResult(id, { ok: true, timestamp: new Date().toISOString() });

    case 'tools/list':
      return jsonRpcResult(id, { tools: MCP_TOOLS });

    case 'resources/list':
      return jsonRpcResult(id, {
        resources: [
          {
            uri: 'aetheria://feeds/live-telemetry',
            name: 'Global Live Telemetry Feed',
            description: 'Resumen en tiempo real de desastres, vuelos, barcos y conflictos.',
            mimeType: 'application/json',
          },
        ],
      });

    case 'resources/read': {
      const uri = String(params?.uri ?? '');
      if (uri !== 'aetheria://feeds/live-telemetry') {
        return jsonRpcError(id, -32602, `Unknown resource URI: ${uri}`);
      }
      const feed = await getWorldFeed('all');
      return jsonRpcResult(id, {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(feed.summary, null, 2),
          },
        ],
      });
    }

    case 'tools/call': {
      const toolName = String(params?.name ?? '');
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      if (toolName === 'query_global_events') {
        const category = (args.category as EventCategory | 'all' | undefined) ?? 'all';
        const feed = await getWorldFeed(category);
        let events = feed.events;

        if (typeof args.lat === 'number' && typeof args.lng === 'number') {
          const center = { lat: args.lat, lng: args.lng };
          const maxRadius = typeof args.radiusKm === 'number' ? args.radiusKm : 1500;
          events = events.filter((e) => haversineKm(center, { lat: e.lat, lng: e.lng }) <= maxRadius);
        }

        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, args.limit)) : 20;
        const sliced = events.slice(0, limit);

        return jsonRpcResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ summary: feed.summary, count: sliced.length, events: sliced }, null, 2),
            },
          ],
        });
      }

      if (toolName === 'track_flights_and_vessels') {
        const lat = Number(args.lat);
        const lng = Number(args.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return jsonRpcError(id, -32602, 'Parameters lat and lng are required numbers');
        }
        const radiusKm = typeof args.radiusKm === 'number' ? args.radiusKm : 2000;
        const feed = await getWorldFeed('all');
        const center = { lat, lng };
        const tracked = feed.events
          .filter((e) => e.category === 'flight' || e.category === 'ship')
          .map((e) => ({
            ...e,
            distanceKm: Math.round(haversineKm(center, { lat: e.lat, lng: e.lng })),
          }))
          .filter((e) => e.distanceKm <= radiusKm)
          .sort((a, b) => a.distanceKm - b.distanceKm);

        return jsonRpcResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  center,
                  radiusKm,
                  flightsCount: tracked.filter((t) => t.category === 'flight').length,
                  shipsCount: tracked.filter((t) => t.category === 'ship').length,
                  units: tracked.slice(0, 20),
                },
                null,
                2
              ),
            },
          ],
        });
      }

      if (toolName === 'compute_predictive_route') {
        const originLat = Number(args.originLat);
        const originLng = Number(args.originLng);
        const destinationLat = Number(args.destinationLat);
        const destinationLng = Number(args.destinationLng);
        if (
          !Number.isFinite(originLat) ||
          !Number.isFinite(originLng) ||
          !Number.isFinite(destinationLat) ||
          !Number.isFinite(destinationLng)
        ) {
          return jsonRpcError(id, -32602, 'Valid origin and destination coordinates are required');
        }
        const travelMode = (args.travelMode as TravelMode | undefined) ?? 'DRIVE';
        const feed = await getWorldFeed('all');
        const route = computeLocalPredictiveRoute({
          origin: { lat: originLat, lng: originLng },
          destination: { lat: destinationLat, lng: destinationLng },
          travelMode,
          departureOffsetHours:
            typeof args.departureOffsetHours === 'number' ? args.departureOffsetHours : 0,
          avoidHazards: Boolean(args.avoidHazards ?? true),
          activeEvents: feed.events,
        });

        return jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(route, null, 2) }],
        });
      }

      if (toolName === 'analyze_geospatial_risk') {
        const lat = Number(args.lat);
        const lng = Number(args.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          return jsonRpcError(id, -32602, 'Parameters lat and lng are required numbers');
        }
        const radiusKm = typeof args.radiusKm === 'number' ? args.radiusKm : 800;
        const feed = await getWorldFeed('all');
        const center = { lat, lng };
        const nearby = feed.events
          .map((e) => ({
            event: e,
            distanceKm: Math.round(haversineKm(center, { lat: e.lat, lng: e.lng })),
          }))
          .filter((item) => item.distanceKm <= radiusKm);

        const hazards = nearby.filter(
          (i) => i.event.category === 'disaster' || i.event.category === 'conflict'
        );
        const severityWeight = hazards.reduce((acc, h) => {
          const w =
            h.event.severity === 'critical'
              ? 35
              : h.event.severity === 'high'
                ? 22
                : h.event.severity === 'moderate'
                  ? 12
                  : 5;
          return acc + w;
        }, 0);

        const riskScore = Math.min(100, severityWeight);
        const traffic = predictTrafficProfile({
          lat,
          lng,
          travelMode: 'DRIVE',
          hazardCountNearCorridor: hazards.length,
        });

        return jsonRpcResult(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  center,
                  radiusKm,
                  compositeRiskScore: riskScore,
                  riskLevel:
                    riskScore >= 65 ? 'CRÍTICO' : riskScore >= 35 ? 'ALTO' : riskScore >= 15 ? 'MODERADO' : 'BAJO',
                  activeHazardsCount: hazards.length,
                  nearbyTrafficCongestionPct: traffic.congestionIndex,
                  optimalWindow: traffic.optimalDepartureWindow,
                  hazards: hazards.slice(0, 10).map((h) => ({
                    title: h.event.title,
                    category: h.event.category,
                    severity: h.event.severity,
                    distanceKm: h.distanceKm,
                  })),
                },
                null,
                2
              ),
            },
          ],
        });
      }

      if (toolName === 'query_disaster_history') {
        const subtype = (args.subtype as DisasterSubtype | 'all' | undefined) ?? 'all';
        const status = (args.status as 'all' | 'active' | 'archived' | undefined) ?? 'all';
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, args.limit)) : 25;
        const history = await queryDisasterHistory({ subtype, status, limit });
        return jsonRpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(history, null, 2) }],
        });
      }

      return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}
