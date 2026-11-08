import { useHotkeys, useWindowEvent } from '@mantine/hooks';
import { useCallback, useRef } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

// Mantine renders Modal content and Popover dropdowns as role="dialog" and Menu dropdowns as
// role="menu"; Combobox targets and some custom popovers carry data-mantine-stop-propagation.
const OPEN_OVERLAY = '[role="dialog"], [role="menu"], [data-mantine-stop-propagation]';

// Passive popovers (birthday nudges) are role="dialog" too and are visible on load, so only an
// overlay the user is engaged with may swallow Escape: it holds focus, or the user's last pointer
// or key interaction was inside it or on its trigger (Mantine sets the trigger's aria-controls).
const isEngaged = (overlay: Element, lastInteracted: Element | null) => {
  if (overlay.contains(document.activeElement)) return true;
  if (!lastInteracted) return false;
  if (overlay.contains(lastInteracted)) return true;
  const controls = lastInteracted.closest('[aria-controls]')?.getAttribute('aria-controls');
  return !!overlay.id && controls === overlay.id;
};

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
  const lastInteracted = useRef<Element | null>(null);
  const snapshot = useCallback((event: KeyboardEvent) => {
    // Only Enter and Space activate a trigger; the target of Tab is the element focus is leaving.
    if (event.key === 'Enter' || event.key === ' ') {
      if (event.target instanceof Element) lastInteracted.current = event.target;
      return;
    }
    if (event.key !== 'Escape') return;
    overlayWasOpen.current = Array.from(document.querySelectorAll(OPEN_OVERLAY)).some(
      (el) => el.getClientRects().length > 0 && isEngaged(el, lastInteracted.current)
    );
  }, []);
  const trackPointer = useCallback((event: PointerEvent) => {
    if (event.target instanceof Element) lastInteracted.current = event.target;
  }, []);
  useWindowEvent('keydown', snapshot, { capture: true });
  useWindowEvent('pointerdown', trackPointer, { capture: true });

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
