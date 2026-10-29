// The Mind: an Obsidian-style force-directed graph on <canvas> (d3-force + d3-zoom).
// Every node is a real memory and every line a real relationship.
//
// Rendering (v0.2.6 "Awakening"):
//  - Small soft-white nodes with a subtle luminosity. Glow is drawn from two cached radial-gradient sprites
//    (white and lavender) with additive blending: no per-frame blur, no shadowBlur.
//  - Every visual state (hover, selection, neighbours, dimming, label fade) is an eased value per node/edge,
//    so changes fade in and out instead of switching.
//  - The animation loop runs only while something is moving (simulation, easing, real events) and stops when
//    the page is hidden.
//  - Layout: link + many-body + collision forces, plus a gentle pull toward a per-project anchor computed from
//    real project membership, so projects form readable clusters instead of one central blob.
//  - Living graph: real "memory created / updated / linked" events fade nodes in, reveal edges and send a
//    restrained pulse along new connections. Nothing is simulated.
//
// v0.3.0 "Living Atmosphere":
//  - The graph canvas is transparent and sits on the atmosphere layer (atmosphere.ts): deep charcoal, faint
//    lavender light, vignette, grain and an optional slow particle field with camera parallax.
//  - Node cores are luminous white / grey / muted lavender by importance; pinned (starred), project hub and very
//    important memories "breathe" gently, as does the selected memory, and light flows slowly along its connections.
//  - Projects read as areas of thought: a soft glow region and a name per cluster, computed from real positions
//    and eased, so a cluster that grows or moves transitions smoothly. Clicking a name focuses the cluster.
//  - Camera: eased wheel zoom anchored at the pointer, eased focus/fit, and any user gesture cancels an animation
//    in progress so the view never fights the user.
//
// v0.5.2 "Neural": fixes the dense ball that big vaults produced.
//  - Cause: notes had no group (everything was pulled to one centre), index notes linking to hundreds of notes pulled
//    everything onto themselves (link strength ignored hub degree), and uniform repulsion turned that into a disk.
//  - Layout: every node has a real group (its project, or for notes the top folder in the vault). Group anchors come
//    from a small layout of the groups themselves (sized by members, pulled together by their real cross-links), so
//    related regions sit near each other. Link strength is normalised by both ends' degree (hubs pull weakly),
//    links between groups pull less, repulsion is local, collisions keep a minimum spacing. Old saved positions
//    from the previous layout are laid out again once (LAYOUT_VERSION); afterwards positions are stable and saved.
//  - Level of detail: zoomed out, links between groups are drawn as one bundle per pair of groups (width from the
//    real number of links); zooming in fades the individual links in and the bundles out. Link opacity adapts to
//    zoom and to how many links are on screen; links of hub notes are fainter unless focused. Everything outside
//    the viewport is skipped. Labels never overlap (screen-space placement by priority).
//  - Neurons: circles with a soft glow, lavender for memories, cool blue for notes, size from real connections
//    and importance. Restrained life: activity-driven light pulses along real connections of recently changed
//    memories and notes, a wave along the hovered neuron's connections and a ripple on selection; none of it in
//    Minimal motion / reduced motion.
import { drag as d3drag } from "d3-drag";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { quadtree, type Quadtree } from "d3-quadtree";
import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { ambientEnabled, motionLevel } from "../lib/motion";
import { ATMOSPHERE_BASE, Atmosphere } from "./atmosphere";
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
  /** User-pinned ("starred") memory: a core memory that breathes softly. */
  starred?: boolean;
  memory_type?: string;
  /** "document" for notes from the Knowledge Library (cool blue neurons); memories otherwise. */
  kind?: string;
  /** Layout group: the memory's project, or for a note the top folder it lives in (real data only). */
  group?: string | null;
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
  core: boolean; // breathes (starred, project hub or very important)
  group: string | null;
  deg: number; // connections in this view
  hub: boolean; // one of the most connected nodes in this view (e.g. an index note)
  active: boolean; // changed recently (drives the occasional activity pulse)
}

interface ClusterState {
  id: string;
  name: string;
  x: number;
  y: number;
  r: number;
  a: number; // eased visibility
  hot: number; // eased hover/focus emphasis
  color: string;
  members: SimNode[];
  seen: boolean;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  id: string;
  type: string;
  strength: number;
  hi: number;
  bornAt: number; // reveal + pulse for new relationships
  cross: boolean; // connects two different groups
  hubby: boolean; // touches a hub node
  curve: number; // signed bend (organic pathways), stable per link
  lod: number; // stable 0..1 rank for progressive detail
}
interface Pulse {
  from: SimNode;
  to: SimNode;
  curve: number;
  start: number;
  dur: number;
  blue: boolean;
}

/** Bump when the layout algorithm changes: saved positions from an older layout are laid out again once. */
const LAYOUT_VERSION = "neural-1";
const LAYOUT_KEY = "moth.mind.layout";
const layoutIsCurrent = () => {
  try {
    return localStorage.getItem(LAYOUT_KEY) === LAYOUT_VERSION;
  } catch {
    return true; // storage unavailable: keep saved positions rather than re-laying out on every load
  }
};
const markLayoutCurrent = () => {
  try {
    localStorage.setItem(LAYOUT_KEY, LAYOUT_VERSION);
  } catch {
    /* ignore */
  }
};
const smooth01 = (x: number) => {
  const u = Math.max(0, Math.min(1, x));
  return u * u * (3 - 2 * u);
};
const RECENT_MS = 14 * 86_400_000;

export interface PhaseResult {
  fps: number;
  p95FrameMs: number;
  avgDrawMs: number;
}
export interface SmoothnessResult {
  nodes: number;
  links: number;
  pan: PhaseResult;
  zoom: PhaseResult;
  hover: PhaseResult;
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
  /** Glide to a project's cluster and emphasise it. */
  focusCluster: (projectId: string) => void;
  /** Real smoothness measurement on this machine: moves the camera and hover itself and counts frames. */
  measure: () => Promise<SmoothnessResult>;
  stats: () => { nodes: number; links: number; frames: number; lastFrameMs: number; running: boolean };
}

interface Props {
  nodes: GraphNodeData[];
  links: GraphLinkData[];
  settings: GraphSettings;
  selectedId?: string | null;
  highlight?: Set<string> | null;
  /** Ids of stored relationships to light up (a path between two memories). */
  edgeHighlight?: Set<string> | null;
  /** Suggested (not yet real) connections: drawn dashed, never part of the layout. */
  suggested?: { id: string; source_id: string; target_id: string }[];
  /** Memories with active awareness items: a soft amber ring (only shown when the caller passes them). */
  attention?: Set<string> | null;
  bloom?: Map<string, number>;
  projectColors?: Map<string, string>;
  compact?: boolean;
  motion?: MotionLevel;
  clusterByProject?: boolean;
  /** Living atmosphere (particles, breathing, flowing selection light). Defaults to the app setting. */
  ambient?: boolean;
  /** Project names for cluster labels (real projects only). */
  clusters?: { id: string; name: string }[];
  onSelect?: (id: string | null) => void;
  onFocus?: (id: string) => void;
  onContext?: (id: string, x: number, y: number) => void;
  onHover?: (node: GraphNodeData | null) => void;
  onPositions?: (items: { id: string; x: number; y: number; pinned?: boolean }[]) => void;
}

const BG = ATMOSPHERE_BASE;
const NODE = "#C9BEF5"; // memory: soft lavender
const NODE_BRIGHT = "#EEE9FF"; // important memory
const NODE_FAINT = "#9A8FCB"; // low-importance memory
const NODE_HUB = "#E3DBFF"; // project hub / starred (core)
const NOTE = "#8DB0E3"; // note: cool blue
const NOTE_HUB = "#C2D5F4"; // most connected notes (index notes)
const FOLDER_TINTS = ["#A78BFA", "#8FB4E8", "#B9A7F7", "#7FA6DB", "#C4B5FD", "#9BBCEB"];

/** Lavender (memories) and cool blue (notes) neurons; brightness from real importance and connectivity. */
function coreColor(n: { category: string; importance: number; starred?: boolean; kind?: string; hub?: boolean }): string {
  if (n.kind === "document") return n.hub ? NOTE_HUB : NOTE;
  if (n.category === "project" || n.starred) return NODE_HUB;
  if (n.importance >= 0.7) return NODE_BRIGHT;
  if (n.importance < 0.35) return NODE_FAINT;
  return NODE;
}
const isCore = (n: { category: string; importance: number; starred?: boolean }) => n.category === "project" || !!n.starred || n.importance >= 0.85;

