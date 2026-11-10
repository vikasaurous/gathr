import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SignOutDialog } from "@/components/gathr/sign-out-dialog";

// Mock auth client
const mockSignOut = vi.fn();
vi.mock("@/lib/auth/client", () => ({
  signOut: (...args: unknown[]) => mockSignOut(...args),
  authClient: {
    signOut: (...args: unknown[]) => mockSignOut(...args),
  },
}));

// Mock router
const mockNavigate = vi.fn();
const mockInvalidate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: mockNavigate,
    invalidate: mockInvalidate,
  }),
}));

// Mock queryClient
const mockQueryClientClear = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    clear: mockQueryClientClear,
  }),
}));

describe("SignOutDialog Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders trigger and opens dialog upon clicking", () => {
    render(<SignOutDialog trigger={<button type="button">Sign out trigger</button>} />);

    // Dialog is initially closed
    expect(screen.queryByText(/Leaving so/i)).not.toBeInTheDocument();

    // Click trigger
    fireEvent.click(screen.getByRole("button", { name: "Sign out trigger" }));

    // Dialog opens with correct typography and content
    expect(screen.getByText(/Leaving so/i)).toBeInTheDocument();
    expect(
      screen.getByText("Are you sure you want to sign out of your GATHR workspace?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Your documents and workspace data will remain safely stored."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stay signed in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("closes dialog when 'Stay signed in' is clicked without calling signOut", async () => {
    mockSignOut.mockResolvedValue({ data: { success: true }, error: null });

    render(<SignOutDialog trigger={<button type="button">Open Modal</button>} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Modal" }));
    expect(screen.getByText(/Leaving so/i)).toBeInTheDocument();

    // Click cancel
    fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));

    // Dialog closes, signOut was not called
    await waitFor(() => {
      expect(screen.queryByText(/Leaving so/i)).not.toBeInTheDocument();
    });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("confirms sign-out, clears query cache, invalidates router, and navigates to /login", async () => {
    mockSignOut.mockResolvedValue({ data: { success: true }, error: null });

    render(<SignOutDialog trigger={<button type="button">Open Modal</button>} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Modal" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
      expect(mockQueryClientClear).toHaveBeenCalledTimes(1);
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith({ to: "/login" });
    });
  });

  it("displays actionable error message inside dialog if signOut fails", async () => {
    mockSignOut.mockResolvedValue({
      data: null,
      error: {
        message: "Network error. Please try again.",
        status: 500,
        statusText: "Internal Error",
      },
    });

    render(<SignOutDialog trigger={<button type="button">Open Modal</button>} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Modal" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Network error. Please try again.");
    });

    // User is NOT navigated away; modal remains open allowing retry
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign out" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Stay signed in" })).not.toBeDisabled();
  });
});
