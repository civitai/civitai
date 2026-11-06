import { useHotkeys, useWindowEvent } from '@mantine/hooks';
import { useCallback, useRef } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

// Mantine renders Modal content and Popover dropdowns as role="dialog" and Menu dropdowns as
// role="menu"; Combobox targets and some custom popovers carry data-mantine-stop-propagation.
const OPEN_OVERLAY = '[role="dialog"], [role="menu"], [data-mantine-stop-propagation]';
const hasOpenOverlay = () =>
  Array.from(document.querySelectorAll(OPEN_OVERLAY)).some((el) => el.getClientRects().length > 0);

/**
 * Escape closes the standalone detail page, unless it is meant for an overlay. Inside a dialog the
 * modal already closes on Escape, and a second close would navigate back twice.
 */
export function useCloseOnEscape(close: () => void) {
  const { opened: inDialog } = useDialogContext();

  // Read before any overlay handles the key: one that closes itself on Escape may already be gone
  // from the DOM by the time the hotkey below runs. Registered on mount, so ahead of any overlay
  // opened later; a listener that changed identity would re-register behind them.
  const overlayWasOpen = useRef(false);
  const snapshot = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') overlayWasOpen.current = hasOpenOverlay();
  }, []);
  useWindowEvent('keydown', snapshot, { capture: true });

  useHotkeys(
    inDialog
      ? []
      : [
          [
            // @mantine/hooks matches a pressed Escape only as 'esc'; a binding written 'Escape' never fires.
            'esc',
            (event) => {
              if (event.isComposing || overlayWasOpen.current) return;
              close();
            },
            { preventDefault: false },
          ],
        ]
  );
}
