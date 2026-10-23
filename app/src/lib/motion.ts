// MOTH's motion level: Full / Balanced / Minimal, with "auto" following the operating system's
// reduced-motion preference. One small store so every component (and the graph) agrees.
import { useEffect, useState } from "react";

export type MotionSetting = "auto" | "full" | "balanced" | "minimal";
export type MotionLevel = "full" | "balanced" | "minimal";

let setting: MotionSetting = "auto";
let legacyReduce = false;
const listeners = new Set<(m: MotionLevel) => void>();
const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

export function motionLevel(): MotionLevel {
  if (legacyReduce) return "minimal";
  if (setting === "auto") return media?.matches ? "minimal" : "balanced";
  return setting;
}

function emit() {
  const m = motionLevel();
  document.documentElement.dataset.motion = m;
  document.documentElement.classList.toggle("reduce-motion", m === "minimal");
  listeners.forEach((l) => l(m));
}

export function setMotionSetting(v: MotionSetting | undefined, reduceMotion?: boolean): void {
  setting = v ?? "auto";
  if (reduceMotion !== undefined) legacyReduce = reduceMotion;
  emit();
}

media?.addEventListener?.("change", emit);

export function useMotion(): MotionLevel {
  const [m, setM] = useState<MotionLevel>(motionLevel());
  useEffect(() => {
    listeners.add(setM);
    setM(motionLevel());
    return () => void listeners.delete(setM);
  }, []);
  return m;
}
