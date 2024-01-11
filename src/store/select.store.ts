import { Key, useCallback } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type SelectStoreState<T extends Key> = {
  selected: { [key: Key]: boolean };
  setSelected: (keys: T[]) => void;
  toggle: (key: T, value?: boolean) => void;
};
export const createSelectStore = <T extends Key = Key>() => {
  const useStore = create<SelectStoreState<T>>()(
    immer((set) => ({
      selected: {},
      setSelected: (keys) =>
        set((state) => {
          state.selected = keys.reduce<Record<Key, boolean>>(
            (acc, key) => ({ ...acc, [key]: true }),
            {}
          );
        }),
      toggle: (key, value) =>
        set((state) => {
          const _value = value ?? !state.selected[key];
          if (_value) {
            state.selected[key] = _value;
          } else {
            delete state.selected[key];
          }
        }),
    }))
  );

  const mapSelected = (selected: Record<Key, boolean>) => {
    return Object.keys(selected).map((key) => {
      const numKey = Number(key);
      return !isNaN(numKey) ? numKey : key;
    }) as T[];
  };

  const useSelection = () => {
    const selected = useStore((state) => state.selected);
    return mapSelected(selected);
  };

  const useIsSelected = (key: T) => {
    const selected = useStore(useCallback((state) => state.selected[key] ?? false, [key]));
    return !!selected;
  };

  const getSelected = () => {
    const selected = useStore.getState().selected;
    return mapSelected(selected);
  };

  return {
    useSelection,
    useIsSelected,
    setSelected: useStore.getState().setSelected,
    toggle: useStore.getState().toggle,
    getSelected,
  };
};
