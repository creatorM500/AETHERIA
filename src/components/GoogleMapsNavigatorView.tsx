import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AdvancedMarker,
  APIProvider,
  Map as GoogleMap,
  Pin,
  useMap,
} from '@vis.gl/react-google-maps';
import { Crosshair, Globe2, Minus, Plus } from 'lucide-react';
import type { GlobalEvent, PredictiveRouteResult, SectorPreset } from '../shared/types.ts';
import { isEsriPlaceholderImage } from '../three/worldTiles.ts';

interface GoogleMapsNavigatorViewProps {
  apiKey: string;
  activeSector: SectorPreset;
  activeRoute: PredictiveRouteResult | null;
  events: GlobalEvent[];
  onSwitchToGlobe: () => void;
}

interface GoogleMapsPolylineInstance {
  setMap: (map: unknown) => void;
}

interface GoogleMapsLatLngBoundsInstance {
  extend: (latLng: { lat: number; lng: number }) => void;
}

interface GoogleMapsRuntime {
  maps?: {
    Polyline: new (opts: Record<string, unknown>) => GoogleMapsPolylineInstance;
    LatLngBounds: new () => GoogleMapsLatLngBoundsInstance;
  };
}

function RoutePolylineOverlay({ route }: { route: PredictiveRouteResult | null }) {
  const map = useMap();
  const polylineRef = useRef<GoogleMapsPolylineInstance | null>(null);

  useEffect(() => {
    if (!map) return;

    if (polylineRef.current) {
      polylineRef.current.setMap(null);
      polylineRef.current = null;
    }

    if (!route || route.polylinePath.length < 2) return;

    const gMaps = (window as unknown as { google?: GoogleMapsRuntime }).google?.maps;
    if (!gMaps) return;

    const poly = new gMaps.Polyline({
      path: route.polylinePath,
      geodesic: true,
      strokeColor: '#06b6d4',
      strokeOpacity: 0.95,
      strokeWeight: 5,
      map,
    });
    polylineRef.current = poly;

    const bounds = new gMaps.LatLngBounds();
    route.polylinePath.forEach((pt) => bounds.extend(pt));
    map.fitBounds(bounds, 64);

    return () => {
      poly.setMap(null);
    };
  }, [map, route]);

  return null;
}

// Web Mercator projection helpers for the key-free interactive 2D slippy map
const TILE_SIZE = 256;

function lngToWorldX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * TILE_SIZE * Math.pow(2, zoom);
}

function latToWorldY(lat: number, zoom: number): number {
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clamped * Math.PI) / 180;
  const n = Math.log(Math.tan(Math.PI / 4 + rad / 2));
  return ((1 - n / Math.PI) / 2) * TILE_SIZE * Math.pow(2, zoom);
}

function worldXToLng(wx: number, zoom: number): number {
  return (wx / (TILE_SIZE * Math.pow(2, zoom))) * 360 - 180;
}

function worldYToLat(wy: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * wy) / (TILE_SIZE * Math.pow(2, zoom));
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

type Map2DLayer = 'nocturno' | 'calles' | 'satelite';

