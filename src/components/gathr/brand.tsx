import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

/** Stack mark: three sheets gathered into one aligned edge. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={cn("size-[18px]", className)} aria-hidden>
      <rect x="3" y="2.5" width="11" height="13" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".35" transform="rotate(-8 8 9)" />
      <rect x="4.5" y="3.5" width="11" height="13" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".6" transform="rotate(-3 10 10)" />
      <rect x="6" y="4.5" width="11" height="13" rx="1" fill="currentColor" />
    </svg>
  );
}

export function Wordmark({ className, to = "/" }: { className?: string; to?: "/" | "/app" }) {
  return (
    <Link to={to} className={cn("group inline-flex items-center gap-2 text-foreground", className)} aria-label="gathr home">
      <Mark className="transition-transform duration-300 group-hover:-rotate-3" />
      <span className="font-serif text-[26px] leading-none tracking-[-0.02em]">gathr</span>
    </Link>
  );
}

export function SectionLabel({ n, children, className }: { n: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-4", className)}>
      <span className="eyebrow">
        {n} / {children}
      </span>
      <span className="rule-fade flex-1" />
    </div>
  );
}
