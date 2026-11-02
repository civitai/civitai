import { useHotkeys } from '@mantine/hooks';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

/**
 * Escape closes the standalone detail page. Inside a dialog the modal already closes on Escape, and
 * a second close would navigate back twice.
 */
export function useCloseOnEscape(close: () => void) {
  const { opened: inDialog } = useDialogContext();
  useHotkeys(
    inDialog
      ? []
      : [
          [
            // @mantine/hooks matches a pressed Escape only as 'esc'; a binding written 'Escape' never fires.
            'esc',
            (event) => {
              // An open popover, menu or combobox marks itself so Escape closes only it.
              const target = event.target instanceof Element ? event.target : null;
              if (event.isComposing || target?.closest('[data-mantine-stop-propagation]')) return;
              close();
            },
            { preventDefault: false },
          ],
        ]
  );
}
