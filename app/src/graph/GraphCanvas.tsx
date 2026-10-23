// The Mind: an Obsidian-style force-directed graph on <canvas> (d3-force + d3-zoom).
// Every node is a real memory and every line a real relationship.
//
// Rendering (v0.2.6 "Awakening"):
//  - Small soft-white nodes with a subtle luminosity. Glow is drawn from two cached radial-gradient sprites
//    (white and lavender) with additive blending: no per-frame blur, no shadowBlur.
//  - Every visual state (hover, selection, neighbours, dimming, label fade) is an eased value per node/edge,
//    so changes fade in and out instead of switching.
//  - The animation loop runs only while something is moving (simulation, easing, real events) and stops when
//    the page is hidden; an optional low-rate ambient shimmer exists only in the "full" motion level.
//  - Layout: link + many-body + collision forces, plus a gentle pull toward a per-project anchor computed from
//    real project membership, so projects form readable clusters instead of one central blob.
//  - Living graph: real "memory created / updated / linked" events fade nodes in, reveal edges and send a
//    restrained pulse along new connections. Nothing is simulated.
import { drag as d3drag } from "d3-drag";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { quadtree, type Quadtree } from "d3-quadtree";
import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { motionLevel } from "../lib/motion";
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

export type MotionLevel = "full" | "balanced" | "minimal";

interface SimNode extends SimulationNodeDatum, Omit<GraphNodeData, "x" | "y"> {
  r: number;
  color: string;
  // eased visual state
  glow: number;
  hi: number; // 1 = highlighted (focus or neighbour)
  dim: number; // 1 = dimmed
  grow: number; // hover/selection size boost (0..1)
  appearAt: number; // performance.now() when it entered (fade/scale in), 0 = no entrance
  pulseAt: number; // last real update pulse
  phase: number; // ambient shimmer phase
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  id: string;
  type: string;
  strength: number;
  hi: number;
  bornAt: number; // reveal + pulse for new relationships
}

export interface GraphHandle {
  focus: (id: string, scale?: number) => void;
  center: (id: string) => void;
  fit: () => void;
  fitIds: (ids: string[]) => void;
  zoomBy: (f: number) => void;
  unpin: (id: string) => void;
  reheat: () => void;
  /** Real backend events (from the change feed). */
  markNew: (ids: string[]) => void;
  markNewLinks: (ids: string[]) => void;
  pulse: (ids: string[]) => void;
  stats: () => { nodes: number; links: number; frames: number; lastFrameMs: number; running: boolean };
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
  motion?: MotionLevel;
  clusterByProject?: boolean;
  onSelect?: (id: string | null) => void;
  onFocus?: (id: string) => void;
  onContext?: (id: string, x: number, y: number) => void;
  onHover?: (node: GraphNodeData | null) => void;
  onPositions?: (items: { id: string; x: number; y: number; pinned?: boolean }[]) => void;
}

const BG = "#1C1C1C";
const NODE = "#C9C9D0";
const NODE_HUB = "#D9D3F5";
const ACCENT = "#A78BFA";
const ACCENT_SOFT = "#C4B5FD";

function radius(n: GraphNodeData, size: number): number {
  const base = n.category === "project" ? 5 : 2.6;
  return (base + Math.sqrt(Math.max(0, n.degree)) * 1.05 + n.importance * 0.9) * size;
}

