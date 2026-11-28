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
    onClose?: () => void;
  };
};

type DialogSettings<TProps = any> = DialogSettingsBase<TProps> & DialogProps<TProps>;

export type Dialog<TProps = any> = DialogSettings<TProps> & {
  id: string | number | symbol;
  /** Unique per open, so a dialog reopened under the same id while it is still closing is a new one. */
  instance?: number;
};

type DialogStore = {
  /** The open dialogs, the last one in front. A closing dialog has already left this list. */
  dialogs: Dialog[];
  /** Dialogs playing their exit transition: still rendered, no longer open. */
  closing: Dialog[];
  trigger: <TProps>(args: DialogSettings<TProps>) => void;
  toggle: <TProps>(args: Dialog<TProps>) => void;
  closeById: (id: string | number | symbol) => void;
  closeLatest: () => void;
  /** Closes every dialog at once, with no exit transition. */
  closeAll: () => void;
  /** Unmounts a closing dialog once its exit transition has ended. */
  removeClosing: (instance: number) => void;
};

let instances = 0;

export const useDialogStore = create<DialogStore>()(
  immer((set, get) => ({
    dialogs: [],
    closing: [],
    trigger: (args) => {
      const instance = ++instances;
      const dialog: Dialog = {
        component: args.component,
        props: args.props,
        options: args.options,
        id: args.id ?? `dialog-${instance}`,
        instance,
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
        const index = state.dialogs.findIndex((x) => x.id === id);
        if (index > -1) state.closing.push(...state.dialogs.splice(index, 1));
      }),
    closeLatest: () =>
      set((state) => {
        const dialog = state.dialogs.pop();
        if (dialog) state.closing.push(dialog);
      }),
    closeAll: () =>
      set((state) => {
        state.dialogs = [];
        state.closing = [];
      }),
    removeClosing: (instance) =>
      set((state) => {
        state.closing = state.closing.filter((x) => x.instance !== instance);
      }),
  }))
);

/** True when the dialog with this id is the last entry in the store, the one in front. `undefined` (no dialog context) is never top-most. */
export function useIsTopDialog(id: string | number | symbol | undefined) {
  return useDialogStore(
    (store) => id !== undefined && store.dialogs[store.dialogs.length - 1]?.id === id
  );
}

const { dialogs, closing, ...dialogStore } = useDialogStore.getState();

export { dialogStore };
