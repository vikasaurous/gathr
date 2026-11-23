import "@tanstack/react-start/server-only";
import { neon } from "@neondatabase/serverless";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { auth } from "@/lib/auth/server";
import { HttpError, getServerEnv } from "./env";
import { isAdminUser } from "./admin-access";
import { DEFAULT_PLAN, isPlanId, type PlanId } from "@/lib/gathr/plans";

export const ADMIN_PAGE_SIZE = 25;

export interface AdminContext {
  userId: string;
  email: string;
}

export interface AdminOverview {
  totalUsers: number;
  verifiedUsers: number;
  newUsers7d: number;
  newUsers30d: number;
  activeSessions: number;
  planCounts: Record<PlanId, number>;
  generatedAt: string;
}

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  providers: string[];
  plan: PlanId;
  activeSessions: number;
}

export interface AdminUserPage {
  rows: AdminUserRow[];
  total: number;
  page: number;
  pageSize: number;
  query: string;
}

/** Minimal SQL interface (matches neon().query) so the queries are unit-testable. */
export interface AdminSql {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * Re-verifies the session AND admin allowlist on EVERY call.
 * Route guards are UX only — server functions are directly callable over HTTP,
 * so this is the real security boundary. Non-admins get a 404 (not 403) so the
 * existence of the admin area is not revealed.
 */
export async function requireAdmin(): Promise<AdminContext> {
  const session = await auth.api.getSession({ headers: getRequestHeaders() });
  const user = session?.user;
  if (!user?.id || !session?.session?.id) {
    throw new HttpError(401, "Authentication required.", "UNAUTHORIZED");
  }
  if (!isAdminUser(user, getServerEnv().ADMIN_EMAILS)) {
    console.warn("[admin] access denied", { userId: user.id });
    throw new HttpError(404, "Not found.", "NOT_FOUND");
  }
  // Admin data must never be cached by browsers or intermediaries.
  setResponseHeader("Cache-Control", "private, no-store");
  return { userId: user.id, email: user.email };
}

export function getAdminSql(): AdminSql {
  const url = getServerEnv().DATABASE_URL;
  if (!url) {
    throw new HttpError(500, "Database is not configured.", "DB_NOT_CONFIGURED");
  }
  const sql = neon(url);
  return {
    query: (text, params) => sql.query(text, params ?? []) as Promise<Record<string, unknown>[]>,
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return new Date(0).toISOString();
}

function toNullableIso(value: unknown): string | null {
  if (value == null) return null;
  return toIso(value);
}

/** Escapes LIKE wildcards so user input is matched literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

export async function fetchAdminOverview(sql: AdminSql): Promise<AdminOverview> {
  const rows = await sql.query(
    `SELECT
       (SELECT count(*)::int FROM "user") AS total_users,
       (SELECT count(*)::int FROM "user" WHERE "emailVerified" = true) AS verified_users,
       (SELECT count(*)::int FROM "user" WHERE "createdAt" >= now() - interval '7 days') AS new_7d,
       (SELECT count(*)::int FROM "user" WHERE "createdAt" >= now() - interval '30 days') AS new_30d,
       (SELECT count(*)::int FROM "session" WHERE "expiresAt" > now()) AS active_sessions,
       (SELECT count(*)::int FROM "user_plan" WHERE "plan" = 'pro') AS pro_users,
       (SELECT count(*)::int FROM "user_plan" WHERE "plan" = 'business') AS business_users`,
    [],
  );
  const r = rows[0] ?? {};
  const totalUsers = Number(r["total_users"] ?? 0);
  const pro = Number(r["pro_users"] ?? 0);
  const business = Number(r["business_users"] ?? 0);
  return {
    totalUsers,
    verifiedUsers: Number(r["verified_users"] ?? 0),
    newUsers7d: Number(r["new_7d"] ?? 0),
    newUsers30d: Number(r["new_30d"] ?? 0),
    activeSessions: Number(r["active_sessions"] ?? 0),
    // A user without a user_plan row is on the default (Free) plan.
    planCounts: { free: Math.max(0, totalUsers - pro - business), pro, business },
    generatedAt: new Date().toISOString(),
  };
}

export async function fetchAdminUsers(
  sql: AdminSql,
  opts: { page: number; query: string },
): Promise<AdminUserPage> {
  const page = Math.max(1, Math.floor(opts.page) || 1);
  const query = opts.query.trim().slice(0, 100);
  const offset = (page - 1) * ADMIN_PAGE_SIZE;

  const filterParams: unknown[] = [];
  let where = "";
  if (query) {
    filterParams.push(`%${escapeLike(query)}%`);
    where = `WHERE (u."email" ILIKE $1 ESCAPE '\\' OR u."name" ILIKE $1 ESCAPE '\\')`;
  }

  const limitIdx = filterParams.length + 1;
  const offsetIdx = filterParams.length + 2;

  const [countRows, rows] = await Promise.all([
    sql.query(`SELECT count(*)::int AS total FROM "user" u ${where}`, filterParams),
    sql.query(
      `SELECT
         u."id", u."name", u."email", u."emailVerified", u."createdAt",
         (SELECT COALESCE(array_agg(DISTINCT a."providerId" ORDER BY a."providerId"), ARRAY[]::text[])
            FROM "account" a WHERE a."userId" = u."id") AS providers,
         COALESCE((SELECT up."plan" FROM "user_plan" up WHERE up."userId" = u."id"), 'free') AS plan,
         (SELECT max(s."createdAt") FROM "session" s WHERE s."userId" = u."id") AS last_sign_in_at,
         (SELECT count(*)::int FROM "session" s
            WHERE s."userId" = u."id" AND s."expiresAt" > now()) AS active_sessions
       FROM "user" u
       ${where}
       ORDER BY u."createdAt" DESC, u."id" ASC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...filterParams, ADMIN_PAGE_SIZE, offset],
    ),
  ]);

  return {
    rows: rows.map((r) => ({
      id: String(r["id"]),
      name: String(r["name"] ?? ""),
      email: String(r["email"] ?? ""),
      emailVerified: r["emailVerified"] === true,
      createdAt: toIso(r["createdAt"]),
      lastSignInAt: toNullableIso(r["last_sign_in_at"]),
      providers: Array.isArray(r["providers"]) ? r["providers"].map(String) : [],
      plan: isPlanId(r["plan"]) ? r["plan"] : DEFAULT_PLAN,
      activeSessions: Number(r["active_sessions"] ?? 0),
    })),
    total: Number(countRows[0]?.["total"] ?? 0),
    page,
    pageSize: ADMIN_PAGE_SIZE,
    query,
  };
}

/**
 * Sets a user's plan (manual assignment until a billing provider exists).
 * Only updates users that exist; returns 404 otherwise. Plan is validated
 * here as well as in the server function (defence in depth).
 */
export async function setUserPlan(
  sql: AdminSql,
  opts: { userId: string; plan: string; adminId: string },
): Promise<{ userId: string; plan: PlanId }> {
  if (!isPlanId(opts.plan)) {
    throw new HttpError(400, "Invalid plan.", "INVALID_PLAN");
  }
  const userId = opts.userId.trim();
  if (!userId || userId.length > 128) {
    throw new HttpError(400, "Invalid user.", "INVALID_USER");
  }
  const rows = await sql.query(
    `INSERT INTO "user_plan" ("userId", "plan", "updatedAt", "updatedBy")
     SELECT u."id", $2::text, now(), $3::text FROM "user" u WHERE u."id" = $1::text
     ON CONFLICT ("userId") DO UPDATE
       SET "plan" = EXCLUDED."plan", "updatedAt" = now(), "updatedBy" = EXCLUDED."updatedBy"
     RETURNING "userId", "plan"`,
    [userId, opts.plan, opts.adminId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "User not found.", "USER_NOT_FOUND");
  return {
    userId: String(row["userId"]),
    plan: isPlanId(row["plan"]) ? row["plan"] : DEFAULT_PLAN,
  };
}
