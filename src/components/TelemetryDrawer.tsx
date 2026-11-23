import { useEffect, useState } from 'react';
import {
  AlertOctagon,
  Bell,
  Compass,
  Database,
  Flame,
  Navigation,
  Plane,
  Radio,
  Search,
  Ship,
  X,
} from 'lucide-react';
import type {
  AlertEvaluationPreview,
  AlertRuleConfig,
  ClientAlertNotification,
  DisasterHistoryRecord,
  EventCategory,
  GlobalEvent,
  SectorPreset,
  WorldFeedSummary,
} from '../shared/types.ts';
import { AlertsPanel } from './AlertsPanel.tsx';
import { DisasterHistoryView } from './DisasterHistoryView.tsx';

export type TelemetryDrawerTab = 'live' | 'history' | 'alerts';

interface TelemetryDrawerProps {
  events: GlobalEvent[];
  summary: WorldFeedSummary | null;
  activeCategory: EventCategory | 'all';
  selectedEvent: GlobalEvent | null;
  initialTab?: TelemetryDrawerTab;
  onTabChange?: (tab: TelemetryDrawerTab) => void;
  alertRules: AlertRuleConfig;
  activeSector: SectorPreset;
  alertPreview: AlertEvaluationPreview;
  alertNotifications: ClientAlertNotification[];
  unreadAlertCount: number;
  onUpdateAlertRules: (updater: (prev: AlertRuleConfig) => AlertRuleConfig) => void;
  onForceReevaluateAlerts: () => void;
  onFocusAlert: (alert: ClientAlertNotification) => void;
  onOpenTerrainAtAlert: (alert: ClientAlertNotification) => void;
  onMarkAllAlertsRead: () => void;
  onDismissAlert: (id: string) => void;
  onClearAlerts: () => void;
  onSelectEvent: (event: GlobalEvent) => void;
  onNavigateToEvent: (event: GlobalEvent) => void;
  onOpenSectorAtEvent: (event: GlobalEvent) => void;
  onLocateHistoryRecord: (record: DisasterHistoryRecord) => void;
  onOpenSectorAtHistoryRecord: (record: DisasterHistoryRecord) => void;
  onClose: () => void;
}

function getCategoryIcon(cat: EventCategory) {
  switch (cat) {
    case 'disaster':
      return Flame;
    case 'flight':
      return Plane;
    case 'ship':
      return Ship;
    case 'conflict':
      return AlertOctagon;
  }
}

function getCategoryAccent(cat: EventCategory): string {
  switch (cat) {
    case 'disaster':
      return 'text-amber-400';
    case 'flight':
      return 'text-sky-400';
    case 'ship':
      return 'text-emerald-400';
    case 'conflict':
      return 'text-rose-400';
  }
}

function getSeverityLabel(sev: GlobalEvent['severity']): string {
  switch (sev) {
    case 'critical':
      return 'Crítico';
    case 'high':
      return 'Alto';
    case 'moderate':
      return 'Moderado';
    case 'low':
      return 'Normal';
  }
}

