import { CornerDownLeft, FilePlus2, Search, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { rpc } from "../lib/api";
import { useApp } from "../lib/app";
import { CATEGORY_LABEL, cn } from "../lib/utils";
import { NAV } from "./Shell";

interface Item {
  id: string;
  label: ReactNode;
  hint?: string;
  icon?: ReactNode;
  run: () => void;
  group: string;
}

export function CommandPalette() {
  const { paletteOpen: open, setPaletteOpen, go, select, edit, toast } = useApp();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [answer, setAnswer] = useState<any | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setResults([]);
      setAnswer(null);
      setActive(0);
      setTimeout(() => input.current?.focus(), 20);
    }
  }, [open]);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      rpc<any[]>("search", { query: q, limit: 8 }).then(setResults).catch(() => setResults([]));
    }, 140);
    return () => clearTimeout(t);
  }, [q]);

  const close = () => setPaletteOpen(false);
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const r of results)
      out.push({
        id: r.memory.id,
        group: "Memories",
        label: r.memory.title,
        hint: CATEGORY_LABEL[r.memory.category],
        run: () => {
          select(r.memory.id);
          close();
        },
      });
    const ql = q.toLowerCase();
    if (q.trim().length > 6 && /\?|^(what|how|why|when|which|who|did)\b/i.test(q.trim()))
      out.unshift({
        id: "ask",
        group: "Ask",
        icon: <Sparkles />,
        label: `Answer from my memories: "${q.trim()}"`,
        run: () => {
          setAnswer({ loading: true });
          rpc("search.ask", { query: q }).then(setAnswer).catch((e) => setAnswer({ answer: e.message, refs: [] }));
        },
      });
    for (const n of NAV)
      if (!ql || n.label.toLowerCase().includes(ql))
        out.push({ id: `nav-${n.page}`, group: "Go to", icon: n.icon, label: n.label, hint: `Ctrl ${n.key}`, run: () => (go(n.page), close()) });
    const actions: Item[] = [
      { id: "new", group: "Actions", icon: <FilePlus2 />, label: "New memory", hint: "Ctrl N", run: () => (edit("new"), close()) },
      {
        id: "reflect",
        group: "Actions",
        icon: <Sparkles />,
        label: "Run a Metamorphosis reflection now",
        run: () => {
          close();
          rpc("meta.reflect").then(() => toast({ kind: "light", text: "Reflection finished. See Metamorphosis for what changed." })).catch((e) => toast({ kind: "error", text: e.message }));
        },
      },
    ];
    for (const a of actions) if (!ql || String(a.label).toLowerCase().includes(ql)) out.push(a);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, q]);

  useEffect(() => setActive(0), [items.length]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(items.length - 1, a + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === "Enter") (e.preventDefault(), items[active]?.run());
    else if (e.key === "Escape") close();
  };

  let lastGroup = "";
  return (
    <AnimatePresence>
      {open ? (
        <motion.div className="fixed inset-0 z-50 bg-black/45" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <motion.div
            role="dialog"
            aria-label="Command search"
            initial={{ y: -8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -6, opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="panel mx-auto mt-[12vh] w-[620px] max-w-[92vw] overflow-hidden shadow-[0_30px_90px_rgba(0,0,0,0.6)]"
          >
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search className="size-4 text-ink-3" />
              <input
                ref={input}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKey}
                placeholder="Search memories, ask a question, or jump to a page"
                className="h-12 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
                aria-label="Search"
              />
            </div>
            {answer ? (
              <div className="selectable border-b border-line bg-bg/60 px-4 py-3 text-[13px] leading-relaxed">
                {answer.loading ? (
                  <span className="text-ink-3">Looking through your memories…</span>
                ) : (
                  <>
                    <p className="text-ink">{answer.answer}</p>
                    {answer.refs?.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {answer.refs.map((r: any, i: number) => (
                          <button key={r.id} onClick={() => (select(r.id), close())} className="rounded-full border border-line px-2 py-0.5 text-[11.5px] text-ink-2 hover:border-accent hover:text-ink">
                            [{i + 1}] {r.title}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
            <div className="max-h-[52vh] overflow-y-auto p-1.5" role="listbox">
              {items.length === 0 ? <div className="px-3 py-6 text-center text-[13px] text-ink-3">No matches. Try different words.</div> : null}
              {items.map((it, i) => {
                const header = it.group !== lastGroup ? it.group : null;
                lastGroup = it.group;
                return (
                  <div key={it.id}>
                    {header ? <div className="px-2.5 pb-1 pt-2.5 text-[11.5px] text-ink-3">{header}</div> : null}
                    <button
                      role="option"
                      aria-selected={i === active}
                      onMouseEnter={() => setActive(i)}
                      onClick={it.run}
                      className={cn("flex h-9 w-full items-center gap-3 rounded-[8px] px-2.5 text-left text-[13px] [&_svg]:size-4", i === active ? "bg-surface-2 text-ink" : "text-ink-2")}
                    >
                      <span className="text-ink-3">{it.icon ?? <span className="block size-1.5 rounded-full bg-node" />}</span>
                      <span className="flex-1 truncate">{it.label}</span>
                      {it.hint ? <span className="text-[11.5px] text-ink-3">{it.hint}</span> : null}
                      {i === active ? <CornerDownLeft className="!size-3.5 text-ink-3" /> : null}
                    </button>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
