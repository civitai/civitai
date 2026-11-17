import React, { createContext, memo, useContext, useEffect, useState } from 'react';
import type { Dialog } from '~/components/Dialog/dialogStore';
import { DialogIdContext, useDialogId } from '~/components/Dialog/dialogId';
import { dialogStore, useDialogStore, useIsLevelFocused } from '~/components/Dialog/dialogStore';
import { useHistoryLayer } from '~/hooks/useHistoryLayer';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';

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
export { useDialogId };

const DialogProviderInner = memo(function DialogProviderInner({
  dialog,
  index,
}: {
  dialog: Dialog;
  index: number;
}) {
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

  // Over the mobile generator, Back closes the dialog first. Routed dialogs have their own entry.
  const overMobileGenerator = useMobileGeneratorStore((state) => state.showing);
  useHistoryLayer(opened, onClose, overMobileGenerator && dialog.type !== 'routed-dialog');

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
});

export const DialogProvider = () => {
  const dialogs = useDialogStore((state) => state.dialogs);
  return (
    <>
      {dialogs.map((dialog, i) => (
        <DialogProviderInner key={dialog.id.toString()} dialog={dialog} index={i} />
      ))}
    </>
  );
};
