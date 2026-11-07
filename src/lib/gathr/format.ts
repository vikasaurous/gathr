export function formatMoney(v: string | number, currency = "INR") {
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

export function formatDate(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function pageRange(pages: number[]) {
  if (!pages.length) return "—";
  return pages.length === 1 ? `p. ${pages[0]}` : `pp. ${pages[0]}–${pages[pages.length - 1]}`;
}
