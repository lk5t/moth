// Obsidian import wizard: choose → scan (real numbers from the files) → preview and options → import (real progress:
// files and bytes done, current phase; pause, resume, cancel) → result. One-time copy: the vault is never changed.
import { AlertTriangle, CheckCircle2, FolderOpen, Pause, Play, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { pickFolder } from "../lib/tauri";
import { cn } from "../lib/utils";
import { Badge, Button, Dialog, Field, Input, Switch } from "./ui";

export const fmtBytes = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "unknown";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString();
const dur = (ms: number | null | undefined) => {
  if (!ms && ms !== 0) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};

export function ImportWizard({ open, onClose, resumeId, onOpenLibrary }: { open: boolean; onClose: () => void; resumeId?: string | null; onOpenLibrary: (batch: string) => void }) {
  const { toast, go } = useApp();
  const [id, setId] = useState<string | null>(resumeId ?? null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [opts, setOpts] = useState({ preserveFolders: true, copyAttachments: true, maxAttachmentMb: 0, excludeExtensions: [] as string[], duplicates: "skip" as "skip" | "separate", folderName: "" });
  useEffect(() => setId(resumeId ?? null), [resumeId, open]);
  const { data: b } = useLive<any>("import.get", { id }, { entities: ["import", "document"], enabled: open && !!id });

  const scan = async (root: string) => {
    if (!root.trim()) return;
    setBusy(true);
    try {
      const r = await rpc<any>("import.scan", { root: root.trim() });
      setId(r.id);
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    const p = await pickFolder();
    if (p) {
      setPath(p);
      void scan(p);
    }
  };
  const act = async (method: string, extra: Record<string, unknown> = {}) => {
    try {
      await rpc(method, { id, ...extra });
    } catch (e) {
      toast({ kind: "error", text: (e as Error).message });
    }
  };

  const status: string = b?.status ?? (id ? "loading" : "choose");
  const s = b?.scan ?? {};
  const pr = b?.progress ?? {};
  const r = b?.result ?? {};
  let body: ReactNode = null;
  let footer: ReactNode = null;

  if (status === "choose") {
    body = (
      <div className="grid gap-3">
        <p className="text-[13px] leading-relaxed text-ink-2">
          MOTH makes its own copy of your Obsidian vault: notes, folders, tags, links and attachments. <b className="font-normal text-ink">Your vault is only read, never changed</b>, and nothing is written into it. This is a one-time copy (no syncing): later changes in Obsidian don't come over, and edits in MOTH don't go back.
        </p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void choose()} loading={busy}>
            <FolderOpen /> Choose vault folder
          </Button>
        </div>
        <Field label="Or type the folder path">
          <div className="flex gap-2">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\you\Documents\My Vault" onKeyDown={(e) => e.key === "Enter" && void scan(path)} />
            <Button onClick={() => void scan(path)} disabled={!path.trim()} loading={busy}>
              Scan
            </Button>
          </div>
        </Field>
      </div>
    );
  } else if (status === "scanning" || status === "loading") {
    body = (
      <Working title="Scanning the vault…" lines={[`${fmtNum(pr.files_seen)} files found so far`, `${fmtBytes(pr.bytes_seen)} looked at`]} note="Only reading. Notes are read one at a time; attachments are only measured here." />
    );
    footer = <Button variant="ghost" onClick={() => void act("import.cancel")}>Cancel</Button>;
  } else if (status === "scanned") {
    const excluded = (s.largest_attachments ?? []).filter((a: any) => opts.maxAttachmentMb && a.size > opts.maxAttachmentMb * 1024 * 1024);
    body = (
      <div className="grid gap-4" data-testid="import-preview">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Num label="Notes" value={fmtNum(s.notes)} />
          <Num label="Folders" value={fmtNum(s.folders)} />
          <Num label="Attachments" value={`${fmtNum(s.attachments)} · ${fmtBytes(s.attachment_bytes)}`} />
          <Num label="Links" value={fmtNum(s.links)} />
        </div>
        <ul className="grid gap-1.5 text-[12.5px] text-ink-2">
          <Line ok={!s.unresolved_links}>{s.unresolved_links ? `${fmtNum(s.unresolved_links)} links point to notes or files that aren't in the vault (they're kept as text and shown as unresolved).` : "Every link points to something in the vault."}</Line>
          {s.same_name_notes?.length ? <Line>{`${s.same_name_notes.length} note name${s.same_name_notes.length === 1 ? " is" : "s are"} used more than once (e.g. "${s.same_name_notes[0].name}"). Links to those names are marked as ambiguous instead of guessed.`}</Line> : null}
          {s.unsupported_files ? <Line>{`${fmtNum(s.unsupported_files)} file${s.unsupported_files === 1 ? "" : "s"} of unsupported types won't be imported: ${s.unsupported.map((u: any) => `${u.ext} (${u.files})`).join(", ")}.`}</Line> : null}
          {s.duplicates_existing ? <Line>{`${fmtNum(s.duplicates_existing)} notes were already imported earlier (same file, same text).`}</Line> : null}
          {s.attachments_existing ? <Line ok>{`${fmtNum(s.attachments_existing)} files were already copied by an earlier import of this vault; they're reused, not copied again. New files are added to the same folder.`}</Line> : null}
          {s.same_text_elsewhere ? <Line ok>{`${fmtNum(s.same_text_elsewhere)} notes have the same text as notes you already have elsewhere; they're imported as separate notes (never merged by title or text).`}</Line> : null}
          {s.failed?.length ? <Line>{`${s.failed.length} file${s.failed.length === 1 ? "" : "s"} can't be read: ${s.failed.slice(0, 3).map((f: any) => f.rel_path).join(", ")}${s.failed.length > 3 ? "…" : ""}`}</Line> : null}
          {s.skipped_folders?.length ? <Line ok>{`Left out: ${s.skipped_folders.slice(0, 4).join(", ")} (Obsidian settings, plugins, trash).`}</Line> : null}
          <Line ok={s.disk?.enough !== false}>{`Needs about ${fmtBytes(s.disk?.needed_bytes)} in MOTH's data folder; ${fmtBytes(s.disk?.free_bytes)} free.${s.disk?.enough === false ? " Not enough: leave out large attachments or free up space." : ""}`}</Line>
        </ul>
        {s.unresolved_examples?.length ? (
          <details className="text-[12px] text-ink-3">
            <summary className="cursor-default hover:text-ink">Examples of unresolved links</summary>
            <p className="mt-1">{s.unresolved_examples.slice(0, 12).map((u: any) => `${u.target} (${u.count})`).join(" · ")}</p>
          </details>
        ) : null}
        <div className="grid gap-2.5 rounded-[10px] border border-line p-3">
          <Opt label="Keep the folder structure" checked={opts.preserveFolders} onChange={(v) => setOpts({ ...opts, preserveFolders: v })} />
          <Opt label="Copy attachments (images, PDFs…)" checked={opts.copyAttachments} onChange={(v) => setOpts({ ...opts, copyAttachments: v })} />
          {opts.copyAttachments ? (
            <div className="flex flex-wrap items-center gap-2 pl-1 text-[12.5px] text-ink-2">
              Leave out files bigger than
              <Input type="number" min={0} className="h-7 w-24" value={opts.maxAttachmentMb || ""} placeholder="no limit" onChange={(e) => setOpts({ ...opts, maxAttachmentMb: Math.max(0, Number(e.target.value) || 0) })} aria-label="Size limit in MB" /> MB
              {excluded.length ? <Badge tone="warn">{excluded.length}+ left out</Badge> : null}
              {(s.file_types ?? []).filter((t: any) => t.kind === "attachment").slice(0, 8).map((t: any) => (
                <button
                  key={t.ext}
                  onClick={() => setOpts({ ...opts, excludeExtensions: opts.excludeExtensions.includes(t.ext) ? opts.excludeExtensions.filter((x) => x !== t.ext) : [...opts.excludeExtensions, t.ext] })}
                  className={cn("rounded-full border px-2 text-[11.5px]", opts.excludeExtensions.includes(t.ext) ? "border-line text-ink-3 line-through" : "border-accent/50 text-ink")}
                  title={opts.excludeExtensions.includes(t.ext) ? "Click to include" : "Click to leave out"}
                >
                  {t.ext} · {fmtNum(t.n)} · {fmtBytes(t.bytes)}
                </button>
              ))}
            </div>
          ) : null}
          {s.duplicates_existing ? <Opt label="Skip notes that were already imported" checked={opts.duplicates === "skip"} onChange={(v) => setOpts({ ...opts, duplicates: v ? "skip" : "separate" })} /> : null}
          <Field label="Library folder name">
            <Input value={opts.folderName} placeholder={s.vault_name} onChange={(e) => setOpts({ ...opts, folderName: e.target.value })} />
          </Field>
          <p className="text-[11.5px] text-ink-3">Cortex analysis is optional and can be started after the import. Importing never needs Claude, the internet or the local AI.</p>
        </div>
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => void act("import.cancel")}>Cancel</Button>
        <Button
          variant="primary"
          onClick={() =>
            void act("import.start", {
              options: { preserveFolders: opts.preserveFolders, copyAttachments: opts.copyAttachments, maxAttachmentBytes: opts.maxAttachmentMb * 1024 * 1024, excludeExtensions: opts.excludeExtensions, duplicates: opts.duplicates, folderName: opts.folderName || undefined },
            })
          }
        >
          Import {fmtNum(s.notes)} notes
        </Button>
      </>
    );
  } else if (status === "importing" || status === "paused") {
    const filesTotal = (pr.notes_total ?? 0) + (pr.attachments_total ?? 0);
    const filesDone = (pr.notes_done ?? 0) + (pr.attachments_done ?? 0);
    body = (
      <div data-testid="import-progress">
        <Working
          title={status === "paused" ? "Paused" : pr.phase === "links" ? "Connecting links…" : pr.phase === "attachments" ? "Copying attachments…" : "Importing notes…"}
          spinning={status === "importing"}
          lines={[
            `${fmtNum(filesDone)} of ${fmtNum(filesTotal)} files (${fmtNum(pr.notes_done)} of ${fmtNum(pr.notes_total)} notes, ${fmtNum(pr.attachments_done)} of ${fmtNum(pr.attachments_total)} attachments)`,
            `${fmtBytes(pr.bytes_done)} of ${fmtBytes(pr.bytes_total)}`,
            pr.current ? `Current: ${pr.current}` : "",
            pr.warnings ? `${fmtNum(pr.warnings)} file${pr.warnings === 1 ? "" : "s"} couldn't be imported (listed at the end)` : "",
          ]}
          bar={pr.bytes_total ? Math.min(1, (pr.bytes_done ?? 0) / pr.bytes_total) : null}
          note="You can keep using MOTH. Quitting is safe: the import continues where it stopped next time."
        />
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => void act("import.cancel")}>
          <X /> Cancel
        </Button>
        {status === "importing" ? (
          <Button onClick={() => void act("import.pause")}>
            <Pause /> Pause
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void act("import.start")}>
            <Play /> Resume
          </Button>
        )}
        <Button onClick={onClose}>Hide</Button>
      </>
    );
  } else if (status === "done" || status === "cancelled" || status === "failed" || status === "undone") {
    body = (
      <div className="grid gap-3" data-testid="import-result">
        <p className="flex items-center gap-2 text-[14px] text-ink">
          {status === "done" ? <CheckCircle2 className="size-4 text-ok" /> : <AlertTriangle className="size-4 text-warn" />}
          {status === "done" ? `Imported in ${dur(r.duration_ms)}` : status === "cancelled" ? "Import cancelled. What was imported so far is kept (you can undo it from Import history)." : status === "undone" ? "This import was undone." : `The import stopped: ${b?.error}`}
        </p>
        {status !== "undone" ? (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Num label="Notes" value={fmtNum(r.notes ?? pr.notes_done)} />
            <Num label="Folders" value={fmtNum(r.folders)} />
            <Num label="Attachments" value={fmtNum(r.attachments ?? pr.attachments_done)} />
            <Num label="Links connected" value={fmtNum(r.links_resolved)} />
            <Num label="Unresolved links" value={fmtNum((r.links_unresolved ?? 0) + (r.links_ambiguous ?? 0))} />
            <Num label="Skipped" value={fmtNum(r.skipped)} />
            <Num label="Already imported" value={fmtNum(r.duplicates)} />
            <Num label="Errors" value={fmtNum(r.errors)} />
          </div>
        ) : null}
        {r.errors ? <FailedList id={id!} /> : null}
        {status === "done" ? <Analyze id={id!} /> : null}
      </div>
    );
    footer = (
      <>
        <Button onClick={() => (onClose(), go("mind"))}>View in The Mind</Button>
        <Button variant="primary" onClick={() => (onOpenLibrary(id!), onClose())}>
          Open in Library
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Import an Obsidian vault" width={720} footer={footer}>
      {body}
    </Dialog>
  );
}

