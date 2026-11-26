import { useEffect, useRef, useState } from 'react';
import { APIProvider, useMapsLibrary } from '@vis.gl/react-google-maps';
import {
  AlertTriangle,
  Compass,
  Crosshair,
  MapPin,
  Maximize2,
  Minimize2,
  Rotate3d,
  X,
} from 'lucide-react';
import { getRoadClassMetadata } from '../shared/trafficCamera.ts';
import type { TrafficCameraFeedPoint } from '../shared/types.ts';

interface TrafficCameraPanelProps {
  camera: TrafficCameraFeedPoint;
  mapsApiKey?: string;
  precipMmH?: number;
  onFocusPoint: (lat: number, lng: number) => void;
  onClose: () => void;
}

interface StreetPhotoMeta {
  available: boolean;
  panoId?: string;
  date?: string | null;
}

function formatCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function normalizeHeading(deg: number): number {
  return Math.round(((deg % 360) + 360) % 360);
}

interface StreetView360CanvasProps {
  panoId: string;
  initialHeading: number;
  expanded: boolean;
  onHeadingChange: (heading: number) => void;
  onUnavailable: () => void;
}

interface StreetViewPanoInstance {
  addListener: (eventName: string, handler: () => void) => { remove: () => void };
  getPov: () => { heading?: number; pitch?: number } | undefined;
  getStatus: () => string | undefined;
}

function StreetView360Canvas({
  panoId,
  initialHeading,
  expanded,
  onHeadingChange,
  onUnavailable,
}: StreetView360CanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panoRef = useRef<StreetViewPanoInstance | null>(null);
  const streetViewLib = useMapsLibrary('streetView');
  const onHeadingRef = useRef(onHeadingChange);
  const onUnavailableRef = useRef(onUnavailable);
  onHeadingRef.current = onHeadingChange;
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !streetViewLib) return;

    const StreetViewCtor = streetViewLib.StreetViewPanorama as unknown as new (
      container: HTMLElement,
      opts: Record<string, unknown>
    ) => StreetViewPanoInstance;

    const pano = new StreetViewCtor(el, {
      pano: panoId,
      pov: { heading: normalizeHeading(initialHeading), pitch: 4 },
      zoom: 0.8,
      disableDefaultUI: true,
      panControl: true,
      zoomControl: true,
      addressControl: false,
      linksControl: false,
      clickToGo: false,
      fullscreenControl: false,
      enableCloseButton: false,
      motionTracking: false,
      motionTrackingControl: false,
      imageDateControl: false,
      showRoadLabels: true,
      scrollwheel: true,
      controlSize: 26,
    });
    panoRef.current = pano;

    const povListener = pano.addListener('pov_changed', () => {
      const pov = pano.getPov();
      if (pov && typeof pov.heading === 'number' && Number.isFinite(pov.heading)) {
        onHeadingRef.current(normalizeHeading(pov.heading));
      }
    });

    const statusListener = pano.addListener('status_changed', () => {
      const st = pano.getStatus();
      if (st && st !== 'OK') {
        onUnavailableRef.current();
      }
    });

    const ro = new ResizeObserver(() => {
      const gEvent = (
        window as unknown as {
          google?: { maps?: { event?: { trigger: (inst: unknown, ev: string) => void } } };
        }
      ).google?.maps?.event;
      gEvent?.trigger(pano, 'resize');
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      povListener.remove();
      statusListener.remove();
      panoRef.current = null;
      el.innerHTML = '';
    };
  }, [streetViewLib, panoId, initialHeading]);

  useEffect(() => {
    const pano = panoRef.current;
    if (!pano) return;
    const triggerResize = () => {
      const gEvent = (
        window as unknown as {
          google?: { maps?: { event?: { trigger: (inst: unknown, ev: string) => void } } };
        }
      ).google?.maps?.event;
      gEvent?.trigger(pano, 'resize');
    };
    const t1 = window.setTimeout(triggerResize, 60);
    const t2 = window.setTimeout(triggerResize, 240);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [expanded]);

  return (
    <div
      ref={containerRef}
      data-testid="traffic-street-360"
      onWheel={(e) => e.stopPropagation()}
      className="w-full h-full bg-[#04070d]"
    />
  );
}