function InteractiveKeyFreeMap({
  activeSector,
  activeRoute,
  events,
  onSwitchToGlobe,
}: Omit<GoogleMapsNavigatorViewProps, 'apiKey'>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tileCacheRef = useRef<
    Map<string, HTMLImageElement | 'loading' | 'error' | 'placeholder'>
  >(new Map());
  const dragRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
  });

  const [layer, setLayer] = useState<Map2DLayer>('calles');
  const [center, setCenter] = useState<{ lat: number; lng: number }>(() =>
    activeRoute
      ? {
          lat: (activeRoute.origin.lat + activeRoute.destination.lat) / 2,
          lng: (activeRoute.origin.lng + activeRoute.destination.lng) / 2,
        }
      : { lat: activeSector.lat, lng: activeSector.lng }
  );
  const [zoom, setZoom] = useState<number>(activeRoute ? 12 : 12);
  const [selectedEventTitle, setSelectedEventTitle] = useState<string | null>(null);
  const rafDrawRef = useRef<number>(0);

  // Recenter smoothly when sector or route changes
  useEffect(() => {
    if (activeRoute) {
      setCenter({
        lat: (activeRoute.origin.lat + activeRoute.destination.lat) / 2,
        lng: (activeRoute.origin.lng + activeRoute.destination.lng) / 2,
      });
      setZoom(12);
    } else {
      setCenter({ lat: activeSector.lat, lng: activeSector.lng });
      setZoom(12);
    }
  }, [activeRoute, activeSector.lat, activeSector.lng]);

  const drawMap = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Dark cartographic base
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, w, h);

    const centerWx = lngToWorldX(center.lng, zoom);
    const centerWy = latToWorldY(center.lat, zoom);
    const topLeftWx = centerWx - w / 2;
    const topLeftWy = centerWy - h / 2;

    const maxTiles = Math.pow(2, zoom);
    const startTx = Math.floor(topLeftWx / TILE_SIZE);
    const endTx = Math.floor((topLeftWx + w) / TILE_SIZE);
    const startTy = Math.max(0, Math.floor(topLeftWy / TILE_SIZE));
    const endTy = Math.min(maxTiles - 1, Math.floor((topLeftWy + h) / TILE_SIZE));

    const scheduleTileRedraw = () => {
      if (rafDrawRef.current) return;
      rafDrawRef.current = window.requestAnimationFrame(() => {
        rafDrawRef.current = 0;
        drawMap();
      });
    };

    const requestTile = (key: string, url: string, checkPlaceholder = false) => {
      const cached = tileCacheRef.current.get(key);
      if (cached instanceof HTMLImageElement) return cached;
      if (cached === 'placeholder') return 'placeholder' as const;
      if (!cached) {
        if (tileCacheRef.current.size > 360) {
          const oldest = tileCacheRef.current.keys().next().value;
          if (oldest) tileCacheRef.current.delete(oldest);
        }
        tileCacheRef.current.set(key, 'loading');
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => {
          if (checkPlaceholder && isEsriPlaceholderImage(img)) {
            tileCacheRef.current.set(key, 'placeholder');
          } else {
            tileCacheRef.current.set(key, img);
          }
          scheduleTileRedraw();
        };
        img.onerror = () => {
          tileCacheRef.current.set(key, 'error');
        };
        img.src = url;
      }
      return null;
    };

    // Render watermark-free slippy tiles + crisp reference labels
    for (let ty = startTy; ty <= endTy; ty++) {
      for (let tx = startTx; tx <= endTx; tx++) {
        const wrappedTx = ((tx % maxTiles) + maxTiles) % maxTiles;
        const dx = tx * TILE_SIZE - topLeftWx;
        const dy = ty * TILE_SIZE - topLeftWy;

        let fetchZoom = layer === 'nocturno' ? Math.min(16, zoom) : zoom;
        let baseImg: HTMLImageElement | null = null;
        let scaleDiff = zoom - fetchZoom;
        let factor = Math.pow(2, scaleDiff);
        let srcTx = Math.floor(wrappedTx / factor);
        let srcTy = Math.floor(ty / factor);

        for (let attempt = 0; attempt <= 3; attempt++) {
          scaleDiff = zoom - fetchZoom;
          factor = Math.pow(2, scaleDiff);
          srcTx = Math.floor(wrappedTx / factor);
          srcTy = Math.floor(ty / factor);
          const baseUrl =
            layer === 'satelite'
              ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${fetchZoom}/${srcTy}/${srcTx}`
              : layer === 'nocturno'
                ? `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${fetchZoom}/${srcTy}/${srcTx}`
                : `https://tile.openstreetmap.org/${fetchZoom}/${srcTx}/${srcTy}.png`;
          const res = requestTile(
            `${layer}:${fetchZoom}/${srcTx}/${srcTy}`,
            baseUrl,
            layer === 'satelite' && fetchZoom >= 16
          );
          if (res === 'placeholder' && fetchZoom > 14) {
            fetchZoom -= 1;
            continue;
          }
          if (res instanceof HTMLImageElement) {
            baseImg = res;
          }
          break;
        }

        if (baseImg) {
          if (scaleDiff > 0) {
            const subW = baseImg.width / factor;
            const subH = baseImg.height / factor;
            const sx = (wrappedTx % factor) * subW;
            const sy = (ty % factor) * subH;
            ctx.drawImage(baseImg, sx, sy, subW, subH, dx, dy, TILE_SIZE, TILE_SIZE);
          } else {
            ctx.drawImage(baseImg, dx, dy, TILE_SIZE, TILE_SIZE);
          }
          if (layer === 'nocturno') {
            ctx.fillStyle = 'rgba(6, 12, 24, 0.52)';
            ctx.fillRect(dx, dy, TILE_SIZE, TILE_SIZE);
          }
        } else {
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
          ctx.lineWidth = 1;
          ctx.strokeRect(dx, dy, TILE_SIZE, TILE_SIZE);
        }

        if ((layer === 'satelite' && zoom <= 17) || layer === 'nocturno') {
          const refUrl =
            layer === 'satelite'
              ? `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${zoom}/${ty}/${wrappedTx}`
              : `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/${fetchZoom}/${srcTy}/${srcTx}`;
          const refRes = requestTile(`ref-${layer}:${fetchZoom}/${srcTx}/${srcTy}`, refUrl);
          if (refRes instanceof HTMLImageElement) {
            if (scaleDiff > 0) {
              const subW = refRes.width / factor;
              const subH = refRes.height / factor;
              const sx = (wrappedTx % factor) * subW;
              const sy = (ty % factor) * subH;
              ctx.drawImage(refRes, sx, sy, subW, subH, dx, dy, TILE_SIZE, TILE_SIZE);
            } else {
              ctx.drawImage(refRes, dx, dy, TILE_SIZE, TILE_SIZE);
            }
          }
        }
      }
    }

    const toScreen = (lat: number, lng: number) => ({
      x: lngToWorldX(lng, zoom) - topLeftWx,
      y: latToWorldY(lat, zoom) - topLeftWy,
    });

    // Active predictive route polyline
    if (activeRoute && activeRoute.polylinePath.length >= 2) {
      ctx.save();
      ctx.beginPath();
      activeRoute.polylinePath.forEach((pt, idx) => {
        const p = toScreen(pt.lat, pt.lng);
        if (idx === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.35)';
      ctx.lineWidth = 10;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();

      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();

      const orig = toScreen(activeRoute.origin.lat, activeRoute.origin.lng);
      const dest = toScreen(activeRoute.destination.lat, activeRoute.destination.lng);

      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.arc(orig.x, orig.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(dest.x, dest.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Live event pins in viewport
    for (const ev of events) {
      const p = toScreen(ev.lat, ev.lng);
      if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) continue;

      const color =
        ev.category === 'disaster'
          ? '#f97316'
          : ev.category === 'conflict'
            ? '#ef4444'
            : ev.category === 'flight'
              ? '#38bdf8'
              : '#10b981';

      ctx.fillStyle = `${color}44`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#06090f';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.restore();
  }, [activeRoute, center, events, layer, zoom]);

  useEffect(() => {
    drawMap();
  }, [drawMap]);

  useEffect(() => {
    const onResize = () => drawMap();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (rafDrawRef.current) {
        cancelAnimationFrame(rafDrawRef.current);
        rafDrawRef.current = 0;
      }
    };
  }, [drawMap]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.lastX;
    const dy = e.clientY - dragRef.current.lastY;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;

    setCenter((prev) => {
      const nextWx = lngToWorldX(prev.lng, zoom) - dx;
      const nextWy = latToWorldY(prev.lat, zoom) - dy;
      return {
        lat: Math.max(-84, Math.min(84, worldYToLat(nextWy, zoom))),
        lng: ((worldXToLng(nextWx, zoom) + 540) % 360) - 180,
      };
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const topLeftWx = lngToWorldX(center.lng, zoom) - rect.width / 2;
    const topLeftWy = latToWorldY(center.lat, zoom) - rect.height / 2;

    const hit = events.find((ev) => {
      const ex = lngToWorldX(ev.lng, zoom) - topLeftWx;
      const ey = latToWorldY(ev.lat, zoom) - topLeftWy;
      return Math.hypot(ex - clickX, ey - clickY) <= 14;
    });
    if (hit) {
      setSelectedEventTitle(`${hit.title} · ${hit.region}`);
    }
  };

  return (
    <div ref={containerRef} className="w-full h-full relative bg-[#070b14] overflow-hidden">
      <canvas
        ref={canvasRef}
        data-testid="interactive-2d-map"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={(e) => {
          setZoom((z) => Math.max(2, Math.min(19, z + (e.deltaY < 0 ? 1 : -1))));
        }}
        className="w-full h-full block cursor-grab active:cursor-grabbing touch-none"
        aria-label="Mapa cartográfico 2D interactivo"
      />

      {/* Top-Left 2D Layer Switcher */}
      <div className="fixed top-[52px] left-3 sm:left-4 z-10 flex items-center gap-1 p-1 bg-[#080d16]/92 border border-white/[0.08] rounded-lg shadow-lg">
        {(
          [
            { id: 'calles', label: 'Calles' },
            { id: 'satelite', label: 'Satélite' },
            { id: 'nocturno', label: 'Nocturno' },
          ] as const
        ).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setLayer(m.id)}
            className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors ${
              layer === m.id
                ? 'bg-cyan-500 text-slate-950'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {selectedEventTitle && (
        <div className="fixed top-24 left-3 sm:left-4 z-10 max-w-xs bg-[#080d16]/92 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-[11px] text-slate-100 shadow-lg">
          {selectedEventTitle}
        </div>
      )}

      {/* Map Controls (Unified Vertical Bar) */}
      <div className="fixed top-[52px] right-3 z-10 flex flex-col divide-y divide-white/[0.07] bg-[#080d16]/92 border border-white/[0.08] rounded-lg overflow-hidden shadow-lg">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(19, z + 1))}
          aria-label="Acercar mapa 2D"
          className="p-2 hover:bg-white/10 text-slate-200 transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(2, z - 1))}
          aria-label="Alejar mapa 2D"
          className="p-2 hover:bg-white/10 text-slate-200 transition-colors"
        >
          <Minus className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            if (activeRoute) {
              setCenter({
                lat: (activeRoute.origin.lat + activeRoute.destination.lat) / 2,
                lng: (activeRoute.origin.lng + activeRoute.destination.lng) / 2,
              });
              setZoom(12);
            } else {
              setCenter({ lat: activeSector.lat, lng: activeSector.lng });
              setZoom(12);
            }
          }}
          aria-label="Centrar mapa en ruta o sector"
          className="p-2 hover:bg-white/10 text-cyan-300 transition-colors"
        >
          <Crosshair className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={onSwitchToGlobe}
          aria-label="Volver al Globo 3D"
          className="p-2 hover:bg-white/10 text-slate-200 hover:text-cyan-300 transition-colors"
        >
          <Globe2 className="w-4 h-4" />
        </button>
      </div>

      {/* Subtle Attribution */}
      <div className="pointer-events-none fixed bottom-2 right-3 z-10 text-[10px] text-slate-500">
        Mapa Web Mercator · OpenStreetMap / Esri ArcGIS (Sin API key)
      </div>
    </div>
  );
}

