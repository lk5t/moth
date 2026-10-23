// Startup splash (markup + CSS live in index.html so it appears before any script runs).
// It never delays MOTH: it fades as soon as the app is ready, with a short minimum so it doesn't flash,
// and switches to a calm "waking up" state if start-up takes longer than the animation.
const el = () => document.getElementById("moth-splash");

export function initSplash(): void {
  const s = el();
  if (!s) return;
  if (location.hash.replace("#", "").startsWith("capture")) return s.remove(); // Quick Capture opens instantly
  const slow = 1900 - performance.now();
  setTimeout(() => el()?.classList.add("slow"), Math.max(0, slow));
}

export function hideSplash(): void {
  const s = el();
  if (!s || s.classList.contains("out")) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "minimal";
  const minVisible = reduce ? 250 : 700; // performance.now() counts from the moment the window started loading
  const wait = Math.max(0, minVisible - performance.now());
  setTimeout(() => {
    s.classList.add("out");
    setTimeout(() => s.remove(), 450);
  }, wait);
}
