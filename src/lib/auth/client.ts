/**
 * Better Auth browser client.
 *
 * Safe to import from client-side React components. Never import the server
 * module (src/lib/auth/server.ts) from components or route loaders.
 */
import { createAuthClient } from "better-auth/react";
import { emailOTPClient, oneTapClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL:
    typeof window !== "undefined"
      ? window.location.origin
      : (process.env.BETTER_AUTH_URL ?? "http://localhost:8080"),
  plugins: [
    emailOTPClient(),
    oneTapClient({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientId: (import.meta.env as any)["VITE_GOOGLE_CLIENT_ID"] as string,
      autoSelect: false,
      cancelOnTapOutside: true,
      context: "signin",
      promptOptions: {
        maxAttempts: 3,
        baseDelay: 1000,
      },
    }),
  ],
});

export const { useSession, signIn, signUp, signOut } = authClient;
