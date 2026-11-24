import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
  isRedirect,
  rootRouteId,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getSessionFn: vi.fn(),
  useSession: vi.fn(() => {
    throw new Error("useSession must not be called in AppLayout or Overview");
  }),
  signInEmail: vi.fn(),
  signInSocial: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/auth/functions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/functions")>();
  return {
    ...actual,
    getSessionFn: (...args: unknown[]) => authMocks.getSessionFn(...args),
  };
});

vi.mock("@/lib/plan/functions", () => ({
  getMyPlanFn: vi.fn(async () => ({ plan: "free" })),
}));

vi.mock("@/lib/auth/client", () => ({
  useSession: (...args: unknown[]) => authMocks.useSession(...args),
  signIn: {
    email: (...args: unknown[]) => authMocks.signInEmail(...args),
    social: (...args: unknown[]) => authMocks.signInSocial(...args),
  },
  signUp: { email: vi.fn() },
  signOut: (...args: unknown[]) => authMocks.signOut(...args),
  authClient: {
    // Returns unauthenticated by default; auth-page components (login, register) may call this.
    useSession: vi.fn(() => ({ data: null, isPending: false })),
    signIn: {
      email: (...args: unknown[]) => authMocks.signInEmail(...args),
      social: (...args: unknown[]) => authMocks.signInSocial(...args),
    },
    signOut: (...args: unknown[]) => authMocks.signOut(...args),
    listAccounts: vi.fn().mockResolvedValue({ data: [] }),
    // One Tap stubs — resolve immediately (no prompt shown in jsdom)
    oneTap: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue({ data: null }),
  },
}));

import { toClientSession, type ClientSession } from "@/lib/auth/functions";
import type { Session } from "@/lib/auth/server";
import { routeTree } from "@/routeTree.gen";
import { Route as AppRoute } from "@/routes/app";
import { Route as LoginRoute } from "@/routes/login";
import { Route as RegisterRoute } from "@/routes/register";
import { isClientAbortError } from "@/start";

function makeClientSession(overrides?: Partial<ClientSession["user"]>): ClientSession {
  return {
    user: {
      id: "usr_123",
      name: "Alex Mehta",
      email: "alex@gathr.example",
      emailVerified: true,
      image: null,
      ...overrides,
    },
    session: {
      id: "ses_123",
      userId: "usr_123",
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    },
  };
}

function createTestRouter(initialUrl: string) {
  const queryClient = new QueryClient();
  return {
    queryClient,
    router: createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [initialUrl] }),
      context: { queryClient, session: undefined },
      defaultPreloadStaleTime: 0,
    }),
  };
}

