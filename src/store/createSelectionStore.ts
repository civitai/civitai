import { createContext, createElement, useCallback, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createStore, useStore } from 'zustand';
import type { StoreApi } from 'zustand';
import { devtools } from 'zustand/middleware';

/**
 * Reusable, list-oriented multi-select with Gmail-style shift-click range selection.
 *
 * Two layers, following the zustand "store factory + Context provider" pattern
 * (https://zustand.docs.pmnd.rs/guides/initialize-state-with-props):
 *
 * - {@link createSelectionStore} builds a vanilla store *instance* (state + actions)
 *   for one selectable surface. Use it directly as a module singleton, or pass the
 *   instance to a provider for subtree-scoped selection.
 * - {@link createSelectionContext} wraps an instance type with a `<Provider>` and
 *   selector hooks. Selector hooks subscribe to a single slice each, so toggling one
 *   row only re-renders that row — the targeted-update behavior plain React Context
 *   can't give.
 *
 * Range selection resolves within a registered group (see `registerOrder`/
 * `useRegisterOrder`), so a shift-range never bridges across separate grids.
 */
export interface SelectionState<T> {
  selected: Record<string, T>;
  /** Ordered item lists per render group, used to resolve shift-click ranges. */
  orders: Record<string, T[]>;
  /** Key of the last clicked item (plain or shift) — the anchor for range selection. */
  anchorKey: string | null;
}

export interface SelectionActions<T> {
  /** Toggle one item and make it the range-select anchor. */
  toggle: (item: T, value?: boolean) => void;
  /**
   * Toggle `item` with shift-click range support (Gmail-style range toggle). On a
   * shift-click the range between the anchor and `item` (inclusive) is toggled as a
   * unit: if every item in it is already selected, the whole range is deselected;
   * otherwise the whole range is selected. Falls back to {@link toggle} with no shift /
   * no anchor / no common group.
   */
  select: (item: T, opts: { shiftKey: boolean; checked: boolean }) => void;
  /** Add or remove many items at once. Programmatic — does not move the anchor. */
  selectMany: (items: T[], value: boolean) => void;
  /** Replace the entire selection. Clears the anchor. */
  setSelected: (items: T[]) => void;
  /** Clear the selection and anchor. */
  clear: () => void;
  /** Register a grid's ordered items under `groupId` (drives range resolution). */
  registerOrder: (groupId: string, items: T[]) => void;
  /** Remove a previously registered group. */
  unregisterOrder: (groupId: string) => void;
  /** Non-reactive snapshot of the selected items. */
  getSelected: () => T[];
}

export type SelectionStore<T> = {
  store: StoreApi<SelectionState<T>>;
  actions: SelectionActions<T>;
  getKey: (item: T) => string;
};

