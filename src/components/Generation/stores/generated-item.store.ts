import { useCallback, Dispatch, SetStateAction } from 'react';
import { create } from 'zustand';
import { removeEmpty } from '~/utils/object-helpers';

type StoreProps = {
  favorite?: boolean;
  feedback?: string;
};

type GeneratedItemStore = Record<string, StoreProps> & {
  setItem: (key: string, value: SetStateAction<StoreProps>) => void;
};

const useStore = create<GeneratedItemStore>((set) => ({
  setItem: (key, value) => {
    set((state) => {
      const currentValue = state[key] ?? {};
      const data = typeof value === 'function' ? value(currentValue) : value;
      return { [key]: { ...currentValue, ...data } };
    });
  },
}));

export const generatedItemStore = {
  setItem: useStore.getState().setItem,
};

export function useGeneratedItemStore<T extends { id: string } & StoreProps>(
  item: T
): [T, Dispatch<SetStateAction<StoreProps>>] {
  return useStore(
    useCallback(
      (state) => {
        const setState = (data: SetStateAction<StoreProps>) => state.setItem(item.id, data);
        return [{ ...item, ...removeEmpty(state[item.id] ?? {}) }, setState];
      },
      [item.id]
    )
  );
}
