import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bike,
  Car,
  Clock,
  Footprints,
  LocateFixed,
  MapPin,
  Navigation,
  Pause,
  Play,
  Search,
  Train,
  X,
} from 'lucide-react';
import { routeSpanToGlobeDistance } from '../shared/geo.ts';
import type {
  LatLngPoint,
  PredictiveRouteResult,
  TravelMode,
  ViewportMode,
} from '../shared/types.ts';
import type { GlobePickMode } from './GlobeWebGLCanvas.tsx';

interface PlaceOption {
  name: string;
  address: string;
  lat: number;
  lng: number;
}

interface NavigationPanelProps {
  activeRoute: PredictiveRouteResult | null;
  onRouteComputed: (route: PredictiveRouteResult) => void;
  onChangeViewport: (mode: ViewportMode) => void;
  onOpenSectorAtRoute: (route: PredictiveRouteResult) => void;
  onFlyTo: (lat: number, lng: number, zoomDistance?: number) => void;
  onClose: () => void;
  onQuotaExceeded: () => void;
  prefillDestination?: { label: string; lat: number; lng: number } | null;
  pickMode: GlobePickMode;
  onSetPickMode: (mode: GlobePickMode) => void;
  pickedPoint: { target: 'origin' | 'destination'; label: string; lat: number; lng: number; nonce: number } | null;
  flyAlongActive: boolean;
  onToggleFlyAlong: () => void;
}

const QUICK_ROUTES: Array<{
  label: string;
  originLabel: string;
  origin: LatLngPoint;
  destLabel: string;
  destination: LatLngPoint;
}> = [
  {
    label: 'CDMX: Zócalo → Santa Fe',
    originLabel: 'Zócalo · CDMX',
    origin: { lat: 19.4326, lng: -99.1332 },
    destLabel: 'Santa Fe · CDMX',
    destination: { lat: 19.366, lng: -99.261 },
  },
  {
    label: 'Madrid: Sol → Barajas T4',
    originLabel: 'Puerta del Sol · Madrid',
    origin: { lat: 40.4168, lng: -3.7038 },
    destLabel: 'Aeropuerto Barajas · Madrid',
    destination: { lat: 40.4983, lng: -3.5676 },
  },
  {
    label: 'Tokio: Estación → Shibuya',
    originLabel: 'Estación de Tokio',
    origin: { lat: 35.6812, lng: 139.7671 },
    destLabel: 'Shibuya Crossing',
    destination: { lat: 35.6595, lng: 139.7004 },
  },
];

