import { EyeOff, Globe2, Loader2, MapPin, Mountain, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseCoordinateQuery, SECTOR_PRESETS } from '../shared/geo.ts';
import type { ViewportMode } from '../shared/types.ts';

const QUICK_SEARCH_VISIBLE_KEY = 'aetheria-quick-search-visible';

function loadQuickSearchVisible(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(QUICK_SEARCH_VISIBLE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export interface QuickSearchPlace {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  isCoordinate?: boolean;
}

interface QuickSearchBarProps {
  viewportMode: ViewportMode;
  onFlyToGlobe: (lat: number, lng: number, label: string) => void;
  onOpenTerrain3D: (lat: number, lng: number, label: string, sublabel?: string) => void;
}

export function QuickSearchBar({
  viewportMode,
  onFlyToGlobe,
  onOpenTerrain3D,
}: QuickSearchBarProps) {
  const [visible, setVisible] = useState<boolean>(loadQuickSearchVisible);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [remotePlaces, setRemotePlaces] = useState<QuickSearchPlace[]>([]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(QUICK_SEARCH_VISIBLE_KEY, String(visible));
    } catch {
      // Ignore storage quota errors
    }
  }, [visible]);

  // Focus shortcut '/' or Ctrl/Cmd+K (also restores bar if currently hidden)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setVisible(true);
        window.requestAnimationFrame(() => {
          inputRef.current?.focus();
          setOpen(true);
        });
        return;
      }
      if (!isInput && e.key === '/') {
        e.preventDefault();
        setVisible(true);
        window.requestAnimationFrame(() => {
          inputRef.current?.focus();
          setOpen(true);
        });
        return;
      }
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  const parsedCoord = useMemo(() => parseCoordinateQuery(query), [query]);

  // Debounced /api/places/search
  useEffect(() => {
    const q = query.trim();
    if (!q || parsedCoord) {
      setRemotePlaces([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch('/api/places/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }),
          signal: controller.signal,
        });
        if (!res.ok) {
          setRemotePlaces([]);
          return;
        }
        const data = (await res.json()) as {
          places?: Array<{ id?: string; name: string; address?: string; lat: number; lng: number }>;
        };
        const mapped: QuickSearchPlace[] = (data.places ?? []).map((p, idx) => ({
          id: p.id ?? `place-${idx}-${p.lat.toFixed(3)}`,
          name: p.name,
          address: p.address ?? '',
          lat: p.lat,
          lng: p.lng,
        }));
        setRemotePlaces(mapped);
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          setRemotePlaces([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }, 240);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, parsedCoord]);

  const localPresetMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? SECTOR_PRESETS.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.country.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q)
        )
      : SECTOR_PRESETS;
    return list.map<QuickSearchPlace>((p) => ({
      id: `preset-${p.id}`,
      name: p.name,
      address: p.country,
      lat: p.lat,
      lng: p.lng,
    }));
  }, [query]);

  const combinedResults = useMemo(() => {
    const results: QuickSearchPlace[] = [];
    if (parsedCoord) {
      results.push({
        id: 'parsed-coord',
        name: `${parsedCoord.lat.toFixed(4)}°, ${parsedCoord.lng.toFixed(4)}°`,
        address: 'Coordenada directa',
        lat: parsedCoord.lat,
        lng: parsedCoord.lng,
        isCoordinate: true,
      });
    }

    const seen = new Set<string>();
    const addUnique = (item: QuickSearchPlace) => {
      const key = `${item.lat.toFixed(3)}:${item.lng.toFixed(3)}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push(item);
    };

    if (query.trim().length > 0) {
      remotePlaces.forEach(addUnique);
      localPresetMatches.forEach(addUnique);
    } else {
      localPresetMatches.forEach(addUnique);
    }

    return results.slice(0, 6);
  }, [parsedCoord, remotePlaces, localPresetMatches, query]);

  const triggerDefaultAction = (place: QuickSearchPlace) => {
    setOpen(false);
    if (viewportMode === 'sector3d') {
      onOpenTerrain3D(place.lat, place.lng, place.name, place.address);
    } else {
      onFlyToGlobe(place.lat, place.lng, place.name);
    }
  };

  if (!visible) {
    return (
      <div ref={rootRef} data-testid="quick-search-bar" className="pointer-events-auto">
        <button
          type="button"
          data-testid="quick-search-show-btn"
          onClick={() => {
            setVisible(true);
            window.requestAnimationFrame(() => {
              inputRef.current?.focus();
              setOpen(true);
            });
          }}
          title="Mostrar buscador rápido (/)"
          aria-label="Mostrar buscador rápido"
          className="flex items-center gap-1.5 bg-[#080d16]/94 hover:bg-[#0d1422] border border-white/12 hover:border-cyan-400/50 text-slate-200 hover:text-cyan-300 rounded-xl px-2.5 py-1.5 text-xs shadow-xl transition-colors"
        >
          <Search className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span>Buscar</span>
          <kbd className="hidden sm:inline-block px-1 py-0.5 text-[10px] font-mono-tabular text-slate-400 bg-white/5 border border-white/10 rounded">
            /
          </kbd>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-testid="quick-search-bar"
      className="pointer-events-auto relative w-[min(320px,calc(100vw-88px))]"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (combinedResults.length > 0) {
            triggerDefaultAction(combinedResults[0]);
          }
        }}
        className="flex items-center gap-1.5 bg-[#080d16]/94 border border-white/12 focus-within:border-cyan-400/70 rounded-xl px-3 py-1.5 shadow-xl transition-colors"
      >
        <Search className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          data-testid="quick-search-input"
          aria-label="Buscador rápido de ciudades, lugares o coordenadas"
          placeholder="Buscar ciudad, lugar o lat, lng..."
          className="w-full bg-transparent text-xs text-white placeholder:text-slate-400 focus:outline-none"
        />
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin shrink-0" />
        ) : query ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setRemotePlaces([]);
              inputRef.current?.focus();
            }}
            aria-label="Limpiar búsqueda"
            className="p-0.5 text-slate-400 hover:text-white rounded transition-colors shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono-tabular text-slate-400 bg-white/5 border border-white/10 rounded shrink-0">
            /
          </kbd>
        )}
        <button
          type="button"
          data-testid="quick-search-hide-btn"
          onClick={() => {
            setOpen(false);
            setVisible(false);
          }}
          title="Ocultar buscador rápido"
          aria-label="Ocultar buscador rápido"
          className="p-1 text-slate-400 hover:text-white hover:bg-white/8 rounded-md transition-colors shrink-0"
        >
          <EyeOff className="w-3.5 h-3.5" />
        </button>
      </form>

      {open && combinedResults.length > 0 && (
        <div
          data-testid="quick-search-results"
          role="listbox"
          aria-label="Resultados de búsqueda rápida"
          className="mt-1.5 bg-[#080d16]/96 border border-white/12 rounded-xl shadow-2xl overflow-hidden divide-y divide-white/8 max-h-[296px] overflow-y-auto"
        >
          {combinedResults.map((place) => (
            <div
              key={place.id}
              className="px-3 py-2 flex items-center justify-between gap-2 hover:bg-white/5 transition-colors"
            >
              <button
                type="button"
                onClick={() => triggerDefaultAction(place)}
                className="flex items-start gap-2 min-w-0 text-left flex-1"
              >
                <MapPin
                  className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                    place.isCoordinate ? 'text-amber-400' : 'text-cyan-400'
                  }`}
                />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-white truncate">{place.name}</div>
                  <div className="text-[10px] text-slate-400 truncate">
                    {place.address || `${place.lat.toFixed(3)}°, ${place.lng.toFixed(3)}°`}
                  </div>
                </div>
              </button>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  data-testid="quick-search-globe-btn"
                  onClick={() => {
                    setOpen(false);
                    onFlyToGlobe(place.lat, place.lng, place.name);
                  }}
                  title="Enfocar en Globo 3D"
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-white/8 hover:bg-white/16 text-slate-200 rounded-md transition-colors whitespace-nowrap"
                >
                  <Globe2 className="w-3 h-3" />
                  <span>Globo</span>
                </button>
                <button
                  type="button"
                  data-testid="quick-search-terrain-btn"
                  onClick={() => {
                    setOpen(false);
                    onOpenTerrain3D(place.lat, place.lng, place.name, place.address);
                  }}
                  title="Abrir directamente en Terreno 3D"
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded-md transition-colors whitespace-nowrap"
                >
                  <Mountain className="w-3 h-3" />
                  <span>Terreno 3D</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
