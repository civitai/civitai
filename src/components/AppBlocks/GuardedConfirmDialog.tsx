import { useEffect, useState } from 'react';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';

/** How long a spend confirm stays disabled after it appears, or after the page regains focus. */
export const CONFIRM_ARM_DELAY_MS = 1000;

/**
 * `true` once the dialog has been on screen, in a focused and visible page, for
 * `delayMs`. It starts `false`, and goes back to `false` whenever the window loses
 * focus or the tab is hidden; the delay restarts when the page comes back.
 *
 * An ordinary safety measure for a button that spends Buzz: the viewer gets a moment to
 * read what the dialog says before it can be confirmed, including when they return to
 * the page from somewhere else.
 */
export function useConfirmArmDelay(delayMs: number = CONFIRM_ARM_DELAY_MS): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      setArmed(false);
    };
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
  }, [delayMs]);
  return armed;
}

/**
 * `ConfirmDialog` for a host-chrome confirm that SPENDS the viewer's Buzz (a training
 * run, a confirmed step): identical, except the confirm button is disabled until
 * `useConfirmArmDelay` arms it. Cancel, the close button and Escape are never delayed.
 */
export default function GuardedConfirmDialog(props: React.ComponentProps<typeof ConfirmDialog>) {
  const armed = useConfirmArmDelay();
  return <ConfirmDialog {...props} confirmProps={{ ...props.confirmProps, disabled: !armed }} />;
}
