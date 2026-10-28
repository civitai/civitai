import type React from 'react';
import { createContext, useContext, useRef } from 'react';
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

export function createDialogTrigger<T = any>(
  component: DialogSettings<T>['component'],
  defaultOptions?: Omit<DialogSettings<T>, 'component'>
) {
  return (options?: Omit<DialogSettings<T>, 'component'>) =>
    dialogStore.trigger({ component, ...defaultOptions, ...options } as DialogSettings<T>);
}

/**
 * The store id of the dialog a component is rendered in (`undefined` outside one).
 *
 * 🔴 A SEPARATE CONTEXT, NOT A FIELD ON `DialogContext`. Most dialogs spread
 * `useDialogContext()` straight into Mantine's `<Modal>`, which forwards unknown props
 * to the DOM — an id there would land as a stray attribute on every modal.
 */
export const DialogIdContext = createContext<Dialog['id'] | undefined>(undefined);
export const useDialogId = () => useContext(DialogIdContext);

export function useIsLevelFocused() {
  const levelRef = useRef<number>();
  const level = useDialogStore((store) => store.dialogs.length);

  if (!levelRef.current) levelRef.current = level;

  return levelRef.current === level;
}

/**
 * True when the dialog with this id is the LAST entry in the store — the one actually
 * in front. Unlike `useIsLevelFocused` (which compares the dialog COUNT now with the
 * count at mount), this stays correct when a dialog underneath closes or another opens
 * on top afterwards. `undefined` (no dialog context) is never top-most.
 */
export function useIsTopDialog(id: string | number | symbol | undefined) {
  return useDialogStore(
    (store) => id !== undefined && store.dialogs[store.dialogs.length - 1]?.id === id
  );
}

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
