import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Check,
  CloudRain,
  Compass,
  Copy,
  FileText,
  Flame,
  Globe2,
  Mountain,
  Sun,
  Wind,
  X,
} from 'lucide-react';
import type {
  ZoneBriefingEventItem,
  ZoneBriefingReport,
  ZoneBriefingThreatLevel,
} from '../shared/types.ts';
import { formatZoneBriefingText } from '../shared/zoneBriefing.ts';

interface BriefingDrawerProps {
  report: ZoneBriefingReport;
  radiusKm: 150 | 500 | 1500;
  onRadiusChange: (radius: 150 | 500 | 1500) => void;
  focusTargetMode: 'sector' | 'globe';
  onFocusTargetModeChange: (mode: 'sector' | 'globe') => void;
  canUseGlobeCenter: boolean;
  onFlyTo: (lat: number, lng: number, zoomDistance?: number) => void;
  onOpenTerrain3D: (lat: number, lng: number, label: string, sublabel?: string) => void;
  onSelectEventId?: (id: string) => void;
  onClose: () => void;
}

function getThreatBadgeStyle(level: ZoneBriefingThreatLevel): string {
  switch (level) {
    case 'Crítico':
      return 'bg-rose-500/15 text-rose-300 border-rose-500/35';
    case 'Elevado':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/35';
    case 'Vigilancia':
      return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/35';
    case 'Estable':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35';
  }
}

function getSeverityBadgeText(severity: ZoneBriefingEventItem['severity']): {
  label: string;
  cls: string;
} {
  switch (severity) {
    case 'critical':
      return { label: 'Crítico', cls: 'text-rose-300' };
    case 'high':
      return { label: 'Alto', cls: 'text-amber-300' };
    case 'moderate':
      return { label: 'Moderado', cls: 'text-cyan-300' };
    case 'low':
      return { label: 'Normal', cls: 'text-slate-400' };
  }
}

