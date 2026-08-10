import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

const createSelectStore = () =>
  create<{
    selected: Record<number, Record<number, boolean>>;
    seeded: Record<string, boolean>;
    setSelected: (userId: number, ids: number[]) => void;
    seedSelected: (userId: number, id: number) => void;
    toggle: (userId: number, id: number, value?: boolean) => void;
    getSelected: (userId: number) => number[];
  }>()(
    immer((set, get) => ({
      selected: {},
      seeded: {},
      setSelected: (userId, ids) => {
        set((state) => {
          state.selected[userId] = ids.reduce<Record<number, boolean>>(
            (acc, ids) => ({ ...acc, [ids]: true }),
            {}
          );
        });
      },
      // The selection UI unmounts when the moderator steps forward and back, so an effect
      // that selected on mount would silently undo a deliberate deselect.
      seedSelected: (userId, id) => {
        const key = `${userId}:${id}`;
        if (get().seeded[key]) return;
        set((state) => {
          state.seeded[key] = true;
          if (!state.selected[userId]) state.selected[userId] = {};
          state.selected[userId][id] = true;
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
