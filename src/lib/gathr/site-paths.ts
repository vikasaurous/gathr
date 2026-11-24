/**
 * Public marketing pages that share the SiteHeader. The root route loads the
 * session only for these paths, so the header can show the right buttons for
 * signed-in visitors (server-rendered, no flash of "Sign in").
 * App, auth and API routes load their own session and are intentionally excluded.
 */
const MARKETING_PATHS = new Set([
  "/",
  "/product",
  "/how-it-works",
  "/features",
  "/pricing",
  "/privacy",
  "/terms",
  "/contact",
]);

export function isMarketingPath(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return MARKETING_PATHS.has(normalized || "/");
}
