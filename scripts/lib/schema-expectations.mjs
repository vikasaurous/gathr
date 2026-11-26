/**
 * Expected final database shape after all migrations. verifySchema() compares
 * a live (or test) database with it using read-only catalog queries, so schema
 * drift is detected without applying anything (Phase 2 acceptance checks 3 and 8).
 */
const TS = "timestamp with time zone";

export const EXPECTED_SCHEMA = {
  user: { columns: { id: "text" } },
  session: { columns: { id: "text", userId: "text" } },
  account: { columns: { id: "text", userId: "text" } },
  workspaces: {
    columns: { id: "uuid", owner_user_id: "text", name: "text", created_at: TS, updated_at: TS },
    constraints: ["workspaces_pkey", "workspaces_owner_user_id_key"],
    indexes: [],
  },
  batches: {
    columns: {
      id: "uuid",
      workspace_id: "uuid",
      name: "text",
      status: "text",
      idempotency_key: "text",
      request_hash: "text",
      created_at: TS,
      updated_at: TS,
    },
    constraints: [
      "batches_pkey",
      "batches_workspace_id_id_key",
      "ck_batches_status",
      "ck_batches_idempotency_pair",
    ],
    indexes: ["batches_workspace_created_at_idx", "batches_workspace_idempotency_key_idx"],
  },
  documents: {
    columns: {
      id: "uuid",
      workspace_id: "uuid",
      batch_id: "uuid",
      original_filename: "text",
      mime_type: "text",
      file_size_bytes: "bigint",
      storage_key: "text",
      active_attempt_id: "uuid",
      lease_expires_at: TS,
      upload_started_at: TS,
      status: "text",
      review_status: "text",
      page_count: "integer",
      error_message: "text",
      uploaded_at: TS,
      created_at: TS,
      updated_at: TS,
    },
    constraints: [
      "documents_pkey",
      "documents_workspace_batch_fk",
      "documents_file_size_bytes_check",
      "documents_page_count_check",
      "ck_documents_mime",
      "ck_documents_storage_key",
      "ck_documents_status",
      "ck_documents_review_status",
      "ck_documents_review_requires_upload",
      "ck_documents_original_filename",
    ],
    indexes: [
      "documents_batch_created_at_idx",
      "documents_workspace_batch_idx",
      "documents_canonical_storage_key_idx",
      "documents_active_lease_idx",
      "documents_review_queue_idx",
    ],
  },
  storage_cleanup_outbox: {
    columns: {
      id: "uuid",
      storage_key: "text",
      bucket_name: "text",
      workspace_id: "uuid",
      batch_id: "uuid",
      document_id: "uuid",
      reason: "text",
      status: "text",
      attempt_count: "integer",
      max_attempts: "integer",
      last_error: "text",
      worker_id: "text",
      locked_until: TS,
      scheduled_at: TS,
      created_at: TS,
      processed_at: TS,
    },
    constraints: [
      "storage_cleanup_outbox_pkey",
      "ck_storage_cleanup_status",
      "ck_storage_cleanup_reason",
      "ck_storage_cleanup_attempts",
    ],
    indexes: ["idx_storage_cleanup_unique_active", "idx_storage_cleanup_dispatch"],
    // Cleanup obligations must survive deletion of their parents: never add foreign keys.
    forbidForeignKeys: true,
  },
  user_plan: {
    columns: {
      userId: "text",
      plan: "text",
      updatedAt: "timestamp without time zone",
      updatedBy: "text",
    },
    constraints: ["user_plan_pkey", "user_plan_userId_fkey", "user_plan_plan_check"],
    indexes: [],
  },
};

const unquote = (name) => String(name).replace(/^"|"$/g, "");

/**
 * query(text) must resolve to an array of row objects.
 * Returns { ok, problems } — never writes.
 */
export async function verifySchema(query) {
  const problems = [];

  const columns = await query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  const constraints = await query(
    `SELECT conrelid::regclass::text AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
  );
  const indexes = await query(
    `SELECT tablename AS table_name, indexname FROM pg_indexes WHERE schemaname = 'public'`,
  );

  for (const [table, expected] of Object.entries(EXPECTED_SCHEMA)) {
    const tableColumns = columns.filter((c) => c.table_name === table);
    if (tableColumns.length === 0) {
      problems.push(`Missing table: ${table}`);
      continue;
    }
    for (const [column, type] of Object.entries(expected.columns ?? {})) {
      const found = tableColumns.find((c) => c.column_name === column);
      if (!found) problems.push(`Missing column: ${table}.${column}`);
      else if (found.data_type !== type) {
        problems.push(
          `Wrong type for ${table}.${column}: expected ${type}, found ${found.data_type}`,
        );
      }
    }

    const tableConstraints = constraints.filter((c) => unquote(c.table_name) === table);
    for (const name of expected.constraints ?? []) {
      if (!tableConstraints.some((c) => c.conname === name)) {
        problems.push(`Missing constraint: ${table}.${name}`);
      }
    }
    if (expected.forbidForeignKeys) {
      for (const fk of tableConstraints.filter((c) => c.contype === "f")) {
        problems.push(`Forbidden foreign key on ${table}: ${fk.conname}`);
      }
    }

    const tableIndexes = indexes.filter((i) => i.table_name === table);
    for (const name of expected.indexes ?? []) {
      if (!tableIndexes.some((i) => i.indexname === name)) {
        problems.push(`Missing index: ${table}.${name}`);
      }
    }
  }

  const fk = constraints.find((c) => c.conname === "documents_workspace_batch_fk");
  if (
    fk &&
    !/FOREIGN KEY \(workspace_id, batch_id\) REFERENCES batches\(workspace_id, id\)/.test(
      fk.definition,
    )
  ) {
    problems.push(`documents_workspace_batch_fk has an unexpected definition: ${fk.definition}`);
  }

  return { ok: problems.length === 0, problems };
}
