import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

const createSelectStore = () =>
  create<{
    selected: Record<number, Record<number, boolean>>;
    setSelected: (userId: number, ids: number[]) => void;
    toggle: (userId: number, id: number, value?: boolean) => void;
    getSelected: (userId: number) => number[];
  }>()(
    immer((set, get) => ({
      selected: {},
      setSelected: (userId, ids) => {
        set((state) => {
          state.selected[userId] = ids.reduce<Record<number, boolean>>(
            (acc, ids) => ({ ...acc, [ids]: true }),
            {}
          );
        });
      },
      toggle: (userId, id, value) => {
        set((state) => {
          if (!state.selected[userId]) state.selected[userId] = {};
          if (value === undefined) {
            if (state.selected[userId][id]) delete state.selected[userId][id];
            else state.selected[userId][id] = true;
          } else {
            state.selected[userId][id] = value;
          }
        });
      },
      getSelected: (userId) => Object.keys(get().selected[userId] ?? {}).map(Number),
    }))
  );

export const useCsamImageSelectStore = createSelectStore();
export const useCsamModelVersionSelectStore = createSelectStore();
