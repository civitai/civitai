import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as DialogProviderModule from '~/components/Dialog/DialogProvider';
import { useCloseOnEscape } from '~/components/Image/Detail/useCloseOnEscape';
import { renderWithProviders } from '../../../../test/component-setup';

const dialog = vi.hoisted(() => ({ opened: false }));
vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogProviderModule>()),
  useDialogContext: () => ({ opened: dialog.opened, onClose: () => undefined }),
}));

function Detail({ close }: { close: () => void }) {
  useCloseOnEscape(close);
  return (
    <>
      <button type="button">page</button>
      <div data-mantine-stop-propagation>
        <button type="button">popover</button>
      </div>
    </>
  );
}

beforeEach(() => {
  dialog.opened = false;
});

describe('Escape on the image detail', () => {
  // Pins the binding name: written 'Escape', @mantine/hooks never matches a real Escape key.
  test('closes the standalone page on a real Escape keypress', async () => {
    const close = vi.fn();
    renderWithProviders(<Detail close={close} />);
    await page.getByRole('button', { name: 'page' }).click();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('leaves the page open when Escape is meant for an open popover', async () => {
    const close = vi.fn();
    renderWithProviders(<Detail close={close} />);
    await page.getByRole('button', { name: 'popover' }).click();
    await userEvent.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
  });

  test('leaves closing to the modal when the detail is inside one', async () => {
    dialog.opened = true;
    const close = vi.fn();
    renderWithProviders(<Detail close={close} />);
    await page.getByRole('button', { name: 'page' }).click();
    await userEvent.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
  });
});
