import { useEffect, useRef, useState, type ReactElement } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { MemoryEditor } from "./components/MemoryEditor";
import { MemoryPanel } from "./components/MemoryPanel";
import { MothMark } from "./components/MothLogo";
import { QuickCapture } from "./components/QuickCapture";
import { NAV, Sidebar, TitleBar, Toasts } from "./components/Shell";
import { Button, Dialog } from "./components/ui";
import { onChanges, rpc } from "./lib/api";
import { AppProvider, useApp, type Page } from "./lib/app";
import { setMotionSetting } from "./lib/motion";
import { notify, onShellEvent, setCaptureShortcut, setKeepInTray, trayRefresh } from "./lib/tauri";
import { AdaptationPage } from "./pages/Adaptation";
import { ConnectionsPage } from "./pages/Connections";
import { CortexPage } from "./pages/Cortex";
import { GuidePage } from "./pages/Guide";
import { ActivityPage, TimelinePage } from "./pages/History";
import { InboxPage } from "./pages/Inbox";
import { MemoriesPage } from "./pages/Memories";
import { MetamorphosisPage } from "./pages/Metamorphosis";
import { MindPage } from "./pages/Mind";
import { Onboarding } from "./pages/Onboarding";
import { OverviewPage } from "./pages/Overview";
import { ProjectsPage } from "./pages/Projects";
import { ResearchPage } from "./pages/Research";
import { SettingsPage } from "./pages/Settings";

const isCaptureWindow = () => typeof window !== "undefined" && window.location.hash.replace("#", "").startsWith("capture");

export default function App() {
  if (isCaptureWindow()) return <QuickCapture />;
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}

function Root() {
  const [state, setState] = useState<"loading" | "onboarding" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [firstMemory, setFirstMemory] = useState<string | undefined>();
  const load = () =>
    rpc<any>("settings.get")
      .then((r) => {
        setMotionSetting(r.settings["appearance.motion"], !!r.settings["appearance.reduceMotion"]);
        void setKeepInTray(r.settings["app.closeToTray"] !== false);
        if (r.settings["quickCapture.enabled"])
          void setCaptureShortcut(r.settings["quickCapture.shortcut"] || null).then((err) => {
            if (err) window.dispatchEvent(new CustomEvent("moth-shortcut-error", { detail: r.settings["quickCapture.shortcut"] }));
          });
        setState(r.settings["onboarding.completed"] ? "ready" : "onboarding");
      })
      .catch((e) => {
        setError(e.message);
        setState("error");
      });
  useEffect(() => void load(), []);

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      {state === "loading" ? (
        <div className="grid flex-1 place-items-center">
          <MothMark size={40} className="animate-pulse text-accent-soft" />
        </div>
      ) : state === "error" ? (
        <div className="grid flex-1 place-items-center">
          <div className="max-w-[420px] text-center">
            <p className="text-[15px]">MOTH's memory engine isn't responding</p>
            <p className="mt-1 text-[13px] text-ink-2">{error}</p>
            <Button className="mt-4" onClick={() => (setState("loading"), void load())}>
              Try again
            </Button>
          </div>
        </div>
      ) : state === "onboarding" ? (
        <div className="min-h-0 flex-1">
          <Onboarding
            onDone={(id) => {
              setFirstMemory(id);
              setState("ready");
            }}
          />
        </div>
      ) : (
        <Workspace firstMemory={firstMemory} onRestartFirstFlight={() => setState("onboarding")} />
      )}
      <Toasts />
    </div>
  );
}

