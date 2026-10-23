import { useCallback, useEffect, useRef, useState } from "react";
import { onChanges, rpc, type ChangeEvent } from "./api";

/** Calls an RPC method and re-fetches when matching live changes arrive (from Claude or the engine). */
export function useLive<T>(method: string, params: unknown = {}, opts: { entities?: ChangeEvent["entity"][]; enabled?: boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(params);
  const seq = useRef(0);
  const enabled = opts.enabled ?? true;
  const entities = (opts.entities ?? ["memory", "relationship", "project", "learning"]).join(",");

  const load = useCallback(async () => {
    if (!enabled) return;
    const n = ++seq.current;
    try {
      const r = await rpc<T>(method, JSON.parse(key));
      if (n === seq.current) {
        setData(r);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [method, key, enabled]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    if (!entities) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const wanted = new Set(entities.split(","));
    return onChanges((changes) => {
      if (!changes.some((c) => wanted.has(c.entity))) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => void load(), 250);
    });
  }, [load, entities]);

  return { data, error, loading, reload: load, setData };
}

export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, deps: unknown[] = []) {
  useEffect(() => {
    const [mod, key] = combo.toLowerCase().split("+");
    const fn = (e: KeyboardEvent) => {
      const modOk = mod === "mod" ? e.ctrlKey || e.metaKey : mod === "shift" ? e.shiftKey : true;
      if (modOk && e.key.toLowerCase() === (key ?? mod)) {
        e.preventDefault();
        handler(e);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}
