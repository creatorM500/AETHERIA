import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CloudLightning,
  Compass,
  Database,
  Download,
  ExternalLink,
  Flame,
  Globe2,
  Mountain,
  RefreshCw,
  Search,
  Snowflake,
  Waves,
} from 'lucide-react';
import type {
  DisasterHistoryRecord,
  DisasterHistoryResponse,
  DisasterSubtype,
} from '../shared/types.ts';

interface DisasterHistoryViewProps {
  onLocateOnGlobe: (record: DisasterHistoryRecord) => void;
  onOpenSectorHere: (record: DisasterHistoryRecord) => void;
}

const SUBTYPE_META: Array<{
  id: DisasterSubtype | 'all';
  label: string;
  icon: typeof Activity;
  accent: string;
}> = [
  { id: 'all', label: 'Todos', icon: Database, accent: 'text-cyan-400' },
  { id: 'earthquake', label: 'Sismos', icon: Activity, accent: 'text-amber-400' },
  { id: 'storm', label: 'Ciclones', icon: CloudLightning, accent: 'text-sky-400' },
  { id: 'wildfire', label: 'Incendios', icon: Flame, accent: 'text-orange-400' },
  { id: 'flood', label: 'Inundaciones', icon: Waves, accent: 'text-teal-400' },
  { id: 'volcano', label: 'Volcanes', icon: Mountain, accent: 'text-rose-400' },
  { id: 'iceberg', label: 'Icebergs', icon: Snowflake, accent: 'text-indigo-300' },
];

function getSubtypeLabel(sub: DisasterSubtype): string {
  return SUBTYPE_META.find((m) => m.id === sub)?.label ?? sub;
}

function getSeverityText(sev: DisasterHistoryRecord['severity']): {
  label: string;
  cls: string;
} {
  switch (sev) {
    case 'critical':
      return { label: 'Crítico', cls: 'text-rose-300' };
    case 'high':
      return { label: 'Alto', cls: 'text-orange-300' };
    case 'moderate':
      return { label: 'Moderado', cls: 'text-amber-300' };
    default:
      return { label: 'Normal', cls: 'text-slate-400' };
  }
}

