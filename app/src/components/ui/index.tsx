// shadcn/ui-style primitives (same API conventions: cva variants + cn), tuned to MOTH's tokens.
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] text-[13px] font-[520] transition-colors disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 cursor-default",
  {
    variants: {
      variant: {
        primary: "bg-accent text-[#17121f] hover:bg-accent-soft",
        secondary: "bg-surface-2 text-ink border border-line hover:border-line-strong hover:bg-[#272732]",
        ghost: "text-ink-2 hover:text-ink hover:bg-surface-2",
        danger: "bg-transparent text-danger border border-[color-mix(in_srgb,var(--color-danger)_40%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)]",
        link: "text-accent hover:text-accent-soft underline-offset-4 hover:underline px-0 h-auto",
      },
      size: { sm: "h-7 px-2.5 text-[12px]", md: "h-8 px-3", lg: "h-10 px-4 text-[14px]", icon: "size-8", iconSm: "size-7" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, disabled, ...p }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...p}>
    {loading ? <Spinner /> : null}
    {children}
  </button>
));
Button.displayName = "Button";

export function Spinner({ className }: { className?: string }) {
  return <span className={cn("inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent opacity-70", className)} aria-hidden />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-8 w-full rounded-[var(--radius-md)] border border-line bg-bg px-2.5 text-[13px] text-ink placeholder:text-ink-3 outline-none transition-colors focus:border-accent/70 focus-visible:outline-none",
      className,
    )}
    {...p}
  />
));
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea
    ref={ref}
    className={cn("w-full resize-y rounded-[var(--radius-md)] border border-line bg-bg px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-3 outline-none focus:border-accent/70 focus-visible:outline-none", className)}
    {...p}
  />
));
Textarea.displayName = "Textarea";

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn("h-8 rounded-[var(--radius-md)] border border-line bg-bg px-2 text-[13px] text-ink outline-none focus:border-accent/70", className)} {...p}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn("grid gap-1.5", className)}>
      <span className="text-[12.5px] font-[520] text-ink">{label}</span>
      {children}
      {hint ? <span className="text-[12px] leading-snug text-ink-3">{hint}</span> : null}
    </label>
  );
}

export function Badge({ children, tone = "neutral", className, title }: { children: ReactNode; tone?: "neutral" | "accent" | "ok" | "warn" | "danger"; className?: string; title?: string }) {
  const tones = {
    neutral: "bg-surface-2 text-ink-2 border-line",
    accent: "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-accent-soft border-[color-mix(in_srgb,var(--color-accent)_30%,transparent)]",
    ok: "bg-[color-mix(in_srgb,var(--color-ok)_12%,transparent)] text-ok border-[color-mix(in_srgb,var(--color-ok)_28%,transparent)]",
    warn: "bg-[color-mix(in_srgb,var(--color-warn)_12%,transparent)] text-warn border-[color-mix(in_srgb,var(--color-warn)_28%,transparent)]",
    danger: "bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-danger border-[color-mix(in_srgb,var(--color-danger)_28%,transparent)]",
  };
  return <span title={title} className={cn("inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11.5px] font-[500]", tones[tone], className)}>{children}</span>;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("relative h-[18px] w-8 shrink-0 rounded-full border transition-colors disabled:opacity-40", checked ? "border-accent bg-accent" : "border-line-strong bg-surface-2")}
    >
      <span className={cn("absolute top-[2px] size-3 rounded-full transition-all duration-200", checked ? "left-[15px] bg-[#17121f]" : "left-[2px] bg-ink-2")} />
    </button>
  );
}

export function Slider({ value, min, max, step, onChange, label, format }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; format?: (v: number) => string }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-[12.5px]">
        <span className="text-ink-2">{label}</span>
        <span className="tabular-nums text-ink-3">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="moth-range h-1 w-full cursor-default appearance-none rounded-full"
        style={{ background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-line-strong) ${pct}%)` }}
      />
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 font-sans text-[11px] text-ink-2">{children}</kbd>;
}

export function Dialog({ open, onClose, title, children, width = 520, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [open, onClose]);
  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div
            role="dialog"
            aria-modal
            className="panel flex max-h-[86vh] w-full flex-col overflow-hidden shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
            style={{ maxWidth: width }}
            initial={{ y: 10, scale: 0.98, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 6, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <h2 className="text-[15px]">{title}</h2>
              <Button variant="ghost" size="iconSm" onClick={onClose} aria-label="Close">
                <X />
              </Button>
            </div>
            <div className="selectable min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer ? <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; className?: string }) {
  return (
    <div role="tablist" className={cn("inline-flex gap-0.5 rounded-[var(--radius-md)] border border-line bg-bg p-0.5", className)}>
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn("h-7 rounded-[7px] px-3 text-[12.5px] transition-colors", value === it.value ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number } | null; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    setTimeout(() => ref.current?.querySelector<HTMLButtonElement>("button")?.focus(), 0);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [at, onClose]);
  if (!at) return null;
  const x = Math.min(at.x, window.innerWidth - 220);
  const y = Math.min(at.y, window.innerHeight - items.length * 32 - 16);
  return createPortal(
    <div ref={ref} role="menu" className="panel fixed z-50 w-[208px] p-1 shadow-[0_16px_48px_rgba(0,0,0,0.5)]" style={{ left: x, top: y }}>
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
          className={cn(
            "flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left text-[13px] outline-none hover:bg-surface-2 focus:bg-surface-2 disabled:opacity-40 [&_svg]:size-[15px]",
            it.danger ? "text-danger" : "text-ink",
          )}
        >
          <span className="text-ink-2">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-[420px] flex-col items-center gap-2 px-6 py-14 text-center">
      {icon ? <div className="mb-1 text-ink-3 [&_svg]:size-7">{icon}</div> : null}
      <h3 className="text-[15px] text-ink">{title}</h3>
      {children ? <p className="text-[13px] leading-relaxed text-ink-2">{children}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 className="text-[14px] text-ink">{children}</h2>
      {aside ? <div className="text-[12.5px] text-ink-3">{aside}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 px-8 pb-5 pt-7">
      <div className="min-w-0">
        <h1 className="text-[22px] leading-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-[72ch] text-[13px] text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
