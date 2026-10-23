// MOTH mark: a symmetrical geometric moth. Forewings carry a single "eye"; works in monochrome at 16px.
export function MothMark({ size = 22, glow = false, className }: { size?: number; glow?: boolean; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden style={glow ? { filter: "drop-shadow(0 0 10px rgba(167,139,250,0.45))" } : undefined}>
      <g fill="currentColor" fillRule="evenodd">
        <path d="M30.6 25.5 9 13.5l4.6 19.8 17-1.6Zm-11.1 1.9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM33.4 25.5 55 13.5l-4.6 19.8-17-1.6Zm11.1 1.9a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z" />
        <path d="M30.4 34.2 14.8 36.6l9 13.4 6.6-8.8ZM33.6 34.2l15.6 2.4-9 13.4-6.6-8.8Z" opacity=".72" />
        <path d="M32 18.5 34.4 31 32 51.5 29.6 31Z" />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M31 18.3c-1.6-4.8-4.6-8-8.6-9.2M33 18.3c1.6-4.8 4.6-8 8.6-9.2" />
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2 text-accent-soft">
      <MothMark size={20} />
      <span className="text-[13px] font-[600] tracking-[0.18em] text-ink">MOTH</span>
    </span>
  );
}
