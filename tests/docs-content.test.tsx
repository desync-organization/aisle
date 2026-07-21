import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import DocsPage from "@/app/docs/page";
import PublicCatalogPolicyPage from "@/app/docs/public-catalog-policy/page";
import { SelectionProvider } from "@/lib/selection/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("Aisle documentation", () => {
  it("explains the open format without presenting authored skill content", () => {
    render(<SelectionProvider><DocsPage /></SelectionProvider>);

    expect(
      screen.getByRole("heading", { level: 1, name: /a clear map of what a skill is/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/SKILL\.md is required/i)).toBeInTheDocument();
    expect(screen.getByText(/does not make skills/i)).toBeInTheDocument();
    expect(screen.queryByText(/foundation ready/i)).not.toBeInTheDocument();
  });

  it("links format and installer claims to their primary sources", () => {
    render(<SelectionProvider><DocsPage /></SelectionProvider>);

    expect(screen.getByRole("link", { name: /Agent Skills specification/i })).toHaveAttribute(
      "href",
      "https://agentskills.io/specification",
    );
    expect(screen.getByRole("link", { name: /Vercel skills CLI source/i })).toHaveAttribute(
      "href",
      "https://github.com/vercel-labs/skills",
    );
    expect(screen.getByText(/commands are issued only after current server-side revalidation/i)).toBeInTheDocument();
  });

  it("keeps upstream, editorial, and findings attribution separate", () => {
    render(<SelectionProvider><PublicCatalogPolicyPage /></SelectionProvider>);

    expect(screen.getByRole("heading", { name: /three kinds of context/i })).toBeInTheDocument();
    expect(screen.getByText(/missing license is displayed as unknown/i)).toBeInTheDocument();
    expect(screen.getByText("AISLE / EDITORIAL")).toBeInTheDocument();
  });
});
