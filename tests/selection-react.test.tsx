import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createSelectionStore,
  encodePersistedSelection,
  SELECTION_STORAGE_KEY,
} from "@/lib/selection";
import {
  SelectionProvider,
  useSelection,
} from "@/lib/selection/react";
import { catalogId, MemorySelectionStorage } from "./selection-test-helpers";

function SelectionHarness() {
  const { state, actions, meta } = useSelection();

  return (
    <section aria-label="Selection controls" aria-busy={!state.hydrated}>
      <output aria-label="Selected catalog skill IDs">{state.ids.join(",")}</output>
      <output aria-label="Selection capacity">{`${state.count}/${meta.maxSelections}`}</output>
      <button type="button" onClick={() => actions.addMany(["skill-b", "skill-a"])}>
        Add package
      </button>
      <button type="button" onClick={() => actions.toggle("skill-a")}>
        Toggle skill A
      </button>
    </section>
  );
}

describe("React selection provider", () => {
  it("uses the stable server snapshot and defers persistence hydration", () => {
    const storage = new MemorySelectionStorage();
    storage.setItem(
      SELECTION_STORAGE_KEY,
      encodePersistedSelection([catalogId("skill-persisted")]),
    );
    const store = createSelectionStore({ storage });

    const html = renderToString(
      <SelectionProvider store={store}>
        <SelectionHarness />
      </SelectionProvider>,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("skill-persisted");
    expect(store.getSnapshot().hydrated).toBe(false);
  });

  it("hydrates after mount and updates accessible subscribers", async () => {
    const storage = new MemorySelectionStorage();
    storage.setItem(
      SELECTION_STORAGE_KEY,
      encodePersistedSelection([catalogId("skill-persisted")]),
    );
    const store = createSelectionStore({ storage });

    render(
      <SelectionProvider store={store}>
        <SelectionHarness />
      </SelectionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Selected catalog skill IDs")).toHaveTextContent(
        "skill-persisted",
      );
    });
    expect(screen.getByRole("region", { busy: false })).toBeInTheDocument();
  });

  it("shares one store between package add-all and individual selection", async () => {
    const store = createSelectionStore({ storage: new MemorySelectionStorage() });
    render(
      <SelectionProvider store={store}>
        <SelectionHarness />
      </SelectionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add package" }));
    expect(screen.getByLabelText("Selected catalog skill IDs")).toHaveTextContent(
      "skill-a,skill-b",
    );
    expect(screen.getByLabelText("Selection capacity")).toHaveTextContent("2/64");

    fireEvent.click(screen.getByRole("button", { name: "Toggle skill A" }));
    expect(screen.getByLabelText("Selected catalog skill IDs")).toHaveTextContent(
      "skill-b",
    );
  });
});
