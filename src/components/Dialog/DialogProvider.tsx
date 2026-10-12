import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Dialog } from '~/components/Dialog/dialogStore';
import { dialogStore, useDialogStore, useIsLevelFocused } from '~/components/Dialog/dialogStore';
import trieMemoize from 'trie-memoize';

type DialogState = {
  opened: boolean;
  onClose: () => void;
  zIndex?: number;
  target?: string | HTMLElement;
  focused?: 'true';
  closeOnEscape?: boolean;
};

const DialogContext = createContext<DialogState>({
  opened: false,
  onClose: () => undefined,
});
export const useDialogContext = () => useContext(DialogContext);

/**
 * The store id of the dialog a component is rendered in (`undefined` outside one).
 *
 * 🔴 A SEPARATE CONTEXT, NOT A FIELD ON `DialogContext`. Most dialogs spread
 * `useDialogContext()` straight into Mantine's `<Modal>`, which forwards unknown props
 * to the DOM — an id there would land as a stray attribute on every modal.
 */
const DialogIdContext = createContext<Dialog['id'] | undefined>(undefined);
export const useDialogId = () => useContext(DialogIdContext);

const DialogProviderInner = ({ dialog, index }: { dialog: Dialog; index: number }) => {
  const [opened, setOpened] = useState(false);
  const isTopLevel = useIsLevelFocused();

  const Dialog = dialog.component;

  function onClose() {
    dialog.options?.onClose?.();
    dialogStore.closeById(dialog.id);
  }

  useEffect(() => {
    setTimeout(() => {
      setOpened(true);
    }, 0);
  }, []);

  return (
    <DialogContext.Provider
      value={{
        opened,
        onClose,
        zIndex: 300 + index,
        target: dialog.target,
        closeOnEscape: isTopLevel,
      }}
    >
      <DialogIdContext.Provider value={dialog.id}>
        <Dialog {...dialog.props} />
      </DialogIdContext.Provider>
    </DialogContext.Provider>
  );
};

export const DialogProvider = () => {
  const dialogs = useDialogStore((state) => state.dialogs);
  return (
    <>
      {dialogs.map((dialog, i) => (
        <React.Fragment key={dialog.id.toString()}>{createRenderElement(dialog, i)}</React.Fragment>
      ))}
    </>
  );
};

const createRenderElement = trieMemoize([WeakMap, {}, {}], (dialog, index) => (
  <DialogProviderInner dialog={dialog} index={index} />
));