function Workspace({ firstMemory, onRestartFirstFlight }: { firstMemory?: string; onRestartFirstFlight: () => void }) {
  const app = useApp();
  const { page, go, setPaletteOpen, edit, select, selected, toast } = app;
  const lastNotification = useRef<number | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);

  // First Flight ends in The Mind with the first memory in the spotlight.
  useEffect(() => {
    if (firstMemory) go("mind", { focus: firstMemory });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstMemory]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "");
      if (mod && e.key.toLowerCase() === "k") (e.preventDefault(), setPaletteOpen(true));
      else if (mod && e.key.toLowerCase() === "n") (e.preventDefault(), edit("new"));
      else if (mod && /^[1-9]$/.test(e.key)) (e.preventDefault(), go(NAV[Number(e.key) - 1].page));
      else if (mod && e.key === ",") (e.preventDefault(), go("settings"));
      else if (mod && e.key === "\\") (e.preventDefault(), app.setSidebarCollapsed(!app.sidebarCollapsed));
      else if (e.key === "Escape" && !typing && selected && !document.querySelector("[role=dialog]")) select(null);
      else if (e.key === "/" && !typing) (e.preventDefault(), setPaletteOpen(true));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, setPaletteOpen, edit, select, selected, app]);

  // Tray menu / Quick Capture window → navigate here.
  useEffect(
    () =>
      onShellEvent<string>("navigate", (target) => {
        if (target.startsWith("memory:")) {
          select(target.slice(7));
          return;
        }
        go(target as Page);
      }),
    [go, select],
  );
  // The Quick Capture shortcut can be taken by another app: say so instead of failing silently.
  useEffect(() => {
    const fn = (e: Event) =>
      toast({ kind: "error", text: `The Quick Capture shortcut ${(e as CustomEvent).detail} is already used by another app. Choose another one in Settings → General.`, action: { label: "Change", run: () => go("settings") } });
    window.addEventListener("moth-shortcut-error", fn);
    return () => window.removeEventListener("moth-shortcut-error", fn);
  }, [toast, go]);
  // In a browser (no tray), "Quick Capture" opens an inline dialog.
  useEffect(() => {
    const fn = () => setCaptureOpen(true);
    window.addEventListener("moth-capture", fn);
    return () => window.removeEventListener("moth-capture", fn);
  }, []);
  // The first time the window is hidden to the tray, say so (once).
  useEffect(
    () =>
      onShellEvent("hidden-to-tray", () => {
        try {
          if (localStorage.getItem("moth.trayHint")) return;
          localStorage.setItem("moth.trayHint", "1");
        } catch {
          /* ignore */
        }
        void notify("MOTH is still running", "It keeps working in the tray so Claude can use it. Right-click the tray icon to quit completely.");
      }),
    [],
  );

  // Native notifications decided by the engine (it already applies your notification level).
  useEffect(() => {
    void rpc<any>("notifications.since", { after_id: 1e15 }).then((r) => (lastNotification.current = r.latest)).catch(() => undefined);
    return onChanges((changes) => {
      if (changes.some((c) => c.entity === "settings")) {
        void trayRefresh();
        if (changes.some((c) => c.entity === "settings" && String(c.id).startsWith("appearance."))) void rpc<any>("settings.get").then((r) => setMotionSetting(r.settings["appearance.motion"], !!r.settings["appearance.reduceMotion"]));
      }
      if (!changes.some((c) => c.entity === "activity")) return;
      if (lastNotification.current === null) return;
      void rpc<any>("notifications.since", { after_id: lastNotification.current }).then((r) => {
        lastNotification.current = r.latest;
        for (const n of r.items) {
          if (document.hasFocus()) toast({ kind: n.level === "important" ? "light" : "info", text: `${n.title}. ${n.body}` });
          else void notify(n.title, n.body);
        }
      });
    });
  }, [toast]);

  // Stable component types: an inline arrow here would remount the page (losing its state) on every render.
  const pages: Record<Page, (props: { onRestartFirstFlight: () => void }) => ReactElement> = {
    overview: OverviewPage,
    mind: MindPage,
    memories: MemoriesPage,
    projects: ProjectsPage,
    metamorphosis: MetamorphosisPage,
    cortex: CortexPage,
    inbox: InboxPage,
    adaptation: AdaptationPage,
    research: ResearchPage,
    timeline: TimelinePage,
    activity: ActivityPage,
    connections: ConnectionsPage,
    settings: SettingsPage,
    guide: GuidePage,
  };
  const Page = pages[page];
  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      <main className="relative min-w-0 flex-1" id="main">
        <Page key={page === "projects" ? `${page}-${app.params.id ?? ""}` : page} onRestartFirstFlight={onRestartFirstFlight} />
      </main>
      <MemoryPanel />
      <CommandPalette />
      <MemoryEditor />
      <Dialog open={captureOpen} onClose={() => setCaptureOpen(false)} title="Quick Capture" width={520}>
        <QuickCapture embedded onClose={() => setCaptureOpen(false)} onOpen={(id) => (setCaptureOpen(false), select(id))} />
      </Dialog>
    </div>
  );
}
