import { describe, it, expect } from "vitest";
import { getAuthErrorMessage } from "@/lib/auth/errors";

describe("Centralized Authentication Error Mapping", () => {
  it("translates account_not_linked with verification link", () => {
    const err = getAuthErrorMessage("account_not_linked");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("account_not_linked");
    expect(err?.showVerifyLink).toBe(true);
    expect(err?.message).toContain("An account with this email already exists");
    expect(err?.message).toContain("connect Google from your account settings");
  });

  it("translates email_not_verified safely without leaking details", () => {
    const err = getAuthErrorMessage("email_not_verified");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("email_not_verified");
    expect(err?.message).toContain("Google could not verify your email address");
  });

  it("translates unable_to_link_account", () => {
    const err = getAuthErrorMessage("unable_to_link_account");
    expect(err?.code).toBe("unable_to_link_account");
    expect(err?.message).toContain("Could not link your Google account");
  });

  it("translates account_already_linked_to_different_user", () => {
    const err = getAuthErrorMessage("account_already_linked_to_different_user");
    expect(err?.code).toBe("account_already_linked_to_different_user");
    expect(err?.message).toContain("already connected to a different workspace");
  });

  it("handles access_denied calmly when user cancels consent", () => {
    const err = getAuthErrorMessage("access_denied");
    expect(err?.code).toBe("access_denied");
    expect(err?.message).toContain("cancelled");
  });

  it("handles email_doesn't_match and email_does_not_match identically", () => {
    const err1 = getAuthErrorMessage("email_doesn't_match");
    const err2 = getAuthErrorMessage("email_does_not_match");
    expect(err1?.code).toBe("email_does_not_match");
    expect(err2?.code).toBe("email_does_not_match");
    expect(err1?.message).toBe(err2?.message);
  });

  it("translates OTP error codes (invalid_otp, expired_otp, too_many_attempts)", () => {
    expect(getAuthErrorMessage("INVALID_OTP")?.code).toBe("invalid_otp");
    expect(getAuthErrorMessage("OTP_EXPIRED")?.code).toBe("expired_otp");
    expect(getAuthErrorMessage("TOO_MANY_ATTEMPTS")?.code).toBe("too_many_attempts");
  });

  it("translates credential errors into secure generic message", () => {
    const err = getAuthErrorMessage("INVALID_EMAIL_OR_PASSWORD");
    expect(err?.code).toBe("invalid_credentials");
    expect(err?.message).toBe(
      "Invalid email or password. Please check your credentials and try again.",
    );
  });

  it("translates network errors", () => {
    const err = getAuthErrorMessage("network_error");
    expect(err?.code).toBe("network_error");
    expect(err?.message).toContain("Unable to reach the authentication service");
  });

  it("translates delivery failure", () => {
    const err = getAuthErrorMessage("delivery_failure");
    expect(err?.code).toBe("delivery_failure");
    expect(err?.message).toContain("Could not deliver the verification email");
  });

  it("masks unknown exception strings into safe generic error without leaking stack trace", () => {
    const rawSqlError =
      "error: select * from \"user\" where email = 'test' failed with code 500 at pg.ts:12";
    const err = getAuthErrorMessage(rawSqlError);
    expect(err?.code).toBe("unknown_error");
    expect(err?.message).toBe("An unexpected authentication error occurred. Please try again.");
    expect(err?.message).not.toContain("select");
    expect(err?.message).not.toContain("pg.ts");
  });

  it("returns null for empty or null error inputs", () => {
    expect(getAuthErrorMessage(null)).toBeNull();
    expect(getAuthErrorMessage(undefined)).toBeNull();
    expect(getAuthErrorMessage("")).toBeNull();
    expect(getAuthErrorMessage("   ")).toBeNull();
  });
});
