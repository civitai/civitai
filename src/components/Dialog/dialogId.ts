import { createContext, useContext } from 'react';
import type { Dialog } from '~/components/Dialog/dialogStore';

/**
 * The store id of the dialog a component is rendered in (`undefined` outside one).
 *
 * 🔴 A SEPARATE CONTEXT, NOT A FIELD ON `DialogContext`. Most dialogs spread
 * `useDialogContext()` straight into Mantine's `<Modal>`, which forwards unknown props
 * to the DOM — an id there would land as a stray attribute on every modal.
 */
export const DialogIdContext = createContext<Dialog['id'] | undefined>(undefined);
export const useDialogId = () => useContext(DialogIdContext);
