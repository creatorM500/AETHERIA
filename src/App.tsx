import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  Flame,
  Globe2,
  History,
  Layers,
  MapPin,
  Mountain,
  Navigation,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Wind,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { AlertToastStack } from './components/AlertToastStack.tsx';
import { GlobeWebGLCanvas, type GlobePickMode } from './components/GlobeWebGLCanvas.tsx';
import { GoogleMapsNavigatorView } from './components/GoogleMapsNavigatorView.tsx';
import { McpConsolePanel } from './components/McpConsolePanel.tsx';
import { NavigationPanel } from './components/NavigationPanel.tsx';
import { QuickSearchBar } from './components/QuickSearchBar.tsx';
import { SeismicEventCard } from './components/SeismicEventCard.tsx';
import { TelemetryDrawer, type TelemetryDrawerTab } from './components/TelemetryDrawer.tsx';
import {
  ALERT_INBOX_STORAGE_KEY,
  ALERT_RULES_STORAGE_KEY,
  ALERT_SEEN_KEYS_STORAGE_KEY,
  DEFAULT_ALERT_RULES,
  evaluateTelemetryAlerts,
  sanitizeAlertRules,
} from './shared/alertRules.ts';
import { SECTOR_PRESETS } from './shared/geo.ts';
import type {
  AlertRuleConfig,
  ClientAlertNotification,
  DisasterHistoryRecord,
  EventCategory,
  GlobalEvent,
  GlobalWindFieldResponse,
  GlobeTextureMode,
  LiveTerrainCoords,
  PredictiveRouteResult,
  QualityTier,
  SectorPreset,
  SeismicHeatmap24hResponse,
  SeismicHeatScaleMetrics,
  SeismicQuake24h,
  TerrainHudStats,
  ViewportMode,
  WorldFeedResponse,
  WorldFeedSummary,
} from './shared/types.ts';

type ActiveDrawer = 'none' | 'telemetry' | 'navigation' | 'mcp';

function loadStoredAlertRules(): AlertRuleConfig {
  if (typeof window === 'undefined') return DEFAULT_ALERT_RULES;
  try {
    const raw = window.localStorage.getItem(ALERT_RULES_STORAGE_KEY);
    if (!raw) return DEFAULT_ALERT_RULES;
    return sanitizeAlertRules(JSON.parse(raw));
  } catch {
    return DEFAULT_ALERT_RULES;
  }
}

function loadStoredNotifications(): ClientAlertNotification[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(ALERT_INBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ClientAlertNotification[]).slice(0, 40) : [];
  } catch {
    return [];
  }
}

