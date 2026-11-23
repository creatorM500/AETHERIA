import { useEffect, useState } from 'react';
import { Bot, Check, Copy, Cpu, Play, Terminal, X } from 'lucide-react';
import type { McpToolDefinition } from '../shared/types.ts';

interface McpConsolePanelProps {
  onClose: () => void;
}

const DEFAULT_ARGS_BY_TOOL: Record<string, string> = {
  query_global_events: JSON.stringify({ category: 'disaster', limit: 6 }, null, 2),
  track_flights_and_vessels: JSON.stringify({ lat: 26.5667, lng: 56.25, radiusKm: 1800 }, null, 2),
  compute_predictive_route: JSON.stringify(
    {
      originLat: 19.4326,
      originLng: -99.1332,
      destinationLat: 19.366,
      destinationLng: -99.261,
      travelMode: 'DRIVE',
      departureOffsetHours: 0,
      avoidHazards: true,
    },
    null,
    2
  ),
  analyze_geospatial_risk: JSON.stringify({ lat: 14.35, lng: 42.65, radiusKm: 900 }, null, 2),
  query_disaster_history: JSON.stringify({ subtype: 'earthquake', status: 'all', limit: 10 }, null, 2),
};

export function McpConsolePanel({ onClose }: McpConsolePanelProps) {
  const [tools, setTools] = useState<McpToolDefinition[]>([]);
  const [selectedTool, setSelectedTool] = useState<string>('query_global_events');
  const [argsJson, setArgsJson] = useState<string>(DEFAULT_ARGS_BY_TOOL.query_global_events);
  const [mcpOutput, setMcpOutput] = useState<string>('');
  const [mcpLoading, setMcpLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const [aiPrompt, setAiPrompt] = useState(
    'Analiza los desastres naturales y zonas de conflicto activos ahora mismo y su impacto en vuelos y rutas marítimas.'
  );
  const [aiAnswer, setAiAnswer] = useState<string>('');
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const mcpEndpoint =
    typeof window !== 'undefined' ? `${window.location.origin}/mcp` : '/mcp';

  useEffect(() => {
    fetch('/api/mcp/tools')
      .then((r) => r.json())
      .then((data: { tools?: McpToolDefinition[] }) => {
        if (Array.isArray(data.tools) && data.tools.length > 0) {
          setTools(data.tools);
        }
      })
      .catch(() => {
        // Ignore transient init errors
      });
  }, []);

  function handleSelectTool(name: string) {
    setSelectedTool(name);
    setArgsJson(DEFAULT_ARGS_BY_TOOL[name] ?? '{}');
  }

  async function runMcpTool() {
    setMcpLoading(true);
    setMcpOutput('');
    try {
      const parsedArgs = JSON.parse(argsJson) as Record<string, unknown>;
      const t0 = performance.now();
      const res = await fetch('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: selectedTool,
            arguments: parsedArgs,
          },
        }),
      });
      const json = await res.json();
      const elapsed = Math.round(performance.now() - t0);
      setMcpOutput(`Respuesta JSON-RPC 2.0 (${elapsed} ms)\n${JSON.stringify(json, null, 2)}`);
    } catch (err) {
      setMcpOutput(
        `Error ejecutando herramienta MCP: ${err instanceof Error ? err.message : 'JSON inválido'}`
      );
    } finally {
      setMcpLoading(false);
    }
  }

  async function runAiAnalysis() {
    if (!aiPrompt.trim()) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      const data = (await res.json()) as {
        analysis?: string;
        error?: string;
        eventsAnalyzed?: number;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Error en análisis IA');
      }
      setAiAnswer(data.analysis ?? '');
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setAiLoading(false);
    }
  }

  function copyMcpConfig() {
    const snippet = JSON.stringify(
      {
        mcpServers: {
          'aetheria-global': {
            type: 'http',
            url: mcpEndpoint,
          },
        },
      },
      null,
      2
    );
    void navigator.clipboard?.writeText(snippet);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <aside
      aria-label="Servidor MCP y Análisis IA en tiempo real"
      className="fixed top-16 right-3 left-3 sm:left-auto sm:w-[430px] max-h-[calc(100dvh-84px)] sm:max-h-[calc(100vh-155px)] z-20 flex flex-col bg-[#080d16]/94 border border-white/8 rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-cyan-400" />
          <h2 className="font-display text-sm font-semibold tracking-wide text-white">
            Servidor MCP e Inteligencia IA
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar panel MCP e IA"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 overflow-y-auto space-y-5">
        {/* MCP Connection Endpoint */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-200">
              Endpoint Model Context Protocol (JSON-RPC 2.0)
            </span>
            <button
              type="button"
              onClick={copyMcpConfig}
              className="flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200 px-2 py-1 rounded bg-white/5 border border-white/10"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copiado' : 'Copiar config MCP'}</span>
            </button>
          </div>
          <div className="font-mono-tabular text-xs bg-[#06090f] border border-white/10 rounded-lg px-3 py-2 text-cyan-300 truncate">
            POST {mcpEndpoint}
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Conecta Claude Desktop, Cursor o cualquier agente compatible vía HTTP MCP para consultar eventos, rastrear vuelos/buques, evaluar riesgo o calcular rutas predictivas en vivo.
          </p>
        </section>

        {/* Interactive MCP Tool Runner */}
        <section className="space-y-2.5 pt-3 border-t border-white/10">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
            <Terminal className="w-3.5 h-3.5 text-amber-400" />
            <span>Ejecutor directo de herramientas MCP</span>
          </div>

          <label className="block">
            <span className="sr-only">Seleccionar herramienta MCP</span>
            <select
              value={selectedTool}
              onChange={(e) => handleSelectTool(e.target.value)}
              className="w-full bg-[#06090f] border border-white/15 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-400"
            >
              {(tools.length > 0
                ? tools
                : Object.keys(DEFAULT_ARGS_BY_TOOL).map((name) => ({
                    name,
                    description: '',
                  }))
              ).map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          {tools.find((t) => t.name === selectedTool)?.description && (
            <p className="text-xs text-slate-400">
              {tools.find((t) => t.name === selectedTool)?.description}
            </p>
          )}

          <label className="block">
            <span className="text-[11px] text-slate-400">Argumentos JSON</span>
            <textarea
              rows={4}
              value={argsJson}
              onChange={(e) => setArgsJson(e.target.value)}
              className="mt-1 w-full font-mono-tabular text-xs bg-[#06090f] border border-white/15 rounded-lg p-2.5 text-slate-100 focus:outline-none focus:border-cyan-400"
            />
          </label>

          <button
            type="button"
            onClick={() => void runMcpTool()}
            disabled={mcpLoading}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-slate-950 rounded-lg transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{mcpLoading ? 'Ejecutando MCP...' : 'Ejecutar herramienta MCP'}</span>
          </button>

          {mcpOutput && (
            <pre className="max-h-48 overflow-auto font-mono-tabular text-[11px] bg-[#06090f] border border-white/10 rounded-lg p-3 text-cyan-200 whitespace-pre-wrap break-words">
              {mcpOutput}
            </pre>
          )}
        </section>

        {/* Real-time AI Geospatial Brief */}
        <section className="space-y-2.5 pt-3 border-t border-white/10">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
            <Bot className="w-3.5 h-3.5 text-cyan-400" />
            <span>Análisis Geoespacial en Tiempo Real</span>
          </div>
          <textarea
            rows={2}
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="Pregunta sobre sismos, desvíos marítimos, vuelos o riesgos regionales..."
            className="w-full text-xs bg-[#06090f] border border-white/15 rounded-lg p-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
          />
          <button
            type="button"
            onClick={() => void runAiAnalysis()}
            disabled={aiLoading}
            className="w-full py-2 px-3 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 disabled:opacity-60 text-slate-950 rounded-lg transition-colors"
          >
            {aiLoading ? 'Analizando telemetría global...' : 'Analizar situación global'}
          </button>

          {aiError && (
            <div className="p-2.5 text-xs text-rose-200 bg-rose-500/15 border border-rose-500/30 rounded-lg">
              {aiError}
            </div>
          )}

          {aiAnswer && (
            <div className="text-xs text-slate-200 bg-[#06090f] border border-white/10 rounded-lg p-3 whitespace-pre-wrap leading-relaxed">
              {aiAnswer}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