/** Soft region sprite for clusters (very low alpha, long falloff). Cached per colour. */
const regionSprites = new Map<string, HTMLCanvasElement>();
function regionSprite(hex: string): HTMLCanvasElement {
  const hit = regionSprites.get(hex);
  if (hit) return hit;
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const v = parseInt(hex.replace("#", ""), 16);
  // Blend the project colour toward lavender so regions stay in one family.
  const mix = (a: number, b: number) => Math.round(a * 0.45 + b * 0.55);
  const rgb = `${mix((v >> 16) & 255, 167)},${mix((v >> 8) & 255, 139)},${mix(v & 255, 250)}`;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, `rgba(${rgb},0.15)`);
  grad.addColorStop(0.45, `rgba(${rgb},0.085)`);
  grad.addColorStop(0.8, `rgba(${rgb},0.025)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  regionSprites.set(hex, c);
  return c;
}

/** Stable 0..1 offset per id (so flowing lights don't all move in lockstep). */
function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}
const ACCENT = "#A78BFA";
const ACCENT_SOFT = "#C4B5FD";

/** Size from real data: connections (log scale, so index notes don't become giant) and, for memories, importance. */
function radius(n: GraphNodeData, size: number): number {
  const doc = n.kind === "document";
  const base = n.category === "project" ? 5 : doc ? 2.1 : 2.5;
  const r = base + Math.log2(1 + Math.max(0, n.degree)) * 1.05 + (doc ? 0 : n.importance * 1.3);
  return Math.min(12, r) * size;
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
  const sprites = useRef<{ white: HTMLCanvasElement; lavender: HTMLCanvasElement; blue: HTMLCanvasElement } | null>(null);
  const tree = useRef<{ q: Quadtree<SimNode>; version: number } | null>(null);
  const posVersion = useRef(0);
  const pendingNew = useRef(new Map<string, number>());
  const pendingLinks = useRef(new Map<string, number>());
  const counters = useRef({ frames: 0, lastFrameMs: 0, breathFrames: 0, visEdges: 0, bundles: 0, labels: 0, detail: 0, pulses: 0 });
  /** Links drawn last frame (sets link opacity: many on screen → each fainter). */
  const visEdges = useRef(1500);
  const edgesInView = useRef(1500);
  /** True when the layout is grouped (projects / note folders): links between groups bundle when zoomed out. */
  const grouped = useRef(false);
  /** Real number of links between each pair of groups (for the bundles). */
  const crossPairs = useRef(new Map<string, { a: string; b: string; count: number }>());
  const groupState = useRef<{ version: number; minBundle: number; centroids: Map<string, { x: number; y: number; n: number }>; bundles: { ax: number; ay: number; bx: number; by: number; count: number; bend: number }[] }>({ version: -1, minBundle: 1, centroids: new Map(), bundles: [] });
  /** Group anchors (cached so small data changes don't move whole regions). */
  const anchorCache = useRef<{ key: string; map: Map<string, { x: number; y: number; R: number }> } | null>(null);
  /** Links touching something that changed recently: the pool for the occasional activity pulse. */
  const activityLinks = useRef<SimLink[]>([]);
  const pulses = useRef<Pulse[]>([]);
  const rippleAt = useRef(0);
  const maxR = useRef(14);
  const relaid = useRef(false);
  const ambientTimer = useRef<number | null>(null);
  const moteCanvas = useRef<HTMLCanvasElement>(null);
  const regionCanvas = useRef<HTMLCanvasElement>(null);
  const breathCanvas = useRef<HTMLCanvasElement>(null);
  const regionSig = useRef("");
  const regionAt = useRef({ x: 0, y: 0, k: 1 });
  const regionSettle = useRef<number | null>(null);
  const regionCss = useRef("");
  const atmos = useRef<Atmosphere | null>(null);
  const clusters = useRef(new Map<string, ClusterState>());
  const clusterLabels = useRef<{ id: string; x0: number; y0: number; x1: number; y1: number }[]>([]);
  const hoverCluster = useRef<string | null>(null);
  const focusedCluster = useRef<string | null>(null);
  const cameraToken = useRef(0);
  const wheelAnim = useRef<{ k: number; px: number; py: number; raf: number | null; last: number } | null>(null);
  const breathing = useRef(false);
  /** Cluster targets (centre/radius) are recomputed only when node positions change, not on hover frames. */
  const clusterTargets = useRef<{ version: number; key: string; items: Map<string, { cx: number; cy: number; r: number; members: SimNode[] }> } | null>(null);
  /** Smooth zoom falls back to direct steps if this machine can't redraw fast enough (keeps it responsive). */
  const zoomPerf = useRef({ slow: false, dts: [] as number[] });
  live.current = props;

  const motion = (): MotionLevel => {
    const m = live.current.motion ?? motionLevel();
    return live.current.settings.animate === false ? "minimal" : m;
  };
  /** Ambient motion (breathing, flowing light) is on only if enabled, not compact and motion isn't Minimal. */
  const ambientOn = () => (live.current.ambient ?? ambientEnabled()) && !live.current.compact && motion() !== "minimal";

  // ------------------------------------------------------------------ drawing
  /** Quadratic "pathway" between two nodes: a gentle, stable bend per link. */
  const pathway = (g: CanvasRenderingContext2D | Path2D, ax: number, ay: number, bx: number, by: number, bend: number, upto = 1) => {
    const cx = (ax + bx) / 2 - (by - ay) * bend;
    const cy = (ay + by) / 2 + (bx - ax) * bend;
    g.moveTo(ax, ay);
    if (upto >= 1) g.quadraticCurveTo(cx, cy, bx, by);
    else {
      // Partial reveal (new relationship): split the curve at `upto` (de Casteljau).
      const qx = ax + (cx - ax) * upto, qy = ay + (cy - ay) * upto;
      const rx = cx + (bx - cx) * upto, ry = cy + (by - cy) * upto;
      g.quadraticCurveTo(qx, qy, qx + (rx - qx) * upto, qy + (ry - qy) * upto);
    }
  };
  /** Point on a pathway at u (0..1). */
  const along = (ax: number, ay: number, bx: number, by: number, bend: number, u: number) => {
    const cx = (ax + bx) / 2 - (by - ay) * bend;
    const cy = (ay + by) / 2 + (bx - ax) * bend;
    const v = 1 - u;
    return { x: v * v * ax + 2 * v * u * cx + u * u * bx, y: v * v * ay + 2 * v * u * cy + u * u * by };
  };

  /** Group centroids and the bundles between them (recomputed only when positions change). */
  const groupGeometry = () => {
    const gs = groupState.current;
    if (gs.version === posVersion.current) return gs;
    const acc = new Map<string, { x: number; y: number; n: number }>();
    for (const n of nodesRef.current) {
      if (!n.group) continue;
      const a = acc.get(n.group) ?? acc.set(n.group, { x: 0, y: 0, n: 0 }).get(n.group)!;
      a.x += n.x!;
      a.y += n.y!;
      a.n++;
    }
    const cent = new Map<string, { x: number; y: number; n: number }>();
    for (const [g, a] of acc) cent.set(g, { x: a.x / a.n, y: a.y / a.n, n: a.n });
    const bundles: { ax: number; ay: number; bx: number; by: number; count: number; bend: number }[] = [];
    for (const [key, cp] of crossPairs.current) {
      const a = cent.get(cp.a);
      const b = cent.get(cp.b);
      if (!a || !b) continue;
      bundles.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, count: cp.count, bend: (hash01(key) - 0.5) * 0.28 });
    }
    // Zoomed out, only the strongest connections between regions are bundled (at most ~160), so the overview stays
    // readable; zooming in reveals every individual link anyway.
    const counts = bundles.map((b) => b.count).sort((a, b) => b - a);
    gs.minBundle = Math.max(1, counts[159] ?? 1);
    gs.version = posVersion.current;
    gs.centroids = cent;
    gs.bundles = bundles;
    return gs;
  };

  const draw = (now: number) => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const t0 = performance.now();
    if (!sprites.current) sprites.current = { white: makeSprite("236,234,255"), lavender: makeSprite("167,139,250"), blue: makeSprite("143,180,232") };
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
    ctx.clearRect(0, 0, w, h); // transparent: the atmosphere layer shows through
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    // Level of detail: 0 = overview (zoomed out), 1 = every neuron and pathway.
    const detail = p.compact ? 0.35 : smooth01((t.k - 0.3) / 0.6);
    const zoomedOut = detail < 0.15;
    const amb = ambientOn();
    // Viewport in graph coordinates (with a margin): nothing outside it is drawn.
    const vm = 40 / t.k;
    const vx0 = -t.x / t.k - vm, vy0 = -t.y / t.k - vm, vx1 = (w - t.x) / t.k + vm, vy1 = (h - t.y) / t.k + vm;
    const inView = (x: number, y: number, r: number) => x + r >= vx0 && x - r <= vx1 && y + r >= vy0 && y - r <= vy1;

    // ---- clusters: soft areas of thought (projects and note folders), from real positions of their members, eased.
    const showClusters = !p.compact && !!p.clusters?.length && p.clusterByProject !== false;
    if (showClusters) {
      const names = new Map(p.clusters!.map((c) => [c.id, c.name]));
      const key = p.clusters!.map((c) => c.id).join(",") + "|" + nodesRef.current.length;
      let targets = clusterTargets.current;
      if (!targets || targets.version !== posVersion.current || targets.key !== key) {
        const groups = new Map<string, SimNode[]>();
        for (const n of nodesRef.current) {
          if (!n.group || !names.has(n.group)) continue;
          let g = groups.get(n.group);
          if (!g) groups.set(n.group, (g = []));
          g.push(n);
        }
        const items = new Map<string, { cx: number; cy: number; r: number; members: SimNode[] }>();
        for (const [id, members] of groups) {
          if (members.length < 3) continue;
          let sx = 0, sy = 0;
          for (const n of members) (sx += n.x!), (sy += n.y!);
          const cx = sx / members.length, cy = sy / members.length;
          // Radius from the 85th-percentile distance, so a few outliers (or a hub pulled away) don't inflate it.
          const ds = members.map((n) => Math.hypot(n.x! - cx, n.y! - cy)).sort((a, b) => a - b);
          items.set(id, { cx, cy, r: Math.min(1400, ds[Math.floor(ds.length * 0.85)] * 1.12 + 26), members });
        }
        targets = clusterTargets.current = { version: posVersion.current, key, items };
      }
      for (const c of clusters.current.values()) c.seen = false;
      const tint = (id: string) => p.projectColors?.get(id) ?? FOLDER_TINTS[Math.floor(hash01(id) * FOLDER_TINTS.length)];
      for (const [id, { cx, cy, r: tr, members }] of targets.items) {
        let c = clusters.current.get(id);
        if (!c) {
          c = { id, name: names.get(id)!, x: cx, y: cy, r: tr, a: 0, hot: 0, color: tint(id), members, seen: true };
          clusters.current.set(id, c);
        }
        c.seen = true;
        c.members = members;
        c.name = names.get(id)!;
        c.color = tint(id);
        const kk = m === "minimal" ? 1 : 1 - Math.exp(-dt / 240); // slow, calm transitions
        const bx = c.x, by = c.y, br = c.r;
        c.x = approach(c.x, cx, kk);
        c.y = approach(c.y, cy, kk);
        c.r = approach(c.r, tr, kk);
        if (Math.abs(c.x - bx) + Math.abs(c.y - by) + Math.abs(c.r - br) > 0.05) moving = true;
      }
      for (const c of clusters.current.values()) {
        const ta = c.seen ? 1 : 0;
        const th = hoverCluster.current === c.id || focusedCluster.current === c.id ? 1 : 0;
        const ba = c.a, bh = c.hot;
        c.a = approach(c.a, ta, m === "minimal" ? 1 : 1 - Math.exp(-dt / 300));
        c.hot = approach(c.hot, th, k);
        if (c.a !== ba || c.hot !== bh) moving = true;
        if (!c.seen && c.a === 0) clusters.current.delete(c.id);
      }
      paintRegions(focusNode || hl ? 1 : 0);
    } else if (clusters.current.size) {
      clusters.current.clear();
      paintRegions(0);
    }

    // ---- pathways
    const lw = (0.7 * s.linkThickness) / Math.max(0.55, Math.sqrt(t.k));
    let dimMix = 0;
    if (focusNode || hl) {
      let sum = 0;
      for (const n of nodesRef.current) sum += n.dim;
      dimMix = nodesRef.current.length ? Math.min(1, (sum / nodesRef.current.length) * 1.6) : 0;
    }
    // Fewer links on screen → each can be a little more visible; thousands → each one fainter.
    const dens = Math.max(0.45, Math.min(1, Math.sqrt(1800 / Math.max(1, visEdges.current))));
    const baseA = (p.compact ? 0.12 : 0.06 + 0.12 * detail) * dens * (1 - 0.75 * dimMix);
    const bundled = grouped.current && !p.compact; // links between groups are bundled when zoomed out
    const crossA = bundled ? baseA * detail : baseA;
    const hubA = baseA * 0.38;
    const intraPath = new Path2D();
    const crossPath = new Path2D();
    const hubPath = new Path2D();
    const special: SimLink[] = [];
    let vis = 0;
    let inViewCount = 0;
    // Progressive detail: zoomed out with thousands of links on screen, a stable subset of them is drawn (always
    // the same links, chosen by id); all of them come back as you zoom in. Bundles and regions carry the overview.
    const keep = detail >= 0.85 ? 1 : Math.min(1, 4500 / Math.max(1, edgesInView.current) + detail * 1.2);
    for (const l of linksRef.current) {
      const a = l.source as SimNode;
      const b = l.target as SimNode;
      if (l.hi > 0.01 || (l.bornAt && now - l.bornAt < 1800)) {
        special.push(l);
        continue;
      }
      // Viewport culling (the bend stays within the segment's box plus a margin).
      if (Math.max(a.x!, b.x!) < vx0 || Math.min(a.x!, b.x!) > vx1 || Math.max(a.y!, b.y!) < vy0 || Math.min(a.y!, b.y!) > vy1) continue;
      inViewCount++;
      if (keep < 1 && l.lod > keep) continue;
      if (l.hubby) {
        if (hubA < 0.004) continue;
        pathway(hubPath, a.x!, a.y!, b.x!, b.y!, l.curve);
      } else if (l.cross) {
        if (crossA < 0.004) continue;
        pathway(crossPath, a.x!, a.y!, b.x!, b.y!, l.curve);
      } else pathway(intraPath, a.x!, a.y!, b.x!, b.y!, l.curve);
      vis++;
    }
    visEdges.current = Math.max(1, vis);
    edgesInView.current = inViewCount;
    ctx.lineWidth = lw;
    ctx.strokeStyle = `rgba(178,170,228,${baseA})`;
    ctx.stroke(intraPath);
    if (crossA >= 0.004) {
      ctx.strokeStyle = `rgba(150,176,232,${crossA})`;
      ctx.stroke(crossPath);
    }
    if (hubA >= 0.004) {
      ctx.strokeStyle = `rgba(170,170,215,${hubA})`;
      ctx.stroke(hubPath);
    }
    // ---- bundles: one soft pathway per pair of groups, as wide as the real number of links between them.
    let bundlesDrawn = 0;
    const bundleA = bundled ? (1 - detail) * (1 - 0.7 * dimMix) : 0;
    if (bundleA > 0.02) {
      const gg = groupGeometry();
      ctx.lineCap = "round";
      for (const bd of gg.bundles) {
        if (bd.count < gg.minBundle) continue;
        if (Math.max(bd.ax, bd.bx) < vx0 || Math.min(bd.ax, bd.bx) > vx1 || Math.max(bd.ay, bd.by) < vy0 || Math.min(bd.ay, bd.by) > vy1) continue;
        const lg = Math.log2(1 + bd.count);
        ctx.lineWidth = lw * (0.8 + lg * 0.75);
        ctx.strokeStyle = `rgba(160,160,232,${Math.min(0.2, (0.03 + 0.016 * lg) * bundleA)})`;
        ctx.beginPath();
        pathway(ctx, bd.ax, bd.ay, bd.bx, bd.by, bd.bend);
        ctx.stroke();
        bundlesDrawn++;
      }
      ctx.lineCap = "butt";
    }
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
      const alpha = Math.max(baseA, 0.16 + 0.55 * l.hi);
      ctx.strokeStyle = l.hi > 0.5 ? `rgba(196,181,253,${alpha})` : `rgba(205,200,235,${Math.max(alpha, 0.3)})`;
      ctx.lineWidth = lw * (1 + 0.5 * l.hi);
      ctx.beginPath();
      pathway(ctx, a.x!, a.y!, b.x!, b.y!, l.curve, reveal);
      ctx.stroke();
    }
    // ---- a path of real stored relationships, bright lavender
    if (p.edgeHighlight?.size) {
      ctx.strokeStyle = "rgba(196,181,253,0.95)";
      ctx.lineWidth = lw * 2.4;
      ctx.beginPath();
      for (const l of linksRef.current) {
        if (!p.edgeHighlight.has(l.id)) continue;
        const a = l.source as SimNode;
        const b = l.target as SimNode;
        pathway(ctx, a.x!, a.y!, b.x!, b.y!, l.curve);
      }
      ctx.stroke();
    }
    // ---- suggestions: dashed, faint lavender, clearly not (yet) connections
    if (p.suggested?.length) {
      ctx.strokeStyle = "rgba(167,139,250,0.55)";
      ctx.lineWidth = lw * 1.3;
      ctx.setLineDash([5 / t.k, 5 / t.k]);
      ctx.beginPath();
      for (const sg of p.suggested) {
        const a = byId.current.get(sg.source_id);
        const b = byId.current.get(sg.target_id);
        if (!a || !b) continue;
        ctx.moveTo(a.x!, a.y!);
        ctx.lineTo(b.x!, b.y!);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (s.showArrows && t.k > 0.9) {
      ctx.fillStyle = `rgba(190,190,205,${0.3 * (1 - 0.7 * dimMix)})`;
      for (const l of linksRef.current) {
        const a = l.source as SimNode;
        const b = l.target as SimNode;
        if (!inView(b.x!, b.y!, 10)) continue;
        // Direction at the end of the bend.
        const q = along(a.x!, a.y!, b.x!, b.y!, l.curve, 0.92);
        const ang = Math.atan2(b.y! - q.y, b.x! - q.x);
        const ex = b.x! - Math.cos(ang) * (b.r + 1.5);
        const ey = b.y! - Math.sin(ang) * (b.r + 1.5);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(ang - 0.45) * 4, ey - Math.sin(ang - 0.45) * 4);
        ctx.lineTo(ex - Math.cos(ang + 0.45) * 4, ey - Math.sin(ang + 0.45) * 4);
        ctx.fill();
      }
    }

    // ---- glow (additive), behind the neuron cores. Every neuron gets a faint halo when you're close enough to
    // see it; core memories and hubs carry a little more light even in the overview. No blur, cached sprites.
    const sp = sprites.current;
    ctx.globalCompositeOperation = "lighter";
    const idleGlow = m === "full" ? 0.18 : m === "balanced" ? 0.15 : 0.08;
    let anyBreath = false;
    for (const n of nodesRef.current) {
      if (!inView(n.x!, n.y!, n.r * 7)) continue;
      let g = n.glow;
      // The selected memory breathes gently (ambient only): its steady part is drawn here,
      // the slowly varying part on the breathing layer (drawBreath), so idle frames stay cheap.
      if (amb && n.id === p.selectedId && g > 0.3) {
        g *= 0.84;
        anyBreath = true;
      }
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
      if (n.dim < 0.5) {
        if (n.core || n.hub) {
          idle = Math.max(idleGlow * (0.5 + n.importance * 0.7) * (n.category === "project" ? 1.4 : 1), 0.17);
          if (n.core && amb) {
            idle *= 0.78; // the breathing part is on the breathing layer
            anyBreath = true;
          }
        } else if (!zoomedOut) idle = idleGlow * 0.55 * detail;
      }
      const intensity = Math.max(g, idle) * (1 - 0.85 * n.dim);
      if (intensity < 0.01) continue;
      let R = Math.max(n.r * (3.2 + 2.6 * n.glow + n.grow * 0.6), (6 + 14 * Math.max(n.glow, g * 0.8)) / Math.max(0.5, t.k));
      // A real new memory or update briefly lights up its surroundings.
      if ((n.appearAt || n.pulseAt) && m !== "minimal") R = Math.max(R, (22 + 26 * g) / Math.max(0.5, t.k));
      const accent = n.glow > 0.5 || n.id === p.selectedId || (n.appearAt && m !== "minimal") || (n.core && n.starred);
      const sprite = accent ? sp.lavender : n.kind === "document" ? sp.blue : n.core ? sp.lavender : sp.white;
      ctx.globalAlpha = Math.min(1, intensity);
      ctx.drawImage(sprite, n.x! - R, n.y! - R, R * 2, R * 2);
    }
    ctx.globalCompositeOperation = "source-over";
    breathing.current = anyBreath || (amb && !!p.selectedId);

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
        const q = along(a.x!, a.y!, b.x!, b.y!, l.curve, u);
        const R = 7 / Math.max(0.6, Math.sqrt(t.k));
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = Math.sin(Math.PI * u) * 0.9;
        ctx.drawImage(sp.lavender, q.x - R, q.y - R, R * 2, R * 2);
        ctx.globalCompositeOperation = "source-over";
      }
    }

    // ---- neuron cores
    for (const n of nodesRef.current) {
      if (!inView(n.x!, n.y!, n.r * 1.5 + 6)) continue;
      // Overview: ordinary neurons are a touch smaller and softer, so regions read as shapes; they sharpen as you zoom.
      const plain = !n.core && !n.hub && n.hi < 0.5 && n.id !== p.selectedId;
      let scale = (1 + 0.28 * n.grow) * (plain ? 0.82 + 0.18 * detail : 1);
      let alpha = (1 - 0.8 * n.dim) * (plain ? 0.72 + 0.28 * detail : 1);
      if (n.appearAt) {
        const age = now - n.appearAt;
        const u = m === "minimal" ? 1 : Math.min(1, age / 700);
        const e = 1 - Math.pow(1 - u, 3);
        scale *= 0.2 + 0.8 * e;
        alpha *= e;
      }
      if (n.status && n.status !== "active") alpha *= 0.45;
      let fill = s.colorBy === "none" ? coreColor(n) : n.color;
      if (n.id === p.selectedId) fill = ACCENT_SOFT;
      else if (focusNode && n.id === focusNode.id) fill = "#FFFFFF";
      else if (hl?.has(n.id) && !focusNode) fill = ACCENT_SOFT;
      else if (n.hi > 0.5) fill = n.kind === "document" ? "#DCE8FA" : "#F1EDFF";
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
      if (p.attention?.has(n.id)) {
        ctx.globalAlpha = 0.75 * (1 - 0.7 * n.dim);
        ctx.strokeStyle = "#E8C37A";
        ctx.lineWidth = 1.2 / t.k;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r * scale + 5 / t.k, 0, Math.PI * 2);
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
    ctx.restore();

    // ---- labels (screen space). Placed by priority and never on top of each other: cluster names first (they
    // matter most zoomed out), then the focused / selected / highlighted neurons, then the most connected ones.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const hv0 = hover.current;
    if (hv0 && !p.compact) {
      // The hover tooltip is drawn last: keep labels out from under it.
      const sx = hv0.x! * t.k + t.x;
      const sy = hv0.y! * t.k + t.y - hv0.r * t.k * 1.3 - 12;
      taken.push({ x0: sx - 220, y0: Math.max(6, sy - 24), x1: sx + 220, y1: Math.max(6, sy - 24) + 26 });
    }
    ctx.lineJoin = "round";
    const outline = (text: string, x: number, y: number) => {
      ctx.strokeStyle = "rgba(11,11,16,0.72)";
      ctx.lineWidth = 3;
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    };
    const free = (x0: number, y0: number, x1: number, y1: number) => {
      for (const r of taken) if (x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0) return false;
      return true;
    };
    // Keep the toolbar area and the status line clear.
    clusterLabels.current = [];
    if (showClusters && clusters.current.size) {
      ctx.font = `600 10.5px "Geist Variable", "Segoe UI", system-ui, sans-serif`;
      (ctx as any).letterSpacing = "0.14em";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const zoomFade = Math.max(0, Math.min(1, (2.3 - t.k) / 0.9));
      const focusIn = focusNode?.group ?? null;
      const list = [...clusters.current.values()].sort((a, b) => b.members.length - a.members.length);
      for (const c of list) {
        const sr = c.r * t.k;
        if (sr < 22 || c.a < 0.05) continue;
        const sx = c.x * t.k + t.x;
        const sy = (c.y - c.r * 0.98) * t.k + t.y - 4;
        if (sx < -150 || sx > w + 150 || sy < -20 || sy > h + 20) continue;
        const dimC = focusNode ? (c.id === focusIn ? 0 : 0.7) : hl ? 0.5 : 0;
        const a = c.a * Math.max(zoomFade, c.hot) * (0.5 + 0.45 * c.hot) * (1 - dimC);
        if (a < 0.03) continue;
        const label = (c.name.length > 32 ? c.name.slice(0, 30) + "…" : c.name).toUpperCase();
        const tw = ctx.measureText(label).width;
        const ly = Math.max(74, Math.min(h - 40, sy)); // stay clear of the toolbar and the status line
        const box = { x0: sx - tw / 2 - 6, y0: ly - 9, x1: sx + tw / 2 + 6, y1: ly + 9 };
        if (!free(box.x0, box.y0, box.x1, box.y1) && c.hot < 0.5) continue;
        taken.push(box);
        ctx.globalAlpha = a;
        ctx.fillStyle = c.hot > 0.5 ? "#E9E5FF" : "#C9C3E8";
        outline(label, sx, ly);
        clusterLabels.current.push({ id: c.id, x0: sx - tw / 2 - 8, y0: ly - 11, x1: sx + tw / 2 + 8, y1: ly + 11 });
      }
      (ctx as any).letterSpacing = "0px";
      ctx.globalAlpha = 1;
    }
    let labelsDrawn = 0;
    if (s.showLabels && !p.compact) {
      const target = Math.max(0, Math.min(1, (t.k - s.textFadeThreshold * 0.75) / (s.textFadeThreshold * 0.35)));
      const before = labelAlpha.current;
      labelAlpha.current = approach(labelAlpha.current, target, m === "minimal" ? 1 : 0.25);
      if (labelAlpha.current !== before) moving = true;
      const cands: { n: SimNode; a: number; pri: number; focus: boolean }[] = [];
      for (const n of nodesRef.current) {
        if (hv0 && n === hv0 && hv0.grow > 0.05) continue; // its name is in the tooltip
        const isFocus = n.hi > 0.5 || n.id === p.selectedId;
        const bigEnough = n.r * t.k > 8.5;
        let a = isFocus ? Math.max(n.hi, n.id === p.selectedId ? 1 : 0) : Math.max(labelAlpha.current, bigEnough ? 0.8 : 0);
        a *= 1 - 0.85 * n.dim;
        if (a < 0.03) continue;
        const sx = n.x! * t.k + t.x;
        const sy = n.y! * t.k + t.y;
        if (sx < -200 || sx > w + 200 || sy < -40 || sy > h + 40) continue;
        const pri = (n.id === p.selectedId ? 4e6 : 0) + (focusNode && n.id === focusNode.id ? 3e6 : 0) + (isFocus ? 2e6 : 0) + (hl?.has(n.id) ? 1e6 : 0) + n.r * 1000 + n.deg;
        cands.push({ n, a, pri, focus: isFocus });
      }
      cands.sort((x, y) => y.pri - x.pri);
      ctx.font = `450 11.5px "Geist Variable", "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const { n, a, focus } of cands.slice(0, 600)) {
        const label = n.title.length > 42 ? n.title.slice(0, 40) + "…" : n.title;
        const sx = n.x! * t.k + t.x;
        const sy = (n.y! + n.r * (1 + 0.28 * n.grow)) * t.k + t.y + 3.5;
        const tw = ctx.measureText(label).width;
        const box = { x0: sx - tw / 2 - 3, y0: sy - 1, x1: sx + tw / 2 + 3, y1: sy + 14 };
        if (!free(box.x0, box.y0, box.x1, box.y1)) continue;
        taken.push(box);
        ctx.globalAlpha = a;
        ctx.fillStyle = focus ? "#F5F5F7" : "#A3A2B6";
        outline(label, sx, sy);
        labelsDrawn++;
      }
      ctx.globalAlpha = 1;
    }

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
    counters.current.visEdges = vis;
    counters.current.bundles = bundlesDrawn;
    counters.current.labels = labelsDrawn;
    counters.current.detail = detail;
    drawBreath(now);
    if (moving && !document.hidden) requestDraw();
  };

  /** The breathing layer: only the slowly varying light (core memories, the selected memory and the light
   *  flowing along its connections) plus the few travelling pulses and the selection ripple. Redrawing it touches
   *  a handful of sprites, never the whole graph. */
  const drawBreath = (now: number) => {
    const bc = breathCanvas.current;
    const g = bc?.getContext("2d");
    if (!bc || !g || !sprites.current) return;
    const amb = ambientOn();
    const m = motion();
    // Drop finished pulses / ripple.
    if (pulses.current.length) pulses.current = pulses.current.filter((pu) => now - pu.start < pu.dur);
    const rippling = m !== "minimal" && rippleAt.current > 0 && now - rippleAt.current < 1000;
    const busy = m !== "minimal" && (pulses.current.length > 0 || rippling);
    const disp = amb || busy ? "block" : "none";
    if (bc.style.display !== disp) bc.style.display = disp;
    counters.current.pulses = pulses.current.length;
    if (!amb && !busy) return;
    const { w, h, dpr } = size.current;
    if (bc.width !== Math.round(w * dpr) || bc.height !== Math.round(h * dpr)) {
      bc.width = Math.round(w * dpr);
      bc.height = Math.round(h * dpr);
      bc.style.width = `${w}px`;
      bc.style.height = `${h}px`;
    }
    const t = transform.current;
    const p = live.current;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.translate(t.x, t.y);
    g.scale(t.k, t.k);
    g.globalCompositeOperation = "lighter";
    const sp = sprites.current;
    if (amb) {
      const idleGlow = m === "full" ? 0.18 : 0.15;
      const breath = 0.5 + 0.5 * Math.sin(now / 680); // ~4.3 s cycle
      const x0 = -t.x / t.k - 60, y0 = -t.y / t.k - 60, x1 = (w - t.x) / t.k + 60, y1 = (h - t.y) / t.k + 60;
      for (const n of nodesRef.current) {
        if (n.x! < x0 || n.x! > x1 || n.y! < y0 || n.y! > y1) continue;
        let a = 0;
        if (n.core && n.dim < 0.5) {
          const idle = Math.max(idleGlow * (0.5 + n.importance * 0.7) * (n.category === "project" ? 1.4 : 1), 0.17);
          a = idle * 0.32 * (0.5 + 0.5 * Math.sin(now / 680 + n.phase));
        }
        if (n.id === p.selectedId && n.glow > 0.3) a = Math.max(a, n.glow * 0.16 * breath);
        a *= 1 - 0.85 * n.dim;
        if (a < 0.005) continue;
        const R = Math.max(n.r * (3.2 + 2.6 * n.glow + n.grow * 0.6), (6 + 14 * n.glow) / Math.max(0.5, t.k));
        g.globalAlpha = Math.min(1, a);
        g.drawImage(n.glow > 0.5 || n.id === p.selectedId || n.starred ? sp.lavender : sp.white, n.x! - R, n.y! - R, R * 2, R * 2);
      }
      // Light flows slowly outward along the selected memory's real connections.
      const sel = p.selectedId ? byId.current.get(p.selectedId) : undefined;
      if (sel && !p.compact) {
        const R = 4.2 / Math.max(0.6, Math.sqrt(t.k));
        for (const l of linksRef.current) {
          if (l.hi < 0.05) continue;
          const a = l.source as SimNode;
          const b = l.target as SimNode;
          if (a !== sel && b !== sel) continue;
          const to = a === sel ? b : a;
          const u = (now / 2800 + hash01(l.id)) % 1;
          const q = along(sel.x!, sel.y!, to.x!, to.y!, a === sel ? l.curve : -l.curve, u);
          g.globalAlpha = Math.sin(Math.PI * u) * 0.5 * l.hi * (1 - 0.6 * to.dim);
          g.drawImage(sp.lavender, q.x - R, q.y - R, R * 2, R * 2);
        }
      }
    }
    if (busy) {
      // Pulses: a small glint travelling along a real connection, with a faint trail; the neuron it reaches
      // lights up briefly as it arrives.
      const R = 5.2 / Math.max(0.6, Math.sqrt(t.k));
      for (const pu of pulses.current) {
        const u = Math.min(1, (now - pu.start) / pu.dur);
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        const sprite = pu.blue ? sp.blue : sp.lavender;
        const fade = 1 - 0.7 * Math.max(pu.from.dim, pu.to.dim);
        for (const [du, f] of [[0, 1], [0.07, 0.45], [0.14, 0.2]] as const) {
          const uu = e - du;
          if (uu <= 0) continue;
          const q = along(pu.from.x!, pu.from.y!, pu.to.x!, pu.to.y!, pu.curve, uu);
          g.globalAlpha = Math.sin(Math.PI * Math.min(1, uu)) * 0.8 * f * fade;
          g.drawImage(sprite, q.x - R, q.y - R, R * 2, R * 2);
        }
        if (u > 0.82) {
          const arrive = (u - 0.82) / 0.18;
          const RR = Math.max(pu.to.r * 3.4, 9 / Math.max(0.5, t.k));
          g.globalAlpha = Math.sin(Math.PI * arrive) * 0.5 * fade;
          g.drawImage(sprite, pu.to.x! - RR, pu.to.y! - RR, RR * 2, RR * 2);
        }
      }
      // Selection ripple: one soft ring expanding from the neuron you selected.
      if (rippling) {
        const sel = p.selectedId ? byId.current.get(p.selectedId) : undefined;
        if (sel) {
          const u = (now - rippleAt.current) / 1000;
          const e = 1 - Math.pow(1 - u, 3);
          g.globalCompositeOperation = "source-over";
          g.globalAlpha = (1 - u) * 0.55;
          g.strokeStyle = ACCENT_SOFT;
          g.lineWidth = 1.4 / t.k;
          g.beginPath();
          g.arc(sel.x!, sel.y!, sel.r + (4 + 34 * e) / t.k, 0, Math.PI * 2);
          g.stroke();
        }
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    counters.current.breathFrames++;
    // Pulses and the ripple need smooth frames while they last (only this light layer is redrawn).
    if (busy) requestBreath();
  };

  /** A pulse along a real connection, from one neuron to the other. */
  const sendPulse = (l: SimLink, from: SimNode, dur: number) => {
    const a = l.source as SimNode;
    const to = a === from ? (l.target as SimNode) : a;
    pulses.current.push({ from, to, curve: a === from ? l.curve : -l.curve, start: performance.now(), dur, blue: from.kind === "document" && to.kind === "document" });
    requestBreath();
  };
  /** Occasional activity pulse: along a real connection of something that changed recently, on screen.
   *  If nothing changed recently, nothing pulses (no random noise). */
  const ambientPulse = () => {
    const pool = activityLinks.current;
    if (!pool.length || pulses.current.length >= 3 || document.hidden) return;
    const t = transform.current;
    const { w, h } = size.current;
    const on = (n: SimNode) => {
      const sx = n.x! * t.k + t.x, sy = n.y! * t.k + t.y;
      return sx > 0 && sx < w && sy > 0 && sy < h;
    };
    for (let i = 0; i < 10; i++) {
      const l = pool[Math.floor(Math.random() * pool.length)];
      const a = l.source as SimNode;
      const b = l.target as SimNode;
      if (!on(a) && !on(b)) continue;
      sendPulse(l, a.active ? a : b, 1500 + Math.random() * 500);
      return;
    }
  };
  /** Hovering a neuron sends one soft wave along its connections. */
  const hoverWave = (n: SimNode) => {
    if (motion() === "minimal" || live.current.compact) return;
    let k = 0;
    for (const l of linksRef.current) {
      if (l.source !== n && l.target !== n) continue;
      sendPulse(l, n, 750 + (k % 5) * 60);
      if (++k >= 24) break;
    }
  };
  const breathFrame = useRef<number | null>(null);
  const requestBreath = () => {
    if (breathFrame.current !== null || document.hidden) return;
    breathFrame.current = requestAnimationFrame((ts) => {
      breathFrame.current = null;
      drawBreath(ts);
    });
  };

  /** Cluster glow regions live on their own layer and are repainted only when they (or the camera) change,
   *  not on every breathing frame: large soft gradients are the most expensive thing to redraw. */
  const paintRegions = (dimmed: number) => {
    const rc = regionCanvas.current;
    const g = rc?.getContext("2d");
    if (!rc || !g) return;
    // Dimming while a memory is focused: one cheap opacity change on the whole layer, eased by CSS.
    const op = dimmed ? "0.45" : "1";
    if (rc.style.opacity !== op) rc.style.opacity = op;
    const disp = clusters.current.size ? "block" : "none";
    if (rc.style.display !== disp) rc.style.display = disp;
    const { w, h, dpr } = size.current;
    const t = transform.current;
    const list = [...clusters.current.values()].filter((c) => c.a >= 0.01);
    const shape = `${w}x${h}@${dpr}|` + list.map((c) => `${c.id}:${c.x.toFixed(1)},${c.y.toFixed(1)},${c.r.toFixed(1)},${c.a.toFixed(2)},${c.hot.toFixed(2)}`).join(";");
    const at = regionAt.current;
    if (shape === regionSig.current) {
      // Only the camera moved: slide/scale the already-painted layer (compositor work only)
      // and repaint it crisply once the camera has been still for a moment.
      if (at.x === t.x && at.y === t.y && at.k === t.k) return;
      const sc = t.k / at.k;
      const css = `translate(${t.x - at.x * sc}px, ${t.y - at.y * sc}px) scale(${sc})`;
      // Unchanged camera (e.g. a breathing frame): keep the pending repaint timer running.
      if (regionCss.current === css && regionSettle.current) return;
      regionCss.current = css;
      rc.style.transformOrigin = "0 0";
      rc.style.transform = css;
      if (regionSettle.current) clearTimeout(regionSettle.current);
      regionSettle.current = window.setTimeout(() => {
        regionSettle.current = null;
        regionSig.current = "";
        requestDraw();
      }, 140);
      return;
    }
    regionSig.current = shape;
    regionAt.current = { x: t.x, y: t.y, k: t.k };
    regionCss.current = "";
    rc.style.transform = "";
    if (rc.width !== Math.round(w * dpr) || rc.height !== Math.round(h * dpr)) {
      rc.width = Math.round(w * dpr);
      rc.height = Math.round(h * dpr);
      rc.style.width = `${w}px`;
      rc.style.height = `${h}px`;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.translate(t.x, t.y);
    g.scale(t.k, t.k);
    for (const c of list) {
      const R = c.r * 1.35;
      g.globalAlpha = Math.min(1, c.a * (0.9 + 0.9 * c.hot));
      g.drawImage(regionSprite(c.color), c.x - R, c.y - R, R * 2, R * 2);
      if (c.hot > 0.02) {
        // Soft boundary only while the cluster is hovered or focused.
        g.globalAlpha = 0.14 * c.hot * c.a;
        g.strokeStyle = ACCENT_SOFT;
        g.lineWidth = 1 / t.k;
        g.beginPath();
        g.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
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
    const mr = maxR.current;
    const cand = tree.current.q.find(p.x, p.y, mr + slack);
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
      return x0 > p.x + mr + slack || x1 < p.x - mr - slack || y0 > p.y + mr + slack || y1 < p.y - mr - slack;
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
    const token = ++cameraToken.current; // a newer camera move or any user gesture cancels this one
    stopWheel();
    if (ms <= 0 || motion() === "minimal") {
      z.transform(sel, target);
      return;
    }
    const from = transform.current;
    const start = performance.now();
    const step = () => {
      if (token !== cameraToken.current) return;
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

  const stopWheel = () => {
    if (wheelAnim.current?.raf) cancelAnimationFrame(wheelAnim.current.raf);
    wheelAnim.current = null;
  };
  const cancelCamera = () => {
    cameraToken.current++;
    stopWheel();
  };

  /** Eased wheel zoom, anchored at the pointer: the point under the cursor stays put. */
  const onWheelZoom = (e: WheelEvent) => {
    const z = zoomRef.current;
    const c = canvas.current;
    if (!z || !c) return;
    e.preventDefault();
    cameraToken.current++; // cancel a focus/fit glide
    const rect = c.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.0018);
    const t = transform.current;
    const base = wheelAnim.current?.k ?? t.k;
    const target = Math.max(0.06, Math.min(8, base * Math.pow(2, delta)));
    const sel = select(c);
    const apply = (k: number) => {
      const cur = transform.current;
      const gx = (px - cur.x) / cur.k;
      const gy = (py - cur.y) / cur.k;
      z.transform(sel, zoomIdentity.translate(px - gx * k, py - gy * k).scale(k));
    };
    if (motion() === "minimal" || zoomPerf.current.slow) {
      apply(target);
      return;
    }
    if (wheelAnim.current) {
      wheelAnim.current.k = target;
      wheelAnim.current.px = px;
      wheelAnim.current.py = py;
      return;
    }
    const anim = { k: target, px, py, raf: null as number | null, last: performance.now() };
    wheelAnim.current = anim;
    const step = (now: number) => {
      if (wheelAnim.current !== anim) return;
      const dt = Math.min(64, now - anim.last);
      anim.last = now;
      const zp = zoomPerf.current;
      zp.dts.push(dt);
      if (zp.dts.length > 12) zp.dts.shift();
      if (zp.dts.length >= 8 && zp.dts.reduce((a, b) => a + b, 0) / zp.dts.length > 28) zp.slow = true;
      const cur = transform.current.k;
      const next = cur + (anim.k - cur) * (1 - Math.exp(-dt / 75));
      const done = Math.abs(anim.k - next) / anim.k < 0.002;
      const cx = transform.current;
      const gx = (anim.px - cx.x) / cx.k;
      const gy = (anim.py - cx.y) / cx.k;
      const k2 = done ? anim.k : next;
      z.transform(sel, zoomIdentity.translate(anim.px - gx * k2, anim.py - gy * k2).scale(k2));
      if (done) wheelAnim.current = null;
      else anim.raf = requestAnimationFrame(step);
    };
    anim.raf = requestAnimationFrame(step);
  };

  const clusterAt = (clientX: number, clientY: number): string | null => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const hit = clusterLabels.current.find((l) => x >= l.x0 && x <= l.x1 && y >= l.y0 && y <= l.y1);
    return hit?.id ?? null;
  };

  const focusClusterId = (id: string) => {
    const c = clusters.current.get(id);
    const members = c?.members ?? nodesRef.current.filter((n) => n.group === id);
    if (!members.length) return;
    focusedCluster.current = id;
    fitNodes(members, true, 1.8);
    requestDraw();
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
    focusCluster: (id) => focusClusterId(id),
    measure: async () => {
      const z = zoomRef.current;
      const c = canvas.current;
      if (!z || !c) throw new Error("The graph isn't ready yet");
      cancelCamera();
      const sel = select(c);
      const start = transform.current;
      const { w, h } = size.current;
      const visible = nodesRef.current.filter((n) => {
        const sx = n.x! * start.k + start.x, sy = n.y! * start.k + start.y;
        return sx > 0 && sx < w && sy > 0 && sy < h;
      });
      const phase = (ms: number, step: (u: number) => void) =>
        new Promise<PhaseResult>((resolve) => {
          const dts: number[] = [];
          let draw = 0, n = 0, last = 0;
          const t0 = performance.now();
          const tick = (now: number) => {
            if (last) dts.push(now - last);
            last = now;
            const u = (now - t0) / ms;
            if (u >= 1) {
              dts.sort((a, b) => a - b);
              const avg = dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length);
              resolve({ fps: Math.round(1000 / Math.max(1, avg)), p95FrameMs: Math.round(dts[Math.floor(dts.length * 0.95)] ?? 0), avgDrawMs: +(draw / Math.max(1, n)).toFixed(1) });
              return;
            }
            step(u);
            draw += counters.current.lastFrameMs;
            n++;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      const pan = await phase(1600, (u) => {
        const a = u * Math.PI * 2;
        z.transform(sel, zoomIdentity.translate(start.x + Math.cos(a) * 120 - 120, start.y + Math.sin(a) * 80).scale(start.k));
      });
      const zoom = await phase(1600, (u) => {
        const k = start.k * Math.pow(2, Math.sin(u * Math.PI * 2) * 0.8);
        z.transform(sel, zoomIdentity.translate(w / 2 - ((w / 2 - start.x) / start.k) * k, h / 2 - ((h / 2 - start.y) / start.k) * k).scale(k));
      });
      z.transform(sel, start);
      let i = 0;
      const hoverRes = await phase(1600, () => {
        if (!visible.length) return requestDraw();
        if (i++ % 3 === 0) hover.current = visible[Math.floor(Math.random() * visible.length)];
        requestDraw();
      });
      hover.current = null;
      requestDraw();
      return { nodes: nodesRef.current.length, links: linksRef.current.length, pan, zoom, hover: hoverRes };
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
    // Diagnostics hook (used by the performance tests): real counters from this renderer.
    if (!live.current.compact) (window as any).__mothGraphStats = () => ({ nodes: nodesRef.current.length, links: linksRef.current.length, frames: counters.current.frames, breathFrames: counters.current.breathFrames, lastFrameMs: counters.current.lastFrameMs, visibleLinks: counters.current.visEdges, bundles: counters.current.bundles, nodeLabels: counters.current.labels, detail: counters.current.detail, pulses: counters.current.pulses, grouped: grouped.current, groups: new Set(nodesRef.current.map((n) => n.group).filter(Boolean)).size, maxRadius: maxR.current, overlaps: (() => { let o = 0; const ns = nodesRef.current; const q = quadtree<SimNode>().x((d) => d.x!).y((d) => d.y!).addAll(ns); for (const n of ns) { q.visit((nd, x0, y0, x1, y1) => { if (!("length" in nd)) { let d: any = nd; do { const m = d.data as SimNode; if (m !== n && m.id > n.id && Math.hypot(m.x! - n.x!, m.y! - n.y!) < m.r + n.r) o++; d = d.next; } while (d); } return x0 > n.x! + 30 || x1 < n.x! - 30 || y0 > n.y! + 30 || y1 < n.y! - 30; }); } return o; })(), simAlpha: sim.current?.alpha() ?? 0, bgFrames: atmos.current?.frames ?? 0, clusters: [...clusters.current.values()].filter((c) => c.a > 0.5).map((c) => ({ id: c.id, name: c.name })), labels: clusterLabels.current.map((l) => ({ ...l })), transform: { ...transform.current }, screen: Object.fromEntries(nodesRef.current.map((n) => { const r = canvas.current!.getBoundingClientRect(); return [n.title, [r.left + transform.current.x + n.x! * transform.current.k, r.top + transform.current.y + n.y! * transform.current.k]]; })) });
    if (wrap.current && moteCanvas.current) atmos.current = new Atmosphere(wrap.current, moteCanvas.current);
    const resize = () => {
      if (!wrap.current) return;
      const r = wrap.current.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size.current = { w: r.width, h: r.height, dpr };
      atmos.current?.resize(r.width, r.height, dpr);
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
        // The new layout is now saved: later loads keep it (no re-layout, no jumping).
        if (relaid.current && live.current.onPositions) markLayoutCurrent();
        if (!fitted.current) {
          fitted.current = true;
          fit(true);
        }
      });
    sim.current = s;

    const z = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.06, 8])
      // Wheel zoom is handled by onWheelZoom (eased); d3 handles panning and touch.
      .filter((e: any) => e.type !== "wheel" && !e.ctrlKey && !e.button && !(e.type === "mousedown" && (findAt(e.clientX, e.clientY) || clusterAt(e.clientX, e.clientY))))
      .on("start", (e) => {
        if (e.sourceEvent) cancelCamera(); // the user takes over: stop any glide
      })
      .on("zoom", (e) => {
        transform.current = e.transform;
        atmos.current?.setCamera({ x: e.transform.x, y: e.transform.y, k: e.transform.k });
        requestDraw();
      });
    zoomRef.current = z;
    const sel = select(c);
    sel.call(z).on("dblclick.zoom", null).on("wheel.zoom", null);
    c.addEventListener("wheel", onWheelZoom, { passive: false });
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

    let waveTimer: number | undefined;
    const onMove = (e: MouseEvent) => {
      const n = findAt(e.clientX, e.clientY);
      const cl = n ? null : clusterAt(e.clientX, e.clientY);
      if (cl !== hoverCluster.current) {
        hoverCluster.current = cl;
        requestDraw();
      }
      if (n !== hover.current) {
        hover.current = n;
        live.current.onHover?.(n);
        requestDraw();
        if (waveTimer) clearTimeout(waveTimer);
        // A short dwell first, so sweeping the mouse across the graph doesn't fire waves everywhere.
        if (n) waveTimer = window.setTimeout(() => hover.current === n && hoverWave(n), 160);
      }
      c.style.cursor = n || cl ? "pointer" : "default";
    };
    const onLeave = () => {
      if (hover.current || hoverCluster.current) {
        hover.current = null;
        hoverCluster.current = null;
        live.current.onHover?.(null);
        requestDraw();
      }
    };
    let downAt = { x: 0, y: 0 };
    const onDown = (e: MouseEvent) => (downAt = { x: e.clientX, y: e.clientY });
    const onClick = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      const n = findAt(e.clientX, e.clientY);
      if (!n && !live.current.compact) {
        const cl = clusterAt(e.clientX, e.clientY);
        if (cl) {
          focusClusterId(cl);
          return;
        }
      }
      if (focusedCluster.current) {
        focusedCluster.current = null;
        requestDraw();
      }
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
        if (breathFrame.current) cancelAnimationFrame(breathFrame.current);
        breathFrame.current = null;
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
      if (waveTimer) clearTimeout(waveTimer);
      ro.disconnect();
      s.stop();
      cancelCamera();
      if (regionSettle.current) clearTimeout(regionSettle.current);
      atmos.current?.destroy();
      atmos.current = null;
      c.removeEventListener("wheel", onWheelZoom);
      if (!live.current.compact && (window as any).__mothGraphStats) delete (window as any).__mothGraphStats;
      document.removeEventListener("visibilitychange", onVisibility);
      c.removeEventListener("mousemove", onMove);
      c.removeEventListener("mouseleave", onLeave);
      c.removeEventListener("mousedown", onDown, true);
      c.removeEventListener("click", onClick);
      c.removeEventListener("dblclick", onDbl);
      c.removeEventListener("contextmenu", onCtx);
      if (frame.current) cancelAnimationFrame(frame.current);
      if (breathFrame.current) cancelAnimationFrame(breathFrame.current);
      if (ambientTimer.current) clearInterval(ambientTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ambient life: the atmosphere drifts on its own cheap layer; the graph itself redraws at a low rate only
  // while something actually breathes (core memories, the selection), and never while hidden.
  const ambientProp = props.ambient;
  useEffect(() => {
    const m = props.settings.animate === false ? "minimal" : props.motion ?? motionLevel();
    const amb = (ambientProp ?? ambientEnabled()) && m !== "minimal";
    atmos.current?.setOptions({ particles: (ambientProp ?? ambientEnabled()) && !props.compact, drift: amb && !props.compact, fps: m === "full" ? 24 : 12 });
    if (ambientTimer.current) clearInterval(ambientTimer.current);
    ambientTimer.current = null;
    let pulseTimer: number | undefined;
    if (amb && !props.compact) {
      // Breathing is a slow ~4 s cycle: 10 updates per second already look smooth (20 in Full).
      const fps = m === "full" ? 20 : 10;
      let skip = 0;
      ambientTimer.current = window.setInterval(() => {
        if (document.hidden || !breathing.current) return;
        // Half rate when MOTH isn't the active window, or on a slow machine / huge graph.
        if (!document.hasFocus() && (skip = (skip + 1) % 2)) return;
        requestBreath();
      }, 1000 / fps);
      // Occasional activity pulses (real recent changes only): about every 2.5 s in Full, 4 s in Balanced.
      pulseTimer = window.setInterval(() => {
        if (document.hidden) return;
        ambientPulse();
      }, m === "full" ? 2500 : 4000);
    }
    requestDraw();
    return () => {
      if (ambientTimer.current) clearInterval(ambientTimer.current);
      if (pulseTimer) clearInterval(pulseTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.motion, props.settings.animate, props.compact, ambientProp]);

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
    // Positions saved by an older layout algorithm (the dense ball) are laid out again, once. Pinned ones stay.
    const relayout = firstLoad && !layoutIsCurrent();
    if (relayout) relaid.current = true;
    const groupOf = (d: GraphNodeData) => (d.group !== undefined ? d.group : d.project_id) ?? null;
    const recentSince = Date.now() - RECENT_MS;
    let placed = 0;
    const unplaced: SimNode[] = [];
    for (const d of props.nodes) {
      const old = prev.get(d.id);
      const color = st.colorBy === "category" ? CATEGORY_COLOR[d.category] ?? NODE : st.colorBy === "project" ? props.projectColors?.get(d.project_id ?? "") ?? (d.kind === "document" ? NOTE : NODE) : NODE;
      const extra = { r: radius(d, st.nodeSize), color, core: isCore(d), group: groupOf(d), deg: nb.get(d.id)?.size ?? 0, active: !!d.updated_at && Date.parse(d.updated_at) >= recentSince };
      if (old) {
        Object.assign(old, d, { x: old.x, y: old.y }, extra);
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
      const n = { ...d, x: undefined, y: undefined, glow: 0, hi: 0, dim: 0, grow: 0, appearAt: 0, pulseAt: 0, phase: Math.random() * Math.PI * 2, hub: false, ...extra } as SimNode;
      if (d.x != null && d.y != null && (!relayout || d.pinned)) {
        n.x = d.x;
        n.y = d.y;
        placed++;
        if (d.pinned) {
          n.fx = d.x;
          n.fy = d.y;
        }
      } else unplaced.push(n);
      // Entrance animation only for memories that really appeared after the graph was shown.
      if (!firstLoad || pendingNew.current.has(d.id)) n.appearAt = pendingNew.current.get(d.id) ?? now;
      pendingNew.current.delete(d.id);
      next.set(d.id, n);
    }
    const all = [...next.values()];
    // Hubs: the most connected nodes in this view (e.g. index notes linking to hundreds of notes).
    const degs = all.map((n) => n.deg).sort((a, b) => a - b);
    const hubMin = Math.max(24, degs[Math.floor(degs.length * 0.985)] ?? 0);
    for (const n of all) n.hub = n.deg >= hubMin;
    maxR.current = Math.max(8, ...all.map((n) => n.r)) + 2;

    // ---- groups and their anchors
    const members = new Map<string, SimNode[]>();
    for (const n of all) if (n.group) (members.get(n.group) ?? members.set(n.group, []).get(n.group)!).push(n);
    const useGroups = props.clusterByProject !== false && members.size > 1;
    grouped.current = useGroups;
    const pairs = new Map<string, { a: string; b: string; count: number }>();
    if (useGroups) {
      for (const l of props.links) {
        const ga = next.get(l.source_id)?.group;
        const gb = next.get(l.target_id)?.group;
        if (!ga || !gb || ga === gb) continue;
        const [a, b] = ga < gb ? [ga, gb] : [gb, ga];
        const key = `${a}|${b}`;
        const pr = pairs.get(key) ?? pairs.set(key, { a, b, count: 0 }).get(key)!;
        pr.count++;
      }
    }
    crossPairs.current = pairs;
    groupState.current.version = -1;
    const spacing = 14 * st.nodeSize;
    const gapR = 26 * st.nodeSize;
    let anchors = new Map<string, { x: number; y: number; R: number }>();
    if (useGroups) {
      const key = [...members].map(([g, ms]) => `${g}:${Math.round(Math.log2(ms.length + 1) * 2)}`).sort().join("|") + `@${st.nodeSize}`;
      if (anchorCache.current && anchorCache.current.key === key && !relayout) anchors = anchorCache.current.map;
      else {
        // A small layout of the groups themselves: each group is a disc sized by its members; real links between
        // groups pull them together, so related regions end up side by side. Groups whose members already have
        // saved positions stay where they are.
        type GNode = SimulationNodeDatum & { id: string; R: number; size: number };
        const order = [...members].sort((a, b) => b[1].length - a[1].length);
        const gnodes: GNode[] = order.map(([id, ms], i) => {
          const R = spacing * (1.15 * Math.sqrt(ms.length) + 1.4);
          const placedMs = ms.filter((n) => n.x != null);
          const gn: GNode = { id, R, size: ms.length };
          if (placedMs.length >= Math.max(1, ms.length * 0.6)) {
            gn.fx = placedMs.reduce((a, n) => a + n.x!, 0) / placedMs.length;
            gn.fy = placedMs.reduce((a, n) => a + n.y!, 0) / placedMs.length;
            gn.x = gn.fx;
            gn.y = gn.fy;
          } else {
            const r = spacing * 6 * Math.sqrt(i + 0.5);
            gn.x = Math.cos(i * 2.39996) * r;
            gn.y = Math.sin(i * 2.39996) * r;
          }
          return gn;
        });
        const gById = new Map(gnodes.map((g) => [g.id, g]));
        const glinks = [...pairs.values()].map((pr) => ({ source: pr.a, target: pr.b, count: pr.count }));
        const gsim = forceSimulation<GNode>(gnodes)
          .force("link", forceLink<GNode, any>(glinks).id((d) => d.id).distance((l: any) => (l.source as GNode).R + (l.target as GNode).R + gapR).strength((l: any) => Math.min(0.6, 0.06 + (0.5 * l.count) / Math.min((l.source as GNode).size, (l.target as GNode).size) / 4)))
          .force("charge", forceManyBody<GNode>().strength((d) => -40 - 3 * Math.sqrt(d.size) * spacing))
          .force("collide", forceCollide<GNode>((d) => d.R + gapR * 0.6).iterations(3).strength(1))
          .force("x", forceX<GNode>(0).strength(0.04))
          .force("y", forceY<GNode>(0).strength(0.04))
          .stop();
        for (let i = 0; i < 320; i++) gsim.tick();
        for (const g of gnodes) anchors.set(g.id, { x: g.x!, y: g.y!, R: g.R });
        anchorCache.current = { key, map: anchors };
        void gById;
      }
    }
    const anchorOf = (d: SimNode) => (useGroups && d.group ? anchors.get(d.group) : undefined);

    // ---- place nodes without a position: inside their group's region, or next to a placed neighbour.
    for (const n of unplaced) {
      const an = anchorOf(n);
      const nbr = [...(nb.get(n.id) ?? [])].map((id) => next.get(id)).find((x) => x && x.x != null);
      const ang = Math.random() * Math.PI * 2;
      if (an && (relayout || !nbr)) {
        const rr = an.R * 0.75 * Math.sqrt(Math.random());
        n.x = an.x + Math.cos(ang) * rr;
        n.y = an.y + Math.sin(ang) * rr;
      } else if (nbr) {
        const dist = 16 + Math.random() * 12;
        n.x = nbr.x! + Math.cos(ang) * dist;
        n.y = nbr.y! + Math.sin(ang) * dist;
      } else {
        const dist = 40 + Math.random() * 120;
        n.x = Math.cos(ang) * dist;
        n.y = Math.sin(ang) * dist;
      }
    }

    const prevLinks = new Map(linksRef.current.map((l) => [l.id, l]));
    byId.current = next;
    neighbours.current = nb;
    nodesRef.current = all;
    linksRef.current = props.links
      .filter((l) => next.has(l.source_id) && next.has(l.target_id))
      .map((l) => {
        const was = prevLinks.get(l.id);
        const bornAt = pendingLinks.current.get(l.id) ?? (!firstLoad && !was ? now : was?.bornAt ?? 0);
        pendingLinks.current.delete(l.id);
        const a = next.get(l.source_id)!;
        const b = next.get(l.target_id)!;
        const hb = hash01(l.id);
        return {
          id: l.id, type: l.type, strength: l.strength, source: a, target: b, hi: was?.hi ?? 0, bornAt,
          cross: useGroups && !!a.group && !!b.group && a.group !== b.group,
          hubby: a.hub || b.hub,
          curve: (hb < 0.5 ? -1 : 1) * (0.05 + Math.abs(hb - 0.5) * 0.22),
          lod: hash01(l.id + "~"),
        };
      });
    activityLinks.current = linksRef.current.filter((l) => (l.source as SimNode).active || (l.target as SimNode).active).slice(0, 4000);
    posVersion.current++;

    // ---- forces
    const total = all.length;
    const dg = (n: SimNode) => Math.max(1, n.deg);
    s.nodes(all);
    s.force(
      "link",
      forceLink<SimNode, SimLink>(linksRef.current)
        .id((d) => d.id)
        .distance((l) => {
          const a = l.source as SimNode;
          const b = l.target as SimNode;
          return st.linkDistance * 0.75 + (a.r + b.r) * 1.3 + (l.hubby ? 24 : 0) + (l.cross ? 30 : 0);
        })
        .strength((l) => {
          const a = l.source as SimNode;
          const b = l.target as SimNode;
          // Normalised by BOTH ends' degree: a hub linking to hundreds of nodes pulls each of them only weakly
          // (that pull is what collapsed big vaults into one ball). Links between groups pull less again.
          const base = (st.linkForce * (0.6 + 0.4 * l.strength) * 3) / Math.sqrt(dg(a) * dg(b));
          return Math.min(0.8, base) * (l.cross ? 0.15 : 1);
        }),
    );
    // Repulsion is local (distanceMax): it spaces neighbours without inflating the whole graph into a disk.
    const repel = st.repelForce * (useGroups ? 0.3 : 0.6) * (1 + 0.25 * Math.log10(Math.max(1, total / 100)));
    s.force("charge", forceManyBody<SimNode>().strength((d) => -repel * (d.category === "project" ? 1.8 : d.hub ? 1.5 : 1)).distanceMin(4).distanceMax(useGroups ? 240 : 600).theta(0.9));
    const anchorK = 0.07;
    s.force("x", forceX<SimNode>((d) => anchorOf(d)?.x ?? 0).strength((d) => (anchorOf(d) ? anchorK : st.centerForce * (useGroups ? 0.25 : 0.5))));
    s.force("y", forceY<SimNode>((d) => anchorOf(d)?.y ?? 0).strength((d) => (anchorOf(d) ? anchorK : st.centerForce * (useGroups ? 0.25 : 0.5))));
    s.force("collide", forceCollide<SimNode>((d) => d.r + 4 * st.nodeSize + (d.hub ? 3 : 0)).iterations(2).strength(0.75));

    const fresh = unplaced.length;
    // Settle most of a new layout before the first frame (bounded to ~0.25 s), so it unfolds calmly instead of
    // starting as a tangle; the rest settles visibly.
    const preSettle = () => {
      const t0 = performance.now();
      s.alpha(1);
      while (performance.now() - t0 < 250 && s.alpha() > 0.08) s.tick();
    };
    if (!st.animate) {
      s.stop();
      if (fresh > 0 || firstLoad) {
        s.alpha(1);
        for (let i = 0; i < Math.min(320, 80 + total); i++) s.tick();
      }
      requestDraw();
      savePositions();
      if (!fitted.current) {
        fitted.current = true;
        fit(false);
      }
    } else if (firstLoad) {
      // Saved layout: settle gently instead of re-generating the graph.
      const saved = placed / Math.max(1, total);
      if (saved > 0.8) s.alpha(0.03).restart();
      else {
        preSettle();
        s.alpha(Math.min(s.alpha(), 0.3)).restart();
      }
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

  // Selecting a neuron: one soft ripple (not in Minimal motion).
  useEffect(() => {
    if (!props.selectedId || props.compact || motion() === "minimal") return;
    rippleAt.current = performance.now();
    requestBreath();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedId]);

  useEffect(requestDraw, [props.selectedId, props.highlight, props.edgeHighlight, props.suggested, props.attention, props.motion, props.clusters, props.settings.showLabels, props.settings.textFadeThreshold, props.settings.linkThickness, props.settings.showArrows]);

  return (
    <div ref={wrap} className="absolute inset-0 overflow-hidden" style={{ background: BG }}>
      <canvas ref={moteCanvas} className="pointer-events-none absolute inset-0 block" aria-hidden="true" />
      <canvas ref={regionCanvas} className="pointer-events-none absolute inset-0 block transition-opacity duration-300" aria-hidden="true" />
      <canvas ref={breathCanvas} className="pointer-events-none absolute inset-0 block" aria-hidden="true" />
      <canvas ref={canvas} className="relative block" aria-label="Knowledge graph" role="img" />
    </div>
  );
});
