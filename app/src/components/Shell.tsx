import { Activity, Brain, Cable, Clock3, Copy, Cpu, FolderKanban, LayoutDashboard, Library, Minus, PanelLeftClose, PanelLeftOpen, Search, Settings, Sparkles, Square, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { isTauri, onConnection } from "../lib/api";
import { useApp, type Page } from "../lib/app";
import { useLive } from "../lib/hooks";
import { isMaximized, windowAction } from "../lib/tauri";
import { cn } from "../lib/utils";
import { Kbd } from "./ui";
import { MothMark } from "./MothLogo";

export const NAV: { page: Page; label: string; icon: ReactNode; key: string }[] = [
  { page: "overview", label: "Overview", icon: <LayoutDashboard />, key: "1" },
  { page: "mind", label: "The Mind", icon: <Brain />, key: "2" },
  { page: "memories", label: "Memories", icon: <Library />, key: "3" },
  { page: "projects", label: "Projects", icon: <FolderKanban />, key: "4" },
  { page: "metamorphosis", label: "Metamorphosis", icon: <Sparkles />, key: "5" },
  { page: "cortex", label: "Cortex", icon: <Cpu />, key: "6" },
  { page: "timeline", label: "Timeline", icon: <Clock3 />, key: "7" },
  { page: "activity", label: "Activity", icon: <Activity />, key: "8" },
  { page: "connections", label: "Connections", icon: <Cable />, key: "9" },
  { page: "settings", label: "Settings", icon: <Settings />, key: "," },
];

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
  const { page, go, sidebarCollapsed: collapsed, setSidebarCollapsed } = useApp();
  const { data: stats } = useLive<any>("meta.stats", {}, { entities: ["memory", "relationship", "project"] });
  const { data: conn } = useLive<any>("connections.status", {}, { entities: ["activity"] });
  const { data: reviews } = useLive<any[]>("cortex.reviews", {}, { entities: ["review"] });
  return (
    <motion.nav
      animate={{ width: collapsed ? 56 : 216 }}
      transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      className="flex shrink-0 flex-col border-r border-line bg-sidebar py-3"
      aria-label="Main"
    >
      <div className="flex flex-col gap-0.5 px-2">
        {NAV.map((n) => (
          <button
            key={n.page}
            onClick={() => go(n.page)}
            title={collapsed ? `${n.label} (Ctrl+${n.key})` : undefined}
            aria-current={page === n.page ? "page" : undefined}
            className={cn(
              "group relative flex h-8 items-center gap-3 rounded-[8px] px-2.5 text-[13px] transition-colors [&_svg]:size-[17px] [&_svg]:shrink-0",
              page === n.page ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface hover:text-ink",
            )}
          >
            {page === n.page ? <span className="absolute left-0 top-2 h-4 w-[2px] rounded-full bg-accent" /> : null}
            <span className={page === n.page ? "text-accent-soft" : ""}>{n.icon}</span>
            <AnimatePresence initial={false}>
              {!collapsed ? (
                <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-1 items-center truncate text-left">
                  {n.label}
                  {n.page === "cortex" && reviews?.length ? <span className="ml-auto rounded-full bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] px-1.5 text-[11px] text-accent-soft" title="Waiting for your approval">{reviews.length}</span> : null}
                </motion.span>
              ) : null}
            </AnimatePresence>
          </button>
        ))}
      </div>
      <div className="mt-auto px-2">
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
              {conn?.claude_connected ? "Claude connected" : "Claude not connected"}
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
