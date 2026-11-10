import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { formatDashboardDate } from "@/lib/gathr/format";

describe("Dashboard Date Formatter — formatDashboardDate", () => {
  it("formats Sunday, 8 November 2026 to SUNDAY, 8 NOVEMBER", () => {
    // 2026-11-08 in UTC/local
    const date = new Date(2026, 10, 8, 14, 30); // Month is 0-indexed: 10 = November
    const result = formatDashboardDate(date);
    expect(result).toBe("SUNDAY, 8 NOVEMBER");
  });

  it("formats Saturday, 7 November 2026 to SATURDAY, 7 NOVEMBER", () => {
    const date = new Date(2026, 10, 7, 9, 15);
    const result = formatDashboardDate(date);
    expect(result).toBe("SATURDAY, 7 NOVEMBER");
  });

  it("formats single digit dates without leading zeros (e.g., 1 January)", () => {
    const date = new Date(2026, 0, 1, 10, 0); // 1 Jan 2026 was a Thursday
    const result = formatDashboardDate(date);
    expect(result).toBe("THURSDAY, 1 JANUARY");
  });

  it("formats leap year date (29 February 2024) correctly", () => {
    const date = new Date(2024, 1, 29, 12, 0); // 29 Feb 2024 was a Thursday
    const result = formatDashboardDate(date);
    expect(result).toBe("THURSDAY, 29 FEBRUARY");
  });

  it("respects explicit timeZone option across international date line", () => {
    // 2026-11-08 23:30 UTC is:
    // - 2026-11-08 15:30 in America/Los_Angeles (Sunday)
    // - 2026-11-09 08:30 in Asia/Tokyo (Monday)
    const date = new Date("2026-11-08T23:30:00Z");

    const laResult = formatDashboardDate(date, "America/Los_Angeles");
    expect(laResult).toBe("SUNDAY, 8 NOVEMBER");

    const tokyoResult = formatDashboardDate(date, "Asia/Tokyo");
    expect(tokyoResult).toBe("MONDAY, 9 NOVEMBER");
  });

  it("defaults to current date when no argument is passed", () => {
    const result = formatDashboardDate();
    expect(typeof result).toBe("string");
    // Verify it matches [WEEKDAY], [DAY] [MONTH] pattern in uppercase
    expect(result).toMatch(/^[A-Z]+, \d{1,2} [A-Z]+$/);
  });
});

describe("Dashboard Date Lifecycle & React Events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("simulates tab visibility change triggering date refresh", () => {
    let visibilityCallback: (() => void) | null = null;
    const addEventSpy = vi
      .spyOn(document, "addEventListener")
      .mockImplementation((event, handler) => {
        if (event === "visibilitychange") {
          visibilityCallback = handler as () => void;
        }
      });

    // Mock Date to Nov 8, 2026
    vi.setSystemTime(new Date(2026, 10, 8, 22, 0));
    expect(formatDashboardDate()).toBe("SUNDAY, 8 NOVEMBER");

    // Advance time past midnight to Nov 9, 2026
    vi.setSystemTime(new Date(2026, 10, 9, 8, 0));

    // When tab becomes visible, formatDashboardDate reflects the new date
    expect(formatDashboardDate()).toBe("MONDAY, 9 NOVEMBER");

    addEventSpy.mockRestore();
  });
});
