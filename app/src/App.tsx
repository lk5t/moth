import { useEffect, useRef, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { MemoryEditor } from "./components/MemoryEditor";
import { MemoryPanel } from "./components/MemoryPanel";
import { MothMark } from "./components/MothLogo";
import { NAV, Sidebar, TitleBar, Toasts } from "./components/Shell";
import { Button } from "./components/ui";
import { onChanges, rpc } from "./lib/api";
import { AppProvider, useApp } from "./lib/app";
import { notify, setKeepInTray } from "./lib/tauri";
import { ConnectionsPage } from "./pages/Connections";
import { ActivityPage, TimelinePage } from "./pages/History";
import { MemoriesPage } from "./pages/Memories";
import { MetamorphosisPage } from "./pages/Metamorphosis";
import { MindPage } from "./pages/Mind";
import { Onboarding } from "./pages/Onboarding";
import { OverviewPage } from "./pages/Overview";
import { ProjectsPage } from "./pages/Projects";
import { SettingsPage } from "./pages/Settings";

export default function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}

function Root() {
  const [state, setState] = useState<"loading" | "onboarding" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const load = () =>
    rpc<any>("settings.get")
      .then((r) => {
        document.documentElement.classList.toggle("reduce-motion", !!r.settings["appearance.reduceMotion"]);
        void setKeepInTray(r.settings["app.closeToTray"] !== false);
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
          <Onboarding onDone={() => setState("ready")} />
        </div>
      ) : (
        <Workspace />
      )}
      <Toasts />
    </div>
  );
}

function Workspace() {
  const app = useApp();
  const { page, go, setPaletteOpen, edit, select, selected } = app;
  const notified = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "");
      if (mod && e.key.toLowerCase() === "k") (e.preventDefault(), setPaletteOpen(true));
      else if (mod && e.key.toLowerCase() === "n") (e.preventDefault(), edit("new"));
      else if (mod && /^[1-9]$/.test(e.key)) (e.preventDefault(), go(NAV[Number(e.key) - 1].page));
      else if (mod && e.key === "\\") (e.preventDefault(), app.setSidebarCollapsed(!app.sidebarCollapsed));
      else if (e.key === "Escape" && !typing && selected && !document.querySelector("[role=dialog]")) select(null);
      else if (e.key === "/" && !typing) (e.preventDefault(), setPaletteOpen(true));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, setPaletteOpen, edit, select, selected, app]);

  // A quiet notification when Claude teaches MOTH something while the window is in the background.
  useEffect(
    () =>
      onChanges((changes) => {
        const learned = changes.filter((c) => c.entity === "memory" && c.op === "insert").length;
        if (!learned || !document.hidden || Date.now() - notified.current < 60_000) return;
        notified.current = Date.now();
        void rpc<any>("settings.get").then((r) => {
          if (r.settings["notifications.enabled"] && r.settings["notifications.learning"]) void notify("MOTH learned something", learned === 1 ? "1 new memory from your latest Claude session" : `${learned} new memories from your latest Claude session`);
        });
      }),
    [],
  );

  const Page = { overview: OverviewPage, mind: MindPage, memories: MemoriesPage, projects: ProjectsPage, metamorphosis: MetamorphosisPage, timeline: TimelinePage, activity: ActivityPage, connections: ConnectionsPage, settings: SettingsPage }[page];
  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      <main className="relative min-w-0 flex-1" id="main">
        <Page key={page === "projects" ? `${page}-${app.params.id ?? ""}` : page} />
      </main>
      <MemoryPanel />
      <CommandPalette />
      <MemoryEditor />
    </div>
  );
}
