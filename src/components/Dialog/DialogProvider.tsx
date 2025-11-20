import React, { useEffect, useState } from 'react';
import type { Dialog } from '~/components/Dialog/dialogStore';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import { DialogContext } from '~/components/Dialog/DialogContext';
import trieMemoize from 'trie-memoize';
import { Freeze } from '~/components/Freeze/Freeze';

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
    <DialogContext.Provider
      value={{
        opened,
        onClose,
        zIndex: 300 + index,
        target: dialog.target,
      }}
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
        <React.Fragment key={dialog.id.toString()}>{createRenderElement(dialog, i)}</React.Fragment>
      ))}
    </>
  );
};

const createRenderElement = trieMemoize([WeakMap, {}, {}], (dialog, index) => (
  <DialogProviderInner dialog={dialog} index={index} />
));
