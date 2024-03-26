import React, { useRef } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface DialogSettings<TProps extends Record<string, unknown> = any> {
  id?: string | number | symbol;
  component: React.ComponentType<TProps>;
  props?: TProps;
  type?: 'dialog' | 'routed-dialog';
  target?: string | HTMLElement;
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
  trigger: <TProps extends Record<string, unknown>>(args: DialogSettings<TProps>) => void;
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
        target: args.target,
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

// used to track the modal stacking context (page modals).
const useStackingContextStore = create<{
  stackingContext: number[];
}>(() => ({
  stackingContext: [],
}));
export function useStackingContext() {
  const stackingContextRef = useRef(useStackingContextStore.getState().stackingContext.length);
  const isCurrentStack = useStackingContextStore(
    (state) => state.stackingContext.length === stackingContextRef.current
  );

  const increase = () => {
    const stackingContext = stackingContextRef.current;
    useStackingContextStore.setState((state) => ({
      stackingContext: [...state.stackingContext, stackingContext],
    }));
  };

  const decrease = () => {
    const stackingContext = stackingContextRef.current;
    useStackingContextStore.setState((state) => ({
      stackingContext: [...state.stackingContext.filter((x) => x !== stackingContext)],
    }));
  };

  return {
    stack: stackingContextRef.current,
    isCurrentStack,
    increase,
    decrease,
  };
}

const { dialogs, ...dialogStore } = useDialogStore.getState();

export { dialogStore };