describe("App routing, route protection, and session deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("matches a page for / instead of falling back to not found", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes("/");

    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
  });

  it("sanitizes server sessions so tokens and connection metadata are never exposed to client context", () => {
    const serverSession = {
      user: {
        id: "usr_1",
        name: "Alex Mehta",
        email: "alex@gathr.example",
        emailVerified: true,
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      session: {
        id: "ses_1",
        userId: "usr_1",
        token: "secret-session-token-must-not-leak",
        expiresAt: new Date("2026-12-01T00:00:00Z"),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "Mozilla/5.0",
      },
    } as Session;

    const sanitized = toClientSession(serverSession);
    expect(sanitized).toEqual({
      user: {
        id: "usr_1",
        name: "Alex Mehta",
        email: "alex@gathr.example",
        emailVerified: true,
        image: null,
      },
      session: {
        id: "ses_1",
        userId: "usr_1",
        expiresAt: new Date("2026-12-01T00:00:00Z"),
      },
    });
    expect(JSON.stringify(sanitized)).not.toContain("secret-session-token-must-not-leak");
    expect(JSON.stringify(sanitized)).not.toContain("127.0.0.1");
    expect(toClientSession(null)).toBeNull();
  });

  it("protects /app via server-side beforeLoad and redirects unauthenticated visitors to /login", async () => {
    authMocks.getSessionFn.mockResolvedValue(null);

    let thrown: unknown;
    try {
      await AppRoute.options.beforeLoad?.({} as never);
    } catch (err) {
      thrown = err;
    }

    expect(authMocks.getSessionFn).toHaveBeenCalledTimes(1);
    expect(isRedirect(thrown)).toBe(true);
    if (isRedirect(thrown)) {
      expect(thrown.options.to).toBe("/login");
    }
  });

  it("redirects authenticated users away from /login and /register to /app", async () => {
    authMocks.getSessionFn.mockResolvedValue(makeClientSession());

    for (const route of [LoginRoute, RegisterRoute]) {
      let thrown: unknown;
      try {
        await route.options.beforeLoad?.({} as never);
      } catch (err) {
        thrown = err;
      }
      expect(isRedirect(thrown)).toBe(true);
      if (isRedirect(thrown)) {
        expect(thrown.options.to).toBe("/app");
      }
    }

    expect(authMocks.getSessionFn).toHaveBeenCalledTimes(2);
  });

  it("renders /app from route context without calling useSession() and runs one getSessionFn per navigation", async () => {
    const session = makeClientSession();
    authMocks.getSessionFn.mockResolvedValue(session);

    const { queryClient, router } = createTestRouter("/app");
    await router.load();

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Alex Mehta")).toBeInTheDocument();
    expect(screen.getByText(/Good morning,/i)).toHaveTextContent("Good morning, Alex.");
    expect(authMocks.getSessionFn).toHaveBeenCalledTimes(1);
    expect(authMocks.useSession).not.toHaveBeenCalled();

    // Navigating across workspace sub-routes runs server-side guard once per transition, with 0 useSession calls
    await act(async () => {
      await router.navigate({ to: "/app/batches" });
    });
    expect(await screen.findByText(/Every upload, with its source files/i)).toBeInTheDocument();
    expect(authMocks.getSessionFn).toHaveBeenCalledTimes(2);
    expect(authMocks.useSession).not.toHaveBeenCalled();

    await act(async () => {
      await router.navigate({ to: "/app/invoices" });
    });
    expect(await screen.findByText(/Every invoice gathered/i)).toBeInTheDocument();
    expect(authMocks.getSessionFn).toHaveBeenCalledTimes(3);
    expect(authMocks.useSession).not.toHaveBeenCalled();

    await act(async () => {
      await router.navigate({ to: "/app/settings" });
    });
    expect(await screen.findByText(/Connected accounts/i)).toBeInTheDocument();
    expect(authMocks.getSessionFn).toHaveBeenCalledTimes(4);
    expect(authMocks.useSession).not.toHaveBeenCalled();
  });

  it("navigates directly to /app after login without redundant router.invalidate() session lookups", async () => {
    const session = makeClientSession();
    // 1st call: /login beforeLoad (signed out); 2nd call: /app beforeLoad (signed in)
    authMocks.getSessionFn.mockResolvedValueOnce(null).mockResolvedValueOnce(session);
    authMocks.signInEmail.mockResolvedValue({ data: { user: session.user }, error: null });

    const { queryClient, router } = createTestRouter("/login");
    const invalidateSpy = vi.spyOn(router, "invalidate");
    await router.load();

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(authMocks.getSessionFn).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText(/Email address/i), {
      target: { value: "alex@gathr.example" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "ValidPassword123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByText("Alex Mehta")).toBeInTheDocument();
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(authMocks.getSessionFn).toHaveBeenCalledTimes(2);
    expect(authMocks.useSession).not.toHaveBeenCalled();
  });

  it("distinguishes client request cancellation aborts from genuine server/database errors", () => {
    const abortedController = new AbortController();
    const abortReason = new DOMException("This operation was aborted", "AbortError");
    abortedController.abort(abortReason);

    expect(isClientAbortError(abortReason, abortedController.signal)).toBe(true);
    expect(
      isClientAbortError(
        Object.assign(new Error("aborted"), { code: "ECONNRESET" }),
        abortedController.signal,
      ),
    ).toBe(true);

    // Real DB/server errors must NOT be classified as client aborts even if signal later aborts
    const activeController = new AbortController();
    expect(isClientAbortError(new Error("connection failed"), activeController.signal)).toBe(false);
    expect(
      isClientAbortError(new Error("NeonDbError: relation missing"), abortedController.signal),
    ).toBe(false);
  });
});
