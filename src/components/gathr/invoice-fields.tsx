import { AlertTriangle, CircleAlert } from "lucide-react";
import { FIELD_META, type FieldKey, type Invoice, type ValidationIssue } from "@/lib/gathr/types";
import { cn } from "@/lib/utils";
import { SourceTag } from "./status";

export function InvoiceFields({
  invoice,
  draft,
  onChange,
  issues,
  onFocusField,
}: {
  invoice: Invoice;
  draft: Record<FieldKey, string>;
  onChange: (k: FieldKey, v: string) => void;
  issues: ValidationIssue[];
  onFocusField: (k: FieldKey | null) => void;
}) {
  const groups: { title: string; keys: FieldKey[] }[] = [
    { title: "Supplier", keys: ["supplier", "gstin"] },
    { title: "Document", keys: ["invoiceNumber", "invoiceDate", "dueDate", "currency"] },
    { title: "Amounts", keys: ["taxableValue", "cgst", "sgst", "igst", "total"] },
  ];
  return (
    <div className="space-y-7">
      {groups.map((g) => (
        <fieldset key={g.title}>
          <legend className="eyebrow mb-2">{g.title}</legend>
          <div className="divide-y divide-border border-y border-border">
            {g.keys.map((k) => {
              const meta = FIELD_META.find((m) => m.key === k)!;
              const f = invoice.fields[k];
              const dirty = draft[k] !== f.value;
              const fieldIssues = issues.filter((i) => i.field === k);
              const primaryIssue =
                fieldIssues.find((i) => i.severity === "error") ?? fieldIssues[0];
              const source = dirty ? (draft[k].trim() ? "corrected" : "missing") : f.source;
              const issueListId = `f-${k}-issues`;
              return (
                <div
                  key={k}
                  className={cn(
                    "grid grid-cols-1 gap-1.5 py-2.5 sm:grid-cols-[130px_1fr] sm:items-center sm:gap-3",
                    primaryIssue &&
                      (primaryIssue.severity === "error"
                        ? "bg-destructive/[0.03]"
                        : "bg-warning/[0.04]"),
                  )}
                >
                  <label
                    htmlFor={`f-${k}`}
                    className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground"
                  >
                    {meta.label}
                    {primaryIssue &&
                      (primaryIssue.severity === "error" ? (
                        <CircleAlert className="size-3.5 text-destructive" />
                      ) : (
                        <AlertTriangle className="size-3.5 text-warning" />
                      ))}
                  </label>
                  <div>
                    <div className="flex items-center gap-2">
                      <input
                        id={`f-${k}`}
                        type={meta.kind === "date" ? "date" : "text"}
                        inputMode={meta.kind === "money" ? "decimal" : undefined}
                        value={draft[k]}
                        onFocus={() => onFocusField(k)}
                        onBlur={() => onFocusField(null)}
                        onChange={(e) =>
                          onChange(
                            k,
                            meta.kind === "code" ? e.target.value.toUpperCase() : e.target.value,
                          )
                        }
                        placeholder="Not found"
                        aria-invalid={primaryIssue?.severity === "error" ? true : undefined}
                        aria-describedby={fieldIssues.length > 0 ? issueListId : undefined}
                        className={cn(
                          "h-8 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-[13.5px] transition-colors hover:border-border focus:border-primary focus:bg-surface focus:outline-none",
                          meta.kind !== "text" && "num text-[12.5px]",
                          meta.kind === "money" && "text-right",
                          dirty && "border-primary/40 bg-primary/5",
                          !draft[k] && "placeholder:text-destructive/70",
                        )}
                      />
                      <span className="w-[118px] shrink-0 text-right">
                        <SourceTag source={source} confidence={f.confidence} />
                      </span>
                    </div>
                    {fieldIssues.length > 0 && (
                      <div id={issueListId} className="space-y-0.5 px-2 pt-1">
                        {fieldIssues.map((issue, idx) => (
                          <p
                            key={`${issue.code}-${idx}`}
                            className={cn(
                              "text-[11.5px]",
                              issue.severity === "error" ? "text-destructive" : "text-warning",
                            )}
                          >
                            {issue.message}
                          </p>
                        ))}
                      </div>
                    )}
                    {f.originalValue !== undefined && !dirty && (
                      <p className="num px-2 pt-0.5 text-[10.5px] text-muted-foreground">
                        was: {f.originalValue || "empty"}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
