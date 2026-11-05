import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { HighlightedBadgesInput } from '~/components/Profile/HighlightedBadgesInput';

/**
 * A pinned badge the user no longer owns has no tile, so it must not take a pin number:
 * the numbers on the visible tiles stay 1, 2, 3.
 */
const badges = [
  { id: 1, name: 'One', data: { url: 'one.png' } },
  { id: 2, name: 'Two', data: { url: 'two.png' } },
  { id: 3, name: 'Three', data: { url: 'three.png' } },
];

describe('HighlightedBadgesInput', () => {
  test('numbers pins consecutively when a saved id is no longer owned', async () => {
    // 99 is saved between two owned badges but has no tile. Pick order differs from tile order.
    await renderWithProviders(
      <HighlightedBadgesInput badges={badges} value={[3, 99, 1, 2]} onChange={vi.fn()} />
    );
    await expect.element(page.getByRole('button', { name: 'Three' })).toHaveTextContent('1');
    await expect.element(page.getByRole('button', { name: 'One' })).toHaveTextContent('2');
    await expect.element(page.getByRole('button', { name: 'Two' })).toHaveTextContent('3');
  });

  const siblings = [
    { id: 10, name: 'Placer', data: { url: 'sticker.png' } },
    { id: 11, name: 'Maker', data: { url: 'sticker.png' } },
    { id: 12, name: 'Other', data: { url: 'other.png' } },
  ];

  test('one tile per image; it shows pinned when only the sibling is pinned', async () => {
    await renderWithProviders(
      <HighlightedBadgesInput badges={siblings} value={[11]} onChange={vi.fn()} />
    );
    await expect.element(page.getByRole('button', { name: 'Placer' })).toHaveTextContent('1');
    expect(page.getByRole('button').elements()).toHaveLength(2);
  });

  test('clicking the tile unpins a pinned sibling and keeps other pins', async () => {
    const onChange = vi.fn();
    await renderWithProviders(
      <HighlightedBadgesInput badges={siblings} value={[12, 11]} onChange={onChange} />
    );
    await page.getByRole('button', { name: 'Placer' }).click();
    expect(onChange).toHaveBeenCalledWith([12]);
  });

  test('unpin clears every sibling id and leaves an unowned id alone', async () => {
    const onChange = vi.fn();
    await renderWithProviders(
      <HighlightedBadgesInput badges={siblings} value={[99, 10, 11]} onChange={onChange} />
    );
    await page.getByRole('button', { name: 'Placer' }).click();
    expect(onChange).toHaveBeenCalledWith([99]);
  });

  test('pinning an unpinned tile adds only its first id', async () => {
    const onChange = vi.fn();
    await renderWithProviders(
      <HighlightedBadgesInput badges={siblings} value={[12]} onChange={onChange} />
    );
    await page.getByRole('button', { name: 'Placer' }).click();
    expect(onChange).toHaveBeenCalledWith([12, 10]);
  });

  test('hide variant: unhiding clears every hidden sibling id', async () => {
    const onChange = vi.fn();
    await renderWithProviders(
      <HighlightedBadgesInput variant="hide" badges={siblings} value={[11]} onChange={onChange} />
    );
    await page.getByRole('button', { name: 'Placer' }).click();
    expect(onChange).toHaveBeenCalledWith([]);
  });

  test('a badge with no image gets no tile', async () => {
    await renderWithProviders(
      <HighlightedBadgesInput
        badges={[...siblings, { id: 13, name: 'Imageless', data: null }]}
        value={[]}
        onChange={vi.fn()}
      />
    );
    expect(page.getByRole('button', { name: 'Imageless' }).elements()).toHaveLength(0);
    expect(page.getByRole('button').elements()).toHaveLength(2);
  });

  test('owning only image-less badges shows the empty message', async () => {
    await renderWithProviders(
      <HighlightedBadgesInput
        badges={[{ id: 13, name: 'Imageless', data: null }]}
        value={[]}
        onChange={vi.fn()}
      />
    );
    await expect.element(page.getByText("You don't have any badges yet.")).toBeVisible();
  });
});
