/**
 * Better Auth browser client.
 *
 * Safe to import from client-side React components. Never import the server
 * module (src/lib/auth/server.ts) from components or route loaders.
 */
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL:
    typeof window !== "undefined"
      ? window.location.origin
      : (process.env.BETTER_AUTH_URL ?? "http://localhost:8080"),
  plugins: [emailOTPClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
