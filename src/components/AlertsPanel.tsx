import { useEffect, useState } from 'react';
import {
  Activity,
  Bell,
  BellRing,
  CheckCheck,
  CloudLightning,
  Compass,
  Crosshair,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { resolveAlertReferencePoint } from '../shared/alertRules.ts';
import type {
  AlertEvaluationPreview,
  AlertRuleConfig,
  ClientAlertNotification,
  SectorPreset,
} from '../shared/types.ts';

interface AlertsPanelProps {
  rules: AlertRuleConfig;
  activeSector: SectorPreset;
  preview: AlertEvaluationPreview;
  notifications: ClientAlertNotification[];
  unreadCount: number;
  onUpdateRules: (updater: (prev: AlertRuleConfig) => AlertRuleConfig) => void;
  onForceReevaluate: () => void;
  onFocusAlert: (alert: ClientAlertNotification) => void;
  onOpenTerrainAtAlert: (alert: ClientAlertNotification) => void;
  onMarkAllRead: () => void;
  onDismissAlert: (id: string) => void;
  onClearAlerts: () => void;
}

export function AlertsPanel({
  rules,
  activeSector,
  preview,
  notifications,
  unreadCount,
  onUpdateRules,
  onForceReevaluate,
  onFocusAlert,
  onOpenTerrainAtAlert,
  onMarkAllRead,
  onDismissAlert,
  onClearAlerts,
}: AlertsPanelProps) {
  const [geoStatus, setGeoStatus] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualLat, setManualLat] = useState<string>(String(rules.referencePoint.lat));
  const [manualLng, setManualLng] = useState<string>(String(rules.referencePoint.lng));
  const [manualLabel, setManualLabel] = useState<string>(rules.referencePoint.label);

  useEffect(() => {
    setManualLat(String(rules.referencePoint.lat));
    setManualLng(String(rules.referencePoint.lng));
    setManualLabel(rules.referencePoint.label);
    setManualError(null);
  }, [rules.referencePoint.lat, rules.referencePoint.lng, rules.referencePoint.label]);

  const effectiveRef = resolveAlertReferencePoint(rules, activeSector);
  const notificationSupported = typeof window !== 'undefined' && 'Notification' in window;
  const permissionState = notificationSupported ? window.Notification.permission : 'denied';

  const handleRequestBrowserPermission = async () => {
    if (!notificationSupported) return;
    if (rules.browserNotificationsEnabled) {
      onUpdateRules((prev) => ({ ...prev, browserNotificationsEnabled: false }));
      return;
    }
    try {
      const perm =
        window.Notification.permission === 'granted'
          ? 'granted'
          : await window.Notification.requestPermission();
      onUpdateRules((prev) => ({
        ...prev,
        browserNotificationsEnabled: perm === 'granted',
      }));
    } catch {
      onUpdateRules((prev) => ({ ...prev, browserNotificationsEnabled: false }));
    }
  };

  const handleUseGeolocation = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoStatus('Geolocalización no disponible; usa Sector activo o Manual.');
      return;
    }
    setGeoStatus('Obteniendo ubicación...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(4));
        const lng = Number(pos.coords.longitude.toFixed(4));
        setGeoStatus(null);
        setManualLat(String(lat));
        setManualLng(String(lng));
        setManualLabel('Mi ubicación');
        onUpdateRules((prev) => ({
          ...prev,
          referencePoint: {
            lat,
            lng,
            label: 'Mi ubicación',
            mode: 'geolocation',
          },
        }));
      },
      () => {
        setGeoStatus('Permiso de ubicación denegado; ajusta las coordenadas manualmente.');
      },
      { timeout: 6000 }
    );
  };

  const handleApplyManualCoords = () => {
    const parsedLat = Number(manualLat);
    const parsedLng = Number(manualLng);
    if (
      manualLat.trim() === '' ||
      manualLng.trim() === '' ||
      !Number.isFinite(parsedLat) ||
      !Number.isFinite(parsedLng) ||
      parsedLat < -85 ||
      parsedLat > 85 ||
      parsedLng < -180 ||
      parsedLng > 180
    ) {
      setManualError('Coordenadas inválidas (Lat -85..85, Lng -180..180).');
      return;
    }
    setManualError(null);
    const cleanLat = Number(parsedLat.toFixed(4));
    const cleanLng = Number(parsedLng.toFixed(4));
    const cleanLabel = manualLabel.trim() || `${cleanLat.toFixed(2)}, ${cleanLng.toFixed(2)}`;
    onUpdateRules((prev) => ({
      ...prev,
      referencePoint: {
        lat: cleanLat,
        lng: cleanLng,
        label: cleanLabel,
        mode: 'custom',
      },
    }));
  };

  return (
    <div className="flex-1 overflow-y-auto divide-y divide-white/10" data-testid="alerts-panel">
      {/* Live Evaluation Summary + Force Re-evaluate */}
      <div className="px-4 py-3 bg-[#060a12] space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-white">Coincidencias en telemetría</div>
          <button
            type="button"
            data-testid="alerts-reevaluate-btn"
            onClick={onForceReevaluate}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Evaluar ahora</span>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-300 font-mono-tabular">
          <span>{preview.matchingSeismicCount} sismos</span>
          <span aria-hidden="true" className="text-slate-500">·</span>
          <span>{preview.matchingMeteoCount} eventos meteo</span>
          {preview.strongestSeismicMag !== null && (
            <>
              <span aria-hidden="true" className="text-slate-500">·</span>
              <span className="text-orange-300">Máx M{preview.strongestSeismicMag.toFixed(1)}</span>
            </>
          )}
          {preview.nearestMeteoKm !== null && (
            <>
              <span aria-hidden="true" className="text-slate-500">·</span>
              <span className="text-cyan-300">Más cercano {preview.nearestMeteoKm} km</span>
            </>
          )}
        </div>
      </div>

      {/* Seismic Threshold Rule */}
      <section aria-label="Configuración de umbral sísmico" className="px-4 py-3.5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="toggle-seismic-alert"
            className="flex items-center gap-2 text-xs font-semibold text-white cursor-pointer"
          >
            <Activity className="w-4 h-4 text-orange-400 shrink-0" />
            <span>Umbral de sismos</span>
          </label>
          <input
            id="toggle-seismic-alert"
            type="checkbox"
            checked={rules.seismicEnabled}
            onChange={(e) =>
              onUpdateRules((prev) => ({ ...prev, seismicEnabled: e.target.checked }))
            }
            className="w-4 h-4 accent-cyan-500 rounded cursor-pointer"
          />
        </div>

        <div className={`space-y-2.5 ${rules.seismicEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <label htmlFor="seismic-mag-slider" className="text-slate-300">
              Magnitud mínima
            </label>
            <span
              data-testid="seismic-threshold-value"
              className="font-mono-tabular font-semibold text-orange-300"
            >
              M{rules.seismicMinMagnitude.toFixed(1)}+
            </span>
          </div>

          <input
            id="seismic-mag-slider"
            data-testid="seismic-mag-slider"
            type="range"
            min="2.5"
            max="8.0"
            step="0.1"
            value={rules.seismicMinMagnitude}
            onChange={(e) =>
              onUpdateRules((prev) => ({
                ...prev,
                seismicMinMagnitude: Number(Number(e.target.value).toFixed(1)),
              }))
            }
            className="w-full accent-orange-400 cursor-pointer"
          />

          <div className="flex items-center gap-1.5">
            {[3.5, 4.5, 5.0, 6.0].map((mag) => {
              const active = Math.abs(rules.seismicMinMagnitude - mag) < 0.05;
              return (
                <button
                  key={mag}
                  type="button"
                  onClick={() =>
                    onUpdateRules((prev) => ({ ...prev, seismicMinMagnitude: mag }))
                  }
                  className={`flex-1 py-1 text-[11px] font-mono-tabular font-medium rounded-md transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-orange-500 text-slate-950'
                      : 'bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  M{mag.toFixed(1)}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <label
              htmlFor="toggle-seismic-radius"
              className="text-[11px] text-slate-300 cursor-pointer"
            >
              Filtrar por distancia al punto de referencia
            </label>
            <input
              id="toggle-seismic-radius"
              type="checkbox"
              checked={rules.seismicUseRadius}
              onChange={(e) =>
                onUpdateRules((prev) => ({ ...prev, seismicUseRadius: e.target.checked }))
              }
              className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer"
            />
          </div>

          {rules.seismicUseRadius && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-400">Radio sísmico</span>
                <span className="font-mono-tabular text-cyan-300">
                  {rules.seismicRadiusKm.toLocaleString('es-ES')} km
                </span>
              </div>
              <input
                type="range"
                aria-label="Radio máximo de sismos en kilómetros"
                min="100"
                max="5000"
                step="100"
                value={rules.seismicRadiusKm}
                onChange={(e) =>
                  onUpdateRules((prev) => ({
                    ...prev,
                    seismicRadiusKm: Number(e.target.value),
                  }))
                }
                className="w-full accent-cyan-400 cursor-pointer"
              />
            </div>
          )}
        </div>
      </section>

      {/* Critical Meteorological Proximity Rule */}
      <section
        aria-label="Configuración de proximidad meteorológica crítica"
        className="px-4 py-3.5 space-y-3"
      >
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="toggle-meteo-alert"
            className="flex items-center gap-2 text-xs font-semibold text-white cursor-pointer"
          >
            <CloudLightning className="w-4 h-4 text-cyan-400 shrink-0" />
            <span>Proximidad meteorológica</span>
          </label>
          <input
            id="toggle-meteo-alert"
            type="checkbox"
            checked={rules.meteorologicalEnabled}
            onChange={(e) =>
              onUpdateRules((prev) => ({ ...prev, meteorologicalEnabled: e.target.checked }))
            }
            className="w-4 h-4 accent-cyan-500 rounded cursor-pointer"
          />
        </div>

        <div
          className={`space-y-2.5 ${rules.meteorologicalEnabled ? '' : 'opacity-50 pointer-events-none'}`}
        >
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <label htmlFor="meteo-radius-slider" className="text-slate-300">
              Radio de proximidad
            </label>
            <span
              data-testid="meteo-radius-value"
              className="font-mono-tabular font-semibold text-cyan-300"
            >
              {rules.meteorologicalRadiusKm.toLocaleString('es-ES')} km
            </span>
          </div>

          <input
            id="meteo-radius-slider"
            data-testid="meteo-radius-slider"
            type="range"
            min="100"
            max="5000"
            step="50"
            value={rules.meteorologicalRadiusKm}
            onChange={(e) =>
              onUpdateRules((prev) => ({
                ...prev,
                meteorologicalRadiusKm: Number(e.target.value),
              }))
            }
            className="w-full accent-cyan-400 cursor-pointer"
          />

          <div className="flex items-center gap-1.5">
            {[500, 1200, 2500, 5000].map((km) => {
              const active = rules.meteorologicalRadiusKm === km;
              return (
                <button
                  key={km}
                  type="button"
                  onClick={() =>
                    onUpdateRules((prev) => ({ ...prev, meteorologicalRadiusKm: km }))
                  }
                  className={`flex-1 py-1 text-[11px] font-mono-tabular font-medium rounded-md transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-cyan-500 text-slate-950'
                      : 'bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  {km} km
                </button>
              );
            })}
          </div>

          {/* Severity filter */}
          <div className="grid grid-cols-2 gap-1 p-0.5 bg-[#05080f] border border-white/10 rounded-lg">
            <button
              type="button"
              onClick={() =>
                onUpdateRules((prev) => ({ ...prev, meteorologicalMinSeverity: 'high' }))
              }
              className={`py-1 text-[11px] font-medium rounded-md transition-colors ${
                rules.meteorologicalMinSeverity === 'high'
                  ? 'bg-white/15 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Alto y Crítico
            </button>
            <button
              type="button"
              onClick={() =>
                onUpdateRules((prev) => ({ ...prev, meteorologicalMinSeverity: 'critical' }))
              }
              className={`py-1 text-[11px] font-medium rounded-md transition-colors ${
                rules.meteorologicalMinSeverity === 'critical'
                  ? 'bg-rose-500 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Solo Crítico
            </button>
          </div>
        </div>

        {/* Reference Coordinate Selector */}
        <div className="pt-1 space-y-2">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-slate-400">Punto de referencia</span>
            <span className="font-mono-tabular text-slate-200 truncate max-w-[190px]">
              {effectiveRef.label} · {effectiveRef.lat.toFixed(2)}, {effectiveRef.lng.toFixed(2)}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-1 p-0.5 bg-[#05080f] border border-white/10 rounded-lg">
            <button
              type="button"
              onClick={() =>
                onUpdateRules((prev) => ({
                  ...prev,
                  referencePoint: {
                    ...prev.referencePoint,
                    mode: 'active-sector',
                    lat: activeSector.lat,
                    lng: activeSector.lng,
                    label: activeSector.name,
                  },
                }))
              }
              className={`py-1 px-1.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                rules.referencePoint.mode === 'active-sector'
                  ? 'bg-cyan-500 text-slate-950'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Sector activo
            </button>
            <button
              type="button"
              onClick={handleUseGeolocation}
              className={`py-1 px-1.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                rules.referencePoint.mode === 'geolocation'
                  ? 'bg-cyan-500 text-slate-950'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Mi ubicación
            </button>
            <button
              type="button"
              onClick={() =>
                onUpdateRules((prev) => ({
                  ...prev,
                  referencePoint: { ...prev.referencePoint, mode: 'custom' },
                }))
              }
              className={`py-1 px-1.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                rules.referencePoint.mode === 'custom'
                  ? 'bg-cyan-500 text-slate-950'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Manual
            </button>
          </div>

          {geoStatus && <div className="text-[11px] text-amber-300">{geoStatus}</div>}

          {rules.referencePoint.mode === 'custom' && (
            <div className="space-y-1.5 pt-1">
              <div className="grid grid-cols-12 gap-1.5">
                <input
                  type="text"
                  value={manualLabel}
                  onChange={(e) => {
                    setManualLabel(e.target.value);
                    setManualError(null);
                  }}
                  placeholder="Nombre"
                  aria-label="Etiqueta de coordenada de referencia"
                  className="col-span-4 px-2 py-1 text-[11px] bg-[#06090f] border border-white/15 rounded text-white focus:outline-none focus:border-cyan-400"
                />
                <input
                  type="number"
                  step="0.01"
                  value={manualLat}
                  onChange={(e) => {
                    setManualLat(e.target.value);
                    setManualError(null);
                  }}
                  placeholder="Lat"
                  aria-label="Latitud de referencia"
                  className="col-span-3 px-2 py-1 text-[11px] font-mono-tabular bg-[#06090f] border border-white/15 rounded text-white focus:outline-none focus:border-cyan-400"
                />
                <input
                  type="number"
                  step="0.01"
                  value={manualLng}
                  onChange={(e) => {
                    setManualLng(e.target.value);
                    setManualError(null);
                  }}
                  placeholder="Lng"
                  aria-label="Longitud de referencia"
                  className="col-span-3 px-2 py-1 text-[11px] font-mono-tabular bg-[#06090f] border border-white/15 rounded text-white focus:outline-none focus:border-cyan-400"
                />
                <button
                  type="button"
                  onClick={handleApplyManualCoords}
                  className="col-span-2 py-1 text-[11px] font-semibold bg-white/10 hover:bg-cyan-500 hover:text-slate-950 text-white rounded transition-colors"
                >
                  Fijar
                </button>
              </div>
              {manualError && (
                <div role="alert" className="text-[11px] text-rose-400">
                  {manualError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Browser Web Notifications Toggle */}
        {notificationSupported && (
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/8">
            <div className="text-[11px] text-slate-300">
              <span>Notificaciones del navegador</span>
              {permissionState === 'denied' && (
                <span className="block text-[10px] text-slate-500">Bloqueadas por el navegador</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleRequestBrowserPermission()}
              disabled={permissionState === 'denied'}
              className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                rules.browserNotificationsEnabled && permissionState === 'granted'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/35'
                  : 'bg-white/5 text-slate-300 hover:bg-white/10 disabled:opacity-45'
              }`}
            >
              <BellRing className="w-3 h-3" />
              <span>
                {rules.browserNotificationsEnabled && permissionState === 'granted'
                  ? 'Activas'
                  : 'Activar'}
              </span>
            </button>
          </div>
        )}
      </section>

      {/* Triggered Notifications Inbox */}
      <section aria-label="Bandeja de alertas disparadas" className="divide-y divide-white/10">
        <div className="px-4 py-2.5 flex items-center justify-between gap-2 bg-[#060a12]">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
            <Bell className="w-3.5 h-3.5 text-cyan-400" />
            <span>Alertas disparadas</span>
            <span className="font-mono-tabular text-slate-400">
              ({notifications.length}
              {unreadCount > 0 ? ` · ${unreadCount} nuevas` : ''})
            </span>
          </div>
          {notifications.length > 0 && (
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={onMarkAllRead}
                  title="Marcar todas como leídas"
                  aria-label="Marcar todas las alertas como leídas"
                  className="p-1 rounded text-slate-400 hover:text-cyan-300 hover:bg-white/5 transition-colors"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={onClearAlerts}
                title="Limpiar historial de alertas"
                aria-label="Limpiar historial de alertas"
                className="p-1 rounded text-slate-400 hover:text-rose-300 hover:bg-white/5 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {notifications.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-slate-400 space-y-1">
            <p>Ninguna alerta activa supera tus umbrales en este ciclo.</p>
            <p className="text-[11px] text-slate-500">
              Ajusta la magnitud mínima o el radio y presiona Evaluar ahora.
            </p>
          </div>
        ) : (
          notifications.map((al) => {
            const isSeismic = al.ruleType === 'seismic';
            const Icon = isSeismic ? Activity : CloudLightning;
            const iconColor =
              al.severity === 'critical'
                ? 'text-rose-400'
                : isSeismic
                  ? 'text-orange-400'
                  : 'text-cyan-400';

            return (
              <div
                key={al.id}
                data-testid="alert-inbox-item"
                className={`px-4 py-3 space-y-2 transition-colors ${
                  al.read ? 'bg-transparent' : 'bg-cyan-950/20'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${iconColor}`} />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white leading-snug">
                        {al.title}
                      </div>
                      <div className="text-[11px] text-slate-300 mt-0.5 leading-snug">
                        {al.message}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono-tabular mt-1">
                        {al.source} · {al.lat.toFixed(2)}, {al.lng.toFixed(2)} ·{' '}
                        {new Date(al.occurredAt).toLocaleTimeString('es-ES', {
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        })}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDismissAlert(al.id)}
                    aria-label={`Descartar alerta ${al.title}`}
                    className="p-1 text-slate-500 hover:text-white rounded transition-colors shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-2 pl-6">
                  <button
                    type="button"
                    onClick={() => onFocusAlert(al)}
                    className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md transition-colors whitespace-nowrap"
                  >
                    <Crosshair className="w-3 h-3" />
                    <span>Enfocar en globo</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenTerrainAtAlert(al)}
                    className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-white/8 hover:bg-white/15 text-slate-200 rounded-md transition-colors whitespace-nowrap"
                  >
                    <Compass className="w-3 h-3 text-cyan-400" />
                    <span>Terreno 3D</span>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
