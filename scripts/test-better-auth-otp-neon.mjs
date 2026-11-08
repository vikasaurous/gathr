import * as fs from "node:fs";
import { Pool } from "@neondatabase/serverless";

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

// Import Better Auth server instance
const { auth } = await import("../src/lib/auth/server.ts");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  console.log("Starting Better Auth OTP + Neon + Resend end-to-end test...");
  const client = await pool.connect();

  const syntheticEmail = "synthetic-e2e-otp-tester@example.synthetic";
  const syntheticId = "test_user_synthetic_e2e_otp";
  const expectedIdentifier = `email-verification-otp-${syntheticEmail}`;

  try {
    // Clean up any stale records
    await client.query(`DELETE FROM "verification" WHERE "identifier" = $1`, [expectedIdentifier]);
    await client.query(`DELETE FROM "account" WHERE "userId" = $1`, [syntheticId]);
    await client.query(`DELETE FROM "user" WHERE "id" = $1 OR "email" = $2`, [
      syntheticId,
      syntheticEmail,
    ]);

    // Insert user with emailVerified = false
    await client.query(
      `
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, false, now(), now())
    `,
      [syntheticId, "Synthetic E2E Tester", syntheticEmail],
    );

    console.log("1. Created unverified user in Neon:", syntheticEmail);

    // Call Better Auth to generate and send verification OTP
    console.log("2. Requesting Better Auth to send verification OTP...");
    const sendRes = await auth.api.sendVerificationOTP({
      body: {
        email: syntheticEmail,
        type: "email-verification",
      },
    });

    console.log("Send verification OTP response:", sendRes);

    // Inspect verification record in Neon database
    const verifRecord = (
      await client.query(
        `
      SELECT * FROM "verification" WHERE "identifier" = $1
    `,
        [expectedIdentifier],
      )
    ).rows[0];

    if (!verifRecord) {
      throw new Error("Verification record was not created in Neon for " + expectedIdentifier);
    }

    const otpCode = verifRecord.value.split(":")[0];
    console.log("3. Verification record found in Neon database:");
    console.log("   Identifier:", verifRecord.identifier);
    console.log("   Expires At:", verifRecord.expiresAt);
    console.log("   Extracted 6-digit OTP code:", otpCode);

    // Confirm user is still unverified before verification
    const beforeUser = (
      await client.query(
        `
      SELECT "emailVerified" FROM "user" WHERE "id" = $1
    `,
        [syntheticId],
      )
    ).rows[0];
    if (beforeUser.emailVerified !== false) {
      throw new Error("User emailVerified should be false before submitting code!");
    }
    console.log("4. User emailVerified is false before verification: PASS");

    // Submit verification using the stored OTP
    console.log("5. Submitting OTP to Better Auth verifyEmail API...");
    const verifyRes = await auth.api.verifyEmailOTP({
      body: {
        email: syntheticEmail,
        otp: otpCode,
      },
    });

    console.log("Verify email OTP response:", verifyRes);

    // Inspect user table in Neon to confirm emailVerified is now true
    const afterUser = (
      await client.query(
        `
      SELECT "emailVerified" FROM "user" WHERE "id" = $1
    `,
        [syntheticId],
      )
    ).rows[0];

    if (afterUser.emailVerified !== true) {
      throw new Error("User emailVerified was NOT updated to true in Neon!");
    }
    console.log("6. Neon user.emailVerified updated to true: PASS!");

    // Clean up synthetic records
    await client.query(`DELETE FROM "verification" WHERE "identifier" = $1`, [expectedIdentifier]);
    await client.query(`DELETE FROM "user" WHERE "id" = $1`, [syntheticId]);
    console.log("7. Cleaned up synthetic test records: PASS!");

    console.log("\nALL END-TO-END BETTER AUTH + NEON + RESEND TESTS PASSED!");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("End-to-end test failed:", err);
  process.exit(1);
});