export function TelemetryDrawer({
  events,
  summary,
  activeCategory,
  selectedEvent,
  initialTab = 'live',
  onTabChange,
  alertRules,
  activeSector,
  alertPreview,
  alertNotifications,
  unreadAlertCount,
  onUpdateAlertRules,
  onForceReevaluateAlerts,
  onFocusAlert,
  onOpenTerrainAtAlert,
  onMarkAllAlertsRead,
  onDismissAlert,
  onClearAlerts,
  onSelectEvent,
  onNavigateToEvent,
  onOpenSectorAtEvent,
  onLocateHistoryRecord,
  onOpenSectorAtHistoryRecord,
  onClose,
}: TelemetryDrawerProps) {
  const [search, setSearch] = useState('');
  const [viewTab, setViewTab] = useState<TelemetryDrawerTab>(initialTab);

  useEffect(() => {
    setViewTab(initialTab);
  }, [initialTab]);

  const selectTab = (next: TelemetryDrawerTab) => {
    setViewTab(next);
    onTabChange?.(next);
  };

  const filtered = events.filter((ev) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      ev.title.toLowerCase().includes(q) ||
      ev.region.toLowerCase().includes(q) ||
      ev.summary.toLowerCase().includes(q)
    );
  });

  return (
    <aside
      aria-label="Monitor de Eventos Globales en Tiempo Real"
      className={`fixed top-[52px] right-3 left-3 sm:left-auto ${
        viewTab === 'history' || viewTab === 'alerts' ? 'sm:w-[420px]' : 'sm:w-[376px]'
      } max-h-[calc(100dvh-76px)] sm:max-h-[calc(100vh-110px)] z-20 flex flex-col bg-[#080d16]/94 border border-white/[0.08] rounded-xl shadow-2xl overflow-hidden transition-[width]`}
    >
      <div className="px-4 py-3 border-b border-white/8 space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-display text-sm font-semibold tracking-wide text-white">
              {viewTab === 'history'
                ? 'Historial de Desastres'
                : viewTab === 'alerts'
                  ? 'Alertas y Umbrales'
                  : 'Telemetría en Vivo'}
            </h2>
            {summary && viewTab === 'live' && (
              <div className="text-[11px] text-slate-400 font-mono-tabular truncate">
                {filtered.length} visibles · {summary.total} activos ·{' '}
                {activeCategory === 'all'
                  ? 'Todas'
                  : activeCategory === 'disaster'
                    ? 'Desastres'
                    : activeCategory === 'flight'
                      ? 'Vuelos'
                      : activeCategory === 'ship'
                        ? 'Barcos'
                        : 'Conflictos'}{' '}
                · {new Date(summary.updatedAt).toLocaleTimeString('es-ES', { hour12: false })}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar monitor de telemetría"
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher: Live vs Saved Disaster Category History vs Alert Rules */}
        <div className="grid grid-cols-3 gap-1 p-0.5 bg-[#05080f] border border-white/10 rounded-lg">
          <button
            type="button"
            onClick={() => selectTab('live')}
            className={`flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              viewTab === 'live'
                ? 'bg-cyan-500 text-slate-950'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Radio className="w-3.5 h-3.5 shrink-0" />
            <span>En Vivo</span>
          </button>
          <button
            type="button"
            onClick={() => selectTab('history')}
            className={`flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              viewTab === 'history'
                ? 'bg-cyan-500 text-slate-950'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Database className="w-3.5 h-3.5 shrink-0" />
            <span>Historial</span>
          </button>
          <button
            type="button"
            data-testid="telemetry-tab-alerts"
            onClick={() => selectTab('alerts')}
            className={`flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              viewTab === 'alerts'
                ? 'bg-cyan-500 text-slate-950'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Bell className="w-3.5 h-3.5 shrink-0" />
            <span>Alertas</span>
            {unreadAlertCount > 0 && (
              <span
                className={`font-mono-tabular text-[10px] ${
                  viewTab === 'alerts' ? 'text-slate-900' : 'text-cyan-300'
                }`}
              >
                {unreadAlertCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {viewTab === 'history' ? (
        <DisasterHistoryView
          onLocateOnGlobe={onLocateHistoryRecord}
          onOpenSectorHere={onOpenSectorAtHistoryRecord}
        />
      ) : viewTab === 'alerts' ? (
        <AlertsPanel
          rules={alertRules}
          activeSector={activeSector}
          preview={alertPreview}
          notifications={alertNotifications}
          unreadCount={unreadAlertCount}
          onUpdateRules={onUpdateAlertRules}
          onForceReevaluate={onForceReevaluateAlerts}
          onFocusAlert={onFocusAlert}
          onOpenTerrainAtAlert={onOpenTerrainAtAlert}
          onMarkAllRead={onMarkAllAlertsRead}
          onDismissAlert={onDismissAlert}
          onClearAlerts={onClearAlerts}
        />
      ) : (
        <>

      {/* Search */}
      <div className="p-3 border-b border-white/10">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar sismo, vuelo, buque, región..."
            aria-label="Filtrar eventos globales por texto"
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-[#06090f] border border-white/15 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
          />
        </div>
      </div>

      {/* Selected Event Highlight */}
      {selectedEvent && (
        <div className="p-3.5 bg-cyan-950/30 border-b border-cyan-500/25 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[11px] text-cyan-300 font-medium">
                {selectedEvent.source} · {getSeverityLabel(selectedEvent.severity)}
              </div>
              <h3 className="text-sm font-semibold text-white leading-snug">
                {selectedEvent.title}
              </h3>
            </div>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">{selectedEvent.summary}</p>
          <div className="text-[11px] font-mono-tabular text-slate-400">
            Lat {selectedEvent.lat.toFixed(3)} · Lng {selectedEvent.lng.toFixed(3)}
            {selectedEvent.speedKts ? ` · ${selectedEvent.speedKts} kts` : ''}
            {selectedEvent.headingDeg !== undefined ? ` · Rumbo ${selectedEvent.headingDeg}°` : ''}
          </div>
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              onClick={() => onOpenSectorAtEvent(selectedEvent)}
              className="flex items-center justify-center gap-1.5 py-1.5 px-2 text-xs font-medium bg-white/10 hover:bg-white/15 text-white rounded-lg transition-colors"
            >
              <Compass className="w-3.5 h-3.5 text-cyan-400" />
              <span>Terreno 3D aquí</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigateToEvent(selectedEvent)}
              className="flex items-center justify-center gap-1.5 py-1.5 px-2 text-xs font-medium bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-lg transition-colors"
            >
              <Navigation className="w-3.5 h-3.5" />
              <span>Navegar aquí</span>
            </button>
          </div>
        </div>
      )}

      {/* Event List */}
      <div className="flex-1 overflow-y-auto divide-y divide-white/10">
        {filtered.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-400">
            No hay eventos que coincidan con el filtro actual.
          </div>
        ) : (
          filtered.map((ev) => {
            const Icon = getCategoryIcon(ev.category);
            const accent = getCategoryAccent(ev.category);
            const isActive = selectedEvent?.id === ev.id;
            return (
              <button
                key={ev.id}
                type="button"
                onClick={() => onSelectEvent(ev)}
                className={`w-full text-left px-4 py-3 transition-colors flex items-start gap-3 ${
                  isActive ? 'bg-cyan-500/15' : 'hover:bg-white/5'
                }`}
              >
                <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${accent}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white truncate">{ev.title}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5 truncate">
                    {ev.region} · {getSeverityLabel(ev.severity)} ·{' '}
                    <span className="font-mono-tabular">
                      {ev.lat.toFixed(2)}, {ev.lng.toFixed(2)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
        </>
      )}
    </aside>
  );
}
