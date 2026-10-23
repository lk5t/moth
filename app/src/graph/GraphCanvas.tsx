// The Mind: an Obsidian-style force-directed graph rendered on <canvas> with d3-force + d3-zoom.
// Nodes are real memories, links are real relationships. Positions persist; updates are incremental.
import { drag as d3drag } from "d3-drag";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { CATEGORY_COLOR } from "../lib/utils";

export interface GraphNodeData {
  id: string;
  title: string;
  category: string;
  project_id: string | null;
  importance: number;
  degree: number;
  x?: number | null;
  y?: number | null;
  pinned?: boolean;
  flags?: string[];
  status?: string;
  updated_at?: string;
}

export interface GraphLinkData {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  strength: number;
}

export interface GraphSettings {
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
  nodeSize: number;
  linkThickness: number;
  textFadeThreshold: number;
  showLabels: boolean;
  animate: boolean;
  colorBy: "none" | "category" | "project";
  showArrows: boolean;
}

interface SimNode extends SimulationNodeDatum, GraphNodeData {
  r: number;
  color: string;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  id: string;
  type: string;
  strength: number;
}

export interface GraphHandle {
  focus: (id: string, scale?: number) => void;
  fit: () => void;
  zoomBy: (f: number) => void;
  unpin: (id: string) => void;
  reheat: () => void;
}

interface Props {
  nodes: GraphNodeData[];
  links: GraphLinkData[];
  settings: GraphSettings;
  selectedId?: string | null;
  highlight?: Set<string> | null;
  bloom?: Map<string, number>;
  projectColors?: Map<string, string>;
  compact?: boolean;
  onSelect?: (id: string | null) => void;
  onFocus?: (id: string) => void;
  onContext?: (id: string, x: number, y: number) => void;
  onHover?: (node: GraphNodeData | null) => void;
  onPositions?: (items: { id: string; x: number; y: number; pinned?: boolean }[]) => void;
}

const BG = "#1C1C1C";
const NODE = "#B8B8BD";
const EDGE = "rgba(180,180,190,0.20)";
const ACCENT = "#A78BFA";
const ACCENT_SOFT = "#C4B5FD";

function radius(n: GraphNodeData, size: number): number {
  const base = n.category === "project" ? 6 : 3.2;
  return (base + Math.sqrt(Math.max(0, n.degree)) * 1.35 + n.importance * 1.2) * size;
}

