import React from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface DialogSettings<TProps extends Record<string, unknown> = any> {
  id?: string | number | symbol;
  component: React.ComponentType<TProps>;
  props?: TProps;
  type?: 'dialog' | 'routed-dialog';
  options?: {
    transitionDuration?: number;
    onClose?: () => void;
  };
}

export interface Dialog extends DialogSettings {
  id: string | number | symbol;
}

type DialogStore = {
  dialogs: Dialog[];
  trigger: (args: DialogSettings) => void;
  closeById: (id: string | number | symbol) => void;
  closeLatest: () => void;
  closeAll: () => void;
};

export const useDialogStore = create<DialogStore>()(
  immer((set, get) => ({
    dialogs: [],
    trigger: (args) => {
      const dialog: Dialog = {
        component: args.component,
        props: args.props,
        options: args.options,
        id: args.id ?? Date.now(),
        type: args.type ?? 'dialog',
      };
      set((state) => {
        const exists = state.dialogs.findIndex((x) => x.id === dialog.id) > -1;
        if (!exists) state.dialogs.push(dialog);
      });
    },
    closeById: (id) =>
      set((state) => {
        state.dialogs = state.dialogs.filter((x) => x.id !== id);
      }),
    closeLatest: () =>
      set((state) => {
        state.dialogs.pop();
      }),
    closeAll: () =>
      set((state) => {
        state.dialogs = [];
      }),
  }))
);

export const useStackingContext = create<{
  stackingContext: number[];
}>(() => ({
  stackingContext: [],
}));

const { dialogs, ...dialogStore } = useDialogStore.getState();

export { dialogStore };
