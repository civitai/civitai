import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { MobileMenuDrawer } from '~/components/Drawer/MobileMenuDrawer';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import type * as IsMobile from '~/hooks/useIsMobile';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';
import { historyLayersSettled, resetHistoryLayers } from '~/utils/history-layers';

// The sort menu opens its drawer on a phone; the test browser's width can't say so.
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof IsMobile>()),
  useIsMobile: () => true,
}));

function Sheet() {
  const [opened, setOpened] = useState(true);
  return (
    <MobileMenuDrawer opened={opened} onClose={() => setOpened(false)} title="Sort">
      <p>Sheet content</p>
    </MobileMenuDrawer>
  );
}

beforeEach(() => {
  // An entry of the test page's own under the sheet's: Back lands here, never off the page.
  history.pushState(history.state, '');
});
afterEach(async () => {
  await historyLayersSettled();
  resetHistoryLayers();
  useMobileGeneratorStore.setState({ showing: false });
});

describe('MobileMenuDrawer', () => {
  test('over the mobile generator, Back closes it', async () => {
    useMobileGeneratorStore.setState({ showing: true });
    renderWithProviders(<Sheet />);
    const content = page.getByText('Sheet content');
    await expect.element(content).toBeInTheDocument();
    history.back();
    await expect.element(content).not.toBeInTheDocument();
  });

  test('anywhere else, Back is left alone', async () => {
    renderWithProviders(<Sheet />);
    const content = page.getByText('Sheet content');
    await expect.element(content).toBeInTheDocument();
    const popped = new Promise((resolve) => addEventListener('popstate', resolve, { once: true }));
    history.back();
    await popped;
    await expect.element(content).toBeInTheDocument();
  });

  test("the sort menu's sheet marks the current sort and closes on a choice", async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <SelectMenuV2
        label="Newest"
        value="Newest"
        onClick={onClick}
        options={[
          { label: 'Newest', value: 'Newest' },
          { label: 'Oldest', value: 'Oldest' },
        ]}
      />
    );
    await page.getByRole('button', { name: /Newest/ }).click();
    await expect
      .element(page.getByRole('menuitemradio', { name: 'Newest' }))
      .toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitemradio', { name: 'Oldest' }).click();
    expect(onClick).toHaveBeenCalledWith('Oldest');
    await expect
      .element(page.getByRole('menuitemradio', { name: 'Oldest' }))
      .not.toBeInTheDocument();
  });
});
