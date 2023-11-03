import React from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface DialogSettings<TProps extends Record<string, unknown> = any> {
  component: React.ComponentType<TProps>;
  props?: TProps;
  options?: {
    transitionDuration?: number;
    onClose?: () => void;
  };
}

export interface Dialog extends DialogSettings {
  id: number;
}

type DialogStore = {
  dialogs: Dialog[];
  trigger: (args: DialogSettings) => void;
  closeById: (id: number) => void;
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
        id: Date.now(),
      };
      set((state) => {
        state.dialogs.push(dialog);
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

const { dialogs, ...dialogStore } = useDialogStore.getState();

export { dialogStore };
