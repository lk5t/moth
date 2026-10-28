import { Activity, BookOpenCheck, HeartPulse, Sparkles, Brain, Cable, ChevronRight, CircleHelp, Clock3, Copy, Cpu, FolderKanban, Inbox, LayoutDashboard, Library, Minus, Moon, PanelLeftClose, PanelLeftOpen, Search, Settings, ShieldOff, Square, UserRound, X, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { isTauri, onConnection } from "../lib/api";
import { useApp, type Page } from "../lib/app";
import { useLive } from "../lib/hooks";
import { isMaximized, openQuickCapture, windowAction } from "../lib/tauri";
import { rpc } from "../lib/api";
import { cn } from "../lib/utils";
import { Kbd } from "./ui";
import { MothMark } from "./MothLogo";
import { cortexActivity } from "./CortexPulse";

type NavItem = { page: Page; label: string; icon: ReactNode; key: string };

/** Main destinations (Ctrl+1…9). The Mind stays one of the central experiences. */
export const NAV: NavItem[] = [
  { page: "overview", label: "Overview", icon: <LayoutDashboard />, key: "1" },
  { page: "mind", label: "The Mind", icon: <Brain />, key: "2" },
  { page: "memories", label: "Memories", icon: <Library />, key: "3" },
  { page: "projects", label: "Projects", icon: <FolderKanban />, key: "4" },
  { page: "discoveries", label: "Discoveries", icon: <Sparkles />, key: "5" },
  { page: "health", label: "Knowledge Health", icon: <HeartPulse />, key: "6" },
  { page: "inbox", label: "Review Queue", icon: <Inbox />, key: "7" },
  { page: "cortex", label: "Cortex", icon: <Cpu />, key: "8" },
  { page: "adaptation", label: "About Me", icon: <UserRound />, key: "9" },
  { page: "research", label: "Research Library", icon: <BookOpenCheck />, key: "" },
  { page: "timeline", label: "Timeline", icon: <Clock3 />, key: "" },
];
/** Sidebar groups (by page, so Ctrl+1…9 can follow NAV's order independently). */
const GROUPS: { label: string | null; pages: Page[] }[] = [
  { label: null, pages: ["overview", "mind", "memories", "projects"] },
  { label: "Intelligence", pages: ["discoveries", "health", "inbox", "cortex"] },
  { label: "Knowledge", pages: ["adaptation", "research", "timeline"] },
];
const SYSTEM: NavItem[] = [
  { page: "connections", label: "Connections", icon: <Cable />, key: "" },
  { page: "settings", label: "Settings", icon: <Settings />, key: "," },
];
const MORE: NavItem[] = [
  { page: "metamorphosis", label: "Sleep Cycle", icon: <Moon />, key: "" },
  { page: "activity", label: "Activity log", icon: <Activity />, key: "" },
  { page: "guide", label: "Quick Guide", icon: <CircleHelp />, key: "" },
];
export const ALL_PAGES: NavItem[] = [...NAV, ...SYSTEM, ...MORE];

export function TitleBar() {
  const { setPaletteOpen } = useApp();
  const [max, setMax] = useState(false);
  const [engine, setEngine] = useState(true);
  useEffect(() => onConnection(setEngine), []);
  useEffect(() => {
    void isMaximized().then(setMax);
    const fn = () => void isMaximized().then(setMax);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return (
    <div data-tauri-drag-region className="drag-region flex h-9 shrink-0 items-center border-b border-line bg-sidebar pl-3" onDoubleClick={() => void windowAction("toggleMaximize")}>
      <div data-tauri-drag-region className="flex items-center gap-2 text-accent-soft">
        <MothMark size={16} />
        <span data-tauri-drag-region className="text-[12px] font-[600] tracking-[0.16em] text-ink">MOTH</span>
      </div>
      <div data-tauri-drag-region className="flex flex-1 justify-center">
        <button
          onClick={() => setPaletteOpen(true)}
          className="flex h-6 w-[340px] max-w-[46vw] items-center gap-2 rounded-[7px] border border-line bg-bg px-2.5 text-[12px] text-ink-3 hover:border-line-strong [-webkit-app-region:no-drag]"
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search your mind</span>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </button>
      </div>
      <div className="flex items-center gap-3 pr-1 [-webkit-app-region:no-drag]">
        <span className="flex items-center gap-1.5 text-[11.5px] text-ink-3" title={engine ? "Memory engine running" : "Reconnecting to the memory engine"}>
          <span className={cn("size-1.5 rounded-full", engine ? "bg-ok" : "animate-pulse bg-warn")} />
          {engine ? "Engine" : "Reconnecting"}
        </span>
        {isTauri() ? (
          <div className="flex">
            <WinBtn label="Minimise" onClick={() => windowAction("minimize")}>
              <Minus />
            </WinBtn>
            <WinBtn label={max ? "Restore" : "Maximise"} onClick={() => windowAction("toggleMaximize").then(() => isMaximized().then(setMax))}>
              {max ? <Copy className="!size-3" /> : <Square className="!size-3" />}
            </WinBtn>
            <WinBtn label="Close" danger onClick={() => windowAction("close")}>
              <X />
            </WinBtn>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WinBtn({ children, onClick, label, danger }: { children: ReactNode; onClick: () => void; label: string; danger?: boolean }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={cn("grid h-9 w-11 place-items-center text-ink-2 transition-colors [&_svg]:size-4", danger ? "hover:bg-[#c42b1c] hover:text-white" : "hover:bg-surface-2 hover:text-ink")}>
      {children}
    </button>
  );
}

export function Sidebar() {
  const { page, go, sidebarCollapsed: collapsed, setSidebarCollapsed, toast } = useApp();
  const { data: stats } = useLive<any>("meta.stats", {}, { entities: ["memory", "relationship", "project"] });
  const { data: conn } = useLive<any>("connections.status", {}, { entities: ["activity"] });
  const { data: counts } = useLive<any>("inbox.counts", {}, { entities: ["review" as any] });
  const { data: sys, reload: reloadSys } = useLive<any>("system.state", {}, { entities: ["settings" as any] });
  const [more, setMore] = useState(() => MORE.some((m) => m.page === page));
  const pending = Number(counts?.pending ?? 0);
  const { data: cortex } = useLive<any>("cortex.status", {}, { entities: ["cortex" as any] });
  const cortexBusy = cortexActivity(cortex).kind === "busy";
  const { data: settings } = useLive<any>("settings.get", {}, { entities: ["settings" as any] });
  const shortcut = settings?.settings?.["quickCapture.enabled"] ? String(settings.settings["quickCapture.shortcut"] ?? "").replace(/\+/g, " ") : "";
  const item = (n: NavItem) => (
    <button
      key={n.page}
      onClick={() => go(n.page)}
      title={collapsed ? `${n.label}${n.key ? ` (Ctrl+${n.key})` : ""}` : undefined}
      aria-current={page === n.page ? "page" : undefined}
      className={cn(
        "group relative flex h-8 items-center gap-3 rounded-[8px] px-2.5 text-[13px] transition-colors duration-200 [&_svg]:size-[17px] [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-200 hover:[&_svg]:translate-x-[1px]",
        page === n.page ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface hover:text-ink",
      )}
    >
      {page === n.page ? <motion.span layoutId="moth-nav-indicator" transition={{ type: "spring", stiffness: 520, damping: 38 }} className="absolute left-0 top-2 h-4 w-[2px] rounded-full bg-accent shadow-[0_0_8px_rgba(167,139,250,0.7)]" /> : null}
      <span className={cn("relative", page === n.page ? "text-accent-soft" : "")}>
        {n.icon}
        {collapsed && n.page === "inbox" && pending ? <span className="absolute -right-1 -top-1 size-2 rounded-full bg-accent" /> : null}
        {n.page === "cortex" && cortexBusy ? <span className="absolute -right-1 -top-1 size-1.5 animate-pulse rounded-full bg-accent shadow-[0_0_6px_rgba(167,139,250,0.9)]" title="Cortex is working" /> : null}
      </span>
      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-1 items-center truncate text-left">
            {n.label}
            {n.page === "inbox" && pending ? <span className="ml-auto rounded-full bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] px-1.5 text-[11px] text-accent-soft" title="Waiting for your decision">{pending}</span> : null}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </button>
  );
  const section = (label: string) => (!collapsed ? <div className="mb-1 mt-3 px-2.5 text-[10.5px] uppercase tracking-[0.14em] text-ink-3">{label}</div> : <div className="mx-2.5 my-2 h-px bg-line" />);
  const toggle = async (what: "privacy" | "learning") => {
    try {
      if (what === "privacy") await rpc("privacy.set", { on: !sys?.privacy });
      else await rpc("automation.pause", { paused: !sys?.learning_paused });
      void reloadSys();
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };
  return (
    <motion.nav
      animate={{ width: collapsed ? 56 : 216 }}
      transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      className="flex shrink-0 flex-col overflow-y-auto border-r border-line bg-sidebar py-3"
      aria-label="Main"
    >
      <div className="flex flex-col gap-0.5 px-2">
        {GROUPS.map((g, gi) => (
          <div key={gi} className="contents">
            {g.label ? section(g.label) : null}
            {g.pages.map((pg) => NAV.find((n) => n.page === pg)).filter(Boolean).map((n) => item(n!))}
          </div>
        ))}
        {section("System")}
        {SYSTEM.map(item)}
        {!collapsed ? (
          <button onClick={() => setMore(!more)} className="mt-1 flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[12px] text-ink-3 hover:text-ink" aria-expanded={more}>
            <ChevronRight className={cn("size-3.5 transition-transform", more && "rotate-90")} /> More
          </button>
        ) : null}
        {more || collapsed ? MORE.map(item) : null}
      </div>
      <div className="mt-auto px-2 pt-3">
        {sys?.privacy || sys?.learning_paused ? (
          <button
            onClick={() => void toggle(sys.privacy ? "privacy" : "learning")}
            title={sys.privacy ? "Privacy Mode is on: MOTH isn't learning automatically and nothing goes to the cloud. Click to turn it off." : "Learning is paused. Click to resume."}
            className="mb-2 flex w-full items-center gap-2 rounded-[10px] border border-[color-mix(in_srgb,var(--color-warn)_40%,transparent)] px-2.5 py-2 text-left text-[12px] text-warn [&_svg]:size-4 [&_svg]:shrink-0"
          >
            <ShieldOff />
            {!collapsed ? <span>{sys.privacy ? "Privacy Mode on" : "Learning paused"}</span> : null}
          </button>
        ) : null}
        {!collapsed ? (
          <button onClick={() => void openQuickCapture()} className="mb-2 flex h-8 w-full items-center gap-2 rounded-[8px] border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong hover:text-ink [&_svg]:size-4">
            <Zap className="text-accent-soft" /> Quick Capture
            {shortcut ? <span className="ml-auto text-[10.5px] text-ink-3">{shortcut}</span> : null}
          </button>
        ) : null}
        {!collapsed && stats ? (
          <div className="mb-3 rounded-[10px] border border-line px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
            <div>
              <span className="tabular-nums text-ink">{Number(stats.total_memories).toLocaleString()}</span> memories
            </div>
            <div>
              <span className="tabular-nums text-ink">{Number(stats.total_relationships).toLocaleString()}</span> connections
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full", conn?.claude_connected ? "bg-ok" : "bg-ink-3")} />
              {conn?.claude_connected ? "Claude connected" : conn?.last_success ? "Claude used MOTH earlier" : "Claude not connected"}
            </div>
          </div>
        ) : null}
        <button
          onClick={() => setSidebarCollapsed(!collapsed)}
          className="flex h-8 w-full items-center gap-3 rounded-[8px] px-2.5 text-[12.5px] text-ink-3 hover:bg-surface hover:text-ink [&_svg]:size-[17px]"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          {!collapsed ? <span>Collapse</span> : null}
        </button>
      </div>
    </motion.nav>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[340px] flex-col gap-2" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className={cn(
              "panel pointer-events-auto flex items-start gap-3 px-3.5 py-3 text-[13px] shadow-[0_12px_40px_rgba(0,0,0,0.45)]",
              t.kind === "error" && "border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)]",
              t.kind === "light" && "light-bloom",
            )}
          >
            {t.kind === "light" ? <MothMark size={16} className="mt-0.5 shrink-0 text-accent-soft" /> : <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", t.kind === "error" ? "bg-danger" : t.kind === "ok" ? "bg-ok" : "bg-ink-2")} />}
            <span className="flex-1 leading-snug text-ink">{t.text}</span>
            {t.action ? (
              <button className="shrink-0 text-accent hover:text-accent-soft" onClick={() => (t.action!.run(), dismiss(t.id))}>
                {t.action.label}
              </button>
            ) : null}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
