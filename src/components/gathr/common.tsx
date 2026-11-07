import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export function EmptyState({ title, children, action, className }: { title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center border border-dashed border-border px-6 py-16 text-center", className)}>
      <div className="mb-5 flex -space-x-3">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-12 w-9 rounded-sm border border-border bg-surface" style={{ transform: `rotate(${(i - 1) * 7}deg)` }} />
        ))}
      </div>
      <p className="font-serif text-2xl">{title}</p>
      {children && <p className="mt-2 max-w-sm text-sm text-muted-foreground">{children}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  onConfirm,
}: {
  trigger: React.ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent className="rounded-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-serif text-2xl font-normal">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function PageHeader({ eyebrow, title, children, actions }: { eyebrow?: string; title: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-b border-border pb-6 md:flex-row md:items-end md:justify-between">
      <div>
        {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
        <h1 className="font-serif text-[40px] leading-none tracking-[-0.01em] md:text-[48px]">{title}</h1>
        {children && <p className="mt-3 text-sm text-muted-foreground">{children}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function FilterTabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[] }) {
  return (
    <div className="-mx-1 flex gap-1 overflow-x-auto">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] transition-colors",
            value === o.value ? "bg-foreground text-background" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="num text-[11px] opacity-60">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
