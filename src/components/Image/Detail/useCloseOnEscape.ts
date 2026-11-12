import { useHotkeys, useWindowEvent } from '@mantine/hooks';
import { useCallback, useRef } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

// Mantine renders Modal content and Popover dropdowns as role="dialog" and Menu dropdowns as
// role="menu"; Combobox targets and some custom popovers carry data-mantine-stop-propagation.
const OPEN_OVERLAY = '[role="dialog"], [role="menu"], [data-mantine-stop-propagation]';

const visibleOverlays = () =>
  Array.from(document.querySelectorAll(OPEN_OVERLAY)).filter(
    (el) => el.getClientRects().length > 0
  );

type Interaction = { target: Element; openBefore: Element[] };

// Passive popovers (birthday nudges) are role="dialog" too and are visible on load, so only an
// overlay the user is engaged with may swallow Escape: it holds focus, the user's last pointer or
// key interaction was inside it, or that interaction was on its trigger (Mantine sets the trigger's
// aria-controls) and opened it. A trigger that was already showing an overlay is not what opened
// it, e.g. a nudge anchored to a button that does something else.
const isEngaged = (overlay: Element, last: Interaction | null) => {
  if (overlay.contains(document.activeElement)) return true;
  if (!last) return false;
  if (overlay.contains(last.target)) return true;
  const controls = last.target.closest('[aria-controls]')?.getAttribute('aria-controls');
  return !!overlay.id && controls === overlay.id && !last.openBefore.includes(overlay);
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
  const lastInteracted = useRef<Interaction | null>(null);
  const record = useCallback((event: Event) => {
    if (event.target instanceof Element) {
      lastInteracted.current = { target: event.target, openBefore: visibleOverlays() };
    }
  }, []);
  const snapshot = useCallback(
    (event: KeyboardEvent) => {
      // Only Enter and Space activate a trigger; the target of Tab is the element focus is leaving.
      if (event.key === 'Enter' || event.key === ' ') return record(event);
      if (event.key !== 'Escape') return;
      overlayWasOpen.current = visibleOverlays().some((el) =>
        isEngaged(el, lastInteracted.current)
      );
    },
    [record]
  );
  useWindowEvent('keydown', snapshot, { capture: true });
  useWindowEvent('pointerdown', record, { capture: true });

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
