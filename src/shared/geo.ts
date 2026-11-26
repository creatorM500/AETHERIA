import type { LatLngPoint, SectorPreset } from './types.ts';

const EARTH_RADIUS_KM = 6371;

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function normalizeLngDeg(lng: number): number {
  if (!Number.isFinite(lng)) return 0;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Converts latitude/longitude (degrees) to right-handed Y-up 3D Cartesian coordinates.
 * Matches Three.js SphereGeometry standard equirectangular UV mapping.
 */
export function latLngToCartesian(
  lat: number,
  lng: number,
  radius = 1
): { x: number; y: number; z: number } {
  const phi = degToRad(90 - lat);
  const theta = degToRad(lng + 180);

  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);

  return { x, y, z };
}

/**
 * Converts Y-up 3D Cartesian coordinates back to latitude/longitude (degrees).
 */
export function cartesianToLatLng(x: number, y: number, z: number): LatLngPoint {
  const radius = Math.sqrt(x * x + y * y + z * z);
  if (radius < 1e-8) {
    return { lat: 0, lng: 0 };
  }

  const phi = Math.acos(clamp(y / radius, -1, 1));
  const lat = 90 - radToDeg(phi);

  let theta = Math.atan2(z, -x);
  if (theta < 0) {
    theta += Math.PI * 2;
  }
  let lng = radToDeg(theta) - 180;
  if (lng < -180) lng += 360;
  if (lng > 180) lng -= 360;

  return { lat, lng };
}

/**
 * Great-circle Haversine distance in kilometers.
 */
export function haversineKm(a: LatLngPoint, b: LatLngPoint): number {
  const dLat = degToRad(b.lat - a.lat);
  const dLng = degToRad(b.lng - a.lng);
  const lat1 = degToRad(a.lat);
  const lat2 = degToRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial forward compass bearing in degrees [0, 360).
 */
export function calculateBearingDeg(from: LatLngPoint, to: LatLngPoint): number {
  const lat1 = degToRad(from.lat);
  const lat2 = degToRad(to.lat);
  const dLng = degToRad(to.lng - from.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  const brng = radToDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}

/**
 * Spherical linear interpolation along a great-circle arc.
 */
export function interpolateGreatCircle(
  from: LatLngPoint,
  to: LatLngPoint,
  segments = 32
): LatLngPoint[] {
  const lat1 = degToRad(from.lat);
  const lng1 = degToRad(from.lng);
  const lat2 = degToRad(to.lat);
  const lng2 = degToRad(to.lng);

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2
      )
    );

  if (d < 1e-6) {
    return [from, to];
  }

  const points: LatLngPoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);

    const x =
      A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
    const y =
      A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);

    const lat = radToDeg(Math.atan2(z, Math.sqrt(x * x + y * y)));
    const lng = radToDeg(Math.atan2(y, x));
    points.push({ lat, lng });
  }
  return points;
}

/**
 * Deterministic multi-octave procedural terrain height sampler for the local 3D Sector view.
 */
export function sampleTerrainElevation(
  x: number,
  z: number,
  seedLat = 19.4326,
  seedLng = -99.1332,
  reliefScale = 1.0
): number {
  const phaseA = (seedLat * 0.17 + seedLng * 0.11) % (Math.PI * 2);
  const phaseB = (seedLat * 0.07 - seedLng * 0.19) % (Math.PI * 2);

  // Keep central urban corridor flatter for realistic street/building grounding
  const radialDist = Math.sqrt(x * x + z * z);
  const basinFactor = clamp((radialDist - 12) / 36, 0.15, 1.35);

  const ridge1 = Math.sin(x * 0.065 + phaseA) * Math.cos(z * 0.065 - phaseB);
  const ridge2 = Math.sin((x + z) * 0.11 + phaseB) * 0.45;
  const micro = Math.cos(x * 0.23 - z * 0.17) * 0.18;

  const rawHeight = (ridge1 * 3.4 + ridge2 * 2.1 + micro + 1.2) * basinFactor * reliefScale;
  return Math.max(-0.4, rawHeight);
}

/**
 * Decodes a Google Encoded Polyline string into LatLng points.
 */
export function decodeEncodedPolyline(encoded: string): LatLngPoint[] {
  const points: LatLngPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dLat;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dLng;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return points;
}

