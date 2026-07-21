import axe from "axe-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import HomePage from "@/app/page";
import { SelectionProvider } from "@/lib/selection/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("Aisle home", () => {
  it("exposes the marketplace shell without fabricated skill listings", async () => {
    render(<SelectionProvider>{await HomePage()}</SelectionProvider>);

    expect(
      screen.getByRole("heading", { level: 1, name: /build your agent stack/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /primary/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /your stack, 0 selected/i })).toBeInTheDocument();
    expect(screen.getByText(/no aisle-authored skills/i)).toBeInTheDocument();
    expect(screen.getByText("Zero").closest("p")).toHaveTextContent("Zero house-made skills");
  });

  it("has no automated accessibility violations in its initial state", async () => {
    const { container } = render(<SelectionProvider>{await HomePage()}</SelectionProvider>);
    const results = await axe.run(container, {
      rules: {
        // JSDOM has no layout engine/canvas implementation, so color contrast is covered by
        // the documented token pairs and a later real-browser audit rather than this smoke test.
        "color-contrast": { enabled: false },
      },
    });

    expect(results.violations).toEqual([]);
  });
});
