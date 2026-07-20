import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SiteHeader } from "@/components/site-header";
import { CommandBlock } from "@/components/ui/command-block";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("marketplace shell interactions", () => {
  beforeEach(() => {
    push.mockReset();
  });

  it("opens catalog search from the visible trigger and submits a normalized query", async () => {
    render(<SiteHeader />);

    fireEvent.click(screen.getByRole("button", { name: /search catalog/i }));
    const searchInput = screen.getByRole("searchbox", { name: /search public agent skills/i });

    fireEvent.change(searchInput, { target: { value: "  deployment  " } });
    fireEvent.submit(searchInput.closest("form")!);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/skills?q=deployment"));
  });

  it("opens catalog search with the slash shortcut outside an input", () => {
    render(<SiteHeader />);

    fireEvent.keyDown(window, { key: "/" });

    expect(screen.getByRole("dialog", { name: /search the public catalog/i })).toBeInTheDocument();
  });

  it("copies a generated command and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<CommandBlock command="npx example install selection" />);
    fireEvent.click(screen.getByRole("button", { name: /copy command/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("npx example install selection"));
    expect(await screen.findByRole("button", { name: /command copied/i })).toBeInTheDocument();
  });
});
