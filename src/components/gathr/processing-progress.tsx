import { Check } from "lucide-react";
import { PROCESSING_STAGES } from "@/lib/gathr/processing";
import { cn } from "@/lib/utils";

export function ProcessingProgress({ stage, progress }: { stage: number; progress: number }) {
  const overall = Math.min(1, (stage + progress) / PROCESSING_STAGES.length);
  return (
    <div className="rounded-lg border border-border bg-surface p-6 md:p-8">
      <div className="flex items-baseline justify-between">
        <p className="font-serif text-[30px] leading-none">{Math.round(overall * 100)}%</p>
        <p className="num text-[11px] text-muted-foreground">Simulated processing · demo engine</p>
      </div>
      <div className="mt-5 grid grid-cols-5 gap-1">
        {PROCESSING_STAGES.map((s, i) => (
          <div key={s.key} className="h-[3px] overflow-hidden bg-border">
            <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${i < stage ? 100 : i === stage ? progress * 100 : 0}%` }} />
          </div>
        ))}
      </div>
      <ol className="mt-8 space-y-3.5">
        {PROCESSING_STAGES.map((s, i) => (
          <li key={s.key} className={cn("flex items-center gap-3 text-[14px] transition-colors", i > stage ? "text-muted-foreground/60" : "text-foreground")}>
            <span className={cn("grid size-5 place-items-center rounded-full border text-[10px]", i < stage ? "border-primary bg-primary text-primary-foreground" : i === stage ? "border-primary text-primary" : "border-border")}>
              {i < stage ? <Check className="size-3" /> : <span className="num">{i + 1}</span>}
            </span>
            {s.label}
            {i === stage && <span className="ml-auto size-1.5 animate-pulse rounded-full bg-primary" />}
          </li>
        ))}
      </ol>
    </div>
  );
}
