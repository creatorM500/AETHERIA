export type EventCategory = 'disaster' | 'flight' | 'ship' | 'conflict';

export type SeverityLevel = 'low' | 'moderate' | 'high' | 'critical';

export type GlobeTextureMode = 'satellite' | 'godseye' | 'thermal' | 'topo';

export type ViewportMode = 'globe' | 'sector3d' | 'maps';

export interface LatLngPoint {
  lat: number;
  lng: number;
}

export type DisasterSubtype =
  | 'earthquake'
  | 'storm'
  | 'wildfire'
  | 'flood'
  | 'volcano'
  | 'iceberg';

export interface GlobalEvent {
  id: string;
  category: EventCategory;
  subtype: string;
  title: string;
  region: string;
  country?: string;
  lat: number;
  lng: number;
  altitudeKm?: number;
  headingDeg?: number;
  speedKts?: number;
  maxWindKmh?: number;
  centralPressureHpa?: number;
  cycloneCategory?: 0 | 1 | 2 | 3 | 4 | 5;
  severity: SeverityLevel;
  magnitude?: number;
  depthKm?: number;
  alertLevel?: string;
  timestamp: string;
  source: string;
  sourceUrl?: string;
  summary: string;
  radiusKm?: number;
  destinationLat?: number;
  destinationLng?: number;
  destinationLabel?: string;
  rawDetails?: Record<string, unknown>;
}

export interface CycloneVortexSpec {
  id: string;
  title: string;
  lat: number;
  lng: number;
  radiusKm: number;
  coreRadiusKm: number;
  outerInfluenceKm: number;
  maxWindMs: number;
  centralPressureHpa: number;
  cycloneCategory: 0 | 1 | 2 | 3 | 4 | 5;
  vorticityScale: number;
  spinSign: 1 | -1;
}

export interface DisasterHistoryRecord {
  id: string;
  subtype: DisasterSubtype;
  title: string;
  region: string;
  country?: string;
  lat: number;
  lng: number;
  severity: SeverityLevel;
  magnitude?: number;
  depthKm?: number;
  speedKts?: number;
  headingDeg?: number;
  radiusKm?: number;
  alertLevel?: string;
  status: 'active' | 'archived';
  source: string;
  sourceUrl?: string;
  summary: string;
  occurredAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observationsCount: number;
  rawData: Record<string, unknown>;
}

export interface DisasterHistoryResponse {
  records: DisasterHistoryRecord[];
  countsBySubtype: Record<DisasterSubtype | 'all', number>;
  activeCount: number;
  archivedCount: number;
  totalSaved: number;
  lastArchivedAt: string | null;
}

export interface WorldFeedSummary {
  total: number;
  disasters: number;
  flights: number;
  ships: number;
  conflicts: number;
  updatedAt: string;
  sources: string[];
}

export interface WorldFeedResponse {
  events: GlobalEvent[];
  summary: WorldFeedSummary;
}

export interface SeismicQuake24h {
  id: string;
  lat: number;
  lng: number;
  magnitude: number;
  depthKm: number;
  place: string;
  occurredAtMs: number;
  timestamp: string;
  tsunami: boolean;
  significance: number;
  sourceUrl?: string;
}

export interface SeismicHeatScaleMetrics {
  count24h: number;
  minMag: number;
  midMag: number;
  maxMag: number;
  peakDensityScore: number;
  peakQuake: SeismicQuake24h | null;
  windowStartIso: string;
  windowEndIso: string;
}

export interface SeismicHeatmap24hResponse {
  quakes: SeismicQuake24h[];
  metrics: SeismicHeatScaleMetrics;
  source: string;
  updatedAt: string;
}

export interface WindPeakPoint {
  lat: number;
  lng: number;
  speedKmh: number;
  directionFromDeg: number;
}

export interface WindFieldMetrics {
  gridRows: number;
  gridCols: number;
  sampleCount: number;
  minSpeedKmh: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  peakPoint: WindPeakPoint | null;
}

export interface GlobalWindFieldResponse {
  minLat: number;
  maxLat: number;
  latStepDeg: number;
  minLng: number;
  lngStepDeg: number;
  rows: number;
  cols: number;
  uGrid: number[];
  vGrid: number[];
  metrics: WindFieldMetrics;
  source: string;
  updatedAt: string;
}

export interface SectorPreset {
  id: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  zoomDistance: number;
  description: string;
  buildingDensity: number;
  terrainRelief: number;
}

