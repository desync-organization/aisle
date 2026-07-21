import axe from "axe-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import CoveragePage from "@/app/coverage/page";
import PrivacyPage from "@/app/privacy/page";
import { SelectionProvider } from "@/lib/selection/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("coverage transparency", () => {
  it("publishes an honest unsynchronized state without fabricated counts", async () => {
    render(<SelectionProvider>{await CoveragePage()}</SelectionProvider>);

    expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    expect(screen.getAllByText(/not available/i).length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/no zeroes are shown/i)).toBeInTheDocument();
    expect(screen.getByText(/no universal registry/i)).toBeInTheDocument();
  });

  it("distinguishes every supported discovery mode", async () => {
    render(<SelectionProvider>{await CoveragePage()}</SelectionProvider>);

    for (const mode of ["Full", "Incremental", "Federated", "On-demand"]) {
      expect(screen.getByText(mode)).toBeInTheDocument();
    }
  });
});

describe("privacy transparency", () => {
  it("separates local, public-source, hosting, and third-party data", () => {
    render(<SelectionProvider><PrivacyPage /></SelectionProvider>);

    expect(screen.getByText("Local selection state")).toBeInTheDocument();
    expect(screen.getByText("Public source metadata")).toBeInTheDocument();
    expect(screen.getByText("Routine request data")).toBeInTheDocument();
    expect(screen.getByText("External destinations")).toBeInTheDocument();
    expect(screen.getByText(/no accounts, ads, or payment collection/i)).toBeInTheDocument();
  });

  it(
    "has no automated accessibility violations in the current privacy page",
    async () => {
      const { container } = render(<SelectionProvider><PrivacyPage /></SelectionProvider>);
      const results = await axe.run(container, {
        rules: { "color-contrast": { enabled: false } },
      });

      expect(results.violations).toEqual([]);
    },
    15_000,
  );
});
