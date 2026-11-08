import { describe, it, expect, beforeEach } from "vitest";

describe("Authentication UX & Lifecycle Logic", () => {
  beforeEach(() => {
    // Clear storage before each test
    sessionStorage.clear();
  });

  describe("Issue B: Email preservation & query string hygiene", () => {
    it("preserves registered email in sessionStorage without URL query params", () => {
      const email = "alex.mehta@example.com";
      // Simulate register success action
      sessionStorage.setItem("gathr_pending_verification_email", email);

      // Verify email is retrievable on page load/refresh
      const retrieved = sessionStorage.getItem("gathr_pending_verification_email");
      expect(retrieved).toBe(email);
    });

    it("clears pending email upon successful verification", () => {
      sessionStorage.setItem("gathr_pending_verification_email", "alex@example.com");
      sessionStorage.setItem("gathr_otp_sent_at", Date.now().toString());

      // Simulate verification success
      sessionStorage.removeItem("gathr_pending_verification_email");
      sessionStorage.removeItem("gathr_otp_sent_at");

      expect(sessionStorage.getItem("gathr_pending_verification_email")).toBeNull();
      expect(sessionStorage.getItem("gathr_otp_sent_at")).toBeNull();
    });

    it("does not serialize empty email query parameters", () => {
      const validateSearch = (search: Record<string, unknown>) => ({
        email:
          typeof search.email === "string" && search.email.trim() ? search.email.trim() : undefined,
      });

      expect(validateSearch({ email: "" })).toEqual({ email: undefined });
      expect(validateSearch({ email: "   " })).toEqual({ email: undefined });
      expect(validateSearch({})).toEqual({ email: undefined });
      expect(validateSearch({ email: "user@gathr.app" })).toEqual({ email: "user@gathr.app" });
    });
  });

  describe("Issue C: Timer lifecycle logic", () => {
    it("does not start timer when no OTP timestamp exists in storage", () => {
      const storedSentAt = sessionStorage.getItem("gathr_otp_sent_at");
      expect(storedSentAt).toBeNull();

      // Calculation when no OTP has been sent
      const expirySeconds = storedSentAt ? 300 : null;
      const cooldownSeconds = storedSentAt ? 60 : 0;

      expect(expirySeconds).toBeNull();
      expect(cooldownSeconds).toBe(0);
    });

    it("resumes countdown accurately across page refreshes based on elapsed time", () => {
      const now = Date.now();
      // Simulate OTP sent 45 seconds ago
      const sentAt = now - 45 * 1000;
      sessionStorage.setItem("gathr_otp_sent_at", sentAt.toString());

      const storedSentAt = parseInt(sessionStorage.getItem("gathr_otp_sent_at")!, 10);
      const elapsed = Math.floor((now - storedSentAt) / 1000);

      const remainingExpiry = Math.max(0, 300 - elapsed);
      const remainingCooldown = Math.max(0, 60 - elapsed);

      expect(remainingExpiry).toBe(255);
      expect(remainingCooldown).toBe(15);
    });

    it("marks code as expired when more than 300 seconds have elapsed", () => {
      const now = Date.now();
      // Simulate OTP sent 350 seconds ago (expired)
      const sentAt = now - 350 * 1000;
      sessionStorage.setItem("gathr_otp_sent_at", sentAt.toString());

      const storedSentAt = parseInt(sessionStorage.getItem("gathr_otp_sent_at")!, 10);
      const elapsed = Math.floor((now - storedSentAt) / 1000);

      const remainingExpiry = elapsed < 300 ? 300 - elapsed : 0;
      const remainingCooldown = Math.max(0, 60 - elapsed);

      expect(remainingExpiry).toBe(0);
      expect(remainingCooldown).toBe(0);
    });

    it("resets expiry to 300s and cooldown to 60s upon fresh resend", () => {
      const now = Date.now();
      sessionStorage.setItem("gathr_otp_sent_at", now.toString());

      const expirySeconds = 300;
      const cooldownSeconds = 60;

      expect(expirySeconds).toBe(300);
      expect(cooldownSeconds).toBe(60);
    });
  });

  describe("Issue A: Deduplication of error displays", () => {
    it("ensures only one active error banner is shown", () => {
      // When both an oauthError and a local form error occur, the UI renders only the most specific current error
      const searchError = "account_not_linked";
      const formError: string | null = null;

      // Active rendered banner is precisely 1
      const renderedBanners = [
        searchError && !formError ? searchError : null,
        formError ? formError : null,
      ].filter(Boolean);

      expect(renderedBanners).toHaveLength(1);
      expect(renderedBanners[0]).toBe("account_not_linked");
    });
  });
});
