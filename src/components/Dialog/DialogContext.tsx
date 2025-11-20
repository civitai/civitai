import { createContext, useContext } from 'react';

export type DialogState = {
  opened: boolean;
  onClose: () => void;
  zIndex?: number;
  target?: string | HTMLElement;
  focused?: 'true';
};

export const DialogContext = createContext<DialogState>({
  opened: false,
  onClose: () => undefined,
});

export const useDialogContext = () => useContext(DialogContext);
