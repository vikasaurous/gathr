import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlanBadge } from "@/components/gathr/plan-badge";

describe("PlanBadge", () => {
  it.each([
    ["free", "Free"],
    ["pro", "Pro"],
    ["business", "Business"],
  ] as const)("renders the %s plan label", (plan, label) => {
    render(<PlanBadge plan={plan} />);
    expect(screen.getByText(label)).toBeTruthy();
  });
});
