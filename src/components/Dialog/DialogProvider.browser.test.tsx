import { Modal } from '@mantine/core';
import { beforeEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { DialogProvider, useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
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

const openDialog = async () => {
  renderWithProviders(<DialogProvider />);
  dialogStore.trigger({ component: TestDialog });
  await expect.element(page.getByRole('dialog', { name: 'Lightbox' })).toBeInTheDocument();
};

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
    await openDialog();
    history.back();
    await expect.element(page.getByRole('dialog', { name: 'Lightbox' })).not.toBeInTheDocument();
  });

  test('elsewhere a dialog takes no history entry', async () => {
    useMobileGeneratorStore.setState({ showing: false });
    const length = history.length;
    await openDialog();
    expect(history.length).toBe(length);
  });
});