export function DisasterHistoryView({
  onLocateOnGlobe,
  onOpenSectorHere,
}: DisasterHistoryViewProps) {
  const [subtype, setSubtype] = useState<DisasterSubtype | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [data, setData] = useState<DisasterHistoryResponse | null>(null);
  const [selected, setSelected] = useState<DisasterHistoryRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadHistory = useCallback(
    async (sub: DisasterSubtype | 'all', st: 'all' | 'active' | 'archived', q: string) => {
      try {
        setError(null);
        const params = new URLSearchParams({
          subtype: sub,
          status: st,
          q: q.trim(),
          limit: '150',
        });
        const res = await fetch(`/api/disasters/history?${params.toString()}`);
        if (!res.ok) throw new Error('Error al consultar historial guardado');
        const json = (await res.json()) as DisasterHistoryResponse;
        setData(json);
        setSelected((prev) =>
          prev ? json.records.find((r) => r.id === prev.id) ?? json.records[0] ?? null : null
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error de red');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void loadHistory(subtype, statusFilter, debouncedSearch);
  }, [loadHistory, subtype, statusFilter, debouncedSearch]);

  const handleSyncArchives = async () => {
    try {
      setSyncing(true);
      setError(null);
      const res = await fetch('/api/disasters/history/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subtype, status: statusFilter, q: debouncedSearch }),
      });
      if (!res.ok) throw new Error('Error al sincronizar archivos históricos');
      const json = (await res.json()) as DisasterHistoryResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al sincronizar');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Quiet DB Summary + Sync / Export Actions */}
      <div className="px-4 py-2 border-b border-white/10 flex items-center justify-between gap-2">
        <div className="text-[11px] font-mono-tabular text-slate-400 truncate">
          {data ? (
            <>
              <span className="text-slate-200 font-medium">{data.totalSaved}</span> reg. ·{' '}
              <span className="text-emerald-300/90">{data.activeCount} act.</span> ·{' '}
              <span>{data.archivedCount} arch.</span>
            </>
          ) : (
            'Cargando historial...'
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void handleSyncArchives()}
            disabled={syncing}
            title="Sincronizar archivos USGS, GDACS y NASA EONET"
            className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-cyan-300 hover:bg-white/10 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
          >
            <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
            <span>{syncing ? 'Guardando...' : 'Sincronizar'}</span>
          </button>
          <a
            href={`/api/disasters/history/export?subtype=${subtype}`}
            download={`aetheria-desastres-${subtype}.json`}
            title="Descargar todos los registros guardados en JSON"
            className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-300 hover:text-white hover:bg-white/10 rounded-md transition-colors whitespace-nowrap"
          >
            <Download className="w-3 h-3" />
            <span>JSON</span>
          </a>
        </div>
      </div>

      {/* Category Tabs (Clean compact wrap without heavy borders) */}
      <div className="px-3 py-2 border-b border-white/10 flex flex-wrap items-center gap-1">
        {SUBTYPE_META.map((cat) => {
          const Icon = cat.icon;
          const active = subtype === cat.id;
          const count = data?.countsBySubtype?.[cat.id] ?? 0;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSubtype(cat.id)}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                active
                  ? 'bg-cyan-500/20 text-white'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-white/5'
              }`}
            >
              <Icon className={`w-3 h-3 ${active ? cat.accent : 'opacity-70'}`} />
              <span>{cat.label}</span>
              <span className="font-mono-tabular text-[10px] opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Single-Row Search + Status Filter */}
      <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar país, sismo, ciclón..."
            aria-label="Buscar en historial guardado de desastres"
            className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-[#06090f] border border-white/10 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'archived')}
          aria-label="Filtrar historial por estado"
          className="px-2.5 py-1.5 text-xs bg-[#06090f] border border-white/10 rounded-lg text-slate-200 focus:outline-none focus:border-cyan-400 shrink-0"
        >
          <option value="all">Todos</option>
          <option value="active">Activos</option>
          <option value="archived">Archivados</option>
        </select>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-rose-300 bg-rose-950/30 border-b border-rose-500/20">
          {error}
        </div>
      )}

      {/* Selected Saved Record Inspector (Zero-Pill Metadata + Pinned Header & Actions) */}
      {selected && (
        <div className="bg-cyan-950/20 border-b border-cyan-500/25 flex flex-col">
          <div className="px-4 pt-3 pb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <span className="text-cyan-300 font-medium">{getSubtypeLabel(selected.subtype)}</span>
                <span aria-hidden="true">·</span>
                <span className={selected.status === 'active' ? 'text-emerald-300' : 'text-slate-400'}>
                  {selected.status === 'active' ? 'Activo' : 'Archivado'}
                </span>
                <span aria-hidden="true">·</span>
                <span className={getSeverityText(selected.severity).cls}>
                  {getSeverityText(selected.severity).label}
                </span>
              </div>
              <h3 className="text-xs font-semibold text-white mt-0.5 leading-snug">
                {selected.title}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-[11px] text-slate-400 hover:text-white shrink-0"
            >
              Cerrar detalle
            </button>
          </div>

          <div className="px-4 space-y-2 max-h-[175px] overflow-y-auto">
            <p className="text-[11px] text-slate-300 leading-relaxed">{selected.summary}</p>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-mono-tabular py-2 border-y border-white/10">
              <div>
                <span className="text-slate-500">Coord:</span>{' '}
                <span className="text-slate-200">
                  {selected.lat.toFixed(3)}, {selected.lng.toFixed(3)}
                </span>
              </div>
              <div>
                <span className="text-slate-500">Fuente:</span>{' '}
                <span className="text-slate-200">{selected.source}</span>
              </div>
              {selected.magnitude !== undefined && (
                <div>
                  <span className="text-slate-500">Magnitud:</span>{' '}
                  <span className="text-amber-300">M{selected.magnitude}</span>
                </div>
              )}
              {selected.depthKm !== undefined && (
                <div>
                  <span className="text-slate-500">Profundidad:</span>{' '}
                  <span className="text-slate-200">{selected.depthKm} km</span>
                </div>
              )}
              {selected.speedKts !== undefined && (
                <div>
                  <span className="text-slate-500">Viento/Vel:</span>{' '}
                  <span className="text-sky-300">{selected.speedKts} kts</span>
                </div>
              )}
              {selected.radiusKm !== undefined && (
                <div>
                  <span className="text-slate-500">Radio:</span>{' '}
                  <span className="text-slate-200">{selected.radiusKm} km</span>
                </div>
              )}
              {selected.country && (
                <div>
                  <span className="text-slate-500">País:</span>{' '}
                  <span className="text-slate-200">{selected.country}</span>
                </div>
              )}
              <div>
                <span className="text-slate-500">Lecturas:</span>{' '}
                <span className="text-cyan-300">{selected.observationsCount}</span>
              </div>
              <div className="col-span-2">
                <span className="text-slate-500">Ocurrió:</span>{' '}
                <span className="text-slate-200">
                  {new Date(selected.occurredAt).toLocaleString('es-ES')}
                </span>
              </div>
              <div className="col-span-2">
                <span className="text-slate-500">Guardado:</span>{' '}
                <span className="text-slate-300">
                  {new Date(selected.firstSeenAt).toLocaleString('es-ES')} →{' '}
                  {new Date(selected.lastSeenAt).toLocaleString('es-ES')}
                </span>
              </div>
            </div>

            <details className="text-[10px]">
              <summary className="cursor-pointer text-cyan-300/90 hover:text-cyan-200 font-medium select-none py-1">
                Ver todos los datos técnicos guardados ({Object.keys(selected.rawData).length} campos)
              </summary>
              <pre className="mt-1 p-2 rounded-lg bg-[#06090f] border border-white/10 text-[10px] text-slate-300 font-mono-tabular whitespace-pre-wrap break-all overflow-x-auto">
                {JSON.stringify(selected.rawData, null, 2)}
              </pre>
            </details>
          </div>

          <div className="px-4 py-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onLocateOnGlobe(selected)}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 text-[11px] font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-lg transition-colors whitespace-nowrap"
            >
              <Globe2 className="w-3.5 h-3.5" />
              <span>Ver en Globo 3D</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenSectorHere(selected)}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 text-[11px] font-medium bg-white/10 hover:bg-white/15 text-white rounded-lg transition-colors whitespace-nowrap"
            >
              <Compass className="w-3.5 h-3.5 text-cyan-300" />
              <span>Terreno 3D</span>
            </button>
            {selected.sourceUrl && (
              <a
                href={selected.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Abrir reporte oficial"
                className="p-1.5 bg-white/10 hover:bg-white/15 text-slate-200 rounded-lg transition-colors shrink-0"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>
      )}

      {/* Historical Records List (Unboxed clean rows) */}
      <div className="flex-1 overflow-y-auto divide-y divide-white/8">
        {loading ? (
          <div className="p-6 text-center text-xs text-slate-400">
            Cargando historial persistente de desastres...
          </div>
        ) : !data || data.records.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-400">
            No hay registros guardados en esta categoría con los filtros actuales.
          </div>
        ) : (
          data.records.map((rec) => {
            const meta = SUBTYPE_META.find((m) => m.id === rec.subtype) ?? SUBTYPE_META[0];
            const Icon = meta.icon;
            const isSelected = selected?.id === rec.id;
            return (
              <button
                key={rec.id}
                type="button"
                onClick={() => setSelected(rec)}
                className={`w-full text-left px-4 py-2.5 transition-colors flex items-start gap-2.5 ${
                  isSelected ? 'bg-cyan-500/12' : 'hover:bg-white/5'
                }`}
              >
                <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${meta.accent}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-white truncate">{rec.title}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5 truncate font-mono-tabular">
                    {meta.label} ·{' '}
                    <span className={rec.status === 'active' ? 'text-emerald-300/90' : 'text-slate-400'}>
                      {rec.status === 'active' ? 'Activo' : 'Archivado'}
                    </span>{' '}
                    · {rec.region} · {new Date(rec.occurredAt).toLocaleDateString('es-ES')}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