/** Radial glow sprite, rendered once and reused for every node (cheap drawImage instead of blur). */
function makeSprite(rgb: string): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, `rgba(${rgb},0.85)`);
  grad.addColorStop(0.18, `rgba(${rgb},0.42)`);
  grad.addColorStop(0.45, `rgba(${rgb},0.12)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return c;
}

const approach = (cur: number, target: number, k: number) => {
  const v = cur + (target - cur) * k;
  return Math.abs(target - v) < 0.002 ? target : v;
};

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
  const lastFrame = useRef(0);
  const sprites = useRef<{ white: HTMLCanvasElement; lavender: HTMLCanvasElement } | null>(null);
  const tree = useRef<{ q: Quadtree<SimNode>; version: number } | null>(null);
  const posVersion = useRef(0);
  const pendingNew = useRef(new Map<string, number>());
  const pendingLinks = useRef(new Map<string, number>());
  const counters = useRef({ frames: 0, lastFrameMs: 0 });
  const ambientTimer = useRef<number | null>(null);
  live.current = props;

  const motion = (): MotionLevel => {
    const m = live.current.motion ?? motionLevel();
    return live.current.settings.animate === false ? "minimal" : m;
  };

  // ------------------------------------------------------------------ drawing
  const draw = (now: number) => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const t0 = performance.now();
    if (!sprites.current) sprites.current = { white: makeSprite("236,234,255"), lavender: makeSprite("167,139,250") };
    const { w, h, dpr } = size.current;
    const t = transform.current;
    const p = live.current;
    const s = p.settings;
    const m = motion();
    const dt = lastFrame.current ? Math.min(64, now - lastFrame.current) : 16;
    lastFrame.current = now;
    // Easing rate: ~120 ms to settle for hover; minimal motion = instant.
    const k = m === "minimal" ? 1 : 1 - Math.exp(-dt / 70);
    let moving = false;

    const focusNode = hover.current ?? (p.selectedId ? byId.current.get(p.selectedId) ?? null : null);
    const nb = focusNode ? neighbours.current.get(focusNode.id) : null;
    const hl = p.highlight && p.highlight.size ? p.highlight : null;

    // ---- advance eased states
    for (const n of nodesRef.current) {
      const isFocus = !!focusNode && n.id === focusNode.id;
      const isSel = n.id === p.selectedId;
      const isNb = !!nb?.has(n.id);
      const tHi = isFocus || isNb || !!hl?.has(n.id) ? 1 : 0;
      const tDim = focusNode ? (isFocus || isNb ? 0 : 1) : hl ? (hl.has(n.id) ? 0 : 1) : 0;
      const tGlow = isSel ? 1 : isFocus ? 0.85 : isNb ? 0.32 : 0;
      const tGrow = isFocus ? 1 : isSel ? 0.6 : 0;
      const before = n.glow + n.hi + n.dim + n.grow;
      n.glow = approach(n.glow, tGlow, k);
      n.hi = approach(n.hi, tHi, k);
      n.dim = approach(n.dim, tDim, k);
      n.grow = approach(n.grow, tGrow, k);
      if (n.glow + n.hi + n.dim + n.grow !== before) moving = true;
    }
    for (const l of linksRef.current) {
      const a = l.source as SimNode;
      const b = l.target as SimNode;
      const tHi = focusNode && (a.id === focusNode.id || b.id === focusNode.id) ? 1 : hl && hl.has(a.id) && hl.has(b.id) ? 0.6 : 0;
      const before = l.hi;
      l.hi = approach(l.hi, tHi, k);
      if (l.hi !== before) moving = true;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const anyFocus = !!focusNode || !!hl;
    const zoomedOut = t.k < 0.35;

    // ---- edges: one batched pass for ordinary edges, individual passes only for highlighted/new ones
    const lw = (0.75 * s.linkThickness) / Math.max(0.55, Math.sqrt(t.k));
    let dimMix = 0;
    if (focusNode || hl) {
      let sum = 0;
      for (const n of nodesRef.current) sum += n.dim;
      dimMix = nodesRef.current.length ? Math.min(1, (sum / nodesRef.current.length) * 1.6) : 0;
    }
    const baseEdgeA = (zoomedOut ? 0.1 : 0.16) * (1 - 0.72 * dimMix);
    ctx.lineWidth = lw;
    ctx.strokeStyle = `rgba(190,190,205,${baseEdgeA})`;
    ctx.beginPath();
    const special: SimLink[] = [];
    for (const l of linksRef.current) {
      if (l.hi > 0.01 || (l.bornAt && now - l.bornAt < 1800)) {
        special.push(l);
        continue;
      }
      const a = l.source as SimNode;
      const b = l.target as SimNode;
      ctx.moveTo(a.x!, a.y!);
      ctx.lineTo(b.x!, b.y!);
    }
    ctx.stroke();
    for (const l of special) {
      const a = l.source as SimNode;
      const b = l.target as SimNode;
      let reveal = 1;
      if (l.bornAt) {
        const age = now - l.bornAt;
        if (age < 1800) {
          moving = true;
          reveal = m === "minimal" ? 1 : Math.min(1, age / 650);
        }
      }
      const ex = a.x! + (b.x! - a.x!) * reveal;
      const ey = a.y! + (b.y! - a.y!) * reveal;
      const alpha = Math.max(baseEdgeA, 0.16 + 0.55 * l.hi) * (l.bornAt && now - l.bornAt < 1800 ? 1 : 1);
      ctx.strokeStyle = l.hi > 0.5 ? `rgba(196,181,253,${alpha})` : `rgba(205,200,235,${Math.max(alpha, 0.3)})`;
      ctx.lineWidth = lw * (1 + 0.5 * l.hi);
      ctx.beginPath();
      ctx.moveTo(a.x!, a.y!);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
    if (s.showArrows && t.k > 0.9) {
      ctx.fillStyle = `rgba(190,190,205,${0.3 * (1 - 0.7 * dimMix)})`;
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

    // ---- glow (additive), behind the node cores
    const sp = sprites.current;
    ctx.globalCompositeOperation = "lighter";
    const idleGlow = m === "full" ? 0.16 : m === "balanced" ? 0.1 : 0;
    const shimmer = m === "full";
    for (const n of nodesRef.current) {
      let g = n.glow;
      // Real-event light: new memories and updates.
      if (n.appearAt) {
        const age = now - n.appearAt;
        if (age < 2600) {
          moving = true;
          g = Math.max(g, Math.sin(Math.PI * Math.min(1, age / 2600)) * 0.95);
        } else n.appearAt = 0;
      }
      if (n.pulseAt) {
        const age = now - n.pulseAt;
        if (age < 1500) {
          moving = true;
          g = Math.max(g, (1 - age / 1500) * 0.8);
        } else n.pulseAt = 0;
      }
      let idle = 0;
      if (idleGlow && !zoomedOut && n.dim < 0.5) {
        idle = idleGlow * (0.5 + n.importance * 0.7) * (n.category === "project" ? 1.4 : 1);
        if (shimmer) idle *= 0.85 + 0.15 * Math.sin(now / 2400 + n.phase);
      }
      const intensity = Math.max(g, idle) * (1 - 0.85 * n.dim);
      if (intensity < 0.01) continue;
      let R = Math.max(n.r * (3.4 + 2.6 * n.glow + n.grow * 0.6), (6 + 14 * Math.max(n.glow, g * 0.8)) / Math.max(0.5, t.k));
      // A real new memory or update briefly lights up its surroundings.
      if ((n.appearAt || n.pulseAt) && m !== "minimal") R = Math.max(R, (22 + 26 * g) / Math.max(0.5, t.k));
      const sprite = n.glow > 0.5 || n.id === p.selectedId || (n.appearAt && m !== "minimal") ? sp.lavender : sp.white;
      ctx.globalAlpha = Math.min(1, intensity);
      ctx.drawImage(sprite, n.x! - R, n.y! - R, R * 2, R * 2);
    }
    ctx.globalCompositeOperation = "source-over";

    // ---- pulses travelling along new relationships (real events only)
    if (m !== "minimal") {
      for (const l of special) {
        if (!l.bornAt) continue;
        const age = now - l.bornAt;
        if (age > 1800) continue;
        const a = l.source as SimNode;
        const b = l.target as SimNode;
        const u = Math.min(1, Math.max(0, (age - 300) / 1100));
        if (u <= 0 || u >= 1) continue;
        const x = a.x! + (b.x! - a.x!) * u;
        const y = a.y! + (b.y! - a.y!) * u;
        const R = 7 / Math.max(0.6, Math.sqrt(t.k));
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = Math.sin(Math.PI * u) * 0.9;
        ctx.drawImage(sp.lavender, x - R, y - R, R * 2, R * 2);
        ctx.globalCompositeOperation = "source-over";
      }
    }

    // ---- node cores
    for (const n of nodesRef.current) {
      let scale = 1 + 0.28 * n.grow;
      let alpha = 1 - 0.8 * n.dim;
      if (n.appearAt) {
        const age = now - n.appearAt;
        const u = m === "minimal" ? 1 : Math.min(1, age / 700);
        const e = 1 - Math.pow(1 - u, 3);
        scale *= 0.2 + 0.8 * e;
        alpha *= e;
      }
      if (n.status && n.status !== "active") alpha *= 0.45;
      let fill = s.colorBy === "none" ? (n.category === "project" ? NODE_HUB : NODE) : n.color;
      if (n.id === p.selectedId) fill = ACCENT_SOFT;
      else if (focusNode && n.id === focusNode.id) fill = "#FFFFFF";
      else if (hl?.has(n.id) && !focusNode) fill = ACCENT_SOFT;
      else if (n.hi > 0.5) fill = "#EDEDF2";
      ctx.globalAlpha = Math.max(0.06, alpha);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r * scale, 0, Math.PI * 2);
      ctx.fill();
      if (n.id === p.selectedId) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.3 / t.k;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r * scale + 3.2 / t.k, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (n.flags?.includes("possible_conflict") && n.dim < 0.5) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = "#E8C37A";
        ctx.beginPath();
        ctx.arc(n.x! + n.r * 0.75, n.y! - n.r * 0.75, Math.max(1.2, n.r * 0.32), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // ---- labels: fade in with zoom like Obsidian; important nodes keep theirs a bit longer
    if (s.showLabels && !p.compact) {
      const target = Math.max(0, Math.min(1, (t.k - s.textFadeThreshold * 0.75) / (s.textFadeThreshold * 0.35)));
      const before = labelAlpha.current;
      labelAlpha.current = approach(labelAlpha.current, target, m === "minimal" ? 1 : 0.25);
      if (labelAlpha.current !== before) moving = true;
      const fontPx = 11.5 / t.k;
      ctx.font = `450 ${fontPx}px "Geist Variable", "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of nodesRef.current) {
        const isFocus = n.hi > 0.5 || n.id === p.selectedId;
        const bigEnough = n.r * t.k > 8.5;
        let a = isFocus ? Math.max(n.hi, n.id === p.selectedId ? 1 : 0) : Math.max(labelAlpha.current, bigEnough ? 0.8 : 0);
        a *= 1 - 0.85 * n.dim;
        if (a < 0.03) continue;
        const sx = n.x! * t.k + t.x;
        const sy = n.y! * t.k + t.y;
        if (sx < -200 || sx > w + 200 || sy < -40 || sy > h + 40) continue;
        ctx.globalAlpha = a;
        ctx.fillStyle = isFocus ? "#F5F5F7" : "#9C9CAC";
        const label = n.title.length > 42 ? n.title.slice(0, 40) + "…" : n.title;
        ctx.fillText(label, n.x!, n.y! + n.r * (1 + 0.28 * n.grow) + 3.5 / t.k);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // ---- tooltip (screen space) for the hovered node
    const hv = hover.current;
    if (hv && !p.compact && hv.grow > 0.05) {
      const sx = hv.x! * t.k + t.x;
      const sy = hv.y! * t.k + t.y - hv.r * t.k * 1.3 - 12;
      const title = hv.title.length > 60 ? hv.title.slice(0, 58) + "…" : hv.title;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `500 12px "Geist Variable", "Segoe UI", system-ui, sans-serif`;
      const tw = ctx.measureText(title).width;
      const bw = tw + 18;
      const bx = Math.max(6, Math.min(w - bw - 6, sx - bw / 2));
      const by = Math.max(6, sy - 24);
      ctx.globalAlpha = Math.min(1, hv.grow * 1.4);
      ctx.fillStyle = "rgba(22,22,28,0.94)";
      ctx.strokeStyle = "rgba(167,139,250,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, 24, 7);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#F2F1F7";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(title, bx + 9, by + 12.5);
      ctx.globalAlpha = 1;
    }

    counters.current.frames++;
    counters.current.lastFrameMs = performance.now() - t0;
    if (moving && !document.hidden) requestDraw();
  };

  const requestDraw = () => {
    if (frame.current !== null || document.hidden) return;
    frame.current = requestAnimationFrame((ts) => {
      frame.current = null;
      draw(ts);
    });
  };

  // ------------------------------------------------------------------ helpers
  const toGraph = (clientX: number, clientY: number) => {
    const rect = canvas.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const t = transform.current;
    return { x: (clientX - rect.left - t.x) / t.k, y: (clientY - rect.top - t.y) / t.k };
  };

  /** Spatial index for hit testing; rebuilt only when positions changed. */
  const findAt = (clientX: number, clientY: number): SimNode | null => {
    const p = toGraph(clientX, clientY);
    if (!tree.current || tree.current.version !== posVersion.current) {
      tree.current = { q: quadtree<SimNode>().x((d) => d.x!).y((d) => d.y!).addAll(nodesRef.current), version: posVersion.current };
    }
    const slack = 6 / transform.current.k;
    const maxR = 14 * (live.current.settings.nodeSize || 1);
    const cand = tree.current.q.find(p.x, p.y, maxR + slack);
    if (!cand) return null;
    // Prefer the closest node whose disc (plus slack) contains the point.
    let best: SimNode | null = null;
    let bestD = Infinity;
    tree.current.q.visit((node, x0, y0, x1, y1) => {
      if (!("length" in node)) {
        let d: any = node;
        do {
          const n = d.data as SimNode;
          const dist = Math.hypot(n.x! - p.x, n.y! - p.y);
          if (dist <= n.r + slack && dist < bestD) {
            best = n;
            bestD = dist;
          }
          d = d.next;
        } while (d);
      }
      return x0 > p.x + maxR + slack || x1 < p.x - maxR - slack || y0 > p.y + maxR + slack || y1 < p.y - maxR - slack;
    });
    return best;
  };

  const savePositions = () => {
    live.current.onPositions?.(nodesRef.current.map((n) => ({ id: n.id, x: n.x!, y: n.y! })));
  };

  const boundsOf = (ns: SimNode[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x!); maxX = Math.max(maxX, n.x!); minY = Math.min(minY, n.y!); maxY = Math.max(maxY, n.y!);
    }
    return { minX, minY, maxX, maxY };
  };

  const fitNodes = (ns: SimNode[], animate = true, maxK = 2.4) => {
    if (!ns.length || !zoomRef.current || !canvas.current) return;
    const { minX, minY, maxX, maxY } = boundsOf(ns);
    const { w, h } = size.current;
    const pad = live.current.compact ? 24 : 90;
    const k = Math.max(0.1, Math.min(maxK, Math.min((w - pad * 2) / Math.max(1, maxX - minX), (h - pad * 2) / Math.max(1, maxY - minY))));
    tweenTo(zoomIdentity.translate(w / 2 - ((minX + maxX) / 2) * k, h / 2 - ((minY + maxY) / 2) * k).scale(k), animate ? 650 : 0);
  };
  const fit = (animate = true) => fitNodes(nodesRef.current, animate);

  const tweenTo = (target: ZoomTransform, ms: number) => {
    const z = zoomRef.current;
    const c = canvas.current;
    if (!z || !c) return;
    const sel = select(c);
    if (ms <= 0 || motion() === "minimal") {
      z.transform(sel, target);
      return;
    }
    const from = transform.current;
    const start = performance.now();
    const step = () => {
      const u = Math.min(1, (performance.now() - start) / ms);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; // ease-in-out cubic
      // Interpolate zoom geometrically so zoom changes feel even.
      const kk = from.k * Math.pow(target.k / from.k, e);
      const cxFrom = (size.current.w / 2 - from.x) / from.k;
      const cyFrom = (size.current.h / 2 - from.y) / from.k;
      const cxTo = (size.current.w / 2 - target.x) / target.k;
      const cyTo = (size.current.h / 2 - target.y) / target.k;
      const cx = cxFrom + (cxTo - cxFrom) * e;
      const cy = cyFrom + (cyTo - cyFrom) * e;
      z.transform(sel, zoomIdentity.translate(size.current.w / 2 - cx * kk, size.current.h / 2 - cy * kk).scale(kk));
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const centerOn = (id: string, scale?: number) => {
    const n = byId.current.get(id);
    if (!n) return;
    const { w, h } = size.current;
    const k = scale ?? Math.max(transform.current.k, 1.1);
    tweenTo(zoomIdentity.translate(w / 2 - n.x! * k, h / 2 - n.y! * k).scale(k), 650);
  };

  useImperativeHandle(ref, () => ({
    focus: (id, scale = 2.2) => centerOn(id, scale),
    center: (id) => centerOn(id),
    fit: () => fit(true),
    fitIds: (ids) => fitNodes(ids.map((i) => byId.current.get(i)).filter(Boolean) as SimNode[], true, 2.2),
    zoomBy: (f) => {
      const t = transform.current;
      const { w, h } = size.current;
      const k = Math.max(0.08, Math.min(8, t.k * f));
      tweenTo(zoomIdentity.translate(w / 2 - ((w / 2 - t.x) / t.k) * k, h / 2 - ((h / 2 - t.y) / t.k) * k).scale(k), 280);
    },
    unpin: (id) => {
      const n = byId.current.get(id);
      if (!n) return;
      n.fx = null;
      n.fy = null;
      n.pinned = false;
      live.current.onPositions?.([{ id, x: n.x!, y: n.y!, pinned: false }]);
      sim.current?.alpha(0.2).restart();
    },
    reheat: () => sim.current?.alpha(0.6).restart(),
    markNew: (ids) => {
      const now = performance.now();
      for (const id of ids) {
        const n = byId.current.get(id);
        if (n && !n.appearAt) n.pulseAt = now;
        else pendingNew.current.set(id, now);
      }
      requestDraw();
    },
    markNewLinks: (ids) => {
      const now = performance.now();
      for (const id of ids) {
        const l = linksRef.current.find((x) => x.id === id);
        if (l) l.bornAt = now;
        else pendingLinks.current.set(id, now);
      }
      requestDraw();
    },
    pulse: (ids) => {
      const now = performance.now();
      for (const id of ids) {
        const n = byId.current.get(id);
        if (n) n.pulseAt = now;
      }
      requestDraw();
    },
    stats: () => ({ nodes: nodesRef.current.length, links: linksRef.current.length, frames: counters.current.frames, lastFrameMs: counters.current.lastFrameMs, running: (sim.current?.alpha() ?? 0) > (sim.current?.alphaMin() ?? 0.001) }),
  }));

  // ------------------------------------------------------------------ setup (once)
  useEffect(() => {
    const c = canvas.current!;
    const resize = () => {
      if (!wrap.current) return;
      const r = wrap.current.getBoundingClientRect();
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
      .alphaDecay(0.032)
      .alphaMin(0.004)
      .velocityDecay(0.52) // more damping: no jitter, no flying nodes
      .on("tick", () => {
        posVersion.current++;
        requestDraw();
        if (!fitted.current && s.alpha() < 0.1 && nodesRef.current.length) {
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
      .scaleExtent([0.06, 8])
      .filter((e: any) => (!e.ctrlKey || e.type === "wheel") && !e.button && !(e.type === "mousedown" && findAt(e.clientX, e.clientY)))
      .wheelDelta((e: any) => -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.0016))
      .on("zoom", (e) => {
        transform.current = e.transform;
        requestDraw();
      });
    zoomRef.current = z;
    const sel = select(c);
    sel.call(z).on("dblclick.zoom", null);
    z.transform(sel, zoomIdentity.translate(size.current.w / 2, size.current.h / 2).scale(live.current.compact ? 0.7 : 1));

    if (!live.current.compact) {
      const dr = d3drag<HTMLCanvasElement, unknown, SimNode | undefined>()
        .subject((e: any) => findAt(e.sourceEvent.clientX, e.sourceEvent.clientY) ?? undefined)
        .on("start", (e) => {
          const n = e.subject as SimNode;
          if (!n) return;
          if (!e.active) s.alphaTarget(0.18).restart();
          n.fx = n.x;
          n.fy = n.y;
          c.style.cursor = "grabbing";
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
          // Release and let the layout settle naturally (Obsidian behaviour); positions are saved on settle.
          if (!n.pinned) {
            n.fx = null;
            n.fy = null;
          } else live.current.onPositions?.([{ id: n.id, x: n.fx!, y: n.fy!, pinned: true }]);
          c.style.cursor = "pointer";
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
      if (n && !live.current.compact) centerOn(n.id);
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
    // No animation work while the window/page is hidden (MOTH in the tray, minimised, another page).
    const onVisibility = () => {
      if (document.hidden) {
        s.stop();
        if (frame.current) cancelAnimationFrame(frame.current);
        frame.current = null;
      } else {
        if (s.alpha() > s.alphaMin()) s.restart();
        requestDraw();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    c.addEventListener("mousemove", onMove);
    c.addEventListener("mouseleave", onLeave);
    c.addEventListener("mousedown", onDown, true); // capture: d3-drag stops propagation of mousedown
    c.addEventListener("click", onClick);
    c.addEventListener("dblclick", onDbl);
    c.addEventListener("contextmenu", onCtx);
    return () => {
      ro.disconnect();
      s.stop();
      document.removeEventListener("visibilitychange", onVisibility);
      c.removeEventListener("mousemove", onMove);
      c.removeEventListener("mouseleave", onLeave);
      c.removeEventListener("mousedown", onDown, true);
      c.removeEventListener("click", onClick);
      c.removeEventListener("dblclick", onDbl);
      c.removeEventListener("contextmenu", onCtx);
      if (frame.current) cancelAnimationFrame(frame.current);
      if (ambientTimer.current) clearInterval(ambientTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ambient shimmer only in "full" motion, at a low frame rate, and only while visible.
  useEffect(() => {
    if (ambientTimer.current) clearInterval(ambientTimer.current);
    ambientTimer.current = null;
    if ((props.motion ?? motionLevel()) === "full" && props.settings.animate !== false && !props.compact) {
      ambientTimer.current = window.setInterval(() => {
        if (!document.hidden) requestDraw();
      }, 1000 / 12);
    }
    return () => {
      if (ambientTimer.current) clearInterval(ambientTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.motion, props.settings.animate, props.compact]);

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
    const now = performance.now();
    const firstLoad = prev.size === 0;
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
        if (pendingNew.current.has(d.id)) {
          old.pulseAt = now;
          pendingNew.current.delete(d.id);
        }
        next.set(d.id, old);
        continue;
      }
      const n = { ...d, x: undefined, y: undefined, r: radius(d, st.nodeSize), color, glow: 0, hi: 0, dim: 0, grow: 0, appearAt: 0, pulseAt: 0, phase: Math.random() * Math.PI * 2 } as SimNode;
      if (d.x != null && d.y != null) {
        n.x = d.x;
        n.y = d.y;
        placed++;
        if (d.pinned) {
          n.fx = d.x;
          n.fy = d.y;
        }
      } else {
        // Enter next to an already-placed neighbour (or its project), so new knowledge appears where it belongs.
        const anchor = [...(nb.get(d.id) ?? [])].map((id) => prev.get(id) ?? next.get(id)).find((x) => x && x.x != null)
          ?? (d.project_id ? [...prev.values()].find((x) => x.project_id === d.project_id && x.x != null) : undefined);
        const ang = Math.random() * Math.PI * 2;
        const dist = anchor ? 16 + Math.random() * 12 : 40 + Math.random() * 120;
        n.x = (anchor?.x ?? 0) + Math.cos(ang) * dist;
        n.y = (anchor?.y ?? 0) + Math.sin(ang) * dist;
        fresh++;
      }
      // Entrance animation only for memories that really appeared after the graph was shown.
      if (!firstLoad || pendingNew.current.has(d.id)) n.appearAt = pendingNew.current.get(d.id) ?? now;
      pendingNew.current.delete(d.id);
      next.set(d.id, n);
    }
    const prevLinks = new Map(linksRef.current.map((l) => [l.id, l]));
    byId.current = next;
    neighbours.current = nb;
    nodesRef.current = [...next.values()];
    linksRef.current = props.links
      .filter((l) => next.has(l.source_id) && next.has(l.target_id))
      .map((l) => {
        const was = prevLinks.get(l.id);
        const bornAt = pendingLinks.current.get(l.id) ?? (!firstLoad && !was ? now : was?.bornAt ?? 0);
        pendingLinks.current.delete(l.id);
        return { id: l.id, type: l.type, strength: l.strength, source: next.get(l.source_id)!, target: next.get(l.target_id)!, hi: was?.hi ?? 0, bornAt };
      });
    posVersion.current++;

    // Cluster anchors from real project membership (golden-angle spiral, spaced by graph size).
    const projectCounts = new Map<string, number>();
    for (const n of nodesRef.current) if (n.project_id) projectCounts.set(n.project_id, (projectCounts.get(n.project_id) ?? 0) + 1);
    const projects = [...projectCounts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const spread = 110 + 9 * Math.sqrt(nodesRef.current.length);
    const anchors = new Map<string, { x: number; y: number }>();
    projects.forEach((id, i) => {
      const r = spread * Math.sqrt(i + (projects.length > 1 ? 0.6 : 0));
      const a = i * 2.39996;
      anchors.set(id, { x: Math.cos(a) * r, y: Math.sin(a) * r });
    });
    const cluster = props.clusterByProject !== false && projects.length > 1;
    const anchorOf = (d: SimNode) => (cluster && d.project_id ? anchors.get(d.project_id) : undefined);

    s.nodes(nodesRef.current);
    s.force(
      "link",
      forceLink<SimNode, SimLink>(linksRef.current)
        .id((d) => d.id)
        .distance((l) => st.linkDistance + ((l.source as SimNode).r + (l.target as SimNode).r) * 1.4)
        .strength((l) => {
          const a = l.source as SimNode;
          const b = l.target as SimNode;
          // Cross-project links pull less, so clusters stay readable without hiding real connections.
          const cross = cluster && a.project_id && b.project_id && a.project_id !== b.project_id ? 0.35 : 1;
          return (cross * st.linkForce * (0.6 + 0.4 * l.strength)) / Math.sqrt(Math.min(nb.get(a.id)?.size ?? 1, nb.get(b.id)?.size ?? 1));
        }),
    );
    s.force("charge", forceManyBody<SimNode>().strength((d) => -st.repelForce * (d.category === "project" ? 1.8 : 1)).distanceMin(4).distanceMax(520).theta(0.9));
    s.force("x", forceX<SimNode>((d) => anchorOf(d)?.x ?? 0).strength((d) => (anchorOf(d) ? 0.045 : st.centerForce * 0.5)));
    s.force("y", forceY<SimNode>((d) => anchorOf(d)?.y ?? 0).strength((d) => (anchorOf(d) ? 0.045 : st.centerForce * 0.5)));
    s.force("collide", forceCollide<SimNode>((d) => d.r + 3.5).iterations(2).strength(0.8));

    const total = nodesRef.current.length;
    if (!st.animate) {
      s.stop();
      if (fresh > 0 || firstLoad) for (let i = 0; i < Math.min(300, 60 + total); i++) s.tick();
      requestDraw();
      savePositions();
      if (!fitted.current) {
        fitted.current = true;
        fit(false);
      }
    } else if (firstLoad) {
      // Saved layout: settle gently instead of re-generating the graph.
      const saved = placed / Math.max(1, total);
      s.alpha(saved > 0.8 ? 0.08 : 1).restart();
      if (saved > 0.8 && !fitted.current) {
        fitted.current = true;
        requestAnimationFrame(() => fit(false));
      }
    } else if (fresh > 0 || prev.size !== next.size) {
      // Small, local reheat: existing nodes barely move.
      s.alpha(Math.min(0.3, 0.08 + fresh * 0.03)).restart();
    }
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nodes, props.links, props.settings.linkDistance, props.settings.linkForce, props.settings.repelForce, props.settings.centerForce, props.settings.nodeSize, props.settings.colorBy, props.settings.animate, props.clusterByProject]);

  useEffect(() => {
    if (props.settings.animate && sim.current && nodesRef.current.length && byId.current.size) sim.current.alpha(Math.max(sim.current.alpha(), 0.3)).restart();
  }, [props.settings.linkDistance, props.settings.linkForce, props.settings.repelForce, props.settings.centerForce]);

  // Legacy bloom prop (onboarding preview): treat as "new memory" light.
  useEffect(() => {
    if (!props.bloom?.size) return;
    for (const [id, at] of props.bloom) {
      const n = byId.current.get(id);
      if (n) n.appearAt = at;
      else pendingNew.current.set(id, at);
    }
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.bloom]);

  useEffect(requestDraw, [props.selectedId, props.highlight, props.motion, props.settings.showLabels, props.settings.textFadeThreshold, props.settings.linkThickness, props.settings.showArrows]);

  return (
    <div ref={wrap} className="absolute inset-0 overflow-hidden" style={{ background: BG }}>
      <canvas ref={canvas} className="block" aria-label="Knowledge graph" role="img" />
    </div>
  );
});
