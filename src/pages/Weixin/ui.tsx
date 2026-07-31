import type { ReactNode } from "react";

export type DeployStatus = "idle" | "running" | "success" | "error";

// ==================== Glass Card Primitives ====================

export const glass =
  "backdrop-blur-xl bg-white/60 dark:bg-white/[0.06] border border-white/40 dark:border-white/[0.08] shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.3)]";
export const glassInner =
  "bg-white/50 dark:bg-white/[0.04] border border-white/50 dark:border-white/[0.06] rounded-xl";

export const miniInputClass =
  "flex-1 h-6 px-1.5 text-[11px] rounded-md border border-white/30 dark:border-white/[0.08] bg-white/40 dark:bg-white/[0.03] outline-none placeholder:text-muted-foreground/50 focus:border-primary/40 focus:ring-1 focus:ring-primary/20 transition-all";

export function GlassCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl ${glass} ${className}`}>{children}</div>;
}

// ==================== Mini Field ====================

export function MiniField({
  label,
  value,
  onChange,
  placeholder,
  labelWidth = "w-[38px]",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  labelWidth?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`text-[10px] text-muted-foreground ${labelWidth} shrink-0 text-right`}>
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={miniInputClass}
      />
    </div>
  );
}
