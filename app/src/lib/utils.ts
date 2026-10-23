import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: s > 86400 * 300 ? "numeric" : undefined });
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export const CATEGORY_LABEL: Record<string, string> = {
  project: "Project", fact: "Fact", idea: "Idea", decision: "Decision", task: "Task", solution: "Solution",
  error: "Error", research: "Research", person: "Person", concept: "Concept", preference: "Preference",
};

// Muted hues for optional "colour by category" in the graph; grey stays the default.
export const CATEGORY_COLOR: Record<string, string> = {
  project: "#c4b5fd", fact: "#b8b8bd", idea: "#e8c37a", decision: "#a78bfa", task: "#8fb8de", solution: "#7dd3a8",
  error: "#f08a8a", research: "#9ad0d3", person: "#e3a7c9", concept: "#c9b48f", preference: "#b9c98f",
};

export const RELATION_LABEL: Record<string, string> = {
  RELATED_TO: "related to", BELONGS_TO: "belongs to", DEPENDS_ON: "depends on", SOLVES: "solves",
  CAUSED_BY: "caused by", REFERENCES: "references", SUPERSEDES: "supersedes", CONTINUES: "continues",
};

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | undefined;
  return ((...a: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as T;
}
