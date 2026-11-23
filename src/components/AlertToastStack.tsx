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

  const visible = toasts.slice(0, 2);

  return (
    <section
      aria-label="Notificaciones de telemetría en tiempo real"
      aria-live="polite"
      data-testid="alert-toast-stack"
      className={`${
        stacked ? 'relative z-20' : 'fixed top-24 left-4 sm:left-6 z-20'
      } w-[min(340px,calc(100vw-88px))] flex flex-col gap-2 pointer-events-auto`}
    >
      {visible.map((toast, idx) => {
        const isSeismic = toast.ruleType === 'seismic';
        const Icon = isSeismic ? Activity : CloudLightning;
        const accentColor =
          toast.severity === 'critical'
            ? 'text-rose-400'
            : isSeismic
              ? 'text-orange-400'
              : 'text-cyan-400';

        return (
          <div
            key={toast.id}
            data-testid="alert-toast-item"
            className={`${idx > 0 ? 'hidden sm:block ' : ''}bg-[#080d16]/96 border border-white/12 rounded-xl px-3.5 py-2.5 shadow-2xl space-y-2`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0">
                <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${accentColor}`} />
                <div className="min-w-0">
                  <div className="text-[11px] font-medium text-slate-400">
                    {isSeismic ? 'Alerta sísmica' : 'Alerta meteorológica'} · {toast.source}
                  </div>
                  <div className="text-xs font-semibold text-white leading-snug truncate">
                    {toast.title}
                  </div>
                  <div className="text-[11px] text-slate-300 mt-0.5 leading-snug">
                    {toast.message}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onDismissToast(toast.id)}
                aria-label={`Cerrar notificación ${toast.title}`}
                className="p-1 text-slate-400 hover:text-white rounded transition-colors shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 pl-6">
              <button
                type="button"
                onClick={() => onFocusAlert(toast)}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md transition-colors whitespace-nowrap"
              >
                <Crosshair className="w-3 h-3" />
                <span>Enfocar</span>
              </button>
              <span className="text-[10px] font-mono-tabular text-slate-400">
                {toast.lat.toFixed(2)}, {toast.lng.toFixed(2)}
              </span>
            </div>
          </div>
        );
      })}

      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[#080d16]/94 border border-white/10 rounded-lg text-[11px]">
        <button
          type="button"
          onClick={onOpenInbox}
          className="flex items-center gap-1.5 text-cyan-300 hover:text-cyan-200 font-medium transition-colors whitespace-nowrap"
        >
          <Bell className="w-3 h-3" />
          <span>Ver y configurar ({unreadCount})</span>
        </button>
        <button
          type="button"
          onClick={onDismissAllToasts}
          className="text-slate-400 hover:text-white transition-colors whitespace-nowrap"
        >
          Ocultar avisos
        </button>
      </div>
    </section>
  );
}
