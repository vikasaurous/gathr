import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({ session: undefined as unknown }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    activeProps: _activeProps,
    ...rest
  }: {
    to: string;
    children: React.ReactNode;
    activeProps?: unknown;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useRouteContext: () => ({ session: ctx.session }),
}));

import { SiteHeader } from "@/components/gathr/site-chrome";

describe("SiteHeader", () => {
  beforeEach(() => {
    ctx.session = undefined;
  });

  it("shows Sign in and Get started to signed-out visitors", () => {
    render(<SiteHeader />);
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.getByRole("link", { name: "Get started" }).getAttribute("href")).toBe(
      "/register",
    );
    expect(screen.queryByRole("link", { name: "Open workspace" })).toBeNull();
  });

  it("shows Open workspace instead of Sign in / Get started when signed in", () => {
    ctx.session = { user: { id: "u1", name: "A", email: "a@x.com", emailVerified: true } };
    render(<SiteHeader />);
    expect(screen.getByRole("link", { name: "Open workspace" }).getAttribute("href")).toBe("/app");
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Get started" })).toBeNull();
  });
});
