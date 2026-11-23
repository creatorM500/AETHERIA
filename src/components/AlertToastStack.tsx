import { Activity, Bell, CloudLightning, Crosshair, X } from 'lucide-react';
import type { ClientAlertNotification } from '../shared/types.ts';

interface AlertToastStackProps {
  toasts: ClientAlertNotification[];
  unreadCount: number;
  onFocusAlert: (alert: ClientAlertNotification) => void;
  onDismissToast: (id: string) => void;
  onDismissAllToasts: () => void;
  onOpenInbox: () => void;
  stacked?: boolean;
}

export function AlertToastStack({
  toasts,
  unreadCount,
  onFocusAlert,
  onDismissToast,
  onDismissAllToasts,
  onOpenInbox,
  stacked = false,
}: AlertToastStackProps) {
  if (toasts.length === 0) return null;

  const leadToast = toasts[0];
  const isSeismic = leadToast.ruleType === 'seismic';
  const Icon = isSeismic ? Activity : CloudLightning;
  const accentColor =
    leadToast.severity === 'critical'
      ? 'text-rose-400'
      : isSeismic
        ? 'text-orange-400'
        : 'text-cyan-400';

  return (
    <section
      aria-label="Notificaciones de telemetría en tiempo real"
      aria-live="polite"
      data-testid="alert-toast-stack"
      className={`${
        stacked ? 'relative z-20' : 'fixed top-[60px] left-3 sm:left-4 z-20'
      } w-[min(272px,calc(100vw-68px))] pointer-events-auto`}
    >
      <div
        data-testid="alert-toast-item"
        className="bg-[#080d16]/90 border border-white/[0.08] rounded-lg shadow-xl overflow-hidden"
      >
        <div className="px-2.5 py-2 space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-1.5 min-w-0">
              <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${accentColor}`} />
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-white leading-snug truncate">
                  {leadToast.title}
                </div>
                <div className="text-[10px] text-slate-400 leading-snug line-clamp-1">
                  {leadToast.message}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onDismissToast(leadToast.id)}
              aria-label={`Cerrar notificación ${leadToast.title}`}
              className="p-0.5 text-slate-400 hover:text-white rounded transition-colors shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 pl-5">
            <button
              type="button"
              onClick={() => onFocusAlert(leadToast)}
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded transition-colors whitespace-nowrap"
            >
              <Crosshair className="w-2.5 h-2.5" />
              <span>Enfocar</span>
            </button>
            <span className="text-[10px] font-mono-tabular text-slate-500">
              {leadToast.lat.toFixed(2)}, {leadToast.lng.toFixed(2)}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-2.5 py-1 border-t border-white/[0.07] bg-white/[0.02] text-[10px]">
          <button
            type="button"
            onClick={onOpenInbox}
            className="flex items-center gap-1 text-cyan-300 hover:text-cyan-200 font-medium transition-colors whitespace-nowrap"
          >
            <Bell className="w-2.5 h-2.5" />
            <span>Ver alertas ({unreadCount})</span>
          </button>
          <button
            type="button"
            onClick={onDismissAllToasts}
            className="text-slate-400 hover:text-white transition-colors whitespace-nowrap"
          >
            Ocultar
          </button>
        </div>
      </div>
    </section>
  );
}
