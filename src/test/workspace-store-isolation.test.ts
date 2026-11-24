import { beforeEach, describe, expect, it } from "vitest";
import { actions, getWorkspaceState } from "@/lib/gathr/store";

const DEFAULT_NAME = "Mehta & Co. Accounting";

describe("workspace store isolation between accounts", () => {
  beforeEach(() => actions.release());

  it("keeps the same user's state across navigations", () => {
    actions.bindUser("user-1");
    actions.setWorkspaceName("Asha Books");
    actions.bindUser("user-1");
    expect(getWorkspaceState().workspaceName).toBe("Asha Books");
  });

  it("discards the previous user's state when a different user is bound", () => {
    actions.bindUser("user-1");
    actions.setWorkspaceName("Asha Books");
    actions.bindUser("user-2");
    expect(getWorkspaceState().workspaceName).toBe(DEFAULT_NAME);
  });

  it("clears everything on release (sign-out)", () => {
    actions.bindUser("user-1");
    actions.setWorkspaceName("Asha Books");
    actions.release();
    expect(getWorkspaceState().workspaceName).toBe(DEFAULT_NAME);
    actions.bindUser("user-2");
    expect(getWorkspaceState().workspaceName).toBe(DEFAULT_NAME);
  });
});
