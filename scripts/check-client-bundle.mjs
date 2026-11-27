#!/usr/bin/env node
/**
 * Phase 1 acceptance check 6: server-only authentication and data modules must
 * not appear in browser bundles.
 *
 * Usage: npm run build && npm run check:bundle
 *
 * Scans the built client assets for identifiers that only exist in server-only
 * code or for secret environment variable names used by the app itself.
 * (Better Auth's own client library mentions BETTER_AUTH_SECRET as a property
 * name in a shared env helper; that is not a leak, so it is not checked.)
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const CLIENT_DIR = process.argv[2] ?? ".output/public";
const FORBIDDEN = [
  "requireSession",
  "resolveSession",
  "getOrCreateWorkspace",
  "requireWorkspaceContext",
  "requireOwnedBatch",
  "requireOwnedDocument",
  "assertSameOrigin",
  "createBatchInWorkspace",
  "listWorkspaceBatches",
  "getWorkspaceBatchDetail",
  "finalizeBatchInWorkspace",
  "deleteBatchInWorkspace",
  "getB2StorageClient",
  "createB2StorageClient",
  "claimDocumentUploadAttempt",
  "heartbeatDocumentUploadAttempt",
  "commitDocumentUploadAttempt",
  "failDocumentUploadAttempt",
  "cancelDocumentUploadAttempt",
  "uploadDocumentStream",
  "streamOwnedDocumentContent",
  "getWorkspaceDocumentDetail",
  "deleteDocumentInWorkspace",
  "preparePdfDownloadStream",
  "listWorkspaceDocuments",
  "transitionDocumentReviewStatus",
  "ReviewStateConflictError",
  "reconcileStaleUploadAttempts",
  "processCleanupOutbox",
  "claimCleanupOutboxJobs",
  "recordOrphanStorageKey",
  "runScheduledMaintenance",
  "logLifecycleEvent",
  "@neondatabase",
  "neonConfig",
  "kysely",
  "DATABASE_URL",
  "RESEND_API_KEY",
  "GOOGLE_CLIENT_SECRET",
  "ADMIN_EMAILS",
  "B2_S3_ENDPOINT",
  "B2_S3_REGION",
  "B2_BUCKET_NAME",
  "B2_APPLICATION_KEY_ID",
  "B2_APPLICATION_KEY",
  "auth.api.",
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(js|mjs|css|html|map)$/.test(name)) yield full;
  }
}

if (!existsSync(CLIENT_DIR)) {
  console.error(`Client build output not found at ${CLIENT_DIR}. Run "npm run build" first.`);
  process.exit(2);
}

const findings = [];
let scanned = 0;
for (const file of walk(CLIENT_DIR)) {
  scanned += 1;
  const text = readFileSync(file, "utf8");
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) findings.push(`${file}: contains "${needle}"`);
  }
}

if (findings.length > 0) {
  console.error("Server-only identifiers found in the client bundle:\n" + findings.join("\n"));
  process.exit(1);
}
console.log(`OK: scanned ${scanned} client files; no server-only identifiers found.`);
