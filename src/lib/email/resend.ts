/**
 * Resend email delivery integration for GATHR.
 *
 * Uses native fetch (Cloudflare Workers compatible) and official Resend REST API:
 * POST https://api.resend.com/emails
 *
 * Credentials remain server-side only. Never import this from client components.
 */

interface SendOtpParams {
  to: string;
  otp: string;
  type: "email-verification" | "sign-in" | "forget-password" | string;
}

export interface SendOtpResult {
  id: string;
  deliveredTo: string;
  isTestMode: boolean;
}

function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return email;
  const [user, domain] = email.split("@");
  if (!user || user.length <= 2) {
    return `${user[0] ?? "*"}***@${domain}`;
  }
  return `${user.slice(0, 2)}***${user.slice(-1)}@${domain}`;
}

export async function sendOtpEmail({ to, otp, type }: SendOtpParams): Promise<SendOtpResult> {
  const isProduction = process.env.NODE_ENV === "production";
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured in server environment.");
  }

  const rawFrom = process.env.RESEND_FROM_EMAIL?.trim() || "GATHR <onboarding@resend.dev>";
  const isTestMode = process.env.RESEND_TEST_MODE === "true";
  const testRecipient = process.env.RESEND_TEST_RECIPIENT?.trim();

  // Production safeguards
  if (isProduction) {
    if (isTestMode) {
      throw new Error("CRITICAL: RESEND_TEST_MODE cannot be enabled in production environments.");
    }
    if (rawFrom.includes("onboarding@resend.dev")) {
      throw new Error(
        "CRITICAL: Production requires a verified custom sender domain (cannot use onboarding@resend.dev).",
      );
    }
  }

  // Recipient resolution: in development test mode, redirect actual delivery to test recipient
  let targetRecipient = to.trim();
  const activeTestMode = !isProduction && isTestMode;

  if (activeTestMode) {
    if (!testRecipient) {
      throw new Error(
        "RESEND_TEST_MODE is enabled, but RESEND_TEST_RECIPIENT is not configured in server environment.",
      );
    }
    targetRecipient = testRecipient;
    console.log(
      `[resend] Development test mode active: rerouting email from ${maskEmail(to)} to test recipient ${maskEmail(testRecipient)}`,
    );
  }

  let subject = "Your GATHR verification code";
  let title = "Verify your email";
  let description =
    "Enter the six-digit code below to verify your email address and activate your GATHR account:";

  if (type === "sign-in") {
    subject = "Your GATHR sign-in code";
    title = "Sign in to GATHR";
    description = "Use this six-digit code to complete your sign-in:";
  } else if (type === "forget-password") {
    subject = "Reset your GATHR password";
    title = "Reset password";
    description = "Use this six-digit code to reset your GATHR account password:";
  }

  const devModeHtmlBanner = activeTestMode
    ? `<tr>
        <td style="padding-bottom: 20px;">
          <div style="background-color: #F6F5F0; border: 1px dashed #425B51; border-radius: 6px; padding: 10px 14px; font-size: 12px; color: #425B51;">
            <strong>Development notice:</strong> Verification code generated for <code>${maskEmail(to)}</code>. Delivered to test recipient inbox.
          </div>
        </td>
      </tr>`
    : "";

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F6F5F0; margin: 0; padding: 40px 20px; color: #20211F;">
  <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 480px; background-color: #FFFFFF; border: 1px solid #E4E3DD; border-radius: 8px; overflow: hidden; padding: 36px 32px;">
    <tr>
      <td style="padding-bottom: 24px;">
        <span style="font-family: Georgia, serif; font-size: 26px; font-weight: normal; letter-spacing: -0.02em; color: #20211F;">gathr</span>
      </td>
    </tr>
    ${devModeHtmlBanner}
    <tr>
      <td style="padding-bottom: 12px;">
        <h1 style="font-size: 22px; font-weight: 600; margin: 0; color: #20211F; letter-spacing: -0.01em;">${title}</h1>
      </td>
    </tr>
    <tr>
      <td style="padding-bottom: 24px; font-size: 14px; line-height: 1.5; color: #777870;">
        ${description}
      </td>
    </tr>
    <tr>
      <td style="padding-bottom: 24px;">
        <div style="background-color: #F6F5F0; border: 1px solid #E4E3DD; border-radius: 6px; padding: 18px 24px; text-align: center;">
          <span style="font-family: 'Courier New', Courier, monospace; font-size: 34px; font-weight: 700; letter-spacing: 10px; color: #425B51;">${otp}</span>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding-bottom: 24px; font-size: 13px; line-height: 1.5; color: #777870;">
        This code expires in <strong>5 minutes</strong>. If you did not request this email, no further action is needed.
      </td>
    </tr>
    <tr>
      <td style="border-top: 1px solid #E4E3DD; padding-top: 20px; font-size: 12px; color: #9A9B93;">
        &copy; ${new Date().getFullYear()} GATHR. Intelligent invoice intake and workspace.
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  const devModeTextBanner = activeTestMode
    ? `[Development notice: Verification code generated for ${maskEmail(to)}. Delivered to test recipient inbox.]\n\n`
    : "";

  const text = `${devModeTextBanner}${title}\n\n${description}\n\n${otp}\n\nThis code expires in 5 minutes. If you did not request this, please ignore this email.`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: rawFrom,
      to: [targetRecipient],
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as {
      message?: string;
      statusCode?: number;
      name?: string;
    };
    console.error(
      `[resend] API request rejected with HTTP ${response.status}:`,
      errorBody.name ?? "UnknownError",
      errorBody.message ?? "",
    );
    throw new Error(
      errorBody.message || `Resend email delivery failed with status ${response.status}`,
    );
  }

  const result = (await response.json()) as { id: string };
  console.log(
    `[resend] Email accepted by Resend API (id: ${result.id}) for recipient: ${maskEmail(targetRecipient)}`,
  );

  return {
    id: result.id,
    deliveredTo: targetRecipient,
    isTestMode: activeTestMode,
  };
}