function FailedList({ id }: { id: string }) {
  const { data } = useLive<any>("import.items", { id, status: "failed", limit: 50 }, { entities: ["import"] });
  return (
    <details className="text-[12px] text-ink-2">
      <summary className="cursor-default text-ink-3 hover:text-ink">Files that couldn't be imported ({data?.total ?? "…"})</summary>
      <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
        {(data?.items ?? []).map((i: any) => (
          <li key={i.rel_path}>
            {i.rel_path}: <span className="text-ink-3">{i.detail}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Working({ title, lines, note, bar, spinning = true }: { title: string; lines: string[]; note?: string; bar?: number | null; spinning?: boolean }) {
  return (
    <div className="grid gap-2">
      <p className="flex items-center gap-2 text-[14px] text-ink">
        {spinning ? <span className="relative inline-flex size-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-40" /><span className="relative inline-flex size-2 rounded-full bg-accent" /></span> : null}
        {title}
      </p>
      {bar !== null && bar !== undefined ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(bar * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Bytes copied">
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${bar * 100}%` }} />
        </div>
      ) : null}
      {lines.filter(Boolean).map((l) => (
        <p key={l} className="text-[12.5px] text-ink-2">
          {l}
        </p>
      ))}
      {note ? <p className="text-[11.5px] text-ink-3">{note}</p> : null}
    </div>
  );
}

function Num({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-line px-3 py-2">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className="text-[15px] tabular-nums text-ink">{value}</div>
    </div>
  );
}

function Line({ children, ok }: { children: ReactNode; ok?: boolean }) {
  return (
    <li className="flex gap-2">
      {ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />}
      <span>{children}</span>
    </li>
  );
}

function Opt({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-[12.5px] text-ink-2">
      {label}
      <Switch checked={checked} onChange={onChange} label={label} />
    </label>
  );
}

/** Optional: let Cortex read some imported notes and propose memories (needs the local AI; never required). */
function Analyze({ id }: { id: string }) {
  const { toast, go } = useApp();
  const [n, setN] = useState(25);
  const [done, setDone] = useState<any>(null);
  return (
    <div className="rounded-[10px] border border-line p-3 text-[12.5px] text-ink-2">
      <p className="text-ink">Optional: extract memories with Cortex</p>
      <p className="mt-0.5 text-ink-3">The local AI reads your longest imported notes and proposes memories (they keep the note as their source; your review settings apply). Your notes are not changed.</p>
      {done ? (
        <p className="mt-2">
          Queued {done.queued} note{done.queued === 1 ? "" : "s"} for Cortex.{" "}
          <button className="text-accent" onClick={() => go("cortex")}>
            Follow it on the Cortex page
          </button>
        </p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <Input type="number" min={1} max={200} value={n} onChange={(e) => setN(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} className="h-7 w-20" aria-label="How many notes" />
          notes
          <Button size="sm" onClick={() => void rpc<any>("import.analyze", { id, limit: n }).then(setDone).catch((e) => toast({ kind: "error", text: e.message }))}>
            Start
          </Button>
        </div>
      )}
    </div>
  );
}
