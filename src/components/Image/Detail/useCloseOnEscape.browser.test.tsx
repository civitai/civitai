import { Modal, Popover } from '@mantine/core';
import { useState } from 'react';
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

const close = vi.fn();
const modalClosed = vi.fn();

function Detail() {
  useCloseOnEscape(close);
  const [modal, setModal] = useState(false);
  const [popover, setPopover] = useState(false);
  return (
    <>
      <button type="button">page</button>
      <button type="button" onClick={() => setModal(true)}>
        report
      </button>
      {/* Mounted on open, as dialogStore dialogs are; no exit transition, the hardest case. */}
      {modal && (
        <Modal
          opened
          onClose={() => {
            modalClosed();
            setModal(false);
          }}
          transitionProps={{ duration: 0 }}
        >
          <button type="button">in modal</button>
        </Modal>
      )}
      <Popover opened={popover} onChange={setPopover} transitionProps={{ duration: 0 }}>
        <Popover.Target>
          <button type="button" onClick={() => setPopover((o) => !o)}>
            hat
          </button>
        </Popover.Target>
        <Popover.Dropdown>
          <button type="button">in popover</button>
        </Popover.Dropdown>
      </Popover>
    </>
  );
}

beforeEach(() => {
  dialog.opened = false;
  close.mockClear();
  modalClosed.mockClear();
});

describe('Escape on the image detail', () => {
  // Pins the binding name: written 'Escape', @mantine/hooks never matches a real Escape key.
  test('closes the standalone page on a real Escape keypress', async () => {
    renderWithProviders(<Detail />);
    await page.getByRole('button', { name: 'page' }).click();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('closes only a dialog opened over the page', async () => {
    renderWithProviders(<Detail />);
    await page.getByRole('button', { name: 'report' }).click();
    await page.getByRole('button', { name: 'in modal' }).click();
    await userEvent.keyboard('{Escape}');
    expect(modalClosed).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  test.each(['in popover', 'hat'])(
    'leaves the page open while a popover is open, focus on "%s"',
    async (focus) => {
      renderWithProviders(<Detail />);
      await page.getByRole('button', { name: 'hat' }).click();
      await expect.element(page.getByRole('button', { name: 'in popover' })).toBeVisible();
      (page.getByRole('button', { name: focus }).element() as HTMLElement).focus();
      await userEvent.keyboard('{Escape}');
      expect(close).not.toHaveBeenCalled();
    }
  );

  test('leaves closing to the modal when the detail is inside one', async () => {
    dialog.opened = true;
    renderWithProviders(<Detail />);
    await page.getByRole('button', { name: 'page' }).click();
    await userEvent.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
  });
});