function loadStoredSeenAlertKeys(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(ALERT_SEEN_KEYS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((k) => typeof k === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export default function App() {
  const [events, setEvents] = useState<GlobalEvent[]>([]);
  const [summary, setSummary] = useState<WorldFeedSummary | null>(null);
  const [isLoadingFeed, setIsLoadingFeed] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);

  const [categoryFilter, setCategoryFilter] = useState<EventCategory | 'all'>('all');
  const [textureMode, setTextureMode] = useState<GlobeTextureMode>('godseye');
  const [viewportMode, setViewportMode] = useState<ViewportMode>('globe');
  const [activeSector, setActiveSector] = useState<SectorPreset>(SECTOR_PRESETS[0]);
  const [selectedEvent, setSelectedEvent] = useState<GlobalEvent | null>(null);

  const [terrainExaggeration, setTerrainExaggeration] = useState<number>(1.5);
  const [qualityPreference, setQualityPreference] = useState<'auto' | QualityTier>('auto');
  const [terrainStats, setTerrainStats] = useState<TerrainHudStats | null>(null);

  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>('none');
  const [telemetryTab, setTelemetryTab] = useState<TelemetryDrawerTab>('live');
  const [dockExpanded, setDockExpanded] = useState<boolean>(true);
  const [autoRotate, setAutoRotate] = useState<boolean>(false);

  const [seismicHeatmapEnabled, setSeismicHeatmapEnabled] = useState<boolean>(true);
  const [seismicQuakes24h, setSeismicQuakes24h] = useState<SeismicQuake24h[]>([]);
  const [seismicMetrics, setSeismicMetrics] = useState<SeismicHeatScaleMetrics | null>(null);
  const [selectedQuake24h, setSelectedQuake24h] = useState<SeismicQuake24h | null>(null);
  const [liveTerrainCoords, setLiveTerrainCoords] = useState<LiveTerrainCoords | null>(null);
  const [copiedCoordAtMs, setCopiedCoordAtMs] = useState<number>(0);

  const [windLayerEnabled, setWindLayerEnabled] = useState<boolean>(true);
  const [windField, setWindField] = useState<GlobalWindFieldResponse | null>(null);

  const [alertRules, setAlertRules] = useState<AlertRuleConfig>(loadStoredAlertRules);
  const [alertNotifications, setAlertNotifications] =
    useState<ClientAlertNotification[]>(loadStoredNotifications);
  const [toastAlerts, setToastAlerts] = useState<ClientAlertNotification[]>([]);
  const [alertEvalNonce, setAlertEvalNonce] = useState<number>(0);
  const seenAlertKeysRef = useRef<Set<string>>(loadStoredSeenAlertKeys());

  const [activeRoute, setActiveRoute] = useState<PredictiveRouteResult | null>(null);
  const [pickMode, setPickMode] = useState<GlobePickMode>('none');
  const [pickedPoint, setPickedPoint] = useState<{
    target: 'origin' | 'destination';
    label: string;
    lat: number;
    lng: number;
    nonce: number;
  } | null>(null);
  const [flyAlongActive, setFlyAlongActive] = useState<boolean>(false);
  const [flyAlongProgress, setFlyAlongProgress] = useState<number>(0);

  const [prefillDest, setPrefillDest] = useState<{
    label: string;
    lat: number;
    lng: number;
  } | null>(null);

  const [focusTarget, setFocusTarget] = useState<{
    lat: number;
    lng: number;
    zoomDistance?: number;
    nonce: number;
  } | null>(null);
  const [zoomSignal, setZoomSignal] = useState<{
    action: 'in' | 'out' | 'street';
    nonce: number;
  } | null>(null);
  const [globeAltitude, setGlobeAltitude] = useState<{
    altitudeMeters: number;
    tileZoom: number;
    lat: number;
    lng: number;
  } | null>(null);

  const initialSubSatRef = useRef<{ lat: number; lng: number } | null>(null);
  const userExploredGlobeRef = useRef<boolean>(false);
  const latestGlobeTargetRef = useRef<{ lat: number; lng: number; altitudeMeters: number } | null>(null);

  const [mapsApiKey, setMapsApiKey] = useState<string>(
    (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? ''
  );
  const [quotaExceeded, setQuotaExceeded] = useState(false);

  // Listen for Google Maps Platform quota events
  useEffect(() => {
    const onQuota = () => setQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuota);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuota);
  }, []);

  // Keyboard shortcut 'H' to toggle HUD dock for unobstructed 3D inspection
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key.toLowerCase() === 'h') {
        setDockExpanded((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Load runtime Maps config if key was provisioned server-side
  useEffect(() => {
    if (mapsApiKey) return;
    fetch('/api/config/maps')
      .then((r) => r.json())
      .then((cfg: { apiKey?: string }) => {
        if (cfg.apiKey) setMapsApiKey(cfg.apiKey);
      })
      .catch(() => {
        // Fallback mode handled gracefully
      });
  }, [mapsApiKey]);

  const fetchWorldEvents = useCallback(async () => {
    try {
      setFeedError(null);
      const [eventsRes, seismicRes, windRes] = await Promise.all([
        fetch('/api/world/events?category=all'),
        fetch('/api/earthquakes/24h').catch(() => null),
        fetch('/api/wind/global').catch(() => null),
      ]);
      if (!eventsRes.ok) throw new Error('Error al sincronizar telemetría global');
      const data = (await eventsRes.json()) as WorldFeedResponse;
      const filteredEvents = data.events.filter(
        (ev) => ev.category !== 'flight' && ev.category !== 'ship'
      );
      setEvents(filteredEvents);
      setSummary({
        ...data.summary,
        total: filteredEvents.length,
        flights: 0,
        ships: 0,
      });

      if (seismicRes && seismicRes.ok) {
        const seismicPayload = (await seismicRes.json()) as SeismicHeatmap24hResponse;
        setSeismicQuakes24h(seismicPayload.quakes ?? []);
        setSeismicMetrics(seismicPayload.metrics ?? null);
      }

      if (windRes && windRes.ok) {
        const windPayload = (await windRes.json()) as GlobalWindFieldResponse;
        if (Array.isArray(windPayload.uGrid) && Array.isArray(windPayload.vGrid)) {
          setWindField(windPayload);
        }
      }
    } catch (err) {
      setFeedError(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setIsLoadingFeed(false);
    }
  }, []);

  useEffect(() => {
    let lastFetchMs = 0;
    const runFetch = () => {
      if (document.visibilityState === 'hidden') return;
      lastFetchMs = Date.now();
      void fetchWorldEvents();
    };
    runFetch();
    const timer = window.setInterval(runFetch, 15_000);
    const onVis = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetchMs >= 15_000) {
        runFetch();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchWorldEvents]);

  const visibleEvents = useMemo(() => {
    if (categoryFilter === 'all') return events;
    return events.filter((e) => e.category === categoryFilter);
  }, [events, categoryFilter]);

  const alertPreview = useMemo(() => {
    return evaluateTelemetryAlerts({
      events,
      seismicQuakes24h,
      rules: alertRules,
      activeSector,
      seenRuleKeys: new Set(),
    }).preview;
  }, [events, seismicQuakes24h, alertRules, activeSector]);

  // Persist user-configured alert rules and notification inbox
  useEffect(() => {
    try {
      window.localStorage.setItem(ALERT_RULES_STORAGE_KEY, JSON.stringify(alertRules));
    } catch {
      // Ignore storage quota errors
    }
  }, [alertRules]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        ALERT_INBOX_STORAGE_KEY,
        JSON.stringify(alertNotifications.slice(0, 40))
      );
    } catch {
      // Ignore storage quota errors
    }
  }, [alertNotifications]);

  // Evaluate incoming telemetry against configured alert thresholds
  useEffect(() => {
    if (events.length === 0 && seismicQuakes24h.length === 0) return;

    const { newNotifications } = evaluateTelemetryAlerts({
      events,
      seismicQuakes24h,
      rules: alertRules,
      activeSector,
      seenRuleKeys: seenAlertKeysRef.current,
    });

    if (newNotifications.length === 0) return;

    for (const n of newNotifications) {
      seenAlertKeysRef.current.add(n.ruleKey);
    }
    try {
      const compactKeys = Array.from(seenAlertKeysRef.current).slice(-200);
      seenAlertKeysRef.current = new Set(compactKeys);
      window.localStorage.setItem(ALERT_SEEN_KEYS_STORAGE_KEY, JSON.stringify(compactKeys));
    } catch {
      // Ignore storage quota errors
    }

    setAlertNotifications((prev) => {
      const existingIds = new Set(prev.map((p) => p.ruleKey));
      const fresh = newNotifications.filter((n) => !existingIds.has(n.ruleKey));
      const updatedExisting = prev.map((item) => {
        const refreshed = newNotifications.find((n) => n.ruleKey === item.ruleKey);
        return refreshed ? { ...refreshed, read: false } : item;
      });
      return [...fresh, ...updatedExisting].slice(0, 40);
    });

    setToastAlerts((prev) => {
      const incomingKeys = new Set(newNotifications.map((n) => n.ruleKey));
      const kept = prev.filter((t) => !incomingKeys.has(t.ruleKey));
      return [...newNotifications, ...kept].slice(0, 4);
    });

    if (
      alertRules.browserNotificationsEnabled &&
      typeof window !== 'undefined' &&
      'Notification' in window &&
      window.Notification.permission === 'granted'
    ) {
      for (const n of newNotifications.slice(0, 2)) {
        try {
          new window.Notification(n.title, {
            body: n.message,
            tag: n.ruleKey,
          });
        } catch {
          // Ignore browser notification exceptions in restricted contexts
        }
      }
    }
  }, [events, seismicQuakes24h, alertRules, activeSector, alertEvalNonce]);

  const unreadAlertCount = useMemo(
    () => alertNotifications.reduce((acc, item) => acc + (item.read ? 0 : 1), 0),
    [alertNotifications]
  );

  const handleForceReevaluateAlerts = useCallback(() => {
    seenAlertKeysRef.current.clear();
    try {
      window.localStorage.removeItem(ALERT_SEEN_KEYS_STORAGE_KEY);
    } catch {
      // Ignore
    }
    setAlertEvalNonce((n) => n + 1);
  }, []);

  const handleMarkAlertRead = useCallback((id: string) => {
    setAlertNotifications((prev) => prev.map((a) => (a.id === id ? { ...a, read: true } : a)));
  }, []);

  const handleMarkAllAlertsRead = useCallback(() => {
    setAlertNotifications((prev) => prev.map((a) => ({ ...a, read: true })));
  }, []);

  const handleDismissToast = useCallback(
    (id: string) => {
      setToastAlerts((prev) => prev.filter((t) => t.id !== id));
      handleMarkAlertRead(id);
    },
    [handleMarkAlertRead]
  );

  const handleDismissAlert = useCallback((id: string) => {
    setToastAlerts((prev) => prev.filter((t) => t.id !== id));
    setAlertNotifications((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleClearAlerts = useCallback(() => {
    setToastAlerts([]);
    setAlertNotifications([]);
  }, []);

  const handleAltitudeChange = useCallback(
    (info: { altitudeMeters: number; tileZoom: number; lat: number; lng: number }) => {
      setGlobeAltitude(info);
      latestGlobeTargetRef.current = {
        lat: info.lat,
        lng: info.lng,
        altitudeMeters: info.altitudeMeters,
      };
      if (!initialSubSatRef.current) {
        initialSubSatRef.current = { lat: info.lat, lng: info.lng };
      }
    },
    []
  );

  const openTerrainAtCoordinate = useCallback(
    async (lat: number, lng: number, explicitName?: string, countryLabel?: string) => {
      const roundedLat = Number(lat.toFixed(5));
      const roundedLng = Number(lng.toFixed(5));
      const fallbackLabel = `${roundedLat.toFixed(3)}, ${roundedLng.toFixed(3)}`;
      const sectorId = `coord-${roundedLat.toFixed(4)}-${roundedLng.toFixed(4)}`;

      setActiveSector({
        id: sectorId,
        name: explicitName ?? fallbackLabel,
        country: countryLabel ?? 'Coordenada global',
        lat: roundedLat,
        lng: roundedLng,
        zoomDistance: 14.5,
        description: `Terreno DEM real y edificios OSM en ${fallbackLabel}`,
        buildingDensity: 1.0,
        terrainRelief: 1.0,
      });
      setLiveTerrainCoords({
        lat: roundedLat,
        lng: roundedLng,
        groundElevM: 0,
        cameraAltM: 0,
        source: 'camera',
      });
      setPickMode('none');
      setViewportMode('sector3d');

      if (!explicitName) {
        try {
          const res = await fetch(`/api/places/reverse?lat=${roundedLat}&lng=${roundedLng}`);
          if (res.ok) {
            const data = (await res.json()) as { label?: string };
            if (data.label) {
              setActiveSector((prev) =>
                prev.id === sectorId ? { ...prev, name: data.label! } : prev
              );
            }
          }
        } catch {
          // Keep coordinate label
        }
      }
    },
    []
  );

  const handleOpenSectorFromNav = useCallback(() => {
    if (viewportMode === 'globe' && userExploredGlobeRef.current && latestGlobeTargetRef.current) {
      const target = latestGlobeTargetRef.current;
      // Only switch away from active preset if user explored close or away from default preset
      if (target.altitudeMeters < 6_000_000) {
        void openTerrainAtCoordinate(target.lat, target.lng);
        return;
      }
    }
    setPickMode('none');
    setViewportMode('sector3d');
  }, [openTerrainAtCoordinate, viewportMode]);

  const handleSelectEvent = useCallback((ev: GlobalEvent | null) => {
    setSelectedEvent(ev);
    if (ev) {
      setSelectedQuake24h(null);
      setActiveDrawer('telemetry');
      setViewportMode('globe');
      userExploredGlobeRef.current = true;
      setFocusTarget({
        lat: ev.lat,
        lng: ev.lng,
        zoomDistance: 17.5,
        nonce: Date.now(),
      });
    }
  }, []);

  const handleSelectQuake24h = useCallback((quake: SeismicQuake24h | null) => {
    setSelectedQuake24h(quake);
    if (quake) {
      setSelectedEvent(null);
    }
  }, []);

  const handleJumpQuakeToTerrain3D = useCallback(
    (quake: SeismicQuake24h) => {
      void openTerrainAtCoordinate(
        quake.lat,
        quake.lng,
        `Sismo M${quake.magnitude.toFixed(1)} · ${quake.place}`,
        `Profundidad ${quake.depthKm.toFixed(1)} km`
      );
    },
    [openTerrainAtCoordinate]
  );

  const handleFocusQuakeGlobe = useCallback((quake: SeismicQuake24h) => {
    setViewportMode('globe');
    userExploredGlobeRef.current = true;
    setFocusTarget({
      lat: quake.lat,
      lng: quake.lng,
      zoomDistance: 15.0,
      nonce: Date.now(),
    });
  }, []);

  const handleCopyTerrainCoords = useCallback(() => {
    const lat = liveTerrainCoords?.lat ?? activeSector.lat;
    const lng = liveTerrainCoords?.lng ?? activeSector.lng;
    const text = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => undefined);
    }
    setCopiedCoordAtMs(Date.now());
  }, [activeSector.lat, activeSector.lng, liveTerrainCoords]);

  const handleFlyTo = useCallback((lat: number, lng: number, zoomDistance = 17.5) => {
    setViewportMode('globe');
    userExploredGlobeRef.current = true;
    setFocusTarget({ lat, lng, zoomDistance, nonce: Date.now() });
  }, []);

  const handleSelectSector = useCallback(
    (preset: SectorPreset) => {
      userExploredGlobeRef.current = false;
      setActiveSector(preset);
      if (viewportMode === 'globe') {
        setFocusTarget({
          lat: preset.lat,
          lng: preset.lng,
          zoomDistance: preset.zoomDistance,
          nonce: Date.now(),
        });
      }
    },
    [viewportMode]
  );

  const handleOpenSectorAtEvent = useCallback(
    (ev: GlobalEvent) => {
      void openTerrainAtCoordinate(ev.lat, ev.lng, ev.title, ev.region);
    },
    [openTerrainAtCoordinate]
  );

  const handleLocateHistoryRecord = useCallback((rec: DisasterHistoryRecord) => {
    setViewportMode('globe');
    userExploredGlobeRef.current = true;
    setFocusTarget({
      lat: rec.lat,
      lng: rec.lng,
      zoomDistance: 15.5,
      nonce: Date.now(),
    });
  }, []);

  const handleOpenSectorAtHistoryRecord = useCallback(
    (rec: DisasterHistoryRecord) => {
      void openTerrainAtCoordinate(rec.lat, rec.lng, rec.title, rec.country ?? rec.region);
    },
    [openTerrainAtCoordinate]
  );

  const handleOpenSectorAtRoute = useCallback(
    (route: PredictiveRouteResult) => {
      const midLat = (route.origin.lat + route.destination.lat) / 2;
      const midLng = (route.origin.lng + route.destination.lng) / 2;
      void openTerrainAtCoordinate(
        midLat,
        midLng,
        `${route.originLabel} → ${route.destinationLabel}`,
        'Corredor de ruta'
      );
    },
    [openTerrainAtCoordinate]
  );

  const handleFocusAlert = useCallback(
    (alert: ClientAlertNotification) => {
      handleMarkAlertRead(alert.id);
      setToastAlerts((prev) => prev.filter((t) => t.id !== alert.id));
      const matchedEvent = events.find((e) => e.id === alert.eventId) ?? null;
      if (matchedEvent) {
        setSelectedEvent(matchedEvent);
      }
      setViewportMode('globe');
      userExploredGlobeRef.current = true;
      setFocusTarget({
        lat: alert.lat,
        lng: alert.lng,
        zoomDistance: 15.5,
        nonce: Date.now(),
      });
    },
    [events, handleMarkAlertRead]
  );

  const handleOpenTerrainAtAlert = useCallback(
    (alert: ClientAlertNotification) => {
      handleMarkAlertRead(alert.id);
      setToastAlerts((prev) => prev.filter((t) => t.id !== alert.id));
      void openTerrainAtCoordinate(alert.lat, alert.lng, alert.title, alert.source);
    },
    [handleMarkAlertRead, openTerrainAtCoordinate]
  );

  const handleOpenAlertsDrawer = useCallback(() => {
    setTelemetryTab('alerts');
    setActiveDrawer('telemetry');
  }, []);

  const handleNavigateToEvent = useCallback((ev: GlobalEvent) => {
    setPrefillDest({ label: ev.title, lat: ev.lat, lng: ev.lng });
    setActiveDrawer('navigation');
  }, []);

  const handlePickGlobePoint = useCallback(
    async (lat: number, lng: number) => {
      if (pickMode === 'none') return;
      const target = pickMode;
      setPickMode('none');
      if (target === 'terrain') {
        await openTerrainAtCoordinate(lat, lng);
        return;
      }
      let label = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
      try {
        const res = await fetch(`/api/places/reverse?lat=${lat}&lng=${lng}`);
        if (res.ok) {
          const data = (await res.json()) as { label?: string };
          if (data.label) label = data.label;
        }
      } catch {
        // Use coordinate fallback
      }
      setPickedPoint({ target, label, lat, lng, nonce: Date.now() });
      setActiveDrawer('navigation');
    },
    [openTerrainAtCoordinate, pickMode]
  );

  const currentFlyStep = useMemo(() => {
    if (!activeRoute || activeRoute.steps.length === 0) return null;
    const idx = Math.min(
      activeRoute.steps.length - 1,
      Math.floor(flyAlongProgress * activeRoute.steps.length)
    );
    return { index: idx + 1, total: activeRoute.steps.length, step: activeRoute.steps[idx] };
  }, [activeRoute, flyAlongProgress]);

  const categoryTabs: Array<{
    id: EventCategory | 'all';
    label: string;
    count: number;
  }> = [
    { id: 'all', label: 'Todos', count: summary?.total ?? events.length },
    { id: 'disaster', label: 'Desastres', count: summary?.disasters ?? 0 },
    { id: 'conflict', label: 'Conflictos', count: summary?.conflicts ?? 0 },
  ];

  const isPresetSector = SECTOR_PRESETS.some((p) => p.id === activeSector.id);

  return (
    <div
      className="relative w-screen h-screen overflow-hidden bg-[#06090f] text-slate-100 select-none"
      data-viewport-mode={viewportMode}
      data-category-filter={categoryFilter}
      data-event-count={visibleEvents.length}
      data-wind-layer={windLayerEnabled ? 'on' : 'off'}
      data-unread-alerts={unreadAlertCount}
    >
      {/* Google Maps Quota Exceeded Banner (Required by Case A) */}
      {quotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Top Bar Contract: 3 Zones (Wordmark — single-line nav links — 1 primary CTA) */}
      <header className="fixed top-0 left-0 right-0 h-14 z-30 flex items-center justify-between gap-4 md:gap-8 px-4 md:px-6 bg-[#06090f]/94 border-b border-white/8">
        {/* Zone 1: Brand wordmark */}
        <button
          type="button"
          onClick={() => {
            userExploredGlobeRef.current = false;
            setViewportMode('globe');
            setFocusTarget({ lat: 20, lng: -40, zoomDistance: 26, nonce: Date.now() });
          }}
          className="font-display text-lg font-bold tracking-wider text-white whitespace-nowrap shrink-0 hover:text-cyan-300 transition-colors"
        >
          Aetheria
        </button>

        {/* Zone 2: Single-line navigation links */}
        <nav
          aria-label="Vistas y módulos principales"
          className="flex items-center gap-4 md:gap-7 text-xs md:text-sm font-medium overflow-x-auto no-scrollbar"
        >
          <button
            type="button"
            onClick={() => setViewportMode('globe')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              viewportMode === 'globe'
                ? 'text-cyan-300 border-cyan-400'
                : 'text-slate-300 border-transparent hover:text-white'
            }`}
          >
            Globo 3D
          </button>
          <button
            type="button"
            onClick={handleOpenSectorFromNav}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              viewportMode === 'sector3d'
                ? 'text-cyan-300 border-cyan-400'
                : 'text-slate-300 border-transparent hover:text-white'
            }`}
          >
            Terreno 3D
          </button>
          <button
            type="button"
            onClick={() => setViewportMode('maps')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              viewportMode === 'maps'
                ? 'text-cyan-300 border-cyan-400'
                : 'text-slate-300 border-transparent hover:text-white'
            }`}
          >
            {mapsApiKey ? 'Google Maps' : 'Mapa 2D'}
          </button>
          <button
            type="button"
            onClick={() => {
              setTelemetryTab('live');
              setActiveDrawer((prev) =>
                prev === 'telemetry' && telemetryTab === 'live' ? 'none' : 'telemetry'
              );
            }}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              activeDrawer === 'telemetry'
                ? 'text-cyan-300 border-cyan-400'
                : 'text-slate-300 border-transparent hover:text-white'
            }`}
          >
            Eventos
          </button>
          <button
            type="button"
            onClick={() => setActiveDrawer((prev) => (prev === 'mcp' ? 'none' : 'mcp'))}
            className={`hidden sm:inline-block whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
              activeDrawer === 'mcp'
                ? 'text-cyan-300 border-cyan-400'
                : 'text-slate-300 border-transparent hover:text-white'
            }`}
          >
            MCP e IA
          </button>
        </nav>

        {/* Zone 3: 1 Primary Action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={() =>
              setActiveDrawer((prev) => (prev === 'navigation' ? 'none' : 'navigation'))
            }
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <Navigation className="w-3.5 h-3.5" />
            <span>Navegar</span>
          </button>
        </div>
      </header>

      {/* Main Spatial Viewport (100% Unobstructed Center) */}
      <main className="w-full h-full pt-14 relative">
        {viewportMode === 'maps' ? (
          <GoogleMapsNavigatorView
            apiKey={mapsApiKey}
            activeSector={activeSector}
            activeRoute={activeRoute}
            events={visibleEvents}
            onSwitchToGlobe={() => setViewportMode('globe')}
          />
        ) : (
          <GlobeWebGLCanvas
            events={visibleEvents}
            selectedEvent={selectedEvent}
            onSelectEvent={handleSelectEvent}
            textureMode={textureMode}
            viewportMode={viewportMode}
            activeSector={activeSector}
            activeRoute={activeRoute}
            focusTarget={focusTarget}
            zoomSignal={zoomSignal}
            onAltitudeChange={handleAltitudeChange}
            terrainExaggeration={terrainExaggeration}
            qualityPreference={qualityPreference}
            onTerrainStatsChange={setTerrainStats}
            autoRotate={autoRotate}
            pickMode={pickMode}
            onPickGlobePoint={(lat, lng) => void handlePickGlobePoint(lat, lng)}
            onTerrainRelocate={(lat, lng) => void openTerrainAtCoordinate(lat, lng)}
            onUserInteract={() => {
              userExploredGlobeRef.current = true;
            }}
            flyAlongActive={flyAlongActive}
            onFlyAlongProgress={setFlyAlongProgress}
            onFlyAlongComplete={() => setFlyAlongActive(false)}
            seismicHeatmapEnabled={seismicHeatmapEnabled}
            seismicQuakes24h={seismicQuakes24h}
            seismicMetrics={seismicMetrics}
            onSelectQuake24h={handleSelectQuake24h}
            onLiveTerrainCoordsChange={setLiveTerrainCoords}
            windLayerEnabled={windLayerEnabled}
            windField={windField}
          />
        )}

        {/* Stacked Bottom-Left Dynamic Layer Legends (Wind 3D + 24h Seismic Heatmap) */}
        {viewportMode !== 'maps' &&
          activeDrawer === 'none' &&
          ((viewportMode === 'globe' && windLayerEnabled && windField) ||
            (seismicHeatmapEnabled && seismicMetrics)) && (
            <div className="fixed bottom-20 left-4 z-10 hidden sm:flex flex-col gap-2 w-[248px]">
              {viewportMode === 'globe' && windLayerEnabled && windField && (
                <aside
                  aria-label="Escala de velocidad del viento global en tiempo real"
                  data-testid="wind-speed-legend"
                  className="flex flex-col gap-1.5 bg-[#080d16]/94 border border-white/10 rounded-xl px-3 py-2.5 shadow-xl"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="flex items-center gap-1.5 font-semibold text-white">
                      <Wind className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <span>Viento Global 3D</span>
                    </span>
                    <span className="font-mono-tabular text-slate-300">
                      Prom {windField.metrics.avgSpeedKmh} km/h
                    </span>
                  </div>

                  <div
                    aria-hidden="true"
                    className="h-2 w-full rounded-full border border-white/10"
                    style={{
                      background:
                        'linear-gradient(90deg, #1785d9 0%, #2dd4bf 22%, #38d673 45%, #facc15 68%, #fa731f 86%, #ffebc7 100%)',
                    }}
                  />

                  <div className="flex items-center justify-between text-[10px] font-mono-tabular text-slate-400">
                    <span>0 km/h</span>
                    <span>
                      {Math.round(Math.max(65, windField.metrics.maxSpeedKmh) / 2)} km/h
                    </span>
                    <span className="text-cyan-300 font-semibold">
                      {Math.max(65, windField.metrics.maxSpeedKmh)}+ km/h
                    </span>
                  </div>

                  {windField.metrics.peakPoint && (
                    <button
                      type="button"
                      onClick={() =>
                        handleFlyTo(
                          windField.metrics.peakPoint!.lat,
                          windField.metrics.peakPoint!.lng,
                          16.0
                        )
                      }
                      title="Enfocar corriente de viento más intensa en tiempo real"
                      className="text-left text-[10px] text-slate-300 hover:text-cyan-300 truncate border-t border-white/8 pt-1.5 transition-colors"
                    >
                      Ráfaga máx {windField.metrics.peakPoint.speedKmh} km/h ·{' '}
                      {windField.metrics.peakPoint.lat.toFixed(1)}°,{' '}
                      {windField.metrics.peakPoint.lng.toFixed(1)}°
                    </button>
                  )}
                </aside>
              )}

              {seismicHeatmapEnabled && seismicMetrics && (
                <aside
                  aria-label="Escala térmica sísmica de las últimas 24 horas"
                  data-testid="seismic-heat-legend"
                  className="flex flex-col gap-1.5 bg-[#080d16]/94 border border-white/10 rounded-xl px-3 py-2.5 shadow-xl"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="flex items-center gap-1.5 font-semibold text-white">
                      <Flame className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                      <span>Calor Sísmico 24h</span>
                    </span>
                    <span className="font-mono-tabular text-slate-300">
                      {seismicMetrics.count24h} eventos
                    </span>
                  </div>

                  <div
                    aria-hidden="true"
                    className="h-2 w-full rounded-full border border-white/10"
                    style={{
                      background:
                        'linear-gradient(90deg, #083f73 0%, #06b6d4 20%, #22c55e 42%, #facc15 62%, #f97316 80%, #ef4444 93%, #fff0d1 100%)',
                    }}
                  />

                  <div className="flex items-center justify-between text-[10px] font-mono-tabular text-slate-400">
                    <span>M{seismicMetrics.minMag.toFixed(1)}</span>
                    <span>M{seismicMetrics.midMag.toFixed(1)}</span>
                    <span className="text-orange-300 font-semibold">
                      M{seismicMetrics.maxMag.toFixed(1)}+
                    </span>
                  </div>

                  {seismicMetrics.peakQuake && (
                    <button
                      type="button"
                      data-testid="seismic-peak-btn"
                      onClick={() => {
                        const peak = seismicMetrics.peakQuake!;
                        handleSelectQuake24h(peak);
                        if (viewportMode === 'globe') {
                          handleFlyTo(peak.lat, peak.lng, 15.5);
                        }
                      }}
                      title="Abrir ficha y enfocar el sismo más fuerte de las últimas 24h"
                      className="text-left text-[10px] text-slate-300 hover:text-cyan-300 truncate border-t border-white/8 pt-1.5 transition-colors"
                    >
                      Pico M{seismicMetrics.peakQuake.magnitude.toFixed(1)} ·{' '}
                      {seismicMetrics.peakQuake.place}
                    </button>
                  )}
                </aside>
              )}
            </div>
          )}

        {/* Ojo de Dios Optical Viewfinder Corner Brackets (Zero Center Occlusion) */}
        {viewportMode !== 'maps' && textureMode === 'godseye' && (
          <div
            aria-hidden="true"
            className="pointer-events-none fixed inset-x-4 top-[60px] bottom-16 z-10"
          >
            <div className="absolute top-0 left-0 w-5 h-5 border-t border-l border-cyan-400/55" />
            <div className="absolute top-0 right-0 w-5 h-5 border-t border-r border-cyan-400/55" />
            <div className="absolute bottom-0 left-0 w-5 h-5 border-b border-l border-cyan-400/55" />
            <div className="absolute bottom-0 right-0 w-5 h-5 border-b border-r border-cyan-400/55" />
            <div className="hidden md:flex items-center gap-2 absolute bottom-1.5 right-3 px-2 py-0.5 rounded bg-[#06090f]/78 border border-cyan-500/25 text-[10px] font-mono-tabular tracking-widest uppercase text-cyan-300/90">
              <span>OJO DE DIOS · BLOQUEO ACTIVO</span>
              <span>·</span>
              <span>
                {(globeAltitude?.lat ?? activeSector.lat).toFixed(3)}°,{' '}
                {(globeAltitude?.lng ?? activeSector.lng).toFixed(3)}°
              </span>
            </div>
          </div>
        )}

        {/* Unified Top-Left HUD Column: QuickSearchBar + Quiet Context Readout + Live Terreno 3D Coords + Alert Toasts */}
        {viewportMode !== 'maps' && activeDrawer === 'none' && (
          <div className="fixed top-[64px] left-4 sm:left-6 z-20 flex flex-col gap-2 items-start pointer-events-none max-w-[calc(100vw-88px)]">
            <QuickSearchBar
              viewportMode={viewportMode}
              onFlyToGlobe={(lat, lng) => handleFlyTo(lat, lng, 14.5)}
              onOpenTerrain3D={(lat, lng, label, sublabel) =>
                void openTerrainAtCoordinate(lat, lng, label, sublabel)
              }
            />

            <div
              className={`pointer-events-none hidden md:flex items-center gap-2 text-xs text-slate-300/95 ${
                viewportMode === 'sector3d'
                  ? 'bg-[#06090f]/82 border border-white/8 rounded-lg px-2.5 py-1 shadow-lg'
                  : 'drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]'
              }`}
            >
              <span className="font-medium text-white">
                {viewportMode === 'sector3d'
                  ? `Terreno 3D · ${activeSector.name}`
                  : 'Globo 3D'}
              </span>
              <span aria-hidden="true">·</span>
              {viewportMode === 'sector3d' ? (
                <span className="font-mono-tabular text-slate-300">
                  {terrainStats?.loading
                    ? terrainStats.stage === 'buildings'
                      ? 'Extruyendo edificios OSM...'
                      : 'Cargando elevación DEM...'
                    : terrainStats?.stage === 'error'
                      ? 'Error cargando DEM'
                      : terrainStats
                        ? `${terrainStats.minElevationM}–${terrainStats.maxElevationM} m · ${terrainStats.buildingsCount.toLocaleString('es-ES')} edificios · ${terrainStats.spanKm} km${
                            terrainStats.chunksLoaded ? ` (${terrainStats.chunksLoaded} sectores)` : ''
                          } · Calidad ${
                            terrainStats.qualityTier === 'ultra'
                              ? 'Alta'
                              : terrainStats.qualityTier === 'balanced'
                                ? 'Media'
                                : 'Eco'
                          }`
                        : 'DEM Terrarium + OSM 3D'}
                </span>
              ) : (
                <span className="font-mono-tabular text-slate-300">
                  {isLoadingFeed ? 'Sincronizando...' : `${visibleEvents.length} señales`}
                </span>
              )}
              {viewportMode === 'globe' && globeAltitude && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono-tabular text-cyan-300">
                    {globeAltitude.altitudeMeters < 1000
                      ? `${globeAltitude.altitudeMeters} m`
                      : `${(globeAltitude.altitudeMeters / 1000).toFixed(1)} km`}
                    {globeAltitude.tileZoom > 0 ? ` · z${globeAltitude.tileZoom}` : ''}
                  </span>
                </>
              )}
              {feedError && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-rose-400">{feedError}</span>
                </>
              )}
            </div>

            {viewportMode === 'sector3d' && (
              <button
                type="button"
                data-testid="terrain-live-coords"
                onClick={handleCopyTerrainCoords}
                title="Clic para copiar latitud y longitud"
                className="pointer-events-auto flex flex-wrap items-center gap-x-2 gap-y-0.5 bg-[#080d16]/94 hover:border-cyan-400/45 border border-white/10 rounded-lg px-2.5 py-1 shadow-lg text-[11px] font-mono-tabular text-slate-200 transition-colors"
              >
                <span className="text-cyan-300 font-semibold">
                  {(liveTerrainCoords?.lat ?? activeSector.lat).toFixed(5)}°,{' '}
                  {(liveTerrainCoords?.lng ?? activeSector.lng).toFixed(5)}°
                </span>
                <span aria-hidden="true" className="text-slate-500">
                  ·
                </span>
                <span>
                  Terreno {(liveTerrainCoords?.groundElevM ?? terrainStats?.minElevationM ?? 0)} m
                </span>
                <span aria-hidden="true" className="text-slate-500">
                  ·
                </span>
                <span>Cámara {(liveTerrainCoords?.cameraAltM ?? 0)} m</span>
                <span aria-hidden="true" className="text-slate-500">
                  ·
                </span>
                <span className="text-slate-400">
                  {liveTerrainCoords?.source === 'cursor' ? 'Cursor' : 'Objetivo'}
                </span>
                {copiedCoordAtMs > 0 && Date.now() - copiedCoordAtMs < 2000 ? (
                  <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                ) : (
                  <Copy className="w-3 h-3 text-slate-400 shrink-0" />
                )}
              </button>
            )}

            <AlertToastStack
              stacked
              toasts={toastAlerts}
              unreadCount={unreadAlertCount}
              onFocusAlert={handleFocusAlert}
              onDismissToast={handleDismissToast}
              onDismissAllToasts={() => setToastAlerts([])}
              onOpenInbox={handleOpenAlertsDrawer}
            />
          </div>
        )}

        {/* Unified Vertical 3D Viewport Controls (+, -, Calle / Terreno aquí) */}
        {viewportMode !== 'maps' && activeDrawer === 'none' && (
          <div
            className={`fixed right-3 sm:right-4 z-10 flex flex-col divide-y divide-white/8 bg-[#080d16]/94 border border-white/8 rounded-xl overflow-hidden shadow-lg transition-all ${
              activeRoute && viewportMode === 'globe' && pickMode === 'none' ? 'top-44' : 'top-16'
            }`}
          >
            <button
              type="button"
              onClick={() => {
                if (viewportMode === 'globe') userExploredGlobeRef.current = true;
                setZoomSignal({ action: 'in', nonce: Date.now() });
              }}
              aria-label={viewportMode === 'sector3d' ? 'Acercar Terreno 3D' : 'Acercar Globo 3D'}
              title="Acercar"
              className="p-2 hover:bg-white/10 text-slate-200 transition-colors"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (viewportMode === 'globe') userExploredGlobeRef.current = true;
                setZoomSignal({ action: 'out', nonce: Date.now() });
              }}
              aria-label={viewportMode === 'sector3d' ? 'Alejar Terreno 3D' : 'Alejar Globo 3D'}
              title="Alejar"
              className="p-2 hover:bg-white/10 text-slate-200 transition-colors"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            {viewportMode === 'globe' ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    userExploredGlobeRef.current = true;
                    setZoomSignal({ action: 'street', nonce: Date.now() });
                  }}
                  aria-label="Zoom máximo a nivel de calle en el Globo 3D"
                  title="Bajar a nivel de calle (z19)"
                  className="px-2 py-1.5 text-[11px] font-medium hover:bg-white/10 text-cyan-300 transition-colors"
                >
                  Calle
                </button>
                <button
                  type="button"
                  onClick={() => setPickMode((m) => (m === 'terrain' ? 'none' : 'terrain'))}
                  aria-label="Abrir Terreno 3D haciendo clic en cualquier punto del globo"
                  title="Abrir Terreno 3D en cualquier coordenada"
                  className={`p-2 flex items-center justify-center transition-colors ${
                    pickMode === 'terrain'
                      ? 'bg-cyan-500 text-slate-950'
                      : 'hover:bg-white/10 text-slate-200 hover:text-cyan-300'
                  }`}
                >
                  <Mountain className="w-4 h-4" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setZoomSignal({ action: 'street', nonce: Date.now() })}
                  aria-label="Acercar Terreno 3D a nivel de calles y edificios"
                  title="Bajar entre los edificios 3D"
                  className="px-2 py-1.5 text-[11px] font-medium hover:bg-white/10 text-cyan-300 transition-colors"
                >
                  Calle
                </button>
                <button
                  type="button"
                  onClick={() => setViewportMode('globe')}
                  aria-label="Volver al Globo 3D"
                  title="Volver al Globo 3D"
                  className="p-2 flex items-center justify-center hover:bg-white/10 text-slate-200 hover:text-cyan-300 transition-colors"
                >
                  <Globe2 className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        )}

        {/* Globe Pick Mode Banner */}
        {pickMode !== 'none' && viewportMode === 'globe' && (
          <div className="fixed top-16 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 bg-[#080d16]/96 border border-cyan-400/45 text-xs text-white px-4 py-2 rounded-lg shadow-xl">
            <MapPin className="w-4 h-4 text-cyan-400 shrink-0" />
            <span>
              Haz clic en cualquier punto del Globo 3D para{' '}
              <strong>
                {pickMode === 'terrain'
                  ? 'abrir Terreno 3D'
                  : pickMode === 'origin'
                    ? 'fijar Origen'
                    : 'fijar Destino'}
              </strong>
            </span>
            <button
              type="button"
              onClick={() => setPickMode('none')}
              aria-label="Cancelar selección en el globo"
              className="p-1 text-slate-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Active 3D Globe Route Navigation HUD */}
        {activeRoute && viewportMode === 'globe' && pickMode === 'none' && (
          <div
            className={`fixed top-16 right-3 left-3 sm:left-auto sm:right-4 sm:w-[340px] z-10 bg-[#080d16]/94 border border-white/10 rounded-xl p-3 shadow-xl space-y-2 ${
              activeDrawer !== 'none' ? 'hidden sm:block' : 'block'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] text-cyan-300 font-medium truncate">
                  {activeRoute.originLabel} → {activeRoute.destinationLabel}
                </div>
                <div className="text-xs text-white font-semibold font-mono-tabular">
                  {Math.round(activeRoute.predictedDurationSeconds / 60)} min ·{' '}
                  {(activeRoute.distanceMeters / 1000).toFixed(1)} km
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!flyAlongActive && flyAlongProgress >= 0.99) {
                    setFlyAlongProgress(0);
                  }
                  setFlyAlongActive((v) => !v);
                }}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg shrink-0 transition-colors ${
                  flyAlongActive
                    ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                    : 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'
                }`}
              >
                {flyAlongActive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                <span>{flyAlongActive ? 'Pausar' : 'Volar ruta'}</span>
              </button>
            </div>
            {currentFlyStep && (
              <div className="text-[11px] text-slate-200 bg-[#06090f] border border-white/8 rounded-lg px-2.5 py-1.5">
                <span className="text-cyan-400 font-mono-tabular mr-1.5">
                  [{currentFlyStep.index}/{currentFlyStep.total}]
                </span>
                {currentFlyStep.step.instruction}
              </div>
            )}
          </div>
        )}
        {/* 24h Earthquake Event Detail Card + Direct Terreno 3D Jump */}
        {selectedQuake24h && viewportMode !== 'maps' && activeDrawer === 'none' && (
          <SeismicEventCard
            quake={selectedQuake24h}
            viewportMode={viewportMode}
            hasActiveRoute={Boolean(activeRoute && pickMode === 'none')}
            onJumpToTerrain3D={handleJumpQuakeToTerrain3D}
            onFocusGlobe={handleFocusQuakeGlobe}
            onClose={() => setSelectedQuake24h(null)}
          />
        )}

        {/* Fallback Alert Toast Stack when a side drawer (other than Alerts) is open */}
        {viewportMode !== 'maps' &&
          activeDrawer !== 'none' &&
          !(activeDrawer === 'telemetry' && telemetryTab === 'alerts') && (
            <AlertToastStack
              toasts={toastAlerts}
              unreadCount={unreadAlertCount}
              onFocusAlert={handleFocusAlert}
              onDismissToast={handleDismissToast}
              onDismissAllToasts={() => setToastAlerts([])}
              onOpenInbox={handleOpenAlertsDrawer}
            />
          )}
      </main>

      {/* Active Side Drawers (Rendered on demand, never blocking center) */}
      {activeDrawer === 'telemetry' && (
        <TelemetryDrawer
          events={visibleEvents}
          summary={summary}
          activeCategory={categoryFilter}
          selectedEvent={selectedEvent}
          initialTab={telemetryTab}
          onTabChange={setTelemetryTab}
          alertRules={alertRules}
          activeSector={activeSector}
          alertPreview={alertPreview}
          alertNotifications={alertNotifications}
          unreadAlertCount={unreadAlertCount}
          onUpdateAlertRules={setAlertRules}
          onForceReevaluateAlerts={handleForceReevaluateAlerts}
          onFocusAlert={handleFocusAlert}
          onOpenTerrainAtAlert={handleOpenTerrainAtAlert}
          onMarkAllAlertsRead={handleMarkAllAlertsRead}
          onDismissAlert={handleDismissAlert}
          onClearAlerts={handleClearAlerts}
          onSelectEvent={handleSelectEvent}
          onNavigateToEvent={handleNavigateToEvent}
          onOpenSectorAtEvent={handleOpenSectorAtEvent}
          onLocateHistoryRecord={handleLocateHistoryRecord}
          onOpenSectorAtHistoryRecord={handleOpenSectorAtHistoryRecord}
          onClose={() => setActiveDrawer('none')}
        />
      )}

      {activeDrawer === 'navigation' && (
        <NavigationPanel
          activeRoute={activeRoute}
          onRouteComputed={(route) => {
            setActiveRoute(route);
            setFlyAlongActive(false);
            setFlyAlongProgress(0);
          }}
          onChangeViewport={setViewportMode}
          onOpenSectorAtRoute={handleOpenSectorAtRoute}
          onFlyTo={handleFlyTo}
          onClose={() => {
            setActiveDrawer('none');
            setPickMode('none');
          }}
          onQuotaExceeded={() => setQuotaExceeded(true)}
          prefillDestination={prefillDest}
          pickMode={pickMode}
          onSetPickMode={(m) => {
            setPickMode(m);
            if (m !== 'none') setViewportMode('globe');
          }}
          pickedPoint={pickedPoint}
          flyAlongActive={flyAlongActive}
          onToggleFlyAlong={() => setFlyAlongActive((v) => !v)}
        />
      )}

      {activeDrawer === 'mcp' && <McpConsolePanel onClose={() => setActiveDrawer('none')} />}

      {/* Unified Single-Row Collapsible Bottom Control Dock (Zero Viewport Occlusion) */}
      <div
        className={`fixed bottom-3 inset-x-0 mx-auto w-fit max-w-[calc(100vw-16px)] z-20 flex-col items-center transition-transform duration-200 ${
          activeDrawer !== 'none' ? 'hidden sm:flex' : 'flex'
        }`}
        style={{
          transform: dockExpanded ? 'translateY(0)' : 'translateY(calc(100% - 28px))',
        }}
      >
        <button
          type="button"
          onClick={() => setDockExpanded((v) => !v)}
          aria-expanded={dockExpanded}
          aria-label={dockExpanded ? 'Ocultar panel de controles' : 'Mostrar panel de controles'}
          className="flex items-center gap-1 px-2.5 py-0.5 text-[11px] text-slate-400 hover:text-white bg-[#080d16]/94 border border-b-0 border-white/8 rounded-t-lg transition-colors whitespace-nowrap"
        >
          {dockExpanded ? (
            <>
              <ChevronDown className="w-3 h-3" />
              <span>Ocultar</span>
            </>
          ) : (
            <>
              <ChevronUp className="w-3 h-3 text-cyan-400" />
              <span>Controles</span>
            </>
          )}
        </button>

        <div className="w-full bg-[#080d16]/94 border border-white/8 rounded-xl shadow-2xl px-2 py-1.5 flex flex-wrap items-center justify-center gap-2">
          {/* Category Filter Segmented Control (Globe) or Relief Exaggeration + Quality (Terreno 3D) */}
          {viewportMode === 'sector3d' ? (
            <div className="flex items-center gap-2 overflow-x-auto max-w-full no-scrollbar">
              <div
                role="group"
                aria-label="Exageración vertical del relieve 3D"
                className="flex items-center gap-0.5"
              >
                <span className="hidden sm:inline text-[11px] text-slate-400 mr-1 whitespace-nowrap">Relieve</span>
                {([1, 1.5, 2.2] as const).map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setTerrainExaggeration(ex)}
                    className={`px-2 py-1 text-xs font-mono-tabular font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      terrainExaggeration === ex
                        ? 'bg-cyan-500 text-slate-950'
                        : 'text-slate-300 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {ex}×
                  </button>
                ))}
              </div>

              <div className="w-px h-4 bg-white/10" aria-hidden="true" />

              <div
                role="group"
                aria-label="Perfil de calidad adaptativa"
                className="flex items-center gap-0.5"
              >
                <span className="hidden sm:inline text-[11px] text-slate-400 mr-1 whitespace-nowrap">Calidad</span>
                {(
                  [
                    { id: 'auto', label: 'Auto' },
                    { id: 'ultra', label: 'Alta' },
                    { id: 'eco', label: 'Eco' },
                  ] as const
                ).map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => setQualityPreference(q.id)}
                    className={`px-2 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      qualityPreference === q.id
                        ? 'bg-white/15 text-cyan-300'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div
              role="group"
              aria-label="Filtrar eventos por categoría"
              className="flex items-center gap-0.5 overflow-x-auto max-w-full no-scrollbar"
            >
              {categoryTabs.map((tab) => {
                const active = categoryFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setCategoryFilter(tab.id)}
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                      active
                        ? 'bg-cyan-500 text-slate-950'
                        : 'text-slate-300 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span
                      className={`font-mono-tabular text-[11px] ${
                        active ? 'text-slate-900' : 'text-slate-500'
                      }`}
                    >
                      {tab.count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="hidden md:block w-px h-5 bg-white/10" aria-hidden="true" />

          {/* Dynamic Globe & Terrain Texture Mode */}
          <div
            role="group"
            aria-label="Textura dinámica del mapa 3D"
            className="flex items-center gap-0.5"
          >
            <Layers className="w-3.5 h-3.5 text-slate-500 mr-1 shrink-0" />
            {(
              [
                { id: 'godseye', label: 'Ojo de Dios' },
                { id: 'satellite', label: 'Satélite' },
                { id: 'thermal', label: 'Nocturno' },
                { id: 'topo', label: 'Calles' },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setTextureMode(m.id)}
                className={`px-2 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  textureMode === m.id
                    ? 'bg-white/15 text-cyan-300'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="hidden md:block w-px h-5 bg-white/10" aria-hidden="true" />

          {/* Compact Sector 3D Selector + Quiet Utility Controls */}
          <div className="flex items-center gap-1 overflow-x-auto max-w-full no-scrollbar">
            <select
              value={activeSector.id}
              onChange={(e) => {
                const found = SECTOR_PRESETS.find((p) => p.id === e.target.value);
                if (found) handleSelectSector(found);
              }}
              aria-label="Seleccionar sector 3D"
              title="Cambiar de sector geográfico"
              className="max-w-[150px] px-2 py-1 text-xs bg-[#06090f] border border-white/10 rounded-lg text-slate-200 focus:outline-none focus:border-cyan-400"
            >
              {!isPresetSector && (
                <option value={activeSector.id}>{activeSector.name}</option>
              )}
              {SECTOR_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>

            {viewportMode === 'globe' && (
              <button
                type="button"
                onClick={() => setAutoRotate((r) => !r)}
                aria-label="Alternar rotación orbital automática"
                title="Rotación automática"
                className={`p-1.5 rounded-lg transition-colors ${
                  autoRotate
                    ? 'bg-white/15 text-cyan-300'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <RotateCw className="w-3.5 h-3.5" />
              </button>
            )}

            <button
              type="button"
              data-testid="wind-layer-toggle"
              onClick={() => {
                if (viewportMode !== 'globe') {
                  setWindLayerEnabled(true);
                  setViewportMode('globe');
                } else {
                  setWindLayerEnabled((v) => !v);
                }
              }}
              aria-pressed={windLayerEnabled && viewportMode === 'globe'}
              aria-label="Alternar capa 3D de partículas de viento en tiempo real sobre el globo"
              title="Capa de viento 3D en tiempo real"
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                windLayerEnabled && viewportMode === 'globe'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/35'
                  : 'text-slate-300 hover:text-white hover:bg-white/5 border border-transparent'
              }`}
            >
              <Wind className="w-3.5 h-3.5 shrink-0" />
              <span>Viento</span>
              {windField && (
                <span className="font-mono-tabular text-[11px] opacity-85">
                  {windField.metrics.maxSpeedKmh}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setSeismicHeatmapEnabled((v) => !v)}
              aria-pressed={seismicHeatmapEnabled}
              aria-label="Alternar capa de calor sísmico de las últimas 24 horas"
              title="Capa de calor sísmico 24h"
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                seismicHeatmapEnabled
                  ? 'bg-orange-500/20 text-orange-300 border border-orange-400/35'
                  : 'text-slate-300 hover:text-white hover:bg-white/5 border border-transparent'
              }`}
            >
              <Flame className="w-3.5 h-3.5 shrink-0" />
              <span>Sismos 24h</span>
              {seismicMetrics && (
                <span className="font-mono-tabular text-[11px] opacity-85">
                  {seismicMetrics.count24h}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setTelemetryTab('history');
                setActiveDrawer((prev) =>
                  prev === 'telemetry' && telemetryTab === 'history' ? 'none' : 'telemetry'
                );
              }}
              aria-label="Abrir historial guardado de desastres naturales"
              title="Historial por categoría de desastres"
              className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeDrawer === 'telemetry' && telemetryTab === 'history'
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'text-slate-300 hover:text-white hover:bg-white/5'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>Historial</span>
            </button>

            <button
              type="button"
              data-testid="dock-alerts-button"
              onClick={() => {
                setTelemetryTab('alerts');
                setActiveDrawer((prev) =>
                  prev === 'telemetry' && telemetryTab === 'alerts' ? 'none' : 'telemetry'
                );
              }}
              aria-label="Configurar alertas y ver notificaciones de telemetría"
              title="Alertas por umbrales sísmicos y meteorológicos"
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeDrawer === 'telemetry' && telemetryTab === 'alerts'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/35'
                  : unreadAlertCount > 0
                    ? 'bg-amber-500/15 text-amber-300 border border-amber-400/30 hover:bg-amber-500/25'
                    : 'text-slate-300 hover:text-white hover:bg-white/5 border border-transparent'
              }`}
            >
              <Bell className="w-3.5 h-3.5 shrink-0" />
              <span>Alertas</span>
              {unreadAlertCount > 0 && (
                <span className="font-mono-tabular text-[11px] font-semibold">
                  {unreadAlertCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => void fetchWorldEvents()}
              aria-label="Actualizar telemetría en tiempo real"
              title="Actualizar ahora"
              className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-white/5 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setActiveDrawer((prev) => (prev === 'mcp' ? 'none' : 'mcp'))}
              className="sm:hidden flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-cyan-300 hover:bg-white/5 rounded-lg whitespace-nowrap shrink-0"
            >
              <Cpu className="w-3 h-3" />
              <span>MCP</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
