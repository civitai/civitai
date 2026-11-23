import type React from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

// Record<string, never> should mean an empty object
type DialogProps<TProps> = TProps extends Record<string, never>
  ? { props?: never }
  : TProps extends unknown
  ? { props?: TProps }
  : { props: TProps };

type DialogSettingsBase<TProps = any> = {
  id?: string | number | symbol;
  component: React.ComponentType<TProps>;
  type?: 'dialog' | 'routed-dialog';
  target?: string | HTMLElement;
  options?: {
    transitionDuration?: number;
    onClose?: () => void;
  };
};

type DialogSettings<TProps = any> = DialogSettingsBase<TProps> & DialogProps<TProps>;

export type Dialog<TProps = any> = DialogSettings<TProps> & {
  id: string | number | symbol;
};

type DialogStore = {
  dialogs: Dialog[];
  trigger: <TProps>(args: DialogSettings<TProps>) => void;
  toggle: <TProps>(args: Dialog<TProps>) => void;
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
        if (!exists) {
          // Cast needed because Immer's WritableDraft doesn't handle HTMLElement in target
          state.dialogs.push(dialog as unknown as (typeof state.dialogs)[number]);
        }
      });
    },
    toggle: (args) => {
      const { trigger, dialogs, closeById } = get();
      const exists = dialogs.findIndex((x) => x.id === args.id) > -1;
      if (!exists) trigger(args as Dialog);
      else closeById(args.id);
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

/** True when the dialog with this id is the last entry in the store, the one in front. `undefined` (no dialog context) is never top-most. */
export function useIsTopDialog(id: string | number | symbol | undefined) {
  return useDialogStore(
    (store) => id !== undefined && store.dialogs[store.dialogs.length - 1]?.id === id
  );
}

const { dialogs, ...dialogStore } = useDialogStore.getState();

export { dialogStore };
