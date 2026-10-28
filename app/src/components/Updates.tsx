// Settings → Updates, and the quiet "MOTH Update Available" notice.
import { ArrowDownToLine, RefreshCw, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../lib/api";
import { checkForUpdate, deferUpdate, installUpdate, useUpdater } from "../lib/updater";
import { isTauri } from "../lib/api";
import { fmtBytes } from "./ImportWizard";
import { Button, Switch } from "./ui";

export function UpdatesSettings({ s, set }: { s: any; set: (k: string, v: unknown, msg?: string) => void }) {
  const u = useUpdater();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    void import("@tauri-apps/api/app").then((a) => a.getVersion()).then(setVersion).catch(() => undefined);
  }, []);
  return (
    <div className="grid gap-5" data-testid="updates-settings">
      <section className="panel p-4">
        <h2 className="text-[14px] text-ink">Updates</h2>
        <div className="mt-2 grid gap-1 text-[13px] text-ink-2">
          <span>
            Installed version: <b className="font-normal text-ink">{version ?? u.current ?? "—"}</b>
          </span>
          <span>Last check: {s["updates.lastCheck"] ? new Date(s["updates.lastCheck"]).toLocaleString() : "never"}</span>
        </div>
        <UpdateStatus />
        <div className="mt-3 flex gap-2">
          <Button onClick={() => void checkForUpdate()} loading={u.phase === "checking"} disabled={!isTauri() || ["downloading", "installing"].includes(u.phase)}>
            <RefreshCw /> Check for updates
          </Button>
          {u.phase === "available" ? (
            <Button variant="primary" onClick={() => void installUpdate()}>
              <ArrowDownToLine /> Update now
            </Button>
          ) : null}
        </div>
        {!isTauri() ? <p className="mt-2 text-[12px] text-ink-3">Updates work in the installed app.</p> : null}
      </section>
      <section className="panel p-4">
        <label className="flex items-center justify-between gap-3 text-[13px] text-ink-2">
          Check for updates automatically (once a day, quietly)
          <Switch checked={!!s["updates.autoCheck"]} onChange={(v) => set("updates.autoCheck", v)} label="Check for updates automatically" />
        </label>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
          Updates come from MOTH's GitHub releases and are signed. MOTH checks the signature with a key built into the app and refuses anything that doesn't match. Before installing, MOTH saves your notes and workspace, pauses imports (they continue afterwards), lets background work finish and makes a backup copy of your database. On Windows, MOTH closes while the installer runs and opens again when it's done.
        </p>
      </section>
    </div>
  );
}

export function UpdateStatus() {
  const u = useUpdater();
  if (u.phase === "none") return <p className="mt-2 text-[12.5px] text-ok">You have the latest version.</p>;
  if (u.phase === "error") return <p className="mt-2 text-[12.5px] text-danger">{u.error}</p>;
  if (u.phase === "available" && u.available)
    return (
      <div className="mt-2 rounded-[10px] border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] p-3">
        <p className="text-[13px] text-ink">Version {u.available.version} is available.</p>
        {u.available.notes ? <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap font-sans text-[12px] text-ink-2">{u.available.notes}</pre> : null}
      </div>
    );
  if (u.phase === "downloading")
    return (
      <div className="mt-2 grid gap-1" role="status">
        <p className="text-[12.5px] text-ink-2">
          Downloading {fmtBytes(u.downloaded)}
          {u.total ? ` of ${fmtBytes(u.total)}` : ""}…
        </p>
        {u.total ? (
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full bg-accent" style={{ width: `${Math.min(100, (u.downloaded / u.total) * 100)}%` }} />
          </div>
        ) : null}
      </div>
    );
  if (u.phase === "installing") return <p className="mt-2 text-[12.5px] text-ink-2">Signature verified. Saving your work and starting the installer… MOTH will close and reopen.</p>;
  return null;
}

/** A small notice when an update is found by the automatic check. Never interrupts with a dialog. */
export function UpdateNotice() {
  const u = useUpdater();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const st = await rpc<any>("settings.get");
        const s = st.settings;
        const last = s["updates.lastCheck"] ? Date.parse(s["updates.lastCheck"]) : 0;
        if (s["updates.autoCheck"] && Date.now() - last > 20 * 3_600_000) {
          const r = await checkForUpdate({ silent: true });
          if (r.available && r.available.version === s["updates.deferredVersion"]) setDismissed(true);
        }
      } catch {
        /* offline or engine busy: try again later */
      }
      timer = setTimeout(tick, 6 * 3_600_000);
    };
    timer = setTimeout(tick, 60_000);
    return () => clearTimeout(timer);
  }, []);
  if (dismissed || !["available", "downloading", "installing"].includes(u.phase) || !u.available) return null;
  return (
    <div className="pointer-events-auto fixed bottom-4 right-4 z-40 w-[340px] rounded-[14px] border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[#161616]/95 p-3.5 shadow-[0_16px_50px_rgba(0,0,0,0.5)] backdrop-blur" role="status" data-testid="update-notice">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-accent-soft" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink">MOTH Update Available</p>
          <p className="text-[12px] text-ink-3">
            {u.current} → {u.available.version}
          </p>
        </div>
        {u.phase === "available" ? (
          <button aria-label="Later" className="text-ink-3 hover:text-ink" onClick={() => (deferUpdate(), setDismissed(true))}>
            <X className="size-4" />
          </button>
        ) : null}
      </div>
      <UpdateStatus />
      {u.phase === "available" ? (
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => (deferUpdate(), setDismissed(true))}>
            Later
          </Button>
          <Button size="sm" variant="primary" onClick={() => void installUpdate()}>
            Update Now
          </Button>
        </div>
      ) : null}
    </div>
  );
}
