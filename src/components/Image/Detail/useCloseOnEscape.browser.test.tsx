import { Menu, Modal, Popover } from '@mantine/core';
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

function Detail({ nudge = false }: { nudge?: boolean }) {
  useCloseOnEscape(close);
  const [modal, setModal] = useState(false);
  const [popover, setPopover] = useState(false);
  const [late, setLate] = useState(false);
  return (
    <>
      <button type="button">page</button>
      {/* A closed overlay kept in the DOM must not count as open. */}
      <div role="dialog" style={{ display: 'none' }} />
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
            <span data-testid="hat-face">face</span>
          </button>
        </Popover.Target>
        <Popover.Dropdown>
          <button type="button">in popover</button>
        </Popover.Dropdown>
      </Popover>
      {/* An unrelated control that carries aria-controls and brings a passive popover up afterwards. */}
      <button type="button" aria-controls="somewhere-else" onClick={() => setLate(true)}>
        other
      </button>
      {late && (
        <Popover opened withinPortal transitionProps={{ duration: 0 }}>
          <Popover.Target>
            <span>late</span>
          </Popover.Target>
          <Popover.Dropdown>
            <span>late nudge</span>
          </Popover.Dropdown>
        </Popover>
      )}
      {/* A passive nudge: opened by the app, never by the user. */}
      {nudge && (
        <Popover opened withinPortal transitionProps={{ duration: 0 }}>
          <Popover.Target>
            <button type="button">nudge</button>
          </Popover.Target>
          <Popover.Dropdown>
            <button type="button">in nudge</button>
          </Popover.Dropdown>
        </Popover>
      )}
      <Menu transitionProps={{ duration: 0 }}>
        <Menu.Target>
          <button type="button">more</button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item>share</Menu.Item>
        </Menu.Dropdown>
      </Menu>
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

  test('leaves the page open while a menu is open', async () => {
    renderWithProviders(<Detail />);
    await page.getByRole('button', { name: 'more' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'share' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
  });

  test('closes the page with a passive popover visible on load', async () => {
    renderWithProviders(<Detail nudge />);
    await expect.element(page.getByRole('button', { name: 'in nudge' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('closes the page after a click elsewhere with a passive popover visible', async () => {
    renderWithProviders(<Detail nudge />);
    await page.getByRole('button', { name: 'page' }).click();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('closes the page after tabbing past a passive popover trigger', async () => {
    renderWithProviders(<Detail nudge />);
    await expect.element(page.getByRole('button', { name: 'in nudge' })).toBeVisible();
    (page.getByRole('button', { name: 'nudge', exact: true }).element() as HTMLElement).focus();
    await userEvent.keyboard('{Tab}');
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('closes the page after clicking the anchor of an already-open passive popover', async () => {
    renderWithProviders(<Detail nudge />);
    await expect.element(page.getByRole('button', { name: 'in nudge' })).toBeVisible();
    await page.getByRole('button', { name: 'nudge', exact: true }).click();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('an overlay holding focus blocks Escape without any pointer or key interaction', async () => {
    renderWithProviders(<Detail nudge />);
    await expect.element(page.getByRole('button', { name: 'in nudge' })).toBeVisible();
    (page.getByRole('button', { name: 'in nudge' }).element() as HTMLElement).focus();
    await userEvent.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
  });

  test('an overlay the user clicked inside blocks Escape after focus moves away', async () => {
    renderWithProviders(<Detail nudge />);
    await page.getByRole('button', { name: 'in nudge' }).click();
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
  });

  test('a control with another id in aria-controls does not engage a popover that appears after it', async () => {
    renderWithProviders(<Detail />);
    await page.getByRole('button', { name: 'other' }).click();
    await expect.element(page.getByText('late nudge')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('a click on a child of the trigger still counts as opening its popover', async () => {
    renderWithProviders(<Detail />);
    await page.getByTestId('hat-face').click();
    await expect.element(page.getByRole('button', { name: 'in popover' })).toBeVisible();
    (page.getByRole('button', { name: 'hat' }).element() as HTMLElement).focus();
    await userEvent.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
  });

  test.each(['{Enter}', ' '])(
    'a menu opened from the keyboard with "%s" blocks Escape',
    async (key) => {
      renderWithProviders(<Detail />);
      await expect.element(page.getByRole('button', { name: 'more' })).toBeVisible();
      (page.getByRole('button', { name: 'more' }).element() as HTMLElement).focus();
      await userEvent.keyboard(key);
      await expect.element(page.getByRole('menuitem', { name: 'share' })).toBeVisible();
      (page.getByRole('button', { name: 'more' }).element() as HTMLElement).focus();
      await userEvent.keyboard('{Escape}');
      expect(close).not.toHaveBeenCalled();
    }
  );

  test('a menu the user opened still blocks Escape beside a passive popover', async () => {
    renderWithProviders(<Detail nudge />);
    await page.getByRole('button', { name: 'more' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'share' })).toBeVisible();
    (page.getByRole('button', { name: 'more' }).element() as HTMLElement).focus();
    await userEvent.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
  });

  test('closes the page once the user has toggled their popover closed', async () => {
    renderWithProviders(<Detail nudge />);
    await page.getByRole('button', { name: 'hat' }).click();
    await expect.element(page.getByRole('button', { name: 'in popover' })).toBeVisible();
    await page.getByRole('button', { name: 'hat' }).click();
    await expect.element(page.getByRole('button', { name: 'in popover' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('a popover the user opened blocks Escape beside a passive one, focus on its trigger', async () => {
    renderWithProviders(<Detail nudge />);
    await page.getByRole('button', { name: 'hat' }).click();
    await expect.element(page.getByRole('button', { name: 'in popover' })).toBeVisible();
    (page.getByRole('button', { name: 'hat' }).element() as HTMLElement).focus();
    await userEvent.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
  });

  test('leaves closing to the modal when the detail is inside one', async () => {
    dialog.opened = true;
    renderWithProviders(<Detail />);
    await page.getByRole('button', { name: 'page' }).click();
    await userEvent.keyboard('{Escape}');
    expect(close).not.toHaveBeenCalled();
  });
});