export type QualityTier = 'ultra' | 'balanced' | 'eco';

export interface TerrainBuildingFootprint {
  id: string;
  outer: Array<[number, number]>;
  holes?: Array<Array<[number, number]>>;
  heightM: number;
  minHeightM: number;
  kind?: string;
}

export type TerrainRoadKind =
  | 'motorway'
  | 'primary'
  | 'secondary'
  | 'residential'
  | 'rail';

export interface TerrainRoadPolyline {
  id: string;
  kind: TerrainRoadKind;
  coords: Array<[number, number]>;
  widthM: number;
  name?: string;
  ref?: string;
}

export interface TrafficCameraFeedPoint {
  id: string;
  cameraCode: string;
  roadName: string;
  roadKind: TerrainRoadKind;
  roadRef?: string;
  lat: number;
  lng: number;
  elevationM: number;
  bearingDeg: number;
  lanes: number;
  speedLimitKmh: number;
  estimatedFlowVph: number;
  congestionPct: number;
  avgSpeedKmh: number;
  solarPhase: 'day' | 'twilight' | 'night';
  nearbyAlertTitle?: string;
}

export type TerrainWaterKind = 'ocean' | 'river' | 'canal' | 'lake' | 'stream';

export interface TerrainWaterFeature {
  id: string;
  kind: TerrainWaterKind;
  isPolygon: boolean;
  rings: Array<Array<[number, number]>>;
  widthM?: number;
}

export interface LiveTerrainCoords {
  lat: number;
  lng: number;
  groundElevM: number;
  cameraAltM: number;
  source: 'cursor' | 'camera';
}

export interface RealTerrainPayload {
  center: LatLngPoint;
  zoom: number;
  tileSpan: {
    minTx: number;
    maxTx: number;
    minTy: number;
    maxTy: number;
  };
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  spanMetersX: number;
  spanMetersZ: number;
  sceneWidth: number;
  sceneDepth: number;
  rows: number;
  cols: number;
  elevationsM: number[];
  minElevationM: number;
  maxElevationM: number;
  buildings: TerrainBuildingFootprint[];
  demSource: 'terrarium-dem' | 'open-meteo-dem' | 'fallback';
  buildingsSource: 'openfreemap-osm' | 'none';
  fetchedAt: string;
}

export interface TerrainChunkPayload {
  zoom: number;
  tx: number;
  ty: number;
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  spanMetersX: number;
  spanMetersZ: number;
  rows: number;
  cols: number;
  elevationsM: number[];
  minElevationM: number;
  maxElevationM: number;
  buildings: TerrainBuildingFootprint[];
  roads?: TerrainRoadPolyline[];
  waterFeatures?: TerrainWaterFeature[];
  demSource: 'terrarium-dem' | 'fallback';
  buildingsSource: 'versatiles-osm' | 'openfreemap-osm' | 'none';
}

export interface TerrainHudStats {
  loading: boolean;
  stage: 'idle' | 'dem' | 'buildings' | 'ready' | 'error';
  minElevationM: number;
  maxElevationM: number;
  buildingsCount: number;
  spanKm: number;
  chunksLoaded?: number;
  demSource: string;
  buildingsSource: string;
  qualityTier: QualityTier;
}

export type TravelMode = 'DRIVE' | 'TRANSIT' | 'WALK' | 'BICYCLE';

export interface TrafficForecastSlot {
  offsetHours: number;
  label: string;
  congestionPct: number;
  predictedSpeedKmh: number;
  confidence: number;
}

export interface RouteHazardAlert {
  eventId: string;
  title: string;
  category: EventCategory;
  severity: SeverityLevel;
  distanceKm: number;
}

export interface NavigationStep {
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
  maneuver: string;
}

