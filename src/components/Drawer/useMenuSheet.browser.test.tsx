import { Menu } from '@mantine/core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { useMenuSheet } from '~/components/Drawer/useMenuSheet';
import { useMobileGeneratorStore } from '~/store/mobile-generator.store';
import { historyLayersSettled, resetHistoryLayers } from '~/utils/history-layers';
import type * as MobileGenerator from '~/hooks/useMobileGenerator';

// The phone layout comes from the flag and media queries, which the test browser can't set.
vi.mock('~/hooks/useMobileGenerator', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileGenerator>()),
  useMobileGenerator: () => true,
}));

function TileMenu() {
  const menuSheet = useMenuSheet();
  return (
    <div style={{ position: 'absolute', top: 0, right: 0 }}>
      <Menu withinPortal {...menuSheet.menuProps}>
        <Menu.Target>
          <button>More</button>
        </Menu.Target>
        <Menu.Dropdown className={menuSheet.dropdownClassName}>
          {Array.from({ length: 20 }, (_, i) => (
            <Menu.Item key={i}>Action {i + 1}</Menu.Item>
          ))}
        </Menu.Dropdown>
        {menuSheet.backdrop}
      </Menu>
    </div>
  );
}

describe('useMenuSheet', () => {
  beforeEach(async () => {
    await historyLayersSettled();
    resetHistoryLayers();
    useMobileGeneratorStore.setState({ showing: true });
  });

  test('a long menu opened at the top of the screen sits on the bottom edge with its first item in view', async () => {
    renderWithProviders(<TileMenu />);
    await page.getByRole('button', { name: 'More' }).click();
    const first = page.getByRole('menuitem', { name: 'Action 1', exact: true });
    await expect.element(first).toBeVisible();

    const menu = first.element().closest('[role="menu"]') as HTMLElement;
    await expect.poll(() => Math.round(menu.getBoundingClientRect().bottom)).toBe(innerHeight);
    expect(first.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  });

  test('Back closes it', async () => {
    history.pushState(history.state, '');
    renderWithProviders(<TileMenu />);
    await page.getByRole('button', { name: 'More' }).click();
    await expect
      .element(page.getByRole('menuitem', { name: 'Action 1', exact: true }))
      .toBeVisible();

    history.back();
    await expect
      .element(page.getByRole('menuitem', { name: 'Action 1', exact: true }))
      .not.toBeInTheDocument();
  });
});
