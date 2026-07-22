import axe from "axe-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import SafetyPage from "@/app/safety/page";
import { SelectionProvider } from "@/lib/selection/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("safety and trust guidance", () => {
  it("defines every trust label without calling a reviewed skill safe", () => {
    render(<SelectionProvider><SafetyPage /></SelectionProvider>);

    for (const label of [
      "Official",
      "Audited / no known findings",
      "Warning",
      "Unreviewed",
      "Failed",
      "Quarantined",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    expect(screen.getByText(/public does not mean safe/i)).toBeInTheDocument();
    expect(screen.getByText(/this is not a security audit/i)).toBeInTheDocument();
    expect(screen.getByText(/not a guarantee of safety/i)).toBeInTheDocument();

    const officialRow = screen.getByText("Official", { selector: ".trust-label" }).closest("tr");
    const unreviewedRow = screen.getByText("Unreviewed", { selector: ".trust-label" }).closest("tr");
    const warningRow = screen.getByText("Warning", { selector: ".trust-label" }).closest("tr");

    expect(officialRow).toHaveTextContent(/not sufficient on its own/i);
    expect(unreviewedRow).toHaveTextContent(/blocked until baseline validation passes/i);
    expect(unreviewedRow).toHaveTextContent(/skill stays visible/i);
    expect(warningRow).toHaveTextContent(/requires acknowledgement/i);
    expect(
      screen.getByRole("region", { name: /trust label table, horizontally scrollable/i }),
    ).toHaveAttribute("tabindex", "0");
  });

  it(
    "has no automated accessibility violations in its initial state",
    async () => {
      const { container } = render(<SelectionProvider><SafetyPage /></SelectionProvider>);
      const results = await axe.run(container, {
        rules: { "color-contrast": { enabled: false } },
      });

      expect(results.violations).toEqual([]);
    },
    15_000,
  );
});