export function createSelectionStore<T>({
  getKey,
  name,
}: {
  /** Stable unique key for an item. */
  getKey: (item: T) => string;
  /** Optional devtools store name. */
  name?: string;
}): SelectionStore<T> {
  const store = createStore<SelectionState<T>>()(
    devtools(
      (): SelectionState<T> => ({ selected: {}, orders: {}, anchorKey: null }),
      name ? { name } : undefined
    )
  );

  // Plain click: toggle the item, then make it the range-select anchor.
  function toggleItem(item: T, value?: boolean) {
    const state = store.getState();
    const key = getKey(item);
    const isSelected = !!state.selected[key];
    const newValue = value ?? !isSelected;

    let selected = state.selected;
    if (newValue !== isSelected) {
      if (newValue) selected = { ...selected, [key]: item };
      else {
        const { [key]: _removed, ...rest } = selected;
        selected = rest;
      }
    }
    store.setState({ selected, anchorKey: key });
  }

  const actions: SelectionActions<T> = {
    toggle: toggleItem,

    select: (item, { shiftKey, checked }) => {
      const state = store.getState();
      const targetKey = getKey(item);

      if (shiftKey && state.anchorKey && state.anchorKey !== targetKey) {
        for (const groupId in state.orders) {
          const list = state.orders[groupId];
          const anchorIndex = list.findIndex((x) => getKey(x) === state.anchorKey);
          const targetIndex = list.findIndex((x) => getKey(x) === targetKey);
          if (anchorIndex !== -1 && targetIndex !== -1) {
            const [start, end] =
              anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
            const range = list.slice(start, end + 1);
            // Gmail range toggle: if the whole range is already selected, deselect it;
            // if any item in it is unselected, select the entire range. The clicked item
            // becomes the new anchor so consecutive shift-clicks chain from it.
            const allSelected = range.every((rangeItem) => !!state.selected[getKey(rangeItem)]);
            const selected = { ...state.selected };
            for (const rangeItem of range) {
              const rangeKey = getKey(rangeItem);
              if (allSelected) delete selected[rangeKey];
              else selected[rangeKey] = rangeItem;
            }
            store.setState({ selected, anchorKey: targetKey });
            return;
          }
        }
      }

      toggleItem(item, checked);
    },

    selectMany: (items, value) => {
      const state = store.getState();
      if (value) {
        const additions = Object.fromEntries(items.map((item) => [getKey(item), item]));
        store.setState({ selected: { ...state.selected, ...additions } });
      } else {
        const removeKeys = new Set(items.map(getKey));
        const rest = Object.fromEntries(
          Object.entries(state.selected).filter(([key]) => !removeKeys.has(key))
        );
        store.setState({ selected: rest });
      }
    },

    setSelected: (items) => {
      const selected = Object.fromEntries(items.map((item) => [getKey(item), item]));
      store.setState({ selected, anchorKey: null });
    },

    clear: () => store.setState({ selected: {}, anchorKey: null }),

    registerOrder: (groupId, items) =>
      store.setState((state) => ({ orders: { ...state.orders, [groupId]: items } })),

    unregisterOrder: (groupId) =>
      store.setState((state) => {
        const { [groupId]: _removed, ...rest } = state.orders;
        return { orders: rest };
      }),

    getSelected: () => Object.values(store.getState().selected),
  };

  return { store, actions, getKey };
}

/**
 * Wrap a {@link SelectionStore} instance type with a Context provider and selector
 * hooks. Pass a `defaultStore` so consumers rendered outside the provider (e.g. a
 * dialog/lightbox portal) still resolve to a store instead of throwing.
 */
export function createSelectionContext<T>(defaultStore?: SelectionStore<T>) {
  const Context = createContext<SelectionStore<T> | null>(null);

  function SelectionProvider({
    store,
    children,
  }: {
    store: SelectionStore<T>;
    children: ReactNode;
  }) {
    return createElement(Context.Provider, { value: store }, children);
  }

  function useApi(): SelectionStore<T> {
    const api = useContext(Context) ?? defaultStore;
    if (!api)
      throw new Error(
        'Selection hooks must be used within a SelectionProvider (or with a default).'
      );
    return api;
  }

  return {
    SelectionProvider,

    /** Stable action handlers for the resolved store instance. */
    useActions: (): SelectionActions<T> => useApi().actions,

    useSelection: (): T[] => {
      const { store } = useApi();
      // Subscribe to the `selected` slice (stable ref); derive the array in render so
      // unrelated state changes (orders/anchor) don't trigger a re-render.
      const selected = useStore(store, (state) => state.selected);
      return Object.values(selected);
    },

    useIsSelected: (item: T): boolean => {
      const { store, getKey } = useApi();
      const key = getKey(item);
      return useStore(
        store,
        useCallback((state: SelectionState<T>) => !!state.selected[key], [key])
      );
    },

    useIsSelecting: (): boolean => {
      const { store } = useApi();
      return useStore(store, (state) => Object.keys(state.selected).length > 0);
    },

    useSelectedCount: (): number => {
      const { store } = useApi();
      return useStore(store, (state) => Object.keys(state.selected).length);
    },

    /**
     * Register the calling grid's ordered (selectable) items under `groupId` for the
     * component's lifetime. Exclude items the user can't select so a range never lands
     * on one.
     */
    useRegisterOrder: (groupId: string, items: T[]) => {
      const { actions, getKey } = useApi();
      // Re-register only when the ordered key signature changes (array identity churns
      // every render under infinite scroll).
      const signature = items.map(getKey).join('|');
      useEffect(() => {
        actions.registerOrder(groupId, items);
        return () => actions.unregisterOrder(groupId);
        // `items` is tracked via `signature`, not by identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [groupId, signature, actions]);
    },
  };
}