export interface PredictiveRouteResult {
  originLabel: string;
  destinationLabel: string;
  origin: LatLngPoint;
  destination: LatLngPoint;
  travelMode: TravelMode;
  distanceMeters: number;
  staticDurationSeconds: number;
  predictedDurationSeconds: number;
  congestionIndex: number;
  optimalDepartureWindow: string;
  mlConfidence: number;
  modelSummary: string;
  source: 'google-routes-api' | 'osrm-ml-engine' | 'predictive-ml-engine';
  polylinePath: LatLngPoint[];
  encodedPolyline?: string;
  steps: NavigationStep[];
  hourlyForecast: TrafficForecastSlot[];
  hazardAlerts: RouteHazardAlert[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type AlertRuleType = 'seismic' | 'meteorological';

export interface AlertReferencePoint {
  lat: number;
  lng: number;
  label: string;
  mode: 'active-sector' | 'geolocation' | 'custom';
}

export interface AlertRuleConfig {
  seismicEnabled: boolean;
  seismicMinMagnitude: number;
  seismicUseRadius: boolean;
  seismicRadiusKm: number;
  meteorologicalEnabled: boolean;
  meteorologicalRadiusKm: number;
  meteorologicalMinSeverity: 'high' | 'critical';
  referencePoint: AlertReferencePoint;
  browserNotificationsEnabled: boolean;
}

export interface ClientAlertNotification {
  id: string;
  ruleKey: string;
  eventId: string;
  ruleType: AlertRuleType;
  title: string;
  message: string;
  severity: SeverityLevel;
  lat: number;
  lng: number;
  magnitude?: number;
  depthKm?: number;
  distanceKm?: number;
  subtype: string;
  source: string;
  occurredAt: string;
  triggeredAtMs: number;
  read: boolean;
}

export interface AlertEvaluationPreview {
  matchingSeismicCount: number;
  matchingMeteoCount: number;
  strongestSeismicMag: number | null;
  nearestMeteoKm: number | null;
}

export interface WeatherRadarPeakPoint {
  lat: number;
  lng: number;
  precipMmH: number;
  pressureHpa: number;
}

export interface WeatherRadarMetrics {
  gridRows: number;
  gridCols: number;
  sampleCount: number;
  minPressureHpa: number;
  maxPressureHpa: number;
  avgPressureHpa: number;
  maxPrecipMmH: number;
  peakPrecipPoint: WeatherRadarPeakPoint | null;
}

export interface GlobalWeatherRadarResponse {
  minLat: number;
  maxLat: number;
  latStepDeg: number;
  minLng: number;
  lngStepDeg: number;
  rows: number;
  cols: number;
  precipGrid: number[];
  pressureGrid: number[];
  cloudGrid: number[];
  metrics: WeatherRadarMetrics;
  source: string;
  updatedAt: string;
}

export interface IsobarContourSegment {
  lat1: number;
  lng1: number;
  lat2: number;
  lng2: number;
  levelHpa: number;
}

export interface CycloneForecastWaypoint {
  hoursAhead: number;
  lat: number;
  lng: number;
  coneRadiusKm: number;
  projectedWindKmh: number;
  projectedPressureHpa: number;
}

export interface CycloneForecastCone {
  cycloneId: string;
  title: string;
  cycloneCategory: 0 | 1 | 2 | 3 | 4 | 5;
  waypoints: CycloneForecastWaypoint[];
  leftEdge: LatLngPoint[];
  rightEdge: LatLngPoint[];
  conePolygon: LatLngPoint[];
}

export type ZoneBriefingThreatLevel = 'Estable' | 'Vigilancia' | 'Elevado' | 'Crítico';

export interface ZoneBriefingEventItem {
  id: string;
  category: EventCategory;
  subtype: string;
  title: string;
  region: string;
  severity: SeverityLevel;
  lat: number;
  lng: number;
  distanceKm: number;
  magnitude?: number;
  summary: string;
}

export interface ZoneBriefingCycloneThreat {
  id: string;
  title: string;
  cycloneCategory: 0 | 1 | 2 | 3 | 4 | 5;
  centralPressureHpa: number;
  maxWindKmh: number;
  distanceKm: number;
  minForecastDistanceKm: number;
  coneInterceptsZone: boolean;
  lat: number;
  lng: number;
}

export interface ZoneBriefingReport {
  zoneLabel: string;
  lat: number;
  lng: number;
  radiusKm: number;
  generatedAtIso: string;
  threatLevel: ZoneBriefingThreatLevel;
  threatScore: number;
  summaryLine: string;
  factors: string[];
  atmosphere: {
    windKmh: number;
    pressureHpa: number;
    precipMmH: number;
    cloudPct: number;
    solarPhaseLabel: string;
  };
  seismic24h: {
    countInZone: number;
    maxMagnitude: number | null;
    nearestKm: number | null;
    strongestPlace: string | null;
  };
  counts: {
    disasters: number;
    conflicts: number;
    totalEventsInZone: number;
  };
  cyclones: ZoneBriefingCycloneThreat[];
  nearbyEvents: ZoneBriefingEventItem[];
  terrain: {
    minElevationM: number;
    maxElevationM: number;
    buildingsCount: number;
    available: boolean;
  };
}