export function TrafficCameraPanel({
  camera,
  mapsApiKey = '',
  precipMmH = 0,
  onFocusPoint,
  onClose,
}: TrafficCameraPanelProps) {
  const [photoMeta, setPhotoMeta] = useState<StreetPhotoMeta | null>(null);
  const [panoFailed, setPanoFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [liveHeading, setLiveHeading] = useState<number>(camera.bearingDeg);

  const meta = getRoadClassMetadata(camera.roadKind);

  useEffect(() => {
    const controller = new AbortController();
    setPhotoMeta(null);
    setPanoFailed(false);
    setLiveHeading(normalizeHeading(camera.bearingDeg));

    fetch(
      `/api/traffic/street-photo/metadata?lat=${encodeURIComponent(
        camera.lat
      )}&lng=${encodeURIComponent(camera.lng)}`,
      { signal: controller.signal }
    )
      .then((res) => (res.ok ? (res.json() as Promise<StreetPhotoMeta>) : { available: false }))
      .then((data) => {
        if (!controller.signal.aborted) {
          setPhotoMeta(data);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPhotoMeta({ available: false });
        }
      });

    return () => controller.abort();
  }, [camera.id, camera.lat, camera.lng, camera.bearingDeg]);

  const canShow360 = Boolean(
    mapsApiKey && photoMeta?.available && photoMeta.panoId && !panoFailed
  );
  const fallbackStaticUrl =
    !mapsApiKey && photoMeta?.available && photoMeta.panoId && !panoFailed
      ? `/api/traffic/street-photo?pano=${encodeURIComponent(
          photoMeta.panoId
        )}&heading=${encodeURIComponent(camera.bearingDeg)}`
      : null;
  const hasPreview = canShow360 || Boolean(fallbackStaticUrl);

  return (
    <aside
      aria-label="Inspección 360° de punto vial en Terreno 3D"
      data-testid="traffic-camera-panel"
      data-expanded={expanded ? 'true' : 'false'}
      className={`fixed top-[56px] left-3 right-3 sm:left-auto sm:right-14 z-20 bg-[#080d16]/94 border border-white/[0.09] rounded-xl shadow-2xl overflow-hidden transition-[width] duration-200 ${
        expanded && hasPreview
          ? 'sm:w-[560px] lg:w-[660px] max-w-[calc(100vw-5.5rem)]'
          : 'sm:w-[320px]'
      }`}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-white/[0.08] flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-xs font-semibold text-white truncate">
              {camera.roadName}
            </h2>
            <div className="text-[10px] font-mono-tabular text-slate-400 truncate">
              {meta.badgeLabel} · {camera.lat.toFixed(5)}°, {camera.lng.toFixed(5)}°
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {hasPreview && (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              aria-label={expanded ? 'Contraer vista previa' : 'Expandir vista previa'}
              title={expanded ? 'Contraer vista previa' : 'Expandir vista previa'}
              data-testid="traffic-camera-expand-btn"
              className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              {expanded ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar inspección vial"
            className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Real 360° Interactive Street View Panorama (look around in place, no walking) */}
      {canShow360 && (
        <div
          className={`relative bg-[#04070d] border-b border-white/[0.08] transition-[height] duration-200 ${
            expanded ? 'h-[340px] sm:h-[380px]' : 'h-[184px]'
          }`}
        >
          <APIProvider
            apiKey={mapsApiKey}
            language="es"
            onError={() => setPanoFailed(true)}
          >
            <StreetView360Canvas
              panoId={photoMeta!.panoId!}
              initialHeading={camera.bearingDeg}
              expanded={expanded}
              onHeadingChange={setLiveHeading}
              onUnavailable={() => setPanoFailed(true)}
            />
          </APIProvider>

          <div className="pointer-events-none absolute top-2 left-2.5 right-2.5 flex items-center justify-between text-[10px] font-mono-tabular">
            <span className="flex items-center gap-1 px-1.5 py-0.5 bg-[#06090f]/82 border border-white/12 rounded text-slate-200">
              <Rotate3d className="w-3 h-3 text-cyan-300" />
              <span>360°{photoMeta?.date ? ` · ${photoMeta.date}` : ''}</span>
            </span>
            <span className="px-1.5 py-0.5 bg-[#06090f]/82 border border-white/12 rounded text-cyan-300">
              {formatCardinal(liveHeading)} {liveHeading}°
            </span>
          </div>
        </div>
      )}

      {/* Fallback real static photo when no JS Maps key is exposed client-side */}
      {!canShow360 && fallbackStaticUrl && (
        <div
          className={`relative bg-[#04070d] border-b border-white/[0.08] transition-[height] duration-200 ${
            expanded ? 'h-[340px] sm:h-[380px]' : 'h-[184px]'
          }`}
        >
          <img
            src={fallbackStaticUrl}
            alt={`Vista real de calle en ${camera.roadName}`}
            data-testid="traffic-street-photo"
            onError={() => setPanoFailed(true)}
            className="block w-full h-full object-cover"
          />
          <div className="pointer-events-none absolute bottom-2 left-2.5 right-2.5 flex items-center justify-between text-[10px] font-mono-tabular">
            <span className="px-1.5 py-0.5 bg-[#06090f]/82 border border-white/12 rounded text-slate-200">
              Street View{photoMeta?.date ? ` · ${photoMeta.date}` : ''}
            </span>
            <span className="px-1.5 py-0.5 bg-[#06090f]/82 border border-white/12 rounded text-cyan-300">
              {formatCardinal(camera.bearingDeg)} {camera.bearingDeg}°
            </span>
          </div>
        </div>
      )}

      {/* Real OSM + DEM + Weather Telemetry */}
      <div className="p-2.5 space-y-2 text-xs">
        <div className="grid grid-cols-3 gap-1.5">
          <div className="bg-[#05080f] border border-white/[0.07] rounded-md px-2 py-1.5">
            <div className="text-[10px] text-slate-400">Carriles</div>
            <div className="font-mono-tabular text-xs font-semibold text-white">
              {camera.lanes}
            </div>
          </div>

          <div className="bg-[#05080f] border border-white/[0.07] rounded-md px-2 py-1.5">
            <div className="text-[10px] text-slate-400">Límite ref.</div>
            <div className="font-mono-tabular text-xs font-semibold text-white">
              {camera.speedLimitKmh} km/h
            </div>
          </div>

          <div className="bg-[#05080f] border border-white/[0.07] rounded-md px-2 py-1.5">
            <div className="text-[10px] text-slate-400">Altitud</div>
            <div className="font-mono-tabular text-xs font-semibold text-white">
              {camera.elevationM} m
            </div>
          </div>
        </div>

        {camera.nearbyAlertTitle && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-200">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="truncate">Incidencia cercana: {camera.nearbyAlertTitle}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span className="flex items-center gap-1 text-[10px] text-slate-400 font-mono-tabular truncate">
            <Compass className="w-3 h-3 text-slate-500 shrink-0" />
            <span>
              Rumbo {formatCardinal(liveHeading)} {liveHeading}°
              {precipMmH >= 0.25 ? ` · ${precipMmH.toFixed(1)} mm/h` : ''}
            </span>
          </span>

          <button
            type="button"
            onClick={() => onFocusPoint(camera.lat, camera.lng)}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Crosshair className="w-3 h-3" />
            <span>Acercar punto</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
