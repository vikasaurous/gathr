import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { PlanCard } from "@/components/gathr/plan-card";
import { SidebarPlanLink } from "@/components/gathr/plan-badge";

describe("SidebarPlanLink", () => {
  it("offers an upgrade to the pricing page on the Free plan", () => {
    render(<SidebarPlanLink plan="free" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/pricing");
    expect(link.textContent).toContain("Upgrade");
    expect(link.textContent).toContain("Free");
  });

  it("links to settings with 'Manage' on the top plan", () => {
    render(<SidebarPlanLink plan="business" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/app/settings");
    expect(link.textContent).toContain("Manage");
  });
});

describe("PlanCard", () => {
  it("shows plan details and an upgrade to Pro on Free", () => {
    render(<PlanCard plan="free" />);
    expect(screen.getByText("Current plan")).toBeTruthy();
    expect(screen.getByText("50 invoices / month")).toBeTruthy();
    const upgrade = screen.getByRole("link", { name: /Upgrade to Pro/ });
    expect(upgrade.getAttribute("href")).toBe("/pricing");
  });

  it("offers Business as the upgrade from Pro", () => {
    render(<PlanCard plan="pro" />);
    expect(screen.getByRole("link", { name: /Upgrade to Business/ })).toBeTruthy();
  });

  it("has no upgrade button on the highest plan", () => {
    render(<PlanCard plan="business" />);
    expect(screen.queryByRole("link", { name: /Upgrade/ })).toBeNull();
    expect(screen.getByText(/highest plan/)).toBeTruthy();
  });
});
