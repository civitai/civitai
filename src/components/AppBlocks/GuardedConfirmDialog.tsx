import { useEffect, useState } from 'react';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { useDialogId } from '~/components/Dialog/DialogProvider';
import { useIsTopDialog } from '~/components/Dialog/dialogStore';

/** How long a spend confirm stays disabled after it appears, or after the page regains focus. */
export const CONFIRM_ARM_DELAY_MS = 1000;

/**
 * `true` once the dialog has been the one in front, in a focused and visible page, for
 * `delayMs` without interruption. It starts `false`, and goes back to `false` whenever
 * the window loses focus, the tab is hidden, or the dialog stops being in front
 * (`active` is false — another dialog opened over it). The WHOLE delay starts again
 * when the page comes back or the dialog is in front again.
 *
 * An ordinary safety measure for a button that spends Buzz: the viewer gets a moment to
 * read what the dialog says before it can be confirmed — including when they return to
 * the page, and when the dialog only becomes visible because one above it closed.
 */
export function useConfirmArmDelay(delayMs: number = CONFIRM_ARM_DELAY_MS, active = true): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      setArmed(false);
    };
    // Time spent behind another dialog never counts: nothing is scheduled, and no
    // focus or visibility event can start the wait, until this one is in front.
    if (!active) {
      disarm();
      return;
    }
    const arm = () => {
      disarm();
      timer = setTimeout(() => setArmed(true), delayMs);
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? arm() : disarm());
    arm();
    window.addEventListener('blur', disarm);
    window.addEventListener('focus', arm);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('blur', disarm);
      window.removeEventListener('focus', arm);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [delayMs, active]);
  return armed;
}

/**
 * `ConfirmDialog` for a host-chrome confirm that SPENDS the viewer's Buzz (a training
 * run, a confirmed step): identical, except the confirm button is disabled until
 * `useConfirmArmDelay` arms it. Cancel, the close button and Escape are never delayed.
 *
 * The delay runs only while this is the top-most dialog — the LAST entry in the dialog
 * store (`useIsTopDialog`). Every open dialog is mounted at once, so one that is covered
 * by another would otherwise finish its wait unseen and be confirmable the instant it
 * is uncovered. It is an identity check, not a count: it stays right when a dialog
 * underneath closes or a further one opens on top.
 */
export default function GuardedConfirmDialog(props: React.ComponentProps<typeof ConfirmDialog>) {
  const dialogId = useDialogId();
  const isTopMost = useIsTopDialog(dialogId);
  const armed = useConfirmArmDelay(CONFIRM_ARM_DELAY_MS, isTopMost);
  return <ConfirmDialog {...props} confirmProps={{ ...props.confirmProps, disabled: !armed }} />;
}
