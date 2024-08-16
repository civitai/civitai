import React, { createContext, useContext, useEffect, useState } from 'react';
import { Dialog, dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import trieMemoize from 'trie-memoize';

type DialogState = {
  opened: boolean;
  onClose: () => void;
  zIndex: number;
  target?: string | HTMLElement;
  focused?: 'true';
};

const DialogContext = createContext<DialogState>({
  opened: false,
  onClose: () => undefined,
  zIndex: 200,
});
export const useDialogContext = () => useContext(DialogContext);

const DialogProviderInner = ({
  dialog,
  index,
  focused,
}: {
  dialog: Dialog;
  index: number;
  focused?: 'true';
}) => {
  const [opened, setOpened] = useState(false);

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
      value={{ opened, onClose, zIndex: 200 + index, target: dialog.target, focused }}
    >
      <Dialog {...dialog.props} />
    </DialogContext.Provider>
  );
};

export const DialogProvider = () => {
  const dialogs = useDialogStore((state) => state.dialogs);
  return (
    <>
      {dialogs.map((dialog, i) => (
        <React.Fragment key={dialog.id.toString()}>
          {createRenderElement(dialog, i, i === dialogs.length - 1 ? 'true' : undefined)}
        </React.Fragment>
      ))}
    </>
  );
};

const createRenderElement = trieMemoize([WeakMap, {}, {}], (dialog, index, focused) => (
  <DialogProviderInner dialog={dialog} index={index} focused={focused} />
));
