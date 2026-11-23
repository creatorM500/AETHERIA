import { Crosshair, ExternalLink, Flame, Mountain, Waves, X } from 'lucide-react';
import type { SeismicQuake24h, ViewportMode } from '../shared/types.ts';

interface SeismicEventCardProps {
  quake: SeismicQuake24h;
  viewportMode: ViewportMode;
  hasActiveRoute?: boolean;
  onJumpToTerrain3D: (quake: SeismicQuake24h) => void;
  onFocusGlobe: (quake: SeismicQuake24h) => void;
  onClose: () => void;
}

function formatRelativeSpanish(occurredAtMs: number): string {
  const diffMin = Math.max(0, Math.round((Date.now() - occurredAtMs) / 60_000));
  if (diffMin < 1) return 'hace instantes';
  if (diffMin < 60) return `hace ${diffMin} min`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return mins > 0 ? `hace ${hours} h ${mins} min` : `hace ${hours} h`;
}

export function SeismicEventCard({
  quake,
  viewportMode,
  hasActiveRoute = false,
  onJumpToTerrain3D,
  onFocusGlobe,
  onClose,
}: SeismicEventCardProps) {
  const magColor =
    quake.magnitude >= 6.0
      ? 'text-rose-400 border-rose-500/40 bg-rose-500/15'
      : quake.magnitude >= 4.5
        ? 'text-orange-300 border-orange-500/40 bg-orange-500/15'
        : quake.magnitude >= 3.0
          ? 'text-amber-300 border-amber-500/35 bg-amber-500/12'
          : 'text-cyan-300 border-cyan-500/35 bg-cyan-500/12';

  const formattedDate = new Date(quake.occurredAtMs).toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  const topOffsetClass =
    hasActiveRoute && viewportMode === 'globe' ? 'sm:top-[156px]' : 'sm:top-[52px]';

  return (
    <aside
      aria-label="Ficha del sismo de las últimas 24 horas"
      data-testid="seismic-event-card"
      className={`fixed bottom-[76px] left-3 right-3 sm:bottom-auto ${topOffsetClass} sm:left-auto sm:right-[60px] sm:w-[304px] z-20 bg-[#080d16]/94 border border-white/[0.08] rounded-lg p-3 shadow-2xl space-y-2.5`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`px-2 py-0.5 rounded border font-mono-tabular text-xs font-bold shrink-0 ${magColor}`}
          >
            M {quake.magnitude.toFixed(1)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-[10px] text-orange-300 font-medium">
              <Flame className="w-3 h-3 shrink-0" />
              <span>Sismo 24h · USGS</span>
            </div>
            <div className="text-[10px] text-slate-400 font-mono-tabular truncate">
              {formattedDate} · {formatRelativeSpanish(quake.occurredAtMs)}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar ficha del sismo"
          className="p-0.5 text-slate-400 hover:text-white rounded transition-colors shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="space-y-1">
        <h3 className="text-xs font-semibold text-white leading-snug">{quake.place}</h3>
        {quake.tsunami && (
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-300 bg-amber-500/12 border border-amber-400/25 rounded px-2 py-0.5">
            <Waves className="w-3 h-3 shrink-0" />
            <span>Aviso de vigilancia de tsunami</span>
          </div>
        )}
      </div>

      <dl className="grid grid-cols-[1fr_0.85fr_1.25fr] gap-2 pt-2 border-t border-white/[0.07] text-[10px]">
        <div>
          <dt className="text-slate-400">Profundidad</dt>
          <dd className="font-mono-tabular text-slate-100 font-medium text-[11px]">
            {quake.depthKm.toFixed(1)} km
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Relevancia</dt>
          <dd className="font-mono-tabular text-slate-100 font-medium text-[11px]">
            {quake.significance}
          </dd>
        </div>
        <div>
          <dt className="text-slate-400">Epicentro</dt>
          <dd className="font-mono-tabular text-cyan-300 text-[11px] whitespace-nowrap">
            {quake.lat.toFixed(2)}°, {quake.lng.toFixed(2)}°
          </dd>
        </div>
      </dl>

      <div className="flex items-center gap-1.5 pt-0.5">
        <button
          type="button"
          data-testid="seismic-jump-terrain-btn"
          onClick={() => onJumpToTerrain3D(quake)}
          className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md transition-colors whitespace-nowrap"
        >
          <Mountain className="w-3.5 h-3.5 shrink-0" />
          <span>Saltar a Terreno 3D</span>
        </button>

        <button
          type="button"
          onClick={() => onFocusGlobe(quake)}
          title={viewportMode === 'globe' ? 'Centrar en Globo 3D' : 'Volver y enfocar en Globo 3D'}
          className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium bg-white/8 hover:bg-white/15 text-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          <Crosshair className="w-3 h-3" />
          <span>Enfocar</span>
        </button>

        {quake.sourceUrl && (
          <a
            href={quake.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Abrir informe oficial USGS"
            aria-label="Abrir informe oficial USGS en nueva pestaña"
            className="p-1.5 text-slate-300 hover:text-cyan-300 bg-white/8 hover:bg-white/15 rounded-md transition-colors shrink-0"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
    </aside>
  );
}
