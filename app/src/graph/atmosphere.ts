// The Mind's atmosphere (v0.3.0 "Living Atmosphere"): the layer behind the graph.
//
//  - A static backdrop: deep charcoal base, a few very faint radial lights (lavender and cool white), a soft
//    vignette and a fine grain. Painted once per size and used as the container's CSS background image, so it
//    costs nothing per frame (no extra live canvas layer to composite).
//  - An optional ambient particle field on a second, transparent canvas: tiny, low-opacity motes that drift very
//    slowly and move a little with the camera (parallax). Each frame only the few small spots the motes
//    occupied are cleared and redrawn (dirty rectangles), so the cost does not depend on the window size.
//
// Purely decorative and never interactive: it sits under the graph canvas with pointer-events: none.
// Everything stops while the window is hidden, and nothing moves when motion is reduced or ambient effects are off.

export const ATMOSPHERE_BASE = "#0E0E13";

export interface Camera {
  x: number;
  y: number;
  k: number;
}

interface Mote {
  x: number; // 0..1 of the field
  y: number;
  z: number; // depth 0.15 (far) .. 1 (near): parallax amount, size and brightness
  vx: number; // field units per second
  vy: number;
  a: number; // base alpha
  phase: number;
}

export interface AtmosphereOptions {
  /** Show particles at all. */
  particles: boolean;
  /** Let them drift and twinkle (false = a still star field, e.g. reduced motion). */
  drift: boolean;
  /** Frames per second for drift (kept low: they move a few pixels per second). */
  fps: number;
}

export class Atmosphere {
  private ctx: CanvasRenderingContext2D | null;
  private bgUrl: string | null = null;
  private bgTimer: number | null = null;
  private dot: HTMLCanvasElement | null = null;
  private dirty: { x: number; y: number; s: number }[] = [];
  private fullClear = true;
  private backdropKey = "";
  private motes: Mote[] = [];
  private w = 0;
  private h = 0;
  private dpr = 1;
  private cam: Camera = { x: 0, y: 0, k: 1 };
  private opts: AtmosphereOptions = { particles: true, drift: true, fps: 20 };
  private raf: number | null = null;
  private timer: number | null = null;
  private last = 0;
  private destroyed = false;
  /** Frames painted (diagnostics for the performance tests). */
  frames = 0;

