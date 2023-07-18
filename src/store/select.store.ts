import { Key, useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

type SelectState = {
  selected: Record<string, Record<Key, boolean>>;
  setSelected: (name: string, key: Key, value?: boolean) => void;
};

const useStore = create<SelectState>()(
  devtools(
    immer((set, get) => ({
      selected: {},
      setSelected: (name, key, value) => {
        set((state) => {
          if (!state.selected[name]) state.selected[name] = { [key]: true };
          else {
            if (state.selected[name][key]) delete state.selected[name][key];
            else state.selected[name][key] = true;
          }
        });
      },
    })),
    { name: 'selected' }
  )
);

const useSelectedStore = ({
  name,
  value,
  initialSelected,
}: {
  name: string;
  value: Key;
  initialSelected?: boolean;
}) => {
  const selected = useStore(useCallback((state) => state.selected[name][value], [name, value]));
  const setSelected = useStore((state) => state.setSelected);

  useEffect(() => {}, []);
};
