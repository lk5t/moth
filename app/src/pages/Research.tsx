// Research Library: insights Claude researched, with their real sources, plus lessons learned from corrections.
import { BookOpenCheck, ExternalLink, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Empty, Input, PageHeader, Tabs } from "../components/ui";
import { useApp } from "../lib/app";
import { useLive } from "../lib/hooks";
import { openExternal } from "../lib/tauri";
import { cn, timeAgo } from "../lib/utils";

export function ResearchPage() {
  const { params, select } = useApp();
  const [tab, setTab] = useState<"research" | "lessons">(params.tab === "lessons" ? "lessons" : "research");
  const [q, setQ] = useState("");
  const [domain, setDomain] = useState("");
  const { data: research } = useLive<any[]>("research.list", {}, { entities: ["memory"] });
  const { data: lessons } = useLive<any[]>("lessons.list", {}, { entities: ["memory"] });
  const domains = useMemo(() => [...new Set((research ?? []).map((r) => r.domain).filter(Boolean))].sort(), [research]);
  const ql = q.toLowerCase();
  const topics = (research ?? []).filter((r) => r.is_topic);
  const insights = (research ?? []).filter((r) => !r.is_topic && (!domain || r.domain === domain) && (!ql || `${r.title} ${r.content} ${r.domain}`.toLowerCase().includes(ql)));
  const shownLessons = (lessons ?? []).filter((l) => !ql || `${l.title} ${l.content}`.toLowerCase().includes(ql));

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title="Research Library"
        description="Reusable insights from research Claude did for you, each with the sources it came from. Speculation and unsourced claims are labelled as such, and nothing here is presented as a guaranteed result."
      />
      <div className="mx-auto max-w-[1100px] px-8 pb-10">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: "research", label: `Research${research ? ` ${research.filter((r) => !r.is_topic).length}` : ""}` },
              { value: "lessons", label: `Lessons${lessons ? ` ${lessons.length}` : ""}` },
            ]}
          />
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="w-[240px] pl-8" aria-label="Filter research" />
          </div>
        </div>

        {tab === "research" ? (
          <>
            {domains.length ? (
              <div className="mb-4 flex flex-wrap gap-1">
                <Chip on={!domain} onClick={() => setDomain("")}>All domains</Chip>
                {domains.map((d) => (
                  <Chip key={d} on={domain === d} onClick={() => setDomain(domain === d ? "" : d)}>
                    {d}
                  </Chip>
                ))}
              </div>
            ) : null}
            {topics.length ? (
              <div className="mb-5 flex flex-wrap gap-2">
                {topics.map((t) => (
                  <button key={t.id} onClick={() => select(t.id)} className="rounded-[10px] border border-line px-3 py-2 text-left hover:border-line-strong">
                    <span className="block text-[12.5px] text-ink">{t.title.replace(/^Research: /, "")}</span>
                    <span className="text-[11.5px] text-ink-3">topic · {timeAgo(t.updated_at)}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {!research ? (
              <div className="skeleton h-32" />
            ) : !insights.length ? (
              <Empty icon={<BookOpenCheck />} title={research.length ? "Nothing matches" : "No research yet"}>
                {research.length ? null : "When Claude researches something for you, it can send the useful insights and their sources to MOTH (moth_submit_research). They appear here and can help future projects."}
              </Empty>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {insights.map((r) => (
                  <li key={r.id} className="panel flex flex-col p-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.evidence === "sourced" ? <Badge tone="ok">Sourced</Badge> : r.evidence === "speculative" ? <Badge tone="warn">Speculation</Badge> : <Badge tone="warn">No source</Badge>}
                      <Badge>{r.scope === "global" ? "Reusable" : "One project"}</Badge>
                      {r.domain ? <span className="truncate text-[11.5px] text-ink-3">{r.domain}</span> : null}
                    </div>
                    <button className="mt-2 text-left text-[14px] text-ink hover:text-accent-soft" onClick={() => select(r.id)}>
                      {r.title}
                    </button>
                    <p className="mt-1 line-clamp-4 text-[12.5px] leading-relaxed text-ink-2">{r.content.split("\n\n")[0]}</p>
                    <div className="mt-auto pt-3">
                      {r.sources.filter((s: any) => s.url).slice(0, 3).map((s: any) => (
                        <button key={s.id} className="flex max-w-full items-center gap-1 truncate text-[12px] text-accent hover:text-accent-soft" onClick={() => void openExternal(s.url)} title={s.url}>
                          <ExternalLink className="size-3 shrink-0" />
                          <span className="truncate">{s.title || s.url}</span>
                          {s.publisher ? <span className="shrink-0 text-ink-3">· {s.publisher}</span> : null}
                        </button>
                      ))}
                      <p className="mt-1 text-[11.5px] text-ink-3">confidence {Math.round(r.confidence * 100)}% · {timeAgo(r.updated_at)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : !lessons ? (
          <div className="skeleton h-32" />
        ) : !shownLessons.length ? (
          <Empty title="No lessons yet">After a mistake is found and the fix is verified, Claude can record the lesson (moth_record_lesson) so the same problem is avoided next time.</Empty>
        ) : (
          <ul className="space-y-3">
            {shownLessons.map((l) => (
              <li key={l.id} className="panel p-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={l.verified ? "ok" : "warn"}>{l.verified ? "Verified" : "Unverified"}</Badge>
                  <Badge>{l.scope === "global" ? "Reusable" : "One project"}</Badge>
                  <span className="ml-auto text-[11.5px] text-ink-3">{timeAgo(l.updated_at)}</span>
                </div>
                <button className="mt-2 text-left text-[14px] text-ink hover:text-accent-soft" onClick={() => select(l.id)}>
                  {l.title}
                </button>
                {l.problem ? (
                  <dl className="mt-2 grid grid-cols-[110px_1fr] gap-y-1 text-[12.5px]">
                    <dt className="text-ink-3">Problem</dt>
                    <dd className="text-ink-2">{l.problem}</dd>
                    <dt className="text-ink-3">Correction</dt>
                    <dd className="text-ink-2">{l.correction}</dd>
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={on} className={cn("flex h-7 items-center rounded-full border px-2.5 text-[12px]", on ? "border-accent/60 bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-ink" : "border-line text-ink-2 hover:text-ink")}>
      {children}
    </button>
  );
}
