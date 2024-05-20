import React, { createContext, useContext, useEffect, useState } from 'react';
import { Dialog, dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import trieMemoize from 'trie-memoize';

type DialogState = {
  opened: boolean;
  onClose: () => void;
  zIndex: number;
  target?: string | HTMLElement;
};

const DialogContext = createContext<DialogState>({
  opened: false,
  onClose: () => undefined,
  zIndex: 200,
});
export const useDialogContext = () => useContext(DialogContext);

const DialogProviderInner = ({ dialog, index }: { dialog: Dialog; index: number }) => {
  const [opened, setOpened] = useState(false);

  const Dialog = dialog.component;
  const onClose = () => {
    dialog.options?.onClose?.();
    dialogStore.closeById(dialog.id);
  };

  useEffect(() => {
    setTimeout(() => {
      setOpened(true);
    }, 0);
  }, []);

  return (
    <DialogContext.Provider value={{ opened, onClose, zIndex: 200 + index, target: dialog.target }}>
      <Dialog {...dialog.props} />
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

const createRenderElement = trieMemoize([WeakMap, {}], (dialog, index) => (
  <DialogProviderInner dialog={dialog} index={index} />
));
