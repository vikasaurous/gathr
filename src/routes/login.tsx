import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useState } from "react";
import { signIn } from "@/lib/auth/client";
import { Wordmark } from "@/components/gathr/brand";
import { getSessionFn } from "@/lib/auth/functions";
import { GoogleButton } from "@/components/gathr/google-button";
import { getAuthErrorMessage } from "@/lib/auth/errors";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    verified: search.verified === "true" || search.verified === true ? true : undefined,
    email:
      typeof search.email === "string" && search.email.trim() ? search.email.trim() : undefined,
    error:
      typeof search.error === "string" && search.error.trim() ? search.error.trim() : undefined,
  }),
  beforeLoad: async () => {
    const session = await getSessionFn();
    if (session) {
      throw redirect({ to: "/app" });
    }
  },
  head: () => ({
    meta: [
      { title: "Sign in — gathr" },
      { name: "description", content: "Sign in to your gathr workspace." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const search = Route.useSearch();
  const [email, setEmail] = useState(search.email ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);

  // Translate OAuth callback error (if present in query string)
  const oauthError = search.error ? getAuthErrorMessage(search.error) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setUnverifiedEmail(null);
    setLoading(true);
    try {
      const result = await signIn.email({ email: email.trim(), password });
      if (result.error) {
        const rawCode = result.error.code || result.error.message || "";
        const mapped = getAuthErrorMessage(rawCode);
        if (
          rawCode === "EMAIL_NOT_VERIFIED" ||
          rawCode.toLowerCase().includes("not verified") ||
          rawCode.toLowerCase().includes("verify your email")
        ) {
          setError(mapped?.message || "Please verify your email before signing in.");
          setUnverifiedEmail(email.trim());
        } else {
          setError(mapped?.message || "Sign-in failed. Check your credentials and try again.");
        }
      } else {
        // Navigating directly to /app runs /app's beforeLoad guard once with the new session cookies.
        await router.navigate({ to: "/app", replace: true });
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Header */}
      <header className="border-b border-border px-6 py-5">
        <div className="mx-auto max-w-[1240px]">
          <Wordmark />
        </div>
      </header>

      {/* Main */}
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="w-full max-w-[400px]">
          {/* Title */}
          <div className="mb-8">
            <p className="eyebrow mb-4">Workspace access</p>
            <h1 className="display text-[52px] leading-none">
              Sign <em>in.</em>
            </h1>
            <p className="mt-4 text-[14px] text-muted-foreground">
              Continue to your gathr workspace.
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            {/* Exactly one OAuth error banner */}
            {oauthError && !error && (
              <div
                role="alert"
                className="space-y-1.5 rounded-md bg-destructive/10 px-3.5 py-3 text-[13px] text-destructive"
              >
                <p>{oauthError.message}</p>
                {oauthError.showVerifyLink && (
                  <p>
                    <Link
                      to="/verify-email"
                      className="font-medium underline underline-offset-2 hover:opacity-85"
                    >
                      Verify your email →
                    </Link>
                  </p>
                )}
              </div>
            )}

            {/* Verified confirmation banner */}
            {search.verified && !oauthError && !error && (
              <div
                role="status"
                className="rounded-md border border-[#425B51]/30 bg-[#425B51]/10 px-3.5 py-3 text-[13px] text-[#425B51]"
              >
                Email verified successfully. Please sign in to your workspace.
              </div>
            )}

            {/* Google sign-in */}
            <GoogleButton callbackURL="/app" errorCallbackURL="/login" />

            {/* OR separator */}
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                or continue with email
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            {/* Email */}
            <div className="space-y-1.5">
              <label htmlFor="email" className="block text-[12.5px] text-muted-foreground">
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                className="auth-input"
                placeholder="you@company.com"
                disabled={loading}
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-[12.5px] text-muted-foreground">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (error) setError(null);
                  }}
                  className="auth-input pr-10"
                  placeholder="••••••••"
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute inset-y-0 right-3 flex items-center text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="size-4" strokeWidth={1.5} />
                  ) : (
                    <Eye className="size-4" strokeWidth={1.5} />
                  )}
                </button>
              </div>
            </div>

            {/* Form Error */}
            {error && (
              <div
                role="alert"
                className="space-y-1.5 rounded-md bg-destructive/10 px-3.5 py-3 text-[13px] text-destructive"
              >
                <p>{error}</p>
                {unverifiedEmail && (
                  <p>
                    <Link
                      to="/verify-email"
                      className="font-medium underline underline-offset-2 hover:opacity-85"
                    >
                      Verify email or request a new code →
                    </Link>
                  </p>
                )}
              </div>
            )}

            {/* Submit */}
            <button type="submit" disabled={loading || !email || !password} className="auth-submit">
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  Signing in…
                </span>
              ) : (
                "Sign in"
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="my-7 h-px bg-border" />

          {/* Register link */}
          <p className="text-center text-[13.5px] text-muted-foreground">
            Don't have an account?{" "}
            <Link to="/register" className="text-foreground underline-offset-2 hover:underline">
              Create one
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
