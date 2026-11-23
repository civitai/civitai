import { Modal } from '@mantine/core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { DialogProvider, useDialogContext } from '~/components/Dialog/DialogProvider';
import { openConfirm } from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import { openDialog } from '~/components/Dialog/openDialog';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';
import { historyLayersSettled, resetHistoryLayers } from '~/utils/history-layers';

function TestDialog() {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} title="Lightbox">
      Image
    </Modal>
  );
}

const openLightbox = async () => {
  renderWithProviders(<DialogProvider />);
  dialogStore.trigger({ component: TestDialog });
  await expect.element(page.getByRole('dialog', { name: 'Lightbox' })).toBeInTheDocument();
};

function NamedDialog({ name }: { name: string }) {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} title={name}>
      {name}
    </Modal>
  );
}

describe('DialogProvider and Escape', () => {
  beforeEach(() => dialogStore.closeAll());

  test('closes only the dialog opened last, one press at a time', async () => {
    renderWithProviders(<DialogProvider />);
    dialogStore.trigger({ component: NamedDialog, props: { name: 'First' }, id: 'first' });
    dialogStore.trigger({ component: NamedDialog, props: { name: 'Second' }, id: 'second' });
    await expect.element(page.getByRole('dialog', { name: 'Second' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByRole('dialog', { name: 'Second' })).not.toBeInTheDocument();
    await expect.element(page.getByRole('dialog', { name: 'First' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByRole('dialog', { name: 'First' })).not.toBeInTheDocument();
  });

  // A dialog that compared the open count with the count at its own mount took itself for the top
  // once a dialog below it closed, so the next Escape closed it along with the real top.
  test('still closes only the last one after a dialog below it closed', async () => {
    renderWithProviders(<DialogProvider />);
    dialogStore.trigger({ component: NamedDialog, props: { name: 'First' }, id: 'first' });
    dialogStore.trigger({ component: NamedDialog, props: { name: 'Second' }, id: 'second' });
    await expect.element(page.getByRole('dialog', { name: 'Second' })).toBeInTheDocument();
    dialogStore.closeById('first');
    dialogStore.trigger({ component: NamedDialog, props: { name: 'Third' }, id: 'third' });
    await expect.element(page.getByRole('dialog', { name: 'Third' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByRole('dialog', { name: 'Third' })).not.toBeInTheDocument();
    await expect.element(page.getByRole('dialog', { name: 'Second' })).toBeInTheDocument();
  });
});

describe('DialogProvider and closing', () => {
  beforeEach(() => dialogStore.closeAll());

  const waitAFewFrames = () => new Promise((resolve) => setTimeout(resolve, 60));

  test('a closed dialog plays its exit transition, then unmounts', async () => {
    renderWithProviders(<DialogProvider />);
    dialogStore.trigger({ component: NamedDialog, props: { name: 'Leaving' }, id: 'leaving' });
    await expect.element(page.getByRole('dialog', { name: 'Leaving' })).toBeInTheDocument();

    dialogStore.closeById('leaving');
    // Closed at once for everything that reads the store...
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    await waitAFewFrames();
    // ...but still on screen while Mantine's exit transition runs, rather than unmounted at once.
    expect(document.body.textContent).toContain('Leaving');
    // Removed when the Modal reports the transition ended, before the fallback timer.
    await vi.waitFor(() => expect(useDialogStore.getState().closing).toHaveLength(0), {
      timeout: 800,
    });
    await expect.element(page.getByRole('dialog', { name: 'Leaving' })).not.toBeInTheDocument();
  });

  test('Escape goes to the dialog below while the one above is still closing', async () => {
    renderWithProviders(<DialogProvider />);
    dialogStore.trigger({ component: NamedDialog, props: { name: 'Below' }, id: 'below' });
    dialogStore.trigger({ component: NamedDialog, props: { name: 'Above' }, id: 'above' });
    await expect.element(page.getByRole('dialog', { name: 'Above' })).toBeInTheDocument();

    dialogStore.closeById('above');
    await waitAFewFrames();
    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByRole('dialog', { name: 'Below' })).not.toBeInTheDocument();
  });

  test('a dialog reopened under the same id while closing opens again', async () => {
    renderWithProviders(<DialogProvider />);
    dialogStore.trigger({ component: NamedDialog, props: { name: 'Again' }, id: 'again' });
    await expect.element(page.getByRole('dialog', { name: 'Again' })).toBeInTheDocument();

    dialogStore.closeById('again');
    dialogStore.trigger({ component: NamedDialog, props: { name: 'Again' }, id: 'again' });
    await vi.waitFor(() => expect(useDialogStore.getState().closing).toHaveLength(0), {
      timeout: 2000,
    });
    expect(useDialogStore.getState().dialogs).toHaveLength(1);
    await expect.element(page.getByRole('dialog', { name: 'Again' })).toBeInTheDocument();
  });
});

describe('openDialog and openConfirm', () => {
  beforeEach(() => dialogStore.closeAll());

  test('a dialog whose module fails to load closes, runs onClose, and the page stays', async () => {
    renderWithProviders(
      <>
        <p>Page content</p>
        <DialogProvider />
      </>
    );
    const onClose = vi.fn();
    openDialog(
      () => Promise.reject(new Error('chunk failed')) as Promise<{ default: () => null }>,
      {},
      { onClose }
    );
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(0));
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText('Page content')).toBeInTheDocument();
  });

  test('a pending confirm ignores a second click, whatever loading the caller passed', async () => {
    renderWithProviders(<DialogProvider />);
    let finish = () => undefined as void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    openConfirm({ message: 'Report it?', onConfirm, confirmProps: { loading: false } });

    const confirm = page.getByRole('button', { name: 'Confirm' });
    await confirm.click();
    // A real second click: the DOM ignores a click on a disabled button, so this runs onConfirm
    // again unless the button is disabled while the first one is pending.
    (confirm.element() as HTMLButtonElement).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    finish();
    await expect.element(page.getByText('Report it?')).not.toBeInTheDocument();
  });

  test('a confirm runs onClose once, after onConfirm, and once on Escape', async () => {
    renderWithProviders(<DialogProvider />);
    const calls: string[] = [];
    openConfirm({
      message: 'Spend Buzz?',
      onConfirm: () => calls.push('confirm'),
      onCancel: () => calls.push('cancel'),
      onClose: () => calls.push('close'),
    });
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect.element(page.getByText('Spend Buzz?')).not.toBeInTheDocument();
    expect(calls).toEqual(['confirm', 'close']);

    calls.length = 0;
    openConfirm({
      message: 'Spend Buzz again?',
      onCancel: () => calls.push('cancel'),
      onClose: () => calls.push('close'),
    });
    await expect.element(page.getByText('Spend Buzz again?')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByText('Spend Buzz again?')).not.toBeInTheDocument();
    expect(calls).toEqual(['cancel', 'close']);
  });
});

describe('DialogProvider and Back', () => {
  beforeEach(async () => {
    await historyLayersSettled();
    resetHistoryLayers();
    dialogStore.closeAll();
  });

  test('over the mobile generator, Back closes the dialog', async () => {
    useMobileGeneratorStore.setState({ showing: true });
    // An entry of the test page's own under the layer: without the layer, Back fails the test here
    // instead of leaving the page.
    history.pushState(history.state, '');
    await openLightbox();
    history.back();
    await expect.element(page.getByRole('dialog', { name: 'Lightbox' })).not.toBeInTheDocument();
  });

  test('elsewhere a dialog takes no history entry', async () => {
    useMobileGeneratorStore.setState({ showing: false });
    const length = history.length;
    await openLightbox();
    expect(history.length).toBe(length);
  });
});
