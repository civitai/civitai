import React, {
  createContext,
  memo,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Dialog } from '~/components/Dialog/dialogStore';
import { DialogIdContext, useDialogId } from '~/components/Dialog/dialogId';
import { dialogStore, useDialogStore, useIsTopDialog } from '~/components/Dialog/dialogStore';
import { useHistoryLayer } from '~/hooks/useHistoryLayer';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';

type DialogState = {
  opened: boolean;
  onClose: () => void;
  zIndex?: number;
  target?: string | HTMLElement;
  focused?: 'true';
  closeOnEscape?: boolean;
  /** Mantine's `Modal`/`Drawer` call this when their exit transition ends; the spread passes it on. */
  onExitTransitionEnd?: () => void;
  /**
   * Both set while the dialog plays its exit transition; the spread puts them on the Modal's root.
   * `inert` stops clicks and focus (a string, as React 18 needs for the attribute); `aria-hidden`
   * takes it out of the accessibility tree, which role queries (Playwright's included) read, as
   * `inert` alone does not for them. A reopened copy is then the only one anyone finds.
   */
  inert?: '';
  'aria-hidden'?: true;
};

/** Dialogs stack from here, one level per open dialog. */
export const DIALOG_Z_INDEX = 300;
/**
 * Over every open dialog (far more than ever stack) and under Mantine's notifications (400), for a
 * surface a dialog must never dim: the music player.
 */
export const ABOVE_DIALOGS_Z_INDEX = DIALOG_Z_INDEX + 50;

/** How long a closing dialog that never reports the end of its exit transition stays mounted. */
const exitFallbackMs = 1000;

const DialogContext = createContext<DialogState>({
  opened: false,
  onClose: () => undefined,
});
export const useDialogContext = () => useContext(DialogContext);
export { useDialogId };

const DialogProviderInner = memo(function DialogProviderInner({
  dialog,
  index,
  closing,
}: {
  dialog: Dialog;
  index: number;
  closing: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  const opened = mounted && !closing;
  const isTopDialog = useIsTopDialog(dialog.id) && !closing;
  // A closing dialog keeps the layer it had while open, so it doesn't drop behind its exit.
  const zIndexRef = useRef(DIALOG_Z_INDEX + index);
  if (!closing) zIndexRef.current = DIALOG_Z_INDEX + index;

  const Dialog = dialog.component;

  function onClose() {
    if (closing) return;
    dialog.options?.onClose?.();
    dialogStore.closeById(dialog.id);
  }

  function onExitTransitionEnd() {
    if (closing && dialog.instance !== undefined) dialogStore.removeClosing(dialog.instance);
  }

  useEffect(() => {
    setTimeout(() => {
      setMounted(true);
    }, 0);
  }, []);

  useEffect(() => {
    if (!closing || dialog.instance === undefined) return;
    const instance = dialog.instance;
    const timeout = setTimeout(() => dialogStore.removeClosing(instance), exitFallbackMs);
    return () => clearTimeout(timeout);
  }, [closing, dialog.instance]);

  // Over the mobile generator, Back closes the dialog first. Routed dialogs have their own entry.
  const overMobileGenerator = useMobileGeneratorStore((state) => state.showing);
  useHistoryLayer(opened, onClose, overMobileGenerator && dialog.type !== 'routed-dialog');

  return (
    <DialogContext.Provider
      value={{
        opened,
        onClose,
        zIndex: zIndexRef.current,
        target: dialog.target,
        closeOnEscape: isTopDialog,
        onExitTransitionEnd,
        inert: closing ? '' : undefined,
        'aria-hidden': closing ? true : undefined,
      }}
    >
      <DialogIdContext.Provider value={dialog.id}>
        {/* `openDialog` opens a React.lazy component; it renders once its module loads. */}
        <Suspense fallback={null}>
          <Dialog {...dialog.props} />
        </Suspense>
      </DialogIdContext.Provider>
    </DialogContext.Provider>
  );
});

export const DialogProvider = () => {
  const dialogs = useDialogStore((state) => state.dialogs);
  const closing = useDialogStore((state) => state.closing);
  // One keyed list, so a dialog keeps its state (and its Modal its transition) as it moves from
  // open to closing.
  const entries = [
    ...closing.map((dialog) => ({ dialog, index: 0, closing: true })),
    ...dialogs.map((dialog, index) => ({ dialog, index, closing: false })),
  ];
  return (
    <>
      {entries.map(({ dialog, index, closing }) => (
        <DialogProviderInner
          key={dialog.instance}
          dialog={dialog}
          index={index}
          closing={closing}
        />
      ))}
    </>
  );
};