export const GraphCanvas = forwardRef<GraphHandle, Props>(function GraphCanvas(props, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sim = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const byId = useRef(new Map<string, SimNode>());
  const neighbours = useRef(new Map<string, Set<string>>());
  const transform = useRef<ZoomTransform>(zoomIdentity);
  const zoomRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const hover = useRef<SimNode | null>(null);
  const size = useRef({ w: 800, h: 600, dpr: 1 });
  const frame = useRef<number | null>(null);
  const live = useRef(props);
  const labelAlpha = useRef(0);
  const fitted = useRef(false);
  live.current = props;

  // ------------------------------------------------------------------ drawing
  const draw = () => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = size.current;
    const t = transform.current;
    const p = live.current;
    const s = p.settings;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const focusNode = hover.current ?? (p.selectedId ? byId.current.get(p.selectedId) ?? null : null);
    const focusSet = focusNode ? new Set([focusNode.id, ...(neighbours.current.get(focusNode.id) ?? [])]) : null;
    const hl = p.highlight && p.highlight.size ? p.highlight : null;
    const dimmed = (id: string) => (focusSet ? !focusSet.has(id) : hl ? !hl.has(id) : false);

    // links
    const lw = (0.9 * s.linkThickness) / Math.max(0.6, Math.sqrt(t.k));
    ctx.lineWidth = lw;
    ctx.strokeStyle = focusSet || hl ? "rgba(180,180,190,0.06)" : EDGE;
    ctx.beginPath();
    for (const l of linksRef.current) {
      const a = l.source as SimNode;
      const b = l.target as SimNode;
      if (focusSet && (focusSet.has(a.id) && focusSet.has(b.id)) && (a.id === focusNode!.id || b.id === focusNode!.id)) continue;
      ctx.moveTo(a.x!, a.y!);
      ctx.lineTo(b.x!, b.y!);
    }
    ctx.stroke();
    if (focusNode) {
      ctx.strokeStyle = "rgba(167,139,250,0.75)";
      ctx.lineWidth = lw * 1.4;
      ctx.beginPath();
      for (const l of linksRef.current) {
        const a = l.source as SimNode;
        const b = l.target as SimNode;
        if (a.id === focusNode.id || b.id === focusNode.id) {
          ctx.moveTo(a.x!, a.y!);
          ctx.lineTo(b.x!, b.y!);
        }
      }
      ctx.stroke();
    }
    if (s.showArrows && t.k > 0.9) {
      ctx.fillStyle = "rgba(180,180,190,0.35)";
      for (const l of linksRef.current) {
        const a = l.source as SimNode;
        const b = l.target as SimNode;
        const ang = Math.atan2(b.y! - a.y!, b.x! - a.x!);
        const ex = b.x! - Math.cos(ang) * (b.r + 1.5);
        const ey = b.y! - Math.sin(ang) * (b.r + 1.5);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(ang - 0.45) * 4, ey - Math.sin(ang - 0.45) * 4);
        ctx.lineTo(ex - Math.cos(ang + 0.45) * 4, ey - Math.sin(ang + 0.45) * 4);
        ctx.fill();
      }
    }

    // light blooms for newly discovered knowledge
    const now = performance.now();
    let animating = false;
    if (p.bloom?.size) {
      for (const [id, start] of p.bloom) {
        const n = byId.current.get(id);
        const age = (now - start) / 2600;
        if (!n || age >= 1) continue;
        animating = true;
        const a = Math.sin(Math.PI * Math.min(1, age * 1.4)) * (1 - age);
        const R = n.r * (3.5 + age * 5);
        const g = ctx.createRadialGradient(n.x!, n.y!, n.r * 0.5, n.x!, n.y!, R);
        g.addColorStop(0, `rgba(196,181,253,${0.55 * a})`);
        g.addColorStop(1, "rgba(167,139,250,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, R, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // nodes
    for (const n of nodesRef.current) {
      const dim = dimmed(n.id);
      let fill = s.colorBy === "none" ? NODE : n.color;
      if (focusNode && n.id === focusNode.id) fill = ACCENT;
      else if (focusSet?.has(n.id)) fill = "#E6E6EA";
      else if (hl?.has(n.id)) fill = ACCENT_SOFT;
      ctx.globalAlpha = dim ? 0.16 : n.status && n.status !== "active" ? 0.45 : 1;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
      ctx.fill();
      if (n.id === p.selectedId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.6 / t.k;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r + 3 / t.k, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (n.flags?.includes("possible_conflict") && !dim) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = "#E8C37A";
        ctx.beginPath();
        ctx.arc(n.x! + n.r * 0.75, n.y! - n.r * 0.75, Math.max(1.4, n.r * 0.32), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // labels fade in with zoom, like Obsidian
    if (s.showLabels && !p.compact) {
      const target = Math.max(0, Math.min(1, (t.k - s.textFadeThreshold * 0.75) / (s.textFadeThreshold * 0.35)));
      labelAlpha.current += (target - labelAlpha.current) * 0.25;
      if (Math.abs(target - labelAlpha.current) > 0.01) animating = true;
      const fontPx = 11.5 / t.k;
      ctx.font = `450 ${fontPx}px "Geist Variable", "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of nodesRef.current) {
        const isFocus = focusSet?.has(n.id) || n.id === p.selectedId;
        const bigEnough = n.r * t.k > 9;
        let a = isFocus ? 1 : Math.max(labelAlpha.current, bigEnough ? 0.85 : 0);
        if (focusSet && !focusSet.has(n.id)) a *= 0.15;
        else if (hl && !hl.has(n.id) && !isFocus) a *= 0.2;
        if (a < 0.03) continue;
        const sx = n.x! * t.k + t.x;
        const sy = n.y! * t.k + t.y;
        if (sx < -200 || sx > w + 200 || sy < -40 || sy > h + 40) continue;
        ctx.globalAlpha = a;
        ctx.fillStyle = isFocus ? "#F5F5F7" : "#9898A8";
        const label = n.title.length > 42 ? n.title.slice(0, 40) + "…" : n.title;
        ctx.fillText(label, n.x!, n.y! + n.r + 3 / t.k);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (animating) requestDraw();
  };

  const requestDraw = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      draw();
    });
  };

  // ------------------------------------------------------------------ helpers
  const toGraph = (clientX: number, clientY: number) => {
    const rect = canvas.current!.getBoundingClientRect();
    const t = transform.current;
    return { x: (clientX - rect.left - t.x) / t.k, y: (clientY - rect.top - t.y) / t.k };
  };

  const findAt = (clientX: number, clientY: number): SimNode | null => {
    const p = toGraph(clientX, clientY);
    const slack = 6 / transform.current.k;
    let best: SimNode | null = null;
    let bestD = Infinity;
    for (const n of nodesRef.current) {
      const dx = n.x! - p.x;
      const dy = n.y! - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= n.r + slack && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  };

  const savePositions = () => {
    live.current.onPositions?.(nodesRef.current.map((n) => ({ id: n.id, x: n.x!, y: n.y! })));
  };

  const fit = (animate = true) => {
    const ns = nodesRef.current;
    if (!ns.length || !zoomRef.current || !canvas.current) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x!); maxX = Math.max(maxX, n.x!); minY = Math.min(minY, n.y!); maxY = Math.max(maxY, n.y!);
    }
    const { w, h } = size.current;
    const pad = live.current.compact ? 24 : 80;
    const k = Math.max(0.12, Math.min(2.4, Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY))));
    const target = zoomIdentity.translate(w / 2 - ((minX + maxX) / 2) * k, h / 2 - ((minY + maxY) / 2) * k).scale(k);
    tweenTo(target, animate ? 500 : 0);
  };

  const tweenTo = (target: ZoomTransform, ms: number) => {
    const z = zoomRef.current;
    const c = canvas.current;
    if (!z || !c) return;
    const sel = select(c);
    if (ms <= 0 || live.current.settings.animate === false) {
      z.transform(sel, target);
      return;
    }
    const from = transform.current;
    const start = performance.now();
    const step = () => {
      const u = Math.min(1, (performance.now() - start) / ms);
      const e = 1 - Math.pow(1 - u, 3);
      z.transform(sel, zoomIdentity.translate(from.x + (target.x - from.x) * e, from.y + (target.y - from.y) * e).scale(from.k + (target.k - from.k) * e));
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  useImperativeHandle(ref, () => ({
    focus: (id, scale = 2.2) => {
      const n = byId.current.get(id);
      if (!n) return;
      const { w, h } = size.current;
      tweenTo(zoomIdentity.translate(w / 2 - n.x! * scale, h / 2 - n.y! * scale).scale(scale), 600);
    },
    fit: () => fit(true),
    zoomBy: (f) => {
      const t = transform.current;
      const { w, h } = size.current;
      const k = Math.max(0.08, Math.min(8, t.k * f));
      tweenTo(zoomIdentity.translate(w / 2 - ((w / 2 - t.x) / t.k) * k, h / 2 - ((h / 2 - t.y) / t.k) * k).scale(k), 250);
    },
    unpin: (id) => {
      const n = byId.current.get(id);
      if (!n) return;
      n.fx = null;
      n.fy = null;
      n.pinned = false;
      live.current.onPositions?.([{ id, x: n.x!, y: n.y!, pinned: false }]);
      sim.current?.alpha(0.3).restart();
    },
    reheat: () => sim.current?.alpha(0.8).restart(),
  }));

  // ------------------------------------------------------------------ setup (once)
  useEffect(() => {
    const c = canvas.current!;
    const resize = () => {
      const r = wrap.current!.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size.current = { w: r.width, h: r.height, dpr };
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
      requestDraw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap.current!);
    resize();

    const s = forceSimulation<SimNode, SimLink>([])
      .alphaDecay(0.028)
      .velocityDecay(0.42)
      .on("tick", () => {
        requestDraw();
        if (!fitted.current && s.alpha() < 0.12 && nodesRef.current.length) {
          fitted.current = true;
          fit(true);
        }
      })
      .on("end", () => {
        savePositions();
        if (!fitted.current) {
          fitted.current = true;
          fit(true);
        }
      });
    sim.current = s;

    const z = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.08, 8])
      .filter((e: any) => (!e.ctrlKey || e.type === "wheel") && !e.button && !(e.type === "mousedown" && findAt(e.clientX, e.clientY)))
      .on("zoom", (e) => {
        transform.current = e.transform;
        requestDraw();
      });
    zoomRef.current = z;
    const sel = select(c);
    sel.call(z).on("dblclick.zoom", null);
    // Start centred on the origin (where the layout is built) until the first fit.
    z.transform(sel, zoomIdentity.translate(size.current.w / 2, size.current.h / 2).scale(live.current.compact ? 0.7 : 1));

    if (!live.current.compact) {
      const dr = d3drag<HTMLCanvasElement, unknown, SimNode | undefined>()
        .subject((e: any) => findAt(e.sourceEvent.clientX, e.sourceEvent.clientY) ?? undefined)
        .on("start", (e) => {
          const n = e.subject as SimNode;
          if (!n) return;
          if (!e.active) s.alphaTarget(0.25).restart();
          n.fx = n.x;
          n.fy = n.y;
        })
        .on("drag", (e) => {
          const n = e.subject as SimNode;
          if (!n) return;
          const p = toGraph(e.sourceEvent.clientX, e.sourceEvent.clientY);
          n.fx = p.x;
          n.fy = p.y;
          hover.current = n;
        })
        .on("end", (e) => {
          const n = e.subject as SimNode;
          if (!n) return;
          if (!e.active) s.alphaTarget(0);
          n.pinned = true;
          live.current.onPositions?.([{ id: n.id, x: n.fx!, y: n.fy!, pinned: true }]);
        });
      sel.call(dr as any);
    }

    const onMove = (e: MouseEvent) => {
      const n = findAt(e.clientX, e.clientY);
      if (n !== hover.current) {
        hover.current = n;
        c.style.cursor = n ? "pointer" : "default";
        live.current.onHover?.(n);
        requestDraw();
      }
    };
    const onLeave = () => {
      if (hover.current) {
        hover.current = null;
        live.current.onHover?.(null);
        requestDraw();
      }
    };
    let downAt = { x: 0, y: 0 };
    const onDown = (e: MouseEvent) => (downAt = { x: e.clientX, y: e.clientY });
    const onClick = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      const n = findAt(e.clientX, e.clientY);
      live.current.onSelect?.(n ? n.id : null);
    };
    const onDbl = (e: MouseEvent) => {
      const n = findAt(e.clientX, e.clientY);
      if (n) live.current.onFocus?.(n.id);
    };
    const onCtx = (e: MouseEvent) => {
      const n = findAt(e.clientX, e.clientY);
      if (!n) return;
      e.preventDefault();
      live.current.onContext?.(n.id, e.clientX, e.clientY);
    };
    c.addEventListener("mousemove", onMove);
    c.addEventListener("mouseleave", onLeave);
    c.addEventListener("mousedown", onDown, true); // capture: d3-drag stops propagation of mousedown
    c.addEventListener("click", onClick);
    c.addEventListener("dblclick", onDbl);
    c.addEventListener("contextmenu", onCtx);
    return () => {
      ro.disconnect();
      s.stop();
      c.removeEventListener("mousemove", onMove);
      c.removeEventListener("mouseleave", onLeave);
      c.removeEventListener("mousedown", onDown, true);
      c.removeEventListener("click", onClick);
      c.removeEventListener("dblclick", onDbl);
      c.removeEventListener("contextmenu", onCtx);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------ incremental data updates
  useEffect(() => {
    const s = sim.current!;
    const st = props.settings;
    const prev = byId.current;
    const next = new Map<string, SimNode>();
    const nb = new Map<string, Set<string>>();
    for (const l of props.links) {
      if (!nb.has(l.source_id)) nb.set(l.source_id, new Set());
      if (!nb.has(l.target_id)) nb.set(l.target_id, new Set());
      nb.get(l.source_id)!.add(l.target_id);
      nb.get(l.target_id)!.add(l.source_id);
    }
    let fresh = 0;
    let placed = 0;
    for (const d of props.nodes) {
      const old = prev.get(d.id);
      const color = st.colorBy === "category" ? CATEGORY_COLOR[d.category] ?? NODE : st.colorBy === "project" ? props.projectColors?.get(d.project_id ?? "") ?? NODE : NODE;
      if (old) {
        Object.assign(old, d, { x: old.x, y: old.y, r: radius(d, st.nodeSize), color });
        if (d.pinned && d.x != null && d.y != null && old.fx == null) {
          old.fx = old.x;
          old.fy = old.y;
        }
        next.set(d.id, old);
        continue;
      }
      const n: SimNode = { ...d, x: undefined, y: undefined, r: radius(d, st.nodeSize), color } as SimNode;
      if (d.x != null && d.y != null) {
        n.x = d.x;
        n.y = d.y;
        placed++;
        if (d.pinned) {
          n.fx = d.x;
          n.fy = d.y;
        }
      } else {
        // Enter next to an already-placed neighbour, so new knowledge appears where it belongs.
        const anchor = [...(nb.get(d.id) ?? [])].map((id) => prev.get(id) ?? next.get(id)).find((x) => x && x.x != null);
        const ang = Math.random() * Math.PI * 2;
        const dist = anchor ? 18 + Math.random() * 14 : 60 + Math.random() * 220;
        n.x = (anchor?.x ?? 0) + Math.cos(ang) * dist;
        n.y = (anchor?.y ?? 0) + Math.sin(ang) * dist;
        fresh++;
      }
      next.set(d.id, n);
    }
    byId.current = next;
    neighbours.current = nb;
    nodesRef.current = [...next.values()];
    linksRef.current = props.links
      .filter((l) => next.has(l.source_id) && next.has(l.target_id))
      .map((l) => ({ id: l.id, type: l.type, strength: l.strength, source: next.get(l.source_id)!, target: next.get(l.target_id)! }));

    s.nodes(nodesRef.current);
    s.force(
      "link",
      forceLink<SimNode, SimLink>(linksRef.current)
        .id((d) => d.id)
        .distance((l) => st.linkDistance + ((l.source as SimNode).r + (l.target as SimNode).r))
        .strength((l) => st.linkForce * (0.6 + 0.4 * l.strength) / Math.sqrt(Math.min(nb.get((l.source as SimNode).id)?.size ?? 1, nb.get((l.target as SimNode).id)?.size ?? 1))),
    );
    s.force("charge", forceManyBody<SimNode>().strength(-st.repelForce).distanceMax(700).theta(0.9));
    s.force("x", forceX<SimNode>(0).strength(st.centerForce * 0.5));
    s.force("y", forceY<SimNode>(0).strength(st.centerForce * 0.5));
    s.force("collide", forceCollide<SimNode>((d) => d.r + 2).iterations(1));

    const total = nodesRef.current.length;
    const firstLoad = prev.size === 0;
    if (!st.animate) {
      s.stop();
      if (fresh > 0 || firstLoad) for (let i = 0; i < Math.min(400, 60 + total); i++) s.tick();
      requestDraw();
      savePositions();
      if (!fitted.current) {
        fitted.current = true;
        fit(false);
      }
    } else if (firstLoad) {
      // Saved layout: settle gently instead of re-generating the graph.
      s.alpha(placed / Math.max(1, total) > 0.8 ? 0.12 : 1).restart();
      if (placed / Math.max(1, total) > 0.8 && !fitted.current) {
        fitted.current = true;
        requestAnimationFrame(() => fit(false));
      }
    } else if (fresh > 0 || prev.size !== next.size) {
      s.alpha(Math.min(0.5, 0.15 + fresh * 0.05)).restart();
    } else requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nodes, props.links, props.settings.linkDistance, props.settings.linkForce, props.settings.repelForce, props.settings.centerForce, props.settings.nodeSize, props.settings.colorBy, props.settings.animate]);

  useEffect(() => {
    if (props.settings.animate && sim.current && nodesRef.current.length && byId.current.size) sim.current.alpha(Math.max(sim.current.alpha(), 0.3)).restart();
  }, [props.settings.linkDistance, props.settings.linkForce, props.settings.repelForce, props.settings.centerForce]);

  useEffect(requestDraw, [props.selectedId, props.highlight, props.bloom, props.settings.showLabels, props.settings.textFadeThreshold, props.settings.linkThickness, props.settings.showArrows]);

  return (
    <div ref={wrap} className="absolute inset-0 overflow-hidden" style={{ background: BG }}>
      <canvas ref={canvas} className="block" aria-label="Knowledge graph" role="img" />
    </div>
  );
});
