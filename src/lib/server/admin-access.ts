/**
 * Owner/admin access rules — pure functions, no secrets, safe to unit test.
 *
 * Access is granted ONLY when ALL of these hold:
 *   1. The ADMIN_EMAILS allowlist is configured (fail closed when empty/unset).
 *   2. The signed-in user's email is on the allowlist (case-insensitive, exact match).
 *   3. The user's email is VERIFIED (blocks pre-registration of an owner address).
 */

export function parseAdminEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const emails = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return Array.from(new Set(emails));
}

export interface AdminCandidate {
  email?: string | null | undefined;
  emailVerified?: boolean | null | undefined;
}

export function isAdminUser(
  user: AdminCandidate | null | undefined,
  rawAllowlist: string | null | undefined,
): boolean {
  if (!user) return false;
  if (user.emailVerified !== true) return false;
  const email = user.email?.trim().toLowerCase();
  if (!email) return false;
  const allowlist = parseAdminEmails(rawAllowlist);
  if (allowlist.length === 0) return false;
  return allowlist.includes(email);
}
