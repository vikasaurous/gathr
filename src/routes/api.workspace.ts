/**
 * GET /api/workspace — returns the signed-in user's own workspace.
 *
 * Reference pattern for protected API routes:
 *  - identity comes from the Better Auth session (requireSession),
 *  - the workspace is derived server-side from persisted ownership,
 *  - any client-supplied workspace identifier is rejected,
 *  - responses are no-store and expose no internal ids or ownership data,
 *  - errors are mapped to safe JSON (never stack traces or secrets).
 */
import { createFileRoute } from "@tanstack/react-router";
import { toSafeErrorResponse, jsonResponse } from "@/lib/server/env";
import { requireWorkspaceContext, rejectClientWorkspaceId } from "@/lib/server/ownership";
import { getSql } from "@/lib/server/sql";

export async function handleGetWorkspace(request: Request): Promise<Response> {
  try {
    rejectClientWorkspaceId(Object.fromEntries(new URL(request.url).searchParams));
    const { workspace } = await requireWorkspaceContext(getSql(request), request);
    return jsonResponse({ workspace: { name: workspace.name, createdAt: workspace.createdAt } });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "HttpError") {
      console.error("[api/workspace] unexpected error:", error);
    }
    return toSafeErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/workspace")({
  server: {
    handlers: {
      GET: async ({ request }) => handleGetWorkspace(request),
    },
  },
});