function formatDuration(sec: number): string {
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} h ${m} min`;
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function NavigationPanel({
  activeRoute,
  onRouteComputed,
  onChangeViewport,
  onOpenSectorAtRoute,
  onFlyTo,
  onClose,
  onQuotaExceeded,
  prefillDestination,
  pickMode,
  onSetPickMode,
  pickedPoint,
  flyAlongActive,
  onToggleFlyAlong,
}: NavigationPanelProps) {
  const [originQuery, setOriginQuery] = useState('Zócalo · Ciudad de México');
  const [originCoords, setOriginCoords] = useState<LatLngPoint>({
    lat: 19.4326,
    lng: -99.1332,
  });

  const [destQuery, setDestQuery] = useState(
    prefillDestination?.label ?? 'Santa Fe · Distrito Corporativo'
  );
  const [destCoords, setDestCoords] = useState<LatLngPoint>(
    prefillDestination
      ? { lat: prefillDestination.lat, lng: prefillDestination.lng }
      : { lat: 19.366, lng: -99.261 }
  );

  const [originSuggestions, setOriginSuggestions] = useState<PlaceOption[]>([]);
  const [destSuggestions, setDestSuggestions] = useState<PlaceOption[]>([]);
  const [travelMode, setTravelMode] = useState<TravelMode>('DRIVE');
  const [departureOffset, setDepartureOffset] = useState<number>(0);
  const [avoidHazards, setAvoidHazards] = useState<boolean>(true);
  const [isComputing, setIsComputing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!pickedPoint) return;
    if (pickedPoint.target === 'origin') {
      setOriginQuery(pickedPoint.label);
      setOriginCoords({ lat: pickedPoint.lat, lng: pickedPoint.lng });
      setOriginSuggestions([]);
    } else {
      setDestQuery(pickedPoint.label);
      setDestCoords({ lat: pickedPoint.lat, lng: pickedPoint.lng });
      setDestSuggestions([]);
    }
  }, [pickedPoint]);

  async function searchPlaces(query: string, target: 'origin' | 'dest') {
    if (target === 'origin') setOriginQuery(query);
    else setDestQuery(query);

    if (query.trim().length < 2) {
      if (target === 'origin') setOriginSuggestions([]);
      else setDestSuggestions([]);
      return;
    }

    try {
      const res = await fetch('/api/places/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = (await res.json()) as {
        places?: PlaceOption[];
        quotaExceeded?: boolean;
      };
      if (data.quotaExceeded) onQuotaExceeded();
      if (target === 'origin') setOriginSuggestions(data.places ?? []);
      else setDestSuggestions(data.places ?? []);
    } catch {
      // Ignore transient typeahead failures
    }
  }

  function handleUseMyLocation() {
    if (!navigator.geolocation) {
      setErrorMsg('Geolocalización no disponible en este navegador.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const pt = {
          lat: Number(pos.coords.latitude.toFixed(5)),
          lng: Number(pos.coords.longitude.toFixed(5)),
        };
        setOriginCoords(pt);
        setOriginQuery(`Mi ubicación (${pt.lat.toFixed(3)}, ${pt.lng.toFixed(3)})`);
        setOriginSuggestions([]);
        onFlyTo(pt.lat, pt.lng, 16);
      },
      () => {
        setErrorMsg('No se pudo obtener el permiso de ubicación actual.');
      }
    );
  }

  async function computeRoute(
    customOrigin?: { label: string; pt: LatLngPoint },
    customDest?: { label: string; pt: LatLngPoint }
  ) {
    const orig = customOrigin?.pt ?? originCoords;
    const dest = customDest?.pt ?? destCoords;
    const origLabel = customOrigin?.label ?? originQuery;
    const dLabel = customDest?.label ?? destQuery;

    setIsComputing(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/navigation/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: orig,
          destination: dest,
          originLabel: origLabel,
          destinationLabel: dLabel,
          travelMode,
          departureOffsetHours: departureOffset,
          avoidHazards,
        }),
      });
      const data = (await res.json()) as PredictiveRouteResult & {
        error?: string;
        quotaExceeded?: boolean;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Error calculando ruta.');
      }
      if (data.quotaExceeded) onQuotaExceeded();
      onRouteComputed(data);
      const zoomDist = routeSpanToGlobeDistance(orig, dest);
      onFlyTo((orig.lat + dest.lat) / 2, (orig.lng + dest.lng) / 2, zoomDist);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error de red en navegación.');
    } finally {
      setIsComputing(false);
    }
  }

  const travelModes: Array<{ id: TravelMode; label: string; Icon: typeof Car }> = [
    { id: 'DRIVE', label: 'Auto', Icon: Car },
    { id: 'TRANSIT', label: 'Trans.', Icon: Train },
    { id: 'BICYCLE', label: 'Bici', Icon: Bike },
    { id: 'WALK', label: 'Pie', Icon: Footprints },
  ];

  return (
    <aside
      aria-label="Asistente de Navegación Predictiva"
      className="fixed top-[52px] left-3 right-3 sm:right-auto sm:w-[388px] max-h-[calc(100dvh-76px)] sm:max-h-[calc(100vh-140px)] z-20 flex flex-col bg-[#080d16]/94 border border-white/[0.08] rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
        <div className="flex items-center gap-2">
          <Navigation className="w-4 h-4 text-cyan-400" />
          <h2 className="font-display text-sm font-semibold tracking-wide text-white">
            Asistente de Navegación ML
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar asistente de navegación"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 overflow-y-auto space-y-4">
        {/* Quick presets */}
        <div className="flex flex-wrap gap-1.5">
          {QUICK_ROUTES.map((qr) => (
            <button
              key={qr.label}
              type="button"
              onClick={() => {
                setOriginQuery(qr.originLabel);
                setOriginCoords(qr.origin);
                setDestQuery(qr.destLabel);
                setDestCoords(qr.destination);
                setOriginSuggestions([]);
                setDestSuggestions([]);
                void computeRoute(
                  { label: qr.originLabel, pt: qr.origin },
                  { label: qr.destLabel, pt: qr.destination }
                );
              }}
              className="px-2.5 py-1 text-xs font-medium bg-white/5 hover:bg-cyan-500/20 text-slate-200 border border-white/10 rounded-md transition-colors whitespace-nowrap"
            >
              {qr.label}
            </button>
          ))}
        </div>

        {/* Origin & Destination */}
        <div className="space-y-2.5">
          <div className="relative">
            <label htmlFor="nav-origin" className="block text-xs text-slate-400 mb-1">
              Origen
            </label>
            <div className="flex gap-1.5">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  id="nav-origin"
                  type="text"
                  value={originQuery}
                  onChange={(e) => void searchPlaces(e.target.value, 'origin')}
                  placeholder="Buscar ciudad, dirección o nodo..."
                  className="w-full pl-8 pr-3 py-2 text-xs bg-[#06090f] border border-white/15 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                />
              </div>
              <button
                type="button"
                onClick={handleUseMyLocation}
                aria-label="Usar mi ubicación GPS actual"
                title="Mi ubicación"
                className="px-2.5 py-2 bg-white/5 hover:bg-white/10 border border-white/15 rounded-lg text-cyan-400 transition-colors"
              >
                <LocateFixed className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => onSetPickMode(pickMode === 'origin' ? 'none' : 'origin')}
                aria-label="Seleccionar origen haciendo clic en el globo 3D"
                title="Elegir en el globo"
                className={`px-2.5 py-2 border rounded-lg transition-colors ${
                  pickMode === 'origin'
                    ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                    : 'bg-white/5 hover:bg-white/10 border-white/15 text-emerald-400'
                }`}
              >
                <MapPin className="w-4 h-4" />
              </button>
            </div>
            {originSuggestions.length > 0 && (
              <ul className="mt-1 bg-[#06090f] border border-white/15 rounded-lg divide-y divide-white/10 max-h-36 overflow-y-auto">
                {originSuggestions.map((p, idx) => (
                  <li key={`${p.name}-${idx}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setOriginQuery(p.name);
                        setOriginCoords({ lat: p.lat, lng: p.lng });
                        setOriginSuggestions([]);
                      }}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-cyan-500/15 transition-colors"
                    >
                      <div className="font-medium text-white truncate">{p.name}</div>
                      <div className="text-slate-400 truncate">{p.address}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="relative">
            <label htmlFor="nav-dest" className="block text-xs text-slate-400 mb-1">
              Destino
            </label>
            <div className="flex gap-1.5">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  id="nav-dest"
                  type="text"
                  value={destQuery}
                  onChange={(e) => void searchPlaces(e.target.value, 'dest')}
                  placeholder="Buscar destino..."
                  className="w-full pl-8 pr-3 py-2 text-xs bg-[#06090f] border border-white/15 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                />
              </div>
              <button
                type="button"
                onClick={() => onSetPickMode(pickMode === 'destination' ? 'none' : 'destination')}
                aria-label="Seleccionar destino haciendo clic en el globo 3D"
                title="Elegir en el globo"
                className={`px-2.5 py-2 border rounded-lg transition-colors ${
                  pickMode === 'destination'
                    ? 'bg-amber-500 text-slate-950 border-amber-400'
                    : 'bg-white/5 hover:bg-white/10 border-white/15 text-amber-400'
                }`}
              >
                <MapPin className="w-4 h-4" />
              </button>
            </div>
            {destSuggestions.length > 0 && (
              <ul className="mt-1 bg-[#06090f] border border-white/15 rounded-lg divide-y divide-white/10 max-h-36 overflow-y-auto">
                {destSuggestions.map((p, idx) => (
                  <li key={`${p.name}-${idx}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setDestQuery(p.name);
                        setDestCoords({ lat: p.lat, lng: p.lng });
                        setDestSuggestions([]);
                      }}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-cyan-500/15 transition-colors"
                    >
                      <div className="font-medium text-white truncate">{p.name}</div>
                      <div className="text-slate-400 truncate">{p.address}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Travel Modes */}
        <div className="grid grid-cols-4 gap-1 p-1 bg-[#06090f] border border-white/10 rounded-lg">
          {travelModes.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTravelMode(id)}
              className={`flex items-center justify-center gap-1.5 py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                travelMode === id
                  ? 'bg-cyan-500 text-slate-950'
                  : 'text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* ML Departure Time & Hazard Avoidance */}
        <div className="flex items-center justify-between gap-3 text-xs">
          <label className="flex items-center gap-2 text-slate-300">
            <Clock className="w-3.5 h-3.5 text-amber-400" />
            <span>Salida:</span>
            <select
              value={departureOffset}
              onChange={(e) => setDepartureOffset(Number(e.target.value))}
              aria-label="Ventana de salida predictiva"
              className="bg-[#06090f] border border-white/15 rounded-md px-2 py-1 text-white focus:outline-none focus:border-cyan-400"
            >
              <option value={0}>Ahora</option>
              <option value={1}>En +1 hora</option>
              <option value={2}>En +2 horas</option>
              <option value={4}>En +4 horas</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={avoidHazards}
              onChange={(e) => setAvoidHazards(e.target.checked)}
              className="accent-cyan-400 rounded"
            />
            <span>Evitar riesgos</span>
          </label>
        </div>

        <button
          type="button"
          onClick={() => void computeRoute()}
          disabled={isComputing}
          className="w-full py-2.5 px-4 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 disabled:opacity-60 text-slate-950 rounded-lg transition-colors"
        >
          {isComputing ? 'Calculando modelo ML y ruta...' : 'Calcular Ruta Predictiva'}
        </button>

        {errorMsg && (
          <div className="p-2.5 text-xs text-rose-200 bg-rose-500/15 border border-rose-500/30 rounded-lg">
            {errorMsg}
          </div>
        )}

        {/* Active Route Result + ML Traffic Forecast */}
        {activeRoute && (
          <div className="space-y-3 pt-2 border-t border-white/10">
            <div className="flex items-baseline justify-between">
              <div>
                <div className="font-mono-tabular text-xl font-bold text-white">
                  {formatDuration(activeRoute.predictedDurationSeconds)}
                </div>
                <div className="text-xs text-slate-400 tabular-nums">
                  {formatDistance(activeRoute.distanceMeters)} · Sin tráfico:{' '}
                  {formatDuration(activeRoute.staticDurationSeconds)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-semibold text-amber-400 tabular-nums">
                  Congestión {activeRoute.congestionIndex}%
                </div>
                <div className="text-[11px] text-slate-400 tabular-nums">
                  Confianza ML {Math.round(activeRoute.mlConfidence * 100)}%
                </div>
              </div>
            </div>

            <div className="text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/20 rounded-lg px-3 py-2">
              <div className="font-medium">{activeRoute.optimalDepartureWindow}</div>
              <div className="text-slate-300 mt-0.5">{activeRoute.modelSummary}</div>
            </div>

            {/* 6-Hour ML Traffic Forecast Bars */}
            <div>
              <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1.5">
                <span>Pronóstico ML de tráfico (6h)</span>
                <span className="font-mono-tabular">
                  {activeRoute.source === 'google-routes-api'
                    ? 'Google Routes + ML'
                    : activeRoute.source === 'osrm-ml-engine'
                      ? 'Rutas OSRM + ML'
                      : 'Motor Predictivo ML'}
                </span>
              </div>
              <div className="grid grid-cols-6 gap-1.5 items-end h-16 bg-[#06090f] border border-white/10 rounded-lg p-2">
                {activeRoute.hourlyForecast.map((slot) => {
                  const barColor =
                    slot.congestionPct >= 65
                      ? 'bg-rose-500'
                      : slot.congestionPct >= 40
                        ? 'bg-amber-400'
                        : 'bg-cyan-400';
                  return (
                    <div key={slot.offsetHours} className="flex flex-col items-center gap-1 h-full justify-end">
                      <div
                        className={`w-full rounded-sm ${barColor}`}
                        style={{ height: `${Math.max(14, slot.congestionPct * 0.44)}px` }}
                        title={`${slot.label}: ${slot.congestionPct}% · ${slot.predictedSpeedKmh} km/h`}
                      />
                      <span className="text-[10px] font-mono-tabular text-slate-400">
                        {slot.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Hazard Proximity Alerts */}
            {activeRoute.hazardAlerts.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Alertas geoespaciales cercanas al corredor</span>
                </div>
                {activeRoute.hazardAlerts.map((h) => (
                  <div
                    key={h.eventId}
                    className="flex items-center justify-between text-xs bg-amber-500/10 border border-amber-500/20 rounded-md px-2.5 py-1.5"
                  >
                    <span className="text-slate-200 truncate pr-2">{h.title}</span>
                    <span className="font-mono-tabular text-amber-300 shrink-0">
                      {h.distanceKm} km
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Fly-Along & View Switchers */}
            <button
              type="button"
              onClick={() => {
                onChangeViewport('globe');
                onToggleFlyAlong();
              }}
              className={`w-full flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-lg transition-colors ${
                flyAlongActive
                  ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950'
              }`}
            >
              {flyAlongActive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>
                {flyAlongActive ? 'Pausar recorrido 3D en el Globo' : 'Recorrer ruta en el Globo 3D'}
              </span>
            </button>

            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => onChangeViewport('globe')}
                className="py-1.5 px-2 text-xs font-medium bg-white/5 hover:bg-white/10 border border-white/8 rounded-md text-slate-200"
              >
                Globo 3D
              </button>
              <button
                type="button"
                onClick={() => onOpenSectorAtRoute(activeRoute)}
                className="py-1.5 px-2 text-xs font-medium bg-white/5 hover:bg-white/10 border border-white/8 rounded-md text-slate-200"
              >
                Terreno 3D
              </button>
              <button
                type="button"
                onClick={() => onChangeViewport('maps')}
                className="py-1.5 px-2 text-xs font-medium bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/25 rounded-md text-cyan-200"
              >
                Mapa 2D
              </button>
            </div>

            {/* Turn-by-turn steps */}
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-slate-300">Indicaciones paso a paso</div>
              <ol className="space-y-1.5">
                {activeRoute.steps.map((step, i) => (
                  <li
                    key={i}
                    className="text-xs bg-[#06090f] border border-white/10 rounded-lg px-3 py-2 text-slate-200 flex justify-between gap-2"
                  >
                    <span>
                      {i + 1}. {step.instruction}
                    </span>
                    <span className="font-mono-tabular text-slate-400 shrink-0">
                      {formatDistance(step.distanceMeters)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
