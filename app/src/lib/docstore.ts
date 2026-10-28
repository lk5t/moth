// One shared, in-memory state per open note, used by every pane that shows it (so two panes never fight).
//
// Autosave: edits are saved ~0.9 s after typing stops, each save carrying the version it was based on. The engine
// refuses a save based on an older version ("conflict"); the text is then kept as a draft and the editor offers
// "keep mine" / "use the saved version". Until a save succeeds, the text is also kept in this browser's storage as a
// recoverable draft (best effort). Pending edits are flushed when switching tabs, closing a tab or the window.
import { useSyncExternalStore } from "react";
import { ApiError, rpc } from "./api";

export type SaveState = "loading" | "saved" | "dirty" | "saving" | "error" | "conflict" | "missing";

export interface DocState {
  id: string;
  title: string;
  text: string;
  /** Last text known to be saved on the engine, and its version. */
  savedText: string;
  version: number;
  state: SaveState;
  error: string | null;
  doc: any | null;
  /** Text that was in browser storage from an earlier session and differs from the saved note. */
  recoveredDraft: string | null;
}

const docs = new Map<string, DocState>();
/** Last known title of every note seen this session (tabs show it even when the note isn't loaded). */
const titles = new Map<string, string>();
export const knownTitle = (id: string) => titles.get(id);
const listeners = new Map<string, Set<() => void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Map<string, Promise<void>>();
const refs = new Map<string, number>();
const SAVE_DELAY = 900;

const draftKey = (id: string) => `moth.draft.${id}`;
function readDraft(id: string): { text: string; base: number } | null {
  try {
    const v = localStorage.getItem(draftKey(id));
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
function writeDraft(id: string, text: string, base: number) {
  try {
    localStorage.setItem(draftKey(id), JSON.stringify({ text, base, at: Date.now() }));
  } catch {
    /* storage unavailable: autosave still works */
  }
}
function clearDraft(id: string) {
  try {
    localStorage.removeItem(draftKey(id));
  } catch {
    /* ignore */
  }
}

function emit(id: string) {
  for (const l of listeners.get(id) ?? []) l();
}
function set(id: string, patch: Partial<DocState>) {
  const cur = docs.get(id);
  if (!cur) return;
  docs.set(id, { ...cur, ...patch });
  if (patch.title) titles.set(id, patch.title);
  emit(id);
}

export async function loadDoc(id: string, force = false): Promise<void> {
  const cur = docs.get(id);
  if (cur && !force && cur.state !== "missing" && cur.doc) return;
  if (!cur) docs.set(id, { id, title: "", text: "", savedText: "", version: 0, state: "loading", error: null, doc: null, recoveredDraft: null });
  emit(id);
  try {
    const d = await rpc<any>("docs.get", { id });
    const draft = readDraft(id);
    const local = docs.get(id)!;
    // Keep unsaved local edits made while (re)loading.
    const keepLocal = local.state === "dirty" || local.state === "conflict";
    titles.set(id, d.title);
    docs.set(id, {
      ...local,
      title: d.title,
      doc: d,
      savedText: d.content,
      version: d.version,
      text: keepLocal ? local.text : d.content,
      state: keepLocal ? local.state : "saved",
      error: null,
      recoveredDraft: !keepLocal && draft && draft.text !== d.content ? draft.text : null,
    });
    emit(id);
  } catch (e) {
    set(id, { state: (e as ApiError).code === "not_found" ? "missing" : "error", error: (e as Error).message });
  }
}

export function editDoc(id: string, text: string) {
  const cur = docs.get(id);
  if (!cur || cur.state === "loading" || cur.state === "missing") return;
  const dirty = text !== cur.savedText;
  set(id, { text, state: cur.state === "conflict" ? "conflict" : dirty ? "dirty" : "saved" });
  if (dirty) writeDraft(id, text, cur.version);
  else clearDraft(id);
  const t = timers.get(id);
  if (t) clearTimeout(t);
  if (dirty && cur.state !== "conflict") timers.set(id, setTimeout(() => void saveDoc(id), SAVE_DELAY));
}

/** Saves now (if there's anything to save). Safe to call repeatedly; saves for one note never overlap. */
export async function saveDoc(id: string, opts: { overwrite?: boolean } = {}): Promise<void> {
  const t = timers.get(id);
  if (t) (clearTimeout(t), timers.delete(id));
  const running = inflight.get(id);
  if (running) await running;
  const cur = docs.get(id);
  if (!cur || cur.text === cur.savedText || (cur.state === "conflict" && !opts.overwrite)) return;
  const text = cur.text;
  const p = (async () => {
    set(id, { state: "saving" });
    try {
      let base = cur.version;
      if (opts.overwrite) base = (await rpc<any>("docs.get", { id })).version;
      const d = await rpc<any>("docs.save", { id, content: text, base_version: base });
      const now = docs.get(id)!;
      docs.set(id, { ...now, doc: d, savedText: text, version: d.version, title: d.title, state: now.text === text ? "saved" : "dirty", error: null, recoveredDraft: null });
      titles.set(id, d.title);
      if (now.text === text) clearDraft(id);
      emit(id);
      if (now.text !== text) timers.set(id, setTimeout(() => void saveDoc(id), SAVE_DELAY));
    } catch (e) {
      const code = (e as ApiError).code;
      set(id, { state: code === "conflict" ? "conflict" : "error", error: (e as Error).message });
    }
  })();
  inflight.set(id, p);
  try {
    await p;
  } finally {
    inflight.delete(id);
  }
}

/** Conflict: drop the local text and take the saved version. */
export async function discardLocal(id: string) {
  clearDraft(id);
  const cur = docs.get(id);
  if (cur) docs.set(id, { ...cur, state: "loading" });
  docs.delete(id);
  await loadDoc(id, true);
}

export function restoreDraft(id: string) {
  const cur = docs.get(id);
  if (!cur?.recoveredDraft) return;
  const text = cur.recoveredDraft;
  set(id, { recoveredDraft: null });
  editDoc(id, text);
}
export function dismissDraft(id: string) {
  clearDraft(id);
  set(id, { recoveredDraft: null });
}

/** After a rename/move/restore done elsewhere: refresh metadata (and text, unless there are local edits). */
export async function refreshDoc(id: string) {
  if (docs.has(id)) await loadDoc(id, true);
}

export async function flushAll(): Promise<void> {
  await Promise.all([...docs.keys()].map((id) => saveDoc(id)));
}

export function hasUnsaved(id?: string): boolean {
  if (id) return ["dirty", "saving", "conflict", "error"].includes(docs.get(id)?.state ?? "");
  return [...docs.values()].some((d) => ["dirty", "saving", "conflict", "error"].includes(d.state));
}

export function retain(id: string) {
  refs.set(id, (refs.get(id) ?? 0) + 1);
  void loadDoc(id);
}
export function release(id: string) {
  const n = (refs.get(id) ?? 1) - 1;
  if (n > 0) return void refs.set(id, n);
  refs.delete(id);
  void saveDoc(id).then(() => {
    if (!refs.has(id) && !hasUnsaved(id)) docs.delete(id);
  });
}

export function useDoc(id: string): DocState | undefined {
  return useSyncExternalStore(
    (cb) => {
      const set = listeners.get(id) ?? listeners.set(id, new Set()).get(id)!;
      set.add(cb);
      return () => set.delete(cb);
    },
    () => docs.get(id),
  );
}

// Save on the way out (best effort; the engine keeps running after the window closes, so a started save finishes).
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => void flushAll());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushAll();
  });
}
