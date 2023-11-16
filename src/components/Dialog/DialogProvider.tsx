import React, { createContext, useContext, useEffect, useState } from 'react';
import { Dialog, dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import trieMemoize from 'trie-memoize';

type DialogState = {
  opened: boolean;
  onClose: () => void;
};

const DialogContext = createContext<DialogState>({ opened: false, onClose: () => undefined });
export const useDialogContext = () => useContext(DialogContext);

const DialogProviderInner = ({ dialog }: { dialog: Dialog }) => {
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
    <DialogContext.Provider value={{ opened, onClose }}>
      <Dialog {...dialog.props} />
    </DialogContext.Provider>
  );
};

export const DialogProvider = () => {
  const dialogs = useDialogStore((state) => state.dialogs);
  return (
    <>
      {dialogs.map((dialog, i) => (
        <div key={dialog.id.toString()}>{createRenderElement(dialog)}</div>
      ))}
    </>
  );
};

const createRenderElement = trieMemoize([WeakMap], (dialog) => (
  <DialogProviderInner dialog={dialog} />
));