export function BriefingDrawer({
  report,
  radiusKm,
  onRadiusChange,
  focusTargetMode,
  onFocusTargetModeChange,
  canUseGlobeCenter,
  onFlyTo,
  onOpenTerrain3D,
  onSelectEventId,
  onClose,
}: BriefingDrawerProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopyBriefing = () => {
    const text = formatZoneBriefingText(report);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => undefined);
    }
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, 2000);
  };

  return (
    <aside
      aria-label="Briefing Operativo de Zona"
      data-testid="briefing-drawer"
      className="fixed top-[52px] right-3 left-3 sm:left-auto sm:w-[400px] max-h-[calc(100dvh-76px)] sm:max-h-[calc(100vh-110px)] z-20 flex flex-col bg-[#080d16]/94 border border-white/[0.08] rounded-xl shadow-2xl overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/[0.08] space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <h2 className="font-display text-sm font-semibold tracking-wide text-white truncate">
                Briefing Operativo
              </h2>
            </div>
            <div className="text-[11px] text-slate-400 font-mono-tabular truncate mt-0.5">
              {report.zoneLabel} · {report.lat.toFixed(3)}°, {report.lng.toFixed(3)}°
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <span
              data-testid="briefing-threat-badge"
              className={`px-2 py-0.5 text-[11px] font-semibold border rounded-md font-mono-tabular ${getThreatBadgeStyle(
                report.threatLevel
              )}`}
            >
              {report.threatLevel} · {report.threatScore}/100
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar briefing operativo"
              className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Target Focus + Operational Radius Controls */}
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div
            role="group"
            aria-label="Referencia geográfica del briefing"
            className="flex items-center p-0.5 bg-[#05080f] border border-white/10 rounded-lg"
          >
            <button
              type="button"
              onClick={() => onFocusTargetModeChange('sector')}
              className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                focusTargetMode === 'sector'
                  ? 'bg-cyan-500 text-slate-950'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Sector activo
            </button>
            <button
              type="button"
              disabled={!canUseGlobeCenter}
              onClick={() => onFocusTargetModeChange('globe')}
              className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap disabled:opacity-40 ${
                focusTargetMode === 'globe'
                  ? 'bg-cyan-500 text-slate-950'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Centro globo
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <div
              role="group"
              aria-label="Radio de análisis operativo"
              className="flex items-center p-0.5 bg-[#05080f] border border-white/10 rounded-lg"
            >
              {([150, 500, 1500] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  data-testid={`briefing-radius-${r}`}
                  onClick={() => onRadiusChange(r)}
                  className={`px-1.5 py-1 text-[11px] font-mono-tabular font-medium rounded-md transition-colors whitespace-nowrap ${
                    radiusKm === r
                      ? 'bg-white/14 text-cyan-300'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {r} km
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleCopyBriefing}
              aria-label="Copiar resumen operativo al portapapeles"
              title="Copiar informe operativo"
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-slate-200 rounded-lg transition-colors whitespace-nowrap"
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  <span className="text-emerald-300">Copiado</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3 text-slate-400" />
                  <span>Copiar</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3.5 text-xs">
        {/* Executive Summary + Factors */}
        <section aria-label="Resumen y factores clave" className="space-y-1.5">
          <p className="text-slate-100 leading-relaxed font-medium">{report.summaryLine}</p>
          <ul className="space-y-1 text-[11px] text-slate-300">
            {report.factors.map((factor, idx) => (
              <li key={idx} className="flex items-start gap-1.5">
                <span className="text-cyan-400 mt-0.5 shrink-0">·</span>
                <span>{factor}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Atmospheric 2x2 Grid */}
        <section aria-label="Condiciones atmosféricas" className="space-y-1.5">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Condiciones Atmosféricas
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-[#05080f] border border-white/[0.07] rounded-lg px-2.5 py-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <Wind className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <span>Viento</span>
              </span>
              <span className="font-mono-tabular text-xs font-semibold text-white">
                {report.atmosphere.windKmh} km/h
              </span>
            </div>

            <div className="bg-[#05080f] border border-white/[0.07] rounded-lg px-2.5 py-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <Activity className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span>Presión</span>
              </span>
              <span className="font-mono-tabular text-xs font-semibold text-white">
                {report.atmosphere.pressureHpa} hPa
              </span>
            </div>

            <div className="bg-[#05080f] border border-white/[0.07] rounded-lg px-2.5 py-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <CloudRain className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Lluvia</span>
              </span>
              <span className="font-mono-tabular text-xs font-semibold text-white">
                {report.atmosphere.precipMmH} mm/h
              </span>
            </div>

            <div className="bg-[#05080f] border border-white/[0.07] rounded-lg px-2.5 py-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <Sun className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>Solar</span>
              </span>
              <span className="font-mono-tabular text-xs font-semibold text-white">
                {report.atmosphere.solarPhaseLabel}
              </span>
            </div>
          </div>
        </section>

        {/* Seismicity 24h & Terrain */}
        <section aria-label="Sismicidad 24h y perfil de terreno" className="grid grid-cols-2 gap-2">
          <div className="bg-[#05080f] border border-white/[0.07] rounded-lg p-2.5 space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              <Flame className="w-3 h-3 text-orange-400 shrink-0" />
              <span>Sismicidad 24h</span>
            </div>
            <div className="font-mono-tabular text-sm font-semibold text-white">
              {report.seismic24h.countInZone} eventos
            </div>
            <div className="font-mono-tabular text-[11px] text-slate-400 truncate">
              {report.seismic24h.maxMagnitude !== null
                ? `Máx M${report.seismic24h.maxMagnitude.toFixed(1)} · ${report.seismic24h.nearestKm ?? 0} km`
                : 'Sin sismos en radio'}
            </div>
          </div>

          <div className="bg-[#05080f] border border-white/[0.07] rounded-lg p-2.5 space-y-1">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              <Mountain className="w-3 h-3 text-cyan-400 shrink-0" />
              <span>Terreno 3D</span>
            </div>
            <div className="font-mono-tabular text-sm font-semibold text-white">
              {report.terrain.available
                ? `${report.terrain.minElevationM}–${report.terrain.maxElevationM} m`
                : 'Listo para carga'}
            </div>
            <div className="font-mono-tabular text-[11px] text-slate-400 truncate">
              {report.terrain.available
                ? `${report.terrain.buildingsCount.toLocaleString('es-ES')} edificios`
                : 'DEM + OSM al abrir'}
            </div>
          </div>
        </section>

        {/* Active Cyclones & 72h Cones */}
        {report.cyclones.length > 0 && (
          <section aria-label="Ciclones y cono de trayectoria 72h" className="space-y-1.5">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Ciclones y Cono 72h
            </h3>
            <div className="space-y-1.5">
              {report.cyclones.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onFlyTo(c.lat, c.lng, 16.5)}
                  className="w-full text-left bg-[#05080f] hover:bg-white/[0.05] border border-white/[0.07] rounded-lg px-2.5 py-2 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-white truncate">{c.title}</span>
                    {c.coneInterceptsZone && (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/15 text-amber-300 rounded shrink-0">
                        Cono en zona
                      </span>
                    )}
                  </div>
                  <div className="font-mono-tabular text-[11px] text-slate-400 mt-0.5">
                    Cat {c.cycloneCategory} · {c.centralPressureHpa} hPa · {c.maxWindKmh} km/h · a{' '}
                    {c.distanceKm} km
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Nearby Signals */}
        <section aria-label="Señales cercanas en zona" className="space-y-1.5">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Señales Cercanas ({report.counts.totalEventsInZone})
            </h3>
            <span className="font-mono-tabular text-[10px] text-slate-500">
              {report.counts.disasters} desastres · {report.counts.conflicts} conflictos
            </span>
          </div>

          {report.nearbyEvents.length === 0 ? (
            <div className="bg-[#05080f] border border-white/[0.06] rounded-lg px-3 py-2.5 text-[11px] text-slate-400">
              Sin incidentes registrados dentro de {report.radiusKm} km.
            </div>
          ) : (
            <div className="space-y-1.5">
              {report.nearbyEvents.map((ev) => {
                const sev = getSeverityBadgeText(ev.severity);
                return (
                  <div
                    key={ev.id}
                    className="bg-[#05080f] border border-white/[0.07] rounded-lg px-2.5 py-2 flex items-center justify-between gap-2"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onFlyTo(ev.lat, ev.lng, 16.5);
                        onSelectEventId?.(ev.id);
                      }}
                      className="min-w-0 flex-1 text-left hover:text-cyan-300 transition-colors"
                    >
                      <div className="text-xs font-medium text-white truncate">{ev.title}</div>
                      <div className="flex items-center gap-1.5 text-[10px] font-mono-tabular text-slate-400 mt-0.5">
                        <span className={sev.cls}>{sev.label}</span>
                        <span>·</span>
                        <span>{ev.distanceKm} km</span>
                        <span>·</span>
                        <span className="truncate">{ev.region}</span>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => onOpenTerrain3D(ev.lat, ev.lng, ev.title, ev.region)}
                      aria-label={`Abrir Terreno 3D en ${ev.title}`}
                      title="Abrir en Terreno 3D"
                      className="px-2 py-1 text-[10px] font-medium bg-white/[0.06] hover:bg-cyan-500 hover:text-slate-950 text-cyan-300 rounded transition-colors shrink-0"
                    >
                      3D
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Footer CTAs */}
      <div className="px-4 py-2.5 border-t border-white/[0.08] bg-[#06090f] grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onFlyTo(report.lat, report.lng, 16.0)}
          className="flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium bg-white/[0.07] hover:bg-white/[0.13] text-white rounded-lg transition-colors"
        >
          <Globe2 className="w-3.5 h-3.5 text-cyan-400" />
          <span>Enfocar Globo</span>
        </button>

        <button
          type="button"
          onClick={() =>
            onOpenTerrain3D(
              report.lat,
              report.lng,
              report.zoneLabel,
              `${report.threatLevel} · ${report.radiusKm} km`
            )
          }
          className="flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-lg transition-colors"
        >
          <Compass className="w-3.5 h-3.5" />
          <span>Abrir Terreno 3D</span>
        </button>
      </div>
    </aside>
  );
}
