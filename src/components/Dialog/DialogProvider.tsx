import { usePrevious } from '@dnd-kit/utilities';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { Dialog, dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';

type DialogState = {
  opened: boolean;
  onClose: () => void;
};

const DialogContext = createContext<DialogState | null>(null);
export const useDialogContext = () => {
  const context = useContext(DialogContext);
  if (!context) throw new Error('missing DialogContext');
  return context;
};

const DialogProviderInner = ({ dialog }: { dialog: Dialog }) => {
  const [opened, setOpened] = useState(false);
  const previousOpened = usePrevious(opened);

  const duration = dialog.options?.transitionDuration ?? 150;
  const Dialog = dialog.component;
  const onClose = () => {
    setOpened(false);
    dialog.options?.onClose?.();
  };

  useEffect(() => {
    setOpened(true);
  }, []);

  useEffect(() => {
    if (!opened && previousOpened)
      setTimeout(() => {
        dialogStore.closeById(dialog.id);
      }, duration);
  }, [opened]); // eslint-disable-line

  return (
    <DialogContext.Provider value={{ opened, onClose }}>
      <Dialog {...dialog.props} />
    </DialogContext.Provider>
  );
};

export const DialogProvider = () => {
  const dialogs = useDialogStore((state) => state.dialogs);
  console.log({ dialogs });
  return (
    <>
      {dialogs.map((dialog) => (
        <DialogProviderInner key={dialog.id} dialog={dialog} />
      ))}
    </>
  );
};