export function GoogleMapsNavigatorView({
  apiKey,
  activeSector,
  activeRoute,
  events,
  onSwitchToGlobe,
}: GoogleMapsNavigatorViewProps) {
  const [authFailed, setAuthFailed] = useState(false);
  const [forceKeyFree, setForceKeyFree] = useState(false);

  useEffect(() => {
    const win = window as unknown as { gm_authFailure?: () => void };
    const prev = win.gm_authFailure;
    win.gm_authFailure = () => {
      setAuthFailed(true);
      if (typeof prev === 'function') prev();
    };
    return () => {
      win.gm_authFailure = prev;
    };
  }, []);

  const center = activeRoute
    ? activeRoute.origin
    : { lat: activeSector.lat, lng: activeSector.lng };

  if (!apiKey || authFailed || forceKeyFree) {
    return (
      <InteractiveKeyFreeMap
        activeSector={activeSector}
        activeRoute={activeRoute}
        events={events}
        onSwitchToGlobe={onSwitchToGlobe}
      />
    );
  }

  return (
    <div className="w-full h-full relative" style={{ minHeight: '100%' }}>
      <APIProvider apiKey={apiKey} language="es" onError={() => setAuthFailed(true)}>
        <GoogleMap
          mapId="DEMO_MAP_ID"
          defaultCenter={center}
          defaultZoom={activeRoute ? 11 : 12}
          gestureHandling="greedy"
          disableDefaultUI={false}
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          style={{ width: '100%', height: '100%' }}
        >
          <RoutePolylineOverlay route={activeRoute} />

          {activeRoute && (
            <>
              <AdvancedMarker position={activeRoute.origin} title={activeRoute.originLabel}>
                <Pin background="#10b981" glyphColor="#ffffff" borderColor="#065f46" />
              </AdvancedMarker>
              <AdvancedMarker
                position={activeRoute.destination}
                title={activeRoute.destinationLabel}
              >
                <Pin background="#f59e0b" glyphColor="#0f172a" borderColor="#92400e" />
              </AdvancedMarker>
            </>
          )}

          {events
            .filter((e) => e.category === 'disaster' || e.category === 'conflict')
            .slice(0, 15)
            .map((ev) => (
              <AdvancedMarker
                key={ev.id}
                position={{ lat: ev.lat, lng: ev.lng }}
                title={`${ev.title} (${ev.severity})`}
              >
                <Pin
                  background={ev.category === 'disaster' ? '#f97316' : '#ef4444'}
                  glyphColor="#ffffff"
                  borderColor="#7f1d1d"
                />
              </AdvancedMarker>
            ))}
        </GoogleMap>
      </APIProvider>

      <button
        type="button"
        onClick={() => setForceKeyFree(true)}
        className="absolute top-16 left-2.5 z-10 px-2.5 py-1.5 text-xs font-medium bg-[#0b111e]/95 hover:bg-[#131d33] border border-white/15 rounded-lg text-cyan-300 shadow-lg transition-colors"
      >
        Cambiar a Mapa OSM Libre
      </button>
    </div>
  );
}
