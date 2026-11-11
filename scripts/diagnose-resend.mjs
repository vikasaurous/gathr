import * as fs from "node:fs";

// Load .env.local safely
const envContent = fs.readFileSync(".env.local", "utf8");
const env = {};
for (const line of envContent.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith("#")) {
    const eq = trimmed.indexOf("=");
    if (eq !== -1) {
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, "");
    }
  }
}

const apiKey = env.RESEND_API_KEY;
const from = env.RESEND_FROM_EMAIL || "GATHR <onboarding@resend.dev>";
const testRecipient = env.RESEND_TEST_RECIPIENT;

console.log("Resend API Key configured:", Boolean(apiKey));
console.log("Resend From:", from);
console.log("Resend Test Recipient configured:", Boolean(testRecipient));

function mask(e) {
  if (!e || !e.includes("@")) return e;
  const [u, d] = e.split("@");
  return u.slice(0, 2) + "***@" + d;
}

console.log("Resend Test Recipient masked:", mask(testRecipient));

async function probeRecipient(recipient) {
  console.log(`\nProbing delivery to: ${mask(recipient)}...`);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: "[GATHR Diagnostic] Delivery Probe",
        text: "This is an automated diagnostic probe to verify Resend delivery restrictions.",
      }),
    });

    const status = res.status;
    const body = await res.json().catch(() => ({}));
    console.log(`Status: ${status}`);
    console.log(`Response JSON:`, JSON.stringify(body, null, 2));
    return { status, body };
  } catch (err) {
    console.error("Fetch threw error:", err.message);
    return { error: err.message };
  }
}

async function main() {
  // Test 1: Arbitrary unverified email
  console.log("--- TEST 1: Sending to arbitrary external email ---");
  await probeRecipient("synthetic-audit-user-456@example.com");

  // Test 2: Configured test recipient (account owner)
  if (testRecipient) {
    console.log("\n--- TEST 2: Sending to configured test recipient ---");
    await probeRecipient(testRecipient);
  }
}

main();
