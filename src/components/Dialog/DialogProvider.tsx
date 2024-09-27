import React, { createContext, useContext, useEffect, useState } from 'react';
import { Dialog, dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import trieMemoize from 'trie-memoize';
import { Freeze } from '~/components/Freeze/Freeze';
import { constants } from '~/server/common/constants';

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
  zIndex: constants.dialog.zIndex,
});
export const useDialogContext = () => useContext(DialogContext);

const DialogProviderInner = ({ dialog, index }: { dialog: Dialog; index: number }) => {
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
    <DialogContext.Provider value={{ opened, onClose, zIndex: (dialog.options?.zIndex ?? constants.dialog.zIndex) + index, target: dialog.target }}>
      <Dialog {...dialog.props} />
    </DialogContext.Provider>
  );
};

export const DialogProvider = () => {
  const dialogs = useDialogStore((state) => state.dialogs);
  return (
    <>
      {dialogs.map((dialog, i) => (
        <Freeze freeze={dialogs.length !== i + 1} key={dialog.id.toString()}>
          {createRenderElement(dialog, i)}
        </Freeze>
      ))}
    </>
  );
};

const createRenderElement = trieMemoize([WeakMap, {}, {}], (dialog, index) => (
  <DialogProviderInner dialog={dialog} index={index} />
));