  constructor(
    private host: HTMLElement,
    private canvas: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext("2d");
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  resize(w: number, h: number, dpr: number): void {
    if (w <= 0 || h <= 0) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const key = `${Math.round(w)}x${Math.round(h)}@${dpr}`;
    if (key !== this.backdropKey) {
      const first = !this.backdropKey;
      this.backdropKey = key;
      // Repaint the backdrop picture after resizing settles (instantly the first time).
      if (this.bgTimer) clearTimeout(this.bgTimer);
      this.bgTimer = window.setTimeout(() => this.paintBackdropImage(), first ? 0 : 180);
    }
    this.fullClear = true;
    this.seed();
    this.paint(performance.now());
  }

  setCamera(c: Camera): void {
    this.cam = c;
    this.fullClear = true;
    // Parallax follows the camera immediately (cheap: one copy + ~100 sprites).
    if (this.opts.particles) this.request();
  }

  setOptions(o: AtmosphereOptions): void {
    this.opts = o;
    this.fullClear = true;
    // No particles: take the layer out of the page entirely (nothing to composite).
    this.canvas.style.display = o.particles ? "block" : "none";
    this.seed();
    this.schedule();
    this.paint(performance.now());
  }

  private paintBackdropImage() {
    this.bgTimer = null;
    if (this.destroyed) return;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(this.w * this.dpr));
    c.height = Math.max(1, Math.round(this.h * this.dpr));
    const g = c.getContext("2d", { alpha: false });
    if (!g) return;
    paintBackdrop(g, this.w, this.h, this.dpr);
    c.toBlob((blob) => {
      if (!blob || this.destroyed) return;
      const url = URL.createObjectURL(blob);
      if (this.bgUrl) URL.revokeObjectURL(this.bgUrl);
      this.bgUrl = url;
      this.host.style.backgroundImage = `url(${url})`;
      this.host.style.backgroundSize = "100% 100%";
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.bgTimer) clearTimeout(this.bgTimer);
    if (this.bgUrl) URL.revokeObjectURL(this.bgUrl);
    this.bgUrl = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.stopLoop();
    this.motes = [];
    this.dirty = [];
    this.dot = null;
  }

  // ------------------------------------------------------------------ internals
  private onVisibility = () => {
    if (document.hidden) this.stopLoop();
    else {
      this.schedule();
      this.paint(performance.now());
    }
  };

  private seed() {
    if (!this.opts.particles) {
      this.motes = [];
      return;
    }
    // Density scales with area; capped so large monitors stay cheap.
    const target = Math.max(36, Math.min(140, Math.round((this.w * this.h) / 13000)));
    if (this.motes.length === target) return;
    let s = 1337 + target;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    this.motes = Array.from({ length: target }, () => {
      const z = 0.15 + Math.pow(rnd(), 1.8) * 0.85; // most motes far away
      const ang = rnd() * Math.PI * 2;
      const speed = (0.0016 + rnd() * 0.0035) * (0.5 + z * 0.5); // a few pixels per second
      return { x: rnd(), y: rnd(), z, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed - 0.0008, a: 0.05 + rnd() * 0.16 * (0.4 + z), phase: rnd() * Math.PI * 2 };
    });
  }

  private schedule() {
    this.stopLoop();
    if (this.destroyed || document.hidden || !this.opts.particles || !this.opts.drift) return;
    const interval = 1000 / Math.max(5, Math.min(30, this.opts.fps));
    let skip = 0;
    this.timer = window.setInterval(() => {
      // Half rate while MOTH isn't the active window.
      if (!document.hasFocus() && (skip = (skip + 1) % 2)) return;
      this.request();
    }, interval);
  }

  private stopLoop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private request() {
    if (this.raf !== null || this.destroyed || document.hidden) return;
    this.raf = requestAnimationFrame((t) => {
      this.raf = null;
      this.paint(t);
    });
  }

  private paint(now: number) {
    const ctx = this.ctx;
    if (!ctx || !this.backdropKey || this.destroyed) return;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    const { w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Clear only where motes were (or everything after a resize / camera move / option change).
    if (this.fullClear) ctx.clearRect(0, 0, w, h);
    else for (const d of this.dirty) ctx.clearRect(d.x - 1, d.y - 1, d.s + 2, d.s + 2);
    this.fullClear = false;
    this.dirty.length = 0;
    this.frames++;
    if (!this.motes.length) return;
    if (!this.dot) this.dot = paintDot();
    ctx.globalCompositeOperation = "lighter";
    // Parallax: nearer motes follow the camera a little more. Zoom spreads them very slightly around the centre.
    const zoomSpread = Math.log2(Math.max(0.05, this.cam.k));
    const drift = this.opts.drift;
    for (const m of this.motes) {
      if (drift && dt) {
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        if (m.x < 0) m.x += 1;
        else if (m.x >= 1) m.x -= 1;
        if (m.y < 0) m.y += 1;
        else if (m.y >= 1) m.y -= 1;
      }
      const par = 0.035 + m.z * 0.09;
      const spread = 1 + zoomSpread * 0.04 * m.z;
      let x = (m.x * w + this.cam.x * par - w / 2) * spread + w / 2;
      let y = (m.y * h + this.cam.y * par - h / 2) * spread + h / 2;
      x = ((x % w) + w) % w;
      y = ((y % h) + h) % h;
      const tw = drift ? 0.75 + 0.25 * Math.sin(now / 3200 + m.phase) : 1;
      const size = 1.6 + m.z * 3.2;
      ctx.globalAlpha = m.a * tw;
      ctx.drawImage(this.dot, x - size / 2, y - size / 2, size, size);
      this.dirty.push({ x: x - size / 2, y: y - size / 2, s: size });
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}

/** The static backdrop: base, faint lights, vignette, grain. Painted once per size. */
function paintBackdrop(g: CanvasRenderingContext2D, w: number, h: number, dpr: number): void {
  const c = g.canvas;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = ATMOSPHERE_BASE;
  g.fillRect(0, 0, w, h);
  const D = Math.hypot(w, h);
  const light = (x: number, y: number, r: number, rgb: string, a: number) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${rgb},${a})`);
    grad.addColorStop(0.55, `rgba(${rgb},${a * 0.35})`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  };
  // Very faint ambient illumination: lavender from the upper left, a cooler violet lower right,
  // and a whisper of light behind the centre where the graph lives.
  light(w * 0.32, h * 0.28, D * 0.55, "167,139,250", 0.07);
  light(w * 0.78, h * 0.76, D * 0.5, "110,100,190", 0.05);
  light(w * 0.52, h * 0.5, D * 0.38, "220,215,255", 0.025);
  // Vignette: darken the edges so the eye rests on the graph.
  const v = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, D * 0.62);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.5)");
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
  // Grain: a small random tile repeated; just enough to break up banding and flatness.
  const T = 128;
  const tile = document.createElement("canvas");
  tile.width = tile.height = T;
  const tg = tile.getContext("2d")!;
  const img = tg.createImageData(T, T);
  let s = 99991;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 16807) % 2147483647;
    const v8 = s & 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v8;
    img.data[i + 3] = 10; // ~4% opacity
  }
  tg.putImageData(img, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const pat = g.createPattern(tile, "repeat");
  if (pat) {
    g.fillStyle = pat;
    g.fillRect(0, 0, c.width, c.height);
  }
}

function paintDot(): HTMLCanvasElement {
  const S = 16;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, "rgba(232,228,255,1)");
  grad.addColorStop(0.35, "rgba(214,206,255,0.55)");
  grad.addColorStop(1, "rgba(200,190,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return c;
}
