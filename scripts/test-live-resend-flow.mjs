import * as fs from "node:fs";

// Load .env.local
const envContent = fs.readFileSync(".env.local", "utf8");
for (const line of envContent.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith("#")) {
    const eq = trimmed.indexOf("=");
    if (eq !== -1) {
      process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
    }
  }
}

// Import sendOtpEmail
const { sendOtpEmail } = await import("../src/lib/email/resend.ts");

console.log("--- Testing live Resend delivery with development test mode ---");
console.log("NODE_ENV:", process.env.NODE_ENV || "development");
console.log("RESEND_TEST_MODE:", process.env.RESEND_TEST_MODE);

const syntheticEmail = "synthetic-dev-user-777@custom-client.example";
const testOtp = "729401";

try {
  const result = await sendOtpEmail({
    to: syntheticEmail,
    otp: testOtp,
    type: "email-verification",
  });

  console.log("\nLive send result:");
  console.log("Resend Email ID:", result.id);
  console.log("Is Test Mode:", result.isTestMode);
  console.log(
    "Delivered To:",
    result.deliveredTo.slice(0, 2) + "***@" + result.deliveredTo.split("@")[1],
  );

  if (result.id && result.isTestMode && result.deliveredTo === process.env.RESEND_TEST_RECIPIENT) {
    console.log("\nSUCCESS: Resend accepted email and routed to test recipient!");
  } else {
    console.error("\nFAILURE: Unexpected delivery result:", result);
    process.exit(1);
  }
} catch (err) {
  console.error("Live test failed with error:", err.message);
  process.exit(1);
}