export const SECTOR_PRESETS: SectorPreset[] = [
  {
    id: 'cdmx',
    name: 'Ciudad de México',
    country: 'México',
    lat: 19.4326,
    lng: -99.1332,
    zoomDistance: 14.5,
    description: 'Valle de México · Corredor Reforma-Polanco con relieve montañoso circundante',
    buildingDensity: 1.0,
    terrainRelief: 1.15,
  },
  {
    id: 'tokyo',
    name: 'Tokio · Shibuya',
    country: 'Japón',
    lat: 35.6762,
    lng: 139.6503,
    zoomDistance: 14.5,
    description: 'Bahía de Tokio · Alta densidad urbana y monitoreo sísmico en tiempo real',
    buildingDensity: 1.2,
    terrainRelief: 0.75,
  },
  {
    id: 'nyc',
    name: 'Nueva York · Manhattan',
    country: 'EE. UU.',
    lat: 40.7128,
    lng: -74.006,
    zoomDistance: 14.5,
    description: 'Hudson & East River · Corredor financiero, tráfico aéreo y portuario',
    buildingDensity: 1.25,
    terrainRelief: 0.5,
  },
  {
    id: 'madrid',
    name: 'Madrid · Castellana',
    country: 'España',
    lat: 40.4168,
    lng: -3.7038,
    zoomDistance: 14.5,
    description: 'Meseta Central · Eje Paseo de la Castellana y nodos intermodales',
    buildingDensity: 0.95,
    terrainRelief: 0.85,
  },
  {
    id: 'hormuz',
    name: 'Estrecho de Ormuz',
    country: 'Omán · Golfo Pérsico',
    lat: 26.185,
    lng: 56.245,
    zoomDistance: 15.0,
    description: 'Fiordos de Musandam y paso estratégico · Tráfico AIS de buques cisterna',
    buildingDensity: 0.45,
    terrainRelief: 1.45,
  },
  {
    id: 'panama',
    name: 'Canal de Panamá',
    country: 'Panamá',
    lat: 9.08,
    lng: -79.68,
    zoomDistance: 15.0,
    description: 'Esclusas interoceánicas · Flujo marítimo Atlántico-Pacífico',
    buildingDensity: 0.55,
    terrainRelief: 1.1,
  },
];

export function lngToTileX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * Math.pow(2, zoom);
}

export function tileXToLng(tx: number, zoom: number): number {
  return (tx / Math.pow(2, zoom)) * 360 - 180;
}

export function latToTileY(lat: number, zoom: number): number {
  const clamped = clamp(lat, -85.05112878, 85.05112878);
  const rad = degToRad(clamped);
  const n = Math.pow(2, zoom);
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
}

export function tileYToLat(ty: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * ty) / Math.pow(2, zoom);
  return radToDeg(Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
}

/**
 * Computes an appropriate 3D globe camera distance (radius=10) to frame a route cleanly.
 */
export function routeSpanToGlobeDistance(origin: LatLngPoint, destination: LatLngPoint): number {
  const km = haversineKm(origin, destination);
  if (km < 8) return 10.1;
  if (km < 25) return 10.18;
  if (km < 80) return 10.45;
  if (km < 300) return 11.2;
  if (km < 1200) return 13.5;
  if (km < 4000) return 17.5;
  return 22.0;
}

/**
 * Parses direct latitude/longitude search queries such as "19.4326, -99.1332",
 * "35.6762 139.6503", or "19.4326° N, 99.1332° W".
 */
export function parseCoordinateQuery(raw: string): LatLngPoint | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const dmsRegex =
    /^(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[,\s;:/]+\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])?$/;
  const match = trimmed.match(dmsRegex);
  if (!match) return null;

  let lat = Number.parseFloat(match[1]);
  let lng = Number.parseFloat(match[3]);
  const latHemi = match[2]?.toUpperCase();
  const lngHemi = match[4]?.toUpperCase();

  if (latHemi === 'S') lat = -Math.abs(lat);
  else if (latHemi === 'N') lat = Math.abs(lat);

  if (lngHemi === 'W') lng = -Math.abs(lng);
  else if (lngHemi === 'E') lng = Math.abs(lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -85 || lat > 85 || lng < -180 || lng > 180) return null;

  return { lat, lng };
}
