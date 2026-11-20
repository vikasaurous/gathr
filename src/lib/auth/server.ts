/**
 * Better Auth v1 server instance — Cloudflare Workers / Nitro compatible.
 *
 * Database: Kysely + @neondatabase/serverless Pool (WebSocket transport).
 * Cloudflare Workers supports native WebSockets, so Pool works without
 * any additional configuration beyond setting neonConfig.webSocketConstructor.
 *
 * Keep this file server-only. Never import it from client-side code.
 */
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { Kysely, PostgresDialect } from "kysely";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { sendOtpEmail } from "@/lib/email/resend";

// In Cloudflare Workers, the global WebSocket constructor is available.
// This line is a no-op in Node.js (where Pool already uses net sockets).
// @ts-expect-error — global WebSocket exists in Workers, possibly undefined in Node
if (typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket;
}

function createDb() {
  return new Kysely({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.DATABASE_URL! }),
    }),
  });
}

export const auth = betterAuth({
  database: {
    db: createDb(),
    type: "postgres",
  },

  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:8080",

  // Allow the local dev server and any production origin configured via env var.
  // Set PRODUCTION_ORIGIN=https://your-domain.com before deploying.
  trustedOrigins: [
    "http://localhost:8080",
    ...(process.env.PRODUCTION_ORIGIN ? [process.env.PRODUCTION_ORIGIN] : []),
  ],

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },

  account: {
    accountLinking: {
      enabled: true,
    },
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },

  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 300,
      allowedAttempts: 3,
      sendVerificationOnSignUp: true,
      overrideDefaultEmailVerification: true,
      sendVerificationOTP: async ({ email, otp, type }) => {
        await sendOtpEmail({ to: email, otp, type });
      },
    }),
    // Required for TanStack Start: wraps cookies so they work in SSR contexts.
    // Must be placed after other plugins in Better Auth.
    tanstackStartCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user;
