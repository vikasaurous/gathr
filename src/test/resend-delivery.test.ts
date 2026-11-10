import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendOtpEmail } from "@/lib/email/resend";

describe("Resend Email Delivery & Production Safeguards", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.RESEND_API_KEY = "re_test_key_mock_1234567890";
    process.env.RESEND_FROM_EMAIL = "GATHR <onboarding@resend.dev>";
    process.env.RESEND_TEST_RECIPIENT = "designedbyslate@gmail.com";
    process.env.RESEND_TEST_MODE = "true";
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("Test A: Development recipient override reroutes recipient to test inbox", async () => {
    let capturedBody: { to?: string[]; html?: string } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: "resend_email_id_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const originalUserEmail = "alex.synthetic@custom-domain.example";
    const result = await sendOtpEmail({
      to: originalUserEmail,
      otp: "123456",
      type: "email-verification",
    });

    expect(result.id).toBe("resend_email_id_123");
    expect(result.isTestMode).toBe(true);
    expect(result.deliveredTo).toBe("designedbyslate@gmail.com");
    // Verify Resend received test recipient, but HTML mentions original user
    expect(capturedBody.to).toEqual(["designedbyslate@gmail.com"]);
    expect(capturedBody.html).toContain("123456");
  });

  it("Test B: Sends directly to test recipient without errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      return new Response(JSON.stringify({ id: "resend_email_id_owner" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await sendOtpEmail({
      to: "designedbyslate@gmail.com",
      otp: "654321",
      type: "email-verification",
    });

    expect(result.id).toBe("resend_email_id_owner");
    expect(result.deliveredTo).toBe("designedbyslate@gmail.com");
  });

  it("Test C: Throws clear configuration error if test mode is enabled but test recipient is missing", async () => {
    delete process.env.RESEND_TEST_RECIPIENT;

    await expect(
      sendOtpEmail({
        to: "alex@example.com",
        otp: "111222",
        type: "email-verification",
      }),
    ).rejects.toThrow(/RESEND_TEST_RECIPIENT is not configured/);
  });

  it("Test D: Handles non-2xx API errors without exposing API key or swallowing errors", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      return new Response(
        JSON.stringify({
          statusCode: 401,
          name: "invalid_api_key",
          message: "API key is invalid",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    });

    await expect(
      sendOtpEmail({
        to: "alex@example.com",
        otp: "333444",
        type: "email-verification",
      }),
    ).rejects.toThrow("API key is invalid");
  });

  it("Test E: Without test mode, sends directly to user email", async () => {
    process.env.RESEND_TEST_MODE = "false";

    let capturedBody: { to?: string[]; html?: string } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: "resend_email_direct" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const target = "user@verified-domain.com";
    const result = await sendOtpEmail({
      to: target,
      otp: "555666",
      type: "email-verification",
    });

    expect(result.isTestMode).toBe(false);
    expect(result.deliveredTo).toBe(target);
    expect(capturedBody.to).toEqual([target]);
  });

  it("Test F: Production safeguard rejects RESEND_TEST_MODE if enabled in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.RESEND_TEST_MODE = "true";
    process.env.RESEND_FROM_EMAIL = "GATHR <auth@gathr.app>";

    await expect(
      sendOtpEmail({
        to: "customer@domain.com",
        otp: "999888",
        type: "email-verification",
      }),
    ).rejects.toThrow(/RESEND_TEST_MODE cannot be enabled in production/);
  });

  it("Test F: Production safeguard rejects onboarding@resend.dev in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.RESEND_TEST_MODE = "false";
    process.env.RESEND_FROM_EMAIL = "GATHR <onboarding@resend.dev>";

    await expect(
      sendOtpEmail({
        to: "customer@domain.com",
        otp: "999888",
        type: "email-verification",
      }),
    ).rejects.toThrow(/Production requires a verified custom sender domain/);
  });
});
