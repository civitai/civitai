import { Key, useCallback } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { isNumeric } from '~/utils/number-helpers';

type SelectState = {
  selected: Record<string, Record<Key, boolean>>;
  setSelected: (name: string, keys: Key[]) => void;
  toggle: (name: string, key: Key, value?: boolean) => void;
};

const useStore = create<SelectState>()(
  devtools(
    immer((set, get) => ({
      selected: {},
      setSelected: (name, keys) => {
        set((state) => {
          state.selected[name] = keys.reduce<Record<Key, boolean>>(
            (acc, key) => ({ ...acc, [key]: true }),
            {}
          );
        });
      },
      toggle: (name, key, value) => {
        set((state) => {
          if (!state.selected[name]) state.selected[name] = {};
          if (value === undefined) {
            if (state.selected[name][key]) delete state.selected[name][key];
            else state.selected[name][key] = true;
          } else {
            state.selected[name][key] = value;
          }
        });
      },
    })),
    { name: 'selected' }
  )
);

const store = useStore.getState();
const selectStoreHandlers = {
  setSelected: store.setSelected,
  toggle: store.toggle,
};

export const createSelectStore = <T extends Key>(name: string) => {
  if (store.selected[name]) throw new Error(`select store name: ${name} already in use`);

  const useSelected = (key: T) => {
    const selected = useStore(
      useCallback((state) => (state.selected[name] ?? { [key]: false })[key], [key])
    );
    return !!selected;
  };

  const mapSelected = (selected: Record<Key, boolean>) => {
    const entries = Object.entries(selected).filter(([key, value]) => value);
    if (!entries.length) return [];
    const mapped = isNumeric(entries[0][1])
      ? entries.map(([key]) => Number(key))
      : entries.map(([key]) => String(key));
    return mapped as T[];
  };

  const useSelection = (): T[] => {
    const selected = useStore((state) => state.selected[name]);
    return selected ? mapSelected(selected) : [];
  };

  const setSelected = (keys: T[]) => selectStoreHandlers.setSelected(name, keys);
  const toggle = (key: T, selected?: boolean) => selectStoreHandlers.toggle(name, key, selected);
  const getSelected = () => {
    const selected = useStore.getState().selected[name];
    return selected ? mapSelected(selected) : [];
  };

  return { useSelected, useSelection, setSelected, toggle, getSelected };
};
