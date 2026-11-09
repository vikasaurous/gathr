export function formatMoney(v: string | number, currency = "INR") {
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatDate(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Formats a Date object into the GATHR dashboard header format:
 * e.g., "SUNDAY, 8 NOVEMBER"
 *
 * Uses `Intl.DateTimeFormat` with full weekday name, numeric day, and full month name,
 * rendered in uppercase using the local environment/browser timezone.
 */
export function formatDashboardDate(date: Date = new Date(), timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = timeZone ? { timeZone } : {};
  const weekday = new Intl.DateTimeFormat("en-US", { ...options, weekday: "long" }).format(date);
  const day = new Intl.DateTimeFormat("en-US", { ...options, day: "numeric" }).format(date);
  const month = new Intl.DateTimeFormat("en-US", { ...options, month: "long" }).format(date);

  return `${weekday}, ${day} ${month}`.toUpperCase();
}

export function pageRange(pages: number[]) {
  if (!pages.length) return "—";
  return pages.length === 1 ? `p. ${pages[0]}` : `pp. ${pages[0]}–${pages[pages.length - 1]}`;
}
