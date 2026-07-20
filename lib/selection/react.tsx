"use client";

import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  createSelectionStore,
  type SelectionActions,
  type SelectionSnapshot,
  type SelectionStore,
} from "./store";

export type SelectionContextValue = Readonly<{
  state: SelectionSnapshot;
  actions: SelectionActions;
  meta: SelectionStore["meta"];
}>;

const SelectionStoreContext = createContext<SelectionStore | null>(null);

export type SelectionProviderProps = Readonly<{
  children: ReactNode;
  store?: SelectionStore;
}>;

/**
 * Owns exactly one store for every package and individual-selection consumer
 * beneath it. Supplying a store is intended for dependency injection and tests.
 */
export function SelectionProvider({
  children,
  store: injectedStore,
}: SelectionProviderProps) {
  const [store] = useState(
    () => injectedStore ?? createSelectionStore(),
  );

  useEffect(() => {
    store.hydrate();
  }, [store]);

  return (
    <SelectionStoreContext value={store}>
      {children}
    </SelectionStoreContext>
  );
}

export function useSelectionStore(): SelectionStore {
  const store = use(SelectionStoreContext);
  if (store === null) {
    throw new Error("useSelectionStore must be used inside SelectionProvider.");
  }
  return store;
}

export function useSelection(): SelectionContextValue {
  const store = useSelectionStore();
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  return useMemo(
    () => ({ state, actions: store.actions, meta: store.meta }),
    [state, store],
  );
}
