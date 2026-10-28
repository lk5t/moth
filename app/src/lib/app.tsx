import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type Page = "overview" | "mind" | "memories" | "projects" | "metamorphosis" | "cortex" | "inbox" | "adaptation" | "research" | "timeline" | "activity" | "connections" | "settings" | "guide" | "health";

export interface Toast {
  id: number;
  kind: "info" | "ok" | "error" | "light";
  text: string;
  action?: { label: string; run: () => void };
}

interface AppState {
  page: Page;
  params: Record<string, string>;
  go: (p: Page, params?: Record<string, string>) => void;
  selected: string | null;
  select: (id: string | null) => void;
  editing: string | "new" | null;
  edit: (id: string | "new" | null) => void;
  paletteOpen: boolean;
  setPaletteOpen: (o: boolean) => void;
  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (c: boolean) => void;
}

const Ctx = createContext<AppState | null>(null);
let toastSeq = 1;

export function AppProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<Page>("overview");
  const [params, setParams] = useState<Record<string, string>>({});
  const [selected, select] = useState<string | null>(null);
  const [editing, edit] = useState<string | "new" | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("moth.sidebar") === "collapsed";
    } catch {
      return false;
    }
  });

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = toastSeq++;
      setToasts((all) => [...all.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.kind === "error" ? 7000 : 4200);
    },
    [dismiss],
  );
  const go = useCallback((p: Page, prm: Record<string, string> = {}) => {
    setPage(p);
    setParams(prm);
  }, []);
  const collapse = useCallback((c: boolean) => {
    setSidebarCollapsed(c);
    try {
      localStorage.setItem("moth.sidebar", c ? "collapsed" : "open");
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(
    () => ({ page, params, go, selected, select, editing, edit, paletteOpen, setPaletteOpen, toasts, toast, dismiss, sidebarCollapsed, setSidebarCollapsed: collapse }),
    [page, params, go, selected, editing, paletteOpen, toasts, toast, dismiss, sidebarCollapsed, collapse],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}
