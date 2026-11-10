import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useState } from "react";
import { signUp } from "@/lib/auth/client";
import { Wordmark } from "@/components/gathr/brand";
import { getSessionFn } from "@/lib/auth/functions";
import { GoogleButton } from "@/components/gathr/google-button";

export const Route = createFileRoute("/register")({
  beforeLoad: async () => {
    const session = await getSessionFn();
    if (session) {
      throw redirect({ to: "/app" });
    }
  },
  head: () => ({
    meta: [
      { title: "Create account — gathr" },
      { name: "description", content: "Create your gathr account." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RegisterPage,
});

function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordMismatch = confirm.length > 0 && password !== confirm;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const result = await signUp.email({ name, email: email.trim(), password });
      if (result.error) {
        setError(result.error.message ?? "Registration failed. Please try again.");
      } else {
        if (typeof window !== "undefined") {
          sessionStorage.setItem("gathr_pending_verification_email", email.trim());
          sessionStorage.setItem("gathr_otp_sent_at", Date.now().toString());
        }
        await router.invalidate();
        await router.navigate({
          to: "/verify-email",
        });
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
            <p className="eyebrow mb-4">New account</p>
            <h1 className="display text-[52px] leading-none">
              Get <em>started.</em>
            </h1>
            <p className="mt-4 text-[14px] text-muted-foreground">
              Create your gathr workspace account.
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            {/* Google sign-in — creates or links account instantly */}
            <GoogleButton callbackURL="/app" errorCallbackURL="/register" />

            {/* OR separator */}
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                or continue with email
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            {/* Name */}
            <div className="space-y-1.5">
              <label htmlFor="name" className="block text-[12.5px] text-muted-foreground">
                Full name
              </label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="auth-input"
                placeholder="Alex Mehta"
                disabled={loading}
              />
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
                onChange={(e) => setEmail(e.target.value)}
                className="auth-input"
                placeholder="you@company.com"
                disabled={loading}
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-[12.5px] text-muted-foreground">
                Password
                <span className="ml-1.5 text-[11px] opacity-60">(min. 8 characters)</span>
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
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

            {/* Confirm password */}
            <div className="space-y-1.5">
              <label htmlFor="confirm" className="block text-[12.5px] text-muted-foreground">
                Confirm password
              </label>
              <div className="relative">
                <input
                  id="confirm"
                  type={showConfirm ? "text" : "password"}
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  aria-invalid={passwordMismatch}
                  className={`auth-input pr-10 ${passwordMismatch ? "border-destructive focus:ring-destructive/30" : ""}`}
                  placeholder="••••••••"
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((s) => !s)}
                  className="absolute inset-y-0 right-3 flex items-center text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={showConfirm ? "Hide password" : "Show password"}
                  tabIndex={-1}
                >
                  {showConfirm ? (
                    <EyeOff className="size-4" strokeWidth={1.5} />
                  ) : (
                    <Eye className="size-4" strokeWidth={1.5} />
                  )}
                </button>
              </div>
              {passwordMismatch && (
                <p className="text-[12px] text-destructive">Passwords do not match.</p>
              )}
            </div>

            {/* Error */}
            {error && (
              <p
                role="alert"
                className="rounded-md bg-destructive/10 px-3.5 py-3 text-[13px] text-destructive"
              >
                {error}
              </p>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !name || !email || !password || !confirm || passwordMismatch}
              className="auth-submit"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  Creating account…
                </span>
              ) : (
                "Create account"
              )}
            </button>
          </form>

          {/* Divider */}
          <div className="my-7 h-px bg-border" />

          {/* Sign-in link */}
          <p className="text-center text-[13.5px] text-muted-foreground">
            Already have an account?{" "}
            <Link to="/login" className="text-foreground underline-offset-2 hover:underline">
              Sign in
            </Link>
          </p>

          {/* Email delivery note */}
          <p className="mt-5 text-center text-[12px] text-muted-foreground">
            A 6-digit verification code will be sent to your email.
          </p>
        </div>
      </main>
    </div>
  );
}
