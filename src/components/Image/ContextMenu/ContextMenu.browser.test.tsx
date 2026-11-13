// The real cascade: the dropdown's size and scroll come from Mantine's styles.
import '../../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { ContextMenu } from '~/components/Image/ContextMenu/ContextMenu';
import { Menu } from '~/components/MantineOverlays';

const items = (count: number) =>
  Array.from({ length: count }, (_, i) => <Menu.Item key={i}>{`Action ${i + 1}`}</Menu.Item>);

describe("a card's ⋯ menu", () => {
  test('a menu taller than the room above and below stays inside the window and scrolls', async () => {
    await page.viewport(390, 600);
    await renderWithProviders(
      <div style={{ paddingTop: 380 }}>
        <ContextMenu>{items(30)}</ContextMenu>
      </div>
    );

    await userEvent.click(page.getByRole('button', { name: 'More options' }));
    const menu = page.getByRole('menu');
    await expect.element(menu).toBeVisible();

    const box = menu.element().getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
    // The first and the last item are both reachable inside it.
    for (const name of ['Action 1', 'Action 30']) {
      const item = page.getByRole('menuitem', { name, exact: true });
      (item.element() as HTMLElement).scrollIntoView({ block: 'nearest' });
      const itemBox = item.element().getBoundingClientRect();
      expect(itemBox.top).toBeGreaterThanOrEqual(0);
      expect(itemBox.bottom).toBeLessThanOrEqual(window.innerHeight);
    }
  });

  test('a short menu opens as before, below its button', async () => {
    await page.viewport(390, 600);
    await renderWithProviders(<ContextMenu>{items(3)}</ContextMenu>);

    const trigger = page.getByRole('button', { name: 'More options' });
    await userEvent.click(trigger);
    const menu = page.getByRole('menu');
    await expect.element(menu).toBeVisible();

    expect(menu.element().getBoundingClientRect().top).toBeGreaterThan(
      trigger.element().getBoundingClientRect().bottom
    );
    const list = menu.element().querySelector('[data-context-menu-scroll]') ?? menu.element();
    expect(list.scrollHeight).toBe(list.clientHeight);
  });
});
