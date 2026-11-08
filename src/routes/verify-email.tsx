import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth/client";
import { Wordmark } from "@/components/gathr/brand";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { getAuthErrorMessage } from "@/lib/auth/errors";

const PENDING_EMAIL_KEY = "gathr_pending_verification_email";
const OTP_SENT_AT_KEY = "gathr_otp_sent_at";

export const Route = createFileRoute("/verify-email")({
  validateSearch: (search: Record<string, unknown>) => ({
    email:
      typeof search.email === "string" && search.email.trim() ? search.email.trim() : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Verify email — gathr" },
      {
        name: "description",
        content: "Verify your email address to access your gathr workspace.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VerifyEmailPage,
});

function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return email;
  const [user, domain] = email.split("@");
  if (!user || user.length <= 2) {
    return `${user[0] ?? "*"}***@${domain}`;
  }
  return `${user.slice(0, 2)}***${user.slice(-1)}@${domain}`;
}

function VerifyEmailPage() {
  const router = useRouter();
  const search = Route.useSearch();

  // Email state: query param first, then sessionStorage, then empty
  const [email, setEmail] = useState(() => {
    if (search.email) return search.email;
    if (typeof window !== "undefined") {
      return sessionStorage.getItem(PENDING_EMAIL_KEY) || "";
    }
    return "";
  });

  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [sendingInitial, setSendingInitial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  // Timer lifecycle: null means no code sent yet; number means active/expired countdown
  const [otpSent, setOtpSent] = useState(false);
  const [expirySeconds, setExpirySeconds] = useState<number | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  // Initialize email & timer state from sessionStorage on mount
  useEffect(() => {
    if (typeof window === "undefined") return;

    setEmail((prev) => prev || sessionStorage.getItem(PENDING_EMAIL_KEY) || "");

    const storedSentAt = sessionStorage.getItem(OTP_SENT_AT_KEY);
    if (storedSentAt) {
      const sentAt = parseInt(storedSentAt, 10);
      if (!isNaN(sentAt)) {
        const elapsed = Math.floor((Date.now() - sentAt) / 1000);
        if (elapsed < 300) {
          setExpirySeconds(300 - elapsed);
          setCooldownSeconds(Math.max(0, 60 - elapsed));
          setOtpSent(true);
        } else {
          setExpirySeconds(0);
          setCooldownSeconds(0);
          setOtpSent(true);
        }
      }
    }
  }, []);

  // Interval ticker: ticks down only when an OTP has actually been sent
  useEffect(() => {
    if (expirySeconds === null && cooldownSeconds === 0) return;

    const timer = setInterval(() => {
      setExpirySeconds((prev) => {
        if (prev === null) return null;
        return prev > 0 ? prev - 1 : 0;
      });
      setCooldownSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => clearInterval(timer);
  }, [expirySeconds, cooldownSeconds]);

  const formatTime = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  /**
   * Request initial verification code when navigating to page without prior OTP send
   */
  async function handleSendInitialCode(e: React.FormEvent) {
    e.preventDefault();
    const targetEmail = email.trim();
    if (!targetEmail || sendingInitial) return;

    setError(null);
    setResendMessage(null);
    setSendingInitial(true);

    try {
      const res = await authClient.emailOtp.sendVerificationOtp({
        email: targetEmail,
        type: "email-verification",
      });

      if (res.error) {
        const mapped = getAuthErrorMessage(res.error.code || res.error.message);
        setError(mapped?.message || "Could not send verification code. Please verify your email.");
      } else {
        if (typeof window !== "undefined") {
          sessionStorage.setItem(OTP_SENT_AT_KEY, Date.now().toString());
          sessionStorage.setItem(PENDING_EMAIL_KEY, targetEmail);
        }
        setOtpSent(true);
        setExpirySeconds(300);
        setCooldownSeconds(60);
        setResendMessage("A 6-digit verification code has been sent to your email.");
      }
    } catch {
      setError("Failed to send verification code. Please check your network connection.");
    } finally {
      setSendingInitial(false);
    }
  }

  /**
   * Submit and verify 6-digit OTP code
   */
  async function handleVerify(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const targetEmail = email.trim();
    const targetOtp = otp.trim();

    if (loading || resending || targetOtp.length !== 6 || !targetEmail) return;
    if (expirySeconds === 0) {
      setError("This verification code has expired. Request a new code below.");
      return;
    }

    setError(null);
    setResendMessage(null);
    setLoading(true);

    try {
      const res = await authClient.emailOtp.verifyEmail({
        email: targetEmail,
        otp: targetOtp,
      });

      if (res.error) {
        const rawCode = res.error.code || res.error.message || "";
        const mapped = getAuthErrorMessage(rawCode);
        setError(mapped?.message || "Verification failed. Please try again.");
      } else {
        // Clear pending registration state on successful verification
        if (typeof window !== "undefined") {
          sessionStorage.removeItem(PENDING_EMAIL_KEY);
          sessionStorage.removeItem(OTP_SENT_AT_KEY);
        }
        setSuccess(true);
        await router.invalidate();
        // Redirect to login with verified notice, no exposed email in URL
        setTimeout(() => {
          router.navigate({
            to: "/login",
            search: { verified: "true" },
          });
        }, 1200);
      }
    } catch {
      setError("An unexpected error occurred during verification. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  /**
   * Request a fresh verification code
   */
  async function handleResend() {
    const targetEmail = email.trim();
    if (cooldownSeconds > 0 || !targetEmail || resending || loading) return;

    setError(null);
    setResendMessage(null);
    setResending(true);

    try {
      const res = await authClient.emailOtp.sendVerificationOtp({
        email: targetEmail,
        type: "email-verification",
      });

      if (res.error) {
        const mapped = getAuthErrorMessage(res.error.code || res.error.message);
        setError(mapped?.message || "Could not resend verification code.");
      } else {
        if (typeof window !== "undefined") {
          sessionStorage.setItem(OTP_SENT_AT_KEY, Date.now().toString());
          sessionStorage.setItem(PENDING_EMAIL_KEY, targetEmail);
        }
        setResendMessage("A fresh 6-digit code has been sent to your email.");
        setCooldownSeconds(60);
        setExpirySeconds(300);
        setOtp("");
      }
    } catch {
      setError("Failed to resend verification code. Please try again.");
    } finally {
      setResending(false);
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
        <div className="w-full max-w-[420px]">
          {/* Title */}
          <div className="mb-8">
            <p className="eyebrow mb-4">Security verification</p>
            <h1 className="display text-[52px] leading-none">
              Check your <em>inbox.</em>
            </h1>
            <p className="mt-4 text-[14px] text-muted-foreground">
              {otpSent && email ? (
                <>
                  We sent a 6-digit verification code to{" "}
                  <strong className="font-mono text-foreground">{maskEmail(email)}</strong>.
                </>
              ) : (
                "Enter your workspace email address to receive a 6-digit verification code."
              )}
            </p>
          </div>

          {/* Success State */}
          {success ? (
            <div className="space-y-4 rounded-lg border border-border bg-surface p-6 text-center">
              <CheckCircle2 className="mx-auto size-10 text-primary" strokeWidth={1.5} />
              <h2 className="font-serif text-[24px]">Email verified</h2>
              <p className="text-[13.5px] text-muted-foreground">
                Your email has been verified. Redirecting to sign in…
              </p>
            </div>
          ) : !otpSent ? (
            /* State: No OTP has been sent yet -> Request OTP first */
            <form onSubmit={handleSendInitialCode} className="space-y-6" noValidate>
              <div className="space-y-1.5">
                <label
                  htmlFor="verify-email-input"
                  className="block text-[12.5px] text-muted-foreground"
                >
                  Email address
                </label>
                <input
                  id="verify-email-input"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (error) setError(null);
                  }}
                  className="auth-input"
                  placeholder="you@company.com"
                  disabled={sendingInitial}
                />
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-md bg-destructive/10 px-3.5 py-3 text-[13px] text-destructive"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={sendingInitial || !email.trim()}
                className="auth-submit"
              >
                {sendingInitial ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    Sending code…
                  </span>
                ) : (
                  "Send verification code"
                )}
              </button>

              <div className="flex items-center justify-center pt-2 text-[13px]">
                <Link
                  to="/login"
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Back to sign in
                </Link>
              </div>
            </form>
          ) : (
            /* State: OTP sent -> Enter 6-digit code */
            <form onSubmit={handleVerify} className="space-y-6" noValidate>
              {/* If no email prefilled, display email input */}
              {!search.email && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="verify-email"
                      className="block text-[12.5px] text-muted-foreground"
                    >
                      Email address
                    </label>
                  </div>
                  <input
                    id="verify-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (error) setError(null);
                    }}
                    className="auth-input"
                    placeholder="you@company.com"
                    disabled={loading || resending}
                  />
                </div>
              )}

              {/* Six-digit OTP input */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="otp-input" className="block text-[12.5px] text-muted-foreground">
                    Six-digit code
                  </label>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {expirySeconds !== null && expirySeconds > 0 ? (
                      <>Expires in {formatTime(expirySeconds)}</>
                    ) : expirySeconds === 0 ? (
                      <span className="text-destructive">Code expired</span>
                    ) : null}
                  </span>
                </div>

                <div className="flex justify-center py-2">
                  <InputOTP
                    id="otp-input"
                    maxLength={6}
                    value={otp}
                    onChange={(val) => {
                      setOtp(val);
                      setError(null);
                    }}
                    disabled={loading || resending || expirySeconds === 0}
                  >
                    <InputOTPGroup className="gap-2">
                      <InputOTPSlot
                        index={0}
                        className="size-11 rounded-md border text-[18px] font-mono shadow-none"
                      />
                      <InputOTPSlot
                        index={1}
                        className="size-11 rounded-md border text-[18px] font-mono shadow-none"
                      />
                      <InputOTPSlot
                        index={2}
                        className="size-11 rounded-md border text-[18px] font-mono shadow-none"
                      />
                      <InputOTPSlot
                        index={3}
                        className="size-11 rounded-md border text-[18px] font-mono shadow-none"
                      />
                      <InputOTPSlot
                        index={4}
                        className="size-11 rounded-md border text-[18px] font-mono shadow-none"
                      />
                      <InputOTPSlot
                        index={5}
                        className="size-11 rounded-md border text-[18px] font-mono shadow-none"
                      />
                    </InputOTPGroup>
                  </InputOTP>
                </div>
              </div>

              {/* Feedback messages */}
              {error && (
                <p
                  role="alert"
                  className="rounded-md bg-destructive/10 px-3.5 py-3 text-[13px] text-destructive"
                >
                  {error}
                </p>
              )}

              {resendMessage && (
                <p
                  role="status"
                  className="rounded-md bg-primary/10 px-3.5 py-3 text-[13px] text-primary"
                >
                  {resendMessage}
                </p>
              )}

              {/* Action Buttons */}
              <div className="space-y-3">
                <button
                  type="submit"
                  disabled={
                    loading ||
                    resending ||
                    otp.length !== 6 ||
                    !email.trim() ||
                    expirySeconds === 0 ||
                    expirySeconds === null
                  }
                  className="auth-submit"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="size-4 animate-spin" />
                      Verifying…
                    </span>
                  ) : (
                    "Verify code"
                  )}
                </button>

                <div className="flex items-center justify-between pt-2 text-[13px]">
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={cooldownSeconds > 0 || resending || loading || !email.trim()}
                    className="flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {resending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="size-3.5" />
                    )}
                    {cooldownSeconds > 0 ? (
                      <span>Resend code in {cooldownSeconds}s</span>
                    ) : (
                      <span>Resend code</span>
                    )}
                  </button>

                  <Link
                    to="/login"
                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Back to sign in
                  </Link>
                </div>
              </div>
            </form>
          )}

          {/* Divider */}
          <div className="my-7 h-px bg-border" />

          {/* Development Notice — only displayed in local development */}
          {import.meta.env.DEV && (
            <p className="text-center text-[12px] text-muted-foreground">
              Development mode: verification codes are delivered to configured test inbox.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
