/**
 * Force-directed memory graph. Renders all episodic / semantic /
 * identity nodes from the helper's /sci/memories endpoint as an
 * interactive SVG force simulation — no D3, no extra deps.
 *
 * Physics: repulsion between all pairs + spring attraction along
 * semantic-similarity edges (built client-side from shared category /
 * type) + centre gravity. Simulation runs until max velocity settles
 * below SETTLE_VEL or MAX_TICKS is reached, then pauses. Dragging a
 * node wakes the simulation for that burst.
 *
 * Edges are inferred client-side (no backend graph needed for v1):
 *   - same category   → weak spring
 *   - same type       → very weak spring (keeps clusters)
 *   - identity + episodic sharing a keyword in content → spring
 *
 * Node display: coloured circle with type initial. Label truncated
 * below. Click = inspect in side panel. Filter bar + search on top.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { listMemories } from './api';
import type { MemoryNode, MemoryNodeType } from './types';

// ── Constants ─────────────────────────────────────────────────────────────

const RADIUS       = 16;
const REPEL        = 4500;
const ATTRACT_EDGE = 0.016;
const ATTRACT_WEAK = 0.004;
const DAMPEN       = 0.76;
const CENTER_G     = 0.007;
const SETTLE_VEL   = 0.12;
const MAX_TICKS    = 500;
const MAX_NODES    = 120; // cap for perf

const NODE_COLOR: Record<MemoryNodeType, string> = {
  identity: '#818cf8',
  episodic:  '#34d399',
  semantic:  '#fb923c',
};

const TYPE_INITIAL: Record<MemoryNodeType, string> = {
  identity: 'I',
  episodic:  'E',
  semantic:  'S',
};

// ── Types ─────────────────────────────────────────────────────────────────

interface SimNode extends MemoryNode {
  x:  number;
  y:  number;
  vx: number;
  vy: number;
}

interface Edge { a: number; b: number; strength: number }

// ── Edge inference ────────────────────────────────────────────────────────

function buildEdges(nodes: SimNode[]): Edge[] {
  const edges: Edge[] = [];
  const n = nodes.length;

  // Extract top keywords from content for cross-type linking
  const stopwords = new Set([
    'the','a','an','is','in','on','at','to','for','of','and','or',
    'i','my','me','we','our','has','have','been','was','were','with',
    'sci','that','this','it','be','by','as','from','are','its',
  ]);
  const keywords = nodes.map(nd =>
    new Set(
      nd.content.toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopwords.has(w))
    )
  );

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = nodes[i];
      const b = nodes[j];

      // Same category (semantic nodes)
      if (a.category && b.category && a.category === b.category) {
        edges.push({ a: i, b: j, strength: ATTRACT_EDGE });
        continue;
      }

      // Same type — weak cluster pull
      if (a.type === b.type) {
        edges.push({ a: i, b: j, strength: ATTRACT_WEAK });
        continue;
      }

      // Shared keyword across types
      let shared = 0;
      for (const kw of keywords[i]) {
        if (keywords[j].has(kw)) shared++;
      }
      if (shared >= 1) {
        edges.push({ a: i, b: j, strength: ATTRACT_EDGE * Math.min(shared, 3) });
      }
    }
  }
  return edges;
}

// ── Physics step ──────────────────────────────────────────────────────────

function stepPhysics(
  nodes:   SimNode[],
  edges:   Edge[],
  w:       number,
  h:       number,
  pinned:  string | null,
): number {
  const n = nodes.length;

  // Repulsion — O(n²), fine up to MAX_NODES
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const d2 = dx * dx + dy * dy + 0.01;
      const d  = Math.sqrt(d2);
      const f  = REPEL / d2;
      const fx = f * dx / d;
      const fy = f * dy / d;
      nodes[i].vx -= fx; nodes[i].vy -= fy;
      nodes[j].vx += fx; nodes[j].vy += fy;
    }
  }

  // Spring attraction along edges
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    a.vx += dx * e.strength; a.vy += dy * e.strength;
    b.vx -= dx * e.strength; b.vy -= dy * e.strength;
  }

  // Integrate + centre gravity
  let maxV = 0;
  for (const nd of nodes) {
    nd.vx += (w / 2 - nd.x) * CENTER_G;
    nd.vy += (h / 2 - nd.y) * CENTER_G;
    nd.vx *= DAMPEN;
    nd.vy *= DAMPEN;
    if (nd.id === pinned) { nd.vx = 0; nd.vy = 0; continue; }
    nd.x = Math.max(RADIUS + 2, Math.min(w - RADIUS - 2, nd.x + nd.vx));
    nd.y = Math.max(RADIUS + 2, Math.min(h - RADIUS - 2, nd.y + nd.vy));
    const v = Math.abs(nd.vx) + Math.abs(nd.vy);
    if (v > maxV) maxV = v;
  }
  return maxV;
}

// ── Label helper ──────────────────────────────────────────────────────────

function shortLabel(content: string): string {
  // Use first meaningful phrase — up to first comma/period or 22 chars
  const trimmed = content.trim();
  const cut = trimmed.search(/[,.:]/);
  const phrase = cut > 0 ? trimmed.slice(0, cut) : trimmed;
  return phrase.length > 20 ? phrase.slice(0, 19) + '…' : phrase;
}

// ── Component ─────────────────────────────────────────────────────────────

interface Props {
  profile?: string;
  enabled:  boolean;
}

export default function MemoryGraph({ profile, enabled }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims]     = useState({ w: 600, h: 420 });
  const nodesRef            = useRef<SimNode[]>([]);
  const edgesRef            = useRef<Edge[]>([]);
  const rafRef              = useRef<number>(0);
  const tickRef             = useRef(0);
  const pinnedRef           = useRef<string | null>(null);
  const [, rerender]        = useState(0);
  const [settled, setSettled]   = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter]     = useState<MemoryNodeType | 'all'>('all');
  const [search, setSearch]     = useState('');

  // ── Data fetch ─────────────────────────────────────────────────────────

  const query = useQuery({
    queryKey:  ['sci', 'memories', profile],
    queryFn:   () => listMemories(profile, MAX_NODES),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // ── Resize observer ────────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setDims(prev =>
        Math.abs(prev.w - width) > 2 || Math.abs(prev.h - height) > 2
          ? { w: width, h: height }
          : prev,
      );
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── Init simulation when data arrives ─────────────────────────────────

  useEffect(() => {
    const raw = query.data?.nodes;
    if (!raw || raw.length === 0) return;

    const capped = raw.slice(0, MAX_NODES);
    const { w, h } = dims;
    const simNodes: SimNode[] = capped.map((n, i) => {
      const angle = (i / capped.length) * 2 * Math.PI;
      const r = Math.min(w, h) * 0.3;
      return {
        ...n,
        x:  w / 2 + r * Math.cos(angle) + (Math.random() - 0.5) * 30,
        y:  h / 2 + r * Math.sin(angle) + (Math.random() - 0.5) * 30,
        vx: 0,
        vy: 0,
      };
    });
    nodesRef.current = simNodes;
    edgesRef.current = buildEdges(simNodes);
    tickRef.current  = 0;
    setSettled(false);
    setSelected(null);
  }, [query.data, dims]);

  // ── Physics loop ───────────────────────────────────────────────────────

  useEffect(() => {
    if (settled) return;
    let running = true;
    const tick = () => {
      if (!running || nodesRef.current.length === 0) return;
      const maxV = stepPhysics(
        nodesRef.current, edgesRef.current,
        dims.w, dims.h, pinnedRef.current,
      );
      tickRef.current++;
      rerender(c => c + 1);
      if (maxV < SETTLE_VEL || tickRef.current >= MAX_TICKS) {
        setSettled(true);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, [settled, dims]);

  // ── Drag ───────────────────────────────────────────────────────────────

  const onNodeMouseDown = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    pinnedRef.current = id;
    setSelected(id);
    setSettled(false);

    const svgEl = (e.currentTarget as SVGElement).closest('svg') as SVGSVGElement;
    const rect  = svgEl.getBoundingClientRect();

    const onMove = (ev: MouseEvent) => {
      const nd = nodesRef.current.find(n => n.id === id);
      if (!nd) return;
      nd.x  = Math.max(RADIUS + 2, Math.min(dims.w - RADIUS - 2, ev.clientX - rect.left));
      nd.y  = Math.max(RADIUS + 2, Math.min(dims.h - RADIUS - 2, ev.clientY - rect.top));
      nd.vx = 0; nd.vy = 0;
      rerender(c => c + 1);
    };
    const onUp = () => {
      pinnedRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  }, [dims]);

  // ── Derived display state ──────────────────────────────────────────────

  const nodes = nodesRef.current;

  const visible = useMemo(() => {
    const q = search.toLowerCase();
    return new Set(
      nodes
        .filter(n => filter === 'all' || n.type === filter)
        .filter(n => !q || n.content.toLowerCase().includes(q) || (n.category ?? '').toLowerCase().includes(q))
        .map(n => n.id),
    );
  }, [nodes, filter, search]);

  const connectedIds = useMemo(() => {
    if (!selected) return new Set<string>();
    const idxMap = new Map(nodes.map((n, i) => [n.id, i]));
    const si = idxMap.get(selected);
    if (si === undefined) return new Set<string>();
    return new Set(
      edgesRef.current
        .filter(e => e.a === si || e.b === si)
        .map(e => nodes[e.a === si ? e.b : e.a]?.id)
        .filter(Boolean) as string[],
    );
  }, [selected, nodes]);

  const selectedNode = selected ? nodes.find(n => n.id === selected) : null;

  const counts = useMemo(() =>
    nodes.reduce<Record<string, number>>((acc, n) => {
      acc[n.type] = (acc[n.type] ?? 0) + 1;
      return acc;
    }, {}),
  [nodes]);

  const idxMap = useMemo(() =>
    new Map(nodes.map((n, i) => [n.id, i])),
  [nodes]);

  // ── Render ─────────────────────────────────────────────────────────────

  if (!enabled) return null;

  if (query.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
        Loading memories…
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-red-500">
        Could not load memories — is sci-helper running?
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
        No memories yet. Send some chats to build the graph.
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden" style={{ userSelect: 'none' }}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border-medium px-2 py-1.5 flex-shrink-0">
        {(['all', 'identity', 'episodic', 'semantic'] as const).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setFilter(t)}
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              filter === t
                ? 'bg-indigo-600 text-white'
                : 'bg-surface-tertiary text-text-secondary hover:text-text-primary'
            }`}
          >
            {t === 'all'
              ? `All (${nodes.length})`
              : `${t[0].toUpperCase() + t.slice(1)} (${counts[t] ?? 0})`}
          </button>
        ))}
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search…"
          className="
            ml-auto w-32 rounded border border-border-medium bg-surface-secondary
            px-2 py-0.5 text-[10px] text-text-primary placeholder-text-secondary
            focus:outline-none focus:ring-1 focus:ring-indigo-500
          "
        />
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 border-b border-border-medium px-2 py-1 flex-shrink-0">
        {(Object.entries(NODE_COLOR) as [MemoryNodeType, string][]).map(([t, c]) => (
          <div key={t} className="flex items-center gap-1 text-[9px] text-text-secondary">
            <span className="h-2 w-2 rounded-full flex-shrink-0" style={{ background: c }} />
            {t}
          </div>
        ))}
        <span className="ml-auto text-[9px] text-text-secondary">
          {settled ? 'Drag to rearrange' : `Simulating… ${tickRef.current}`}
        </span>
      </div>

      {/* Graph + detail */}
      <div className="flex flex-1 min-h-0">
        <div ref={containerRef} className="flex-1 relative overflow-hidden">
          <svg
            width={dims.w}
            height={dims.h}
            className="block"
            style={{ background: 'transparent', cursor: 'default' }}
            onClick={() => setSelected(null)}
          >
            {/* Edges */}
            {edgesRef.current.map((e, i) => {
              const a = nodes[e.a];
              const b = nodes[e.b];
              if (!a || !b || !visible.has(a.id) || !visible.has(b.id)) return null;
              const hi = selected === a.id || selected === b.id;
              return (
                <line
                  key={i}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={hi ? '#6366f1' : '#374151'}
                  strokeWidth={hi ? 1.2 : 0.6}
                  strokeOpacity={hi ? 0.85 : 0.4}
                />
              );
            })}

            {/* Nodes */}
            {nodes.map(n => {
              if (!visible.has(n.id)) return null;
              const isSel = n.id === selected;
              const isCon = connectedIds.has(n.id);
              const isDim = !!selected && !isSel && !isCon;
              const color = NODE_COLOR[n.type];
              const label = shortLabel(n.content);
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  onMouseDown={ev => onNodeMouseDown(ev, n.id)}
                  onClick={ev => { ev.stopPropagation(); setSelected(n.id); }}
                  style={{ cursor: 'grab' }}
                >
                  {isSel && (
                    <circle
                      r={RADIUS + 5}
                      fill="none"
                      stroke={color}
                      strokeWidth={1.5}
                      strokeOpacity={0.35}
                    />
                  )}
                  <circle
                    r={RADIUS}
                    fill={color}
                    fillOpacity={isDim ? 0.07 : 0.15}
                    stroke={color}
                    strokeWidth={isSel ? 2 : 1}
                    strokeOpacity={isDim ? 0.2 : 1}
                  />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={10}
                    fontWeight="700"
                    fill={color}
                    fillOpacity={isDim ? 0.2 : 1}
                    style={{ pointerEvents: 'none' }}
                  >
                    {TYPE_INITIAL[n.type]}
                  </text>
                  <text
                    y={RADIUS + 9}
                    textAnchor="middle"
                    fontSize={8}
                    fill="#d1d5db"
                    fillOpacity={isDim ? 0.15 : 0.75}
                    style={{ pointerEvents: 'none' }}
                  >
                    {label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Detail panel */}
        <div className="
          w-44 flex-shrink-0 border-l border-border-medium
          bg-surface-secondary p-2 text-[11px] text-text-secondary
          overflow-y-auto
        ">
          {selectedNode ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-1">
                <span className="font-semibold text-text-primary leading-tight text-xs">
                  {shortLabel(selectedNode.content)}
                </span>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="text-text-secondary hover:text-text-primary flex-shrink-0"
                >
                  ✕
                </button>
              </div>

              <span
                className="self-start rounded px-1.5 py-0.5 text-[9px] font-mono uppercase"
                style={{
                  background: NODE_COLOR[selectedNode.type] + '22',
                  color:      NODE_COLOR[selectedNode.type],
                }}
              >
                {selectedNode.type}
                {selectedNode.category ? ` · ${selectedNode.category}` : ''}
              </span>

              <p className="leading-relaxed text-text-secondary break-words">
                {selectedNode.content}
              </p>

              {selectedNode.confidence != null && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] uppercase text-text-secondary">confidence</span>
                  <div className="flex-1 h-1 rounded-full bg-surface-tertiary overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width:      `${selectedNode.confidence * 100}%`,
                        background: NODE_COLOR[selectedNode.type],
                      }}
                    />
                  </div>
                  <span className="text-[9px] font-mono">
                    {selectedNode.confidence.toFixed(2)}
                  </span>
                </div>
              )}

              {selectedNode.occurredAt && (
                <p className="text-[9px] text-text-secondary">
                  {new Date(selectedNode.occurredAt).toLocaleDateString()}
                </p>
              )}

              {connectedIds.size > 0 && (
                <div>
                  <p className="text-[9px] uppercase text-text-secondary mb-1">
                    Connected ({connectedIds.size})
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {[...connectedIds].slice(0, 8).map(id => {
                      const cn = nodes[idxMap.get(id) ?? -1];
                      if (!cn) return null;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setSelected(id)}
                          className="
                            flex items-center gap-1.5 rounded px-1 py-0.5
                            text-left text-[10px] text-text-primary
                            hover:bg-surface-tertiary
                          "
                        >
                          <span
                            className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                            style={{ background: NODE_COLOR[cn.type] }}
                          />
                          <span className="truncate">{shortLabel(cn.content)}</span>
                        </button>
                      );
                    })}
                    {connectedIds.size > 8 && (
                      <p className="text-[9px] text-text-secondary pl-1">
                        +{connectedIds.size - 8} more
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-text-secondary">Click a node to inspect.</p>
          )}
        </div>
      </div>
    </div>
  );
}
