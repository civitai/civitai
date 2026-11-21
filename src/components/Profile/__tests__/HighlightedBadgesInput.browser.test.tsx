import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { HighlightedBadgesInput } from '~/components/Profile/HighlightedBadgesInput';

/**
 * A pinned badge the user no longer owns has no tile, so it must not take a pin number:
 * the numbers in the pin row stay 1, 2, 3. Numbers live only in the pin row; the grid
 * marks pinned tiles with aria-pressed.
 */
const badges = [
  { id: 1, name: 'One', data: { url: 'one.png' } },
  { id: 2, name: 'Two', data: { url: 'two.png' } },
  { id: 3, name: 'Three', data: { url: 'three.png' } },
];

// dnd-kit needs separate moves to activate and then to find the drop target; a single
// jump (locator.dropTo) ends with no target.
async function dragPin(from: string, to: string) {
  const el = (name: string) => page.getByRole('listitem', { name }).element() as HTMLElement;
  const center = (e: HTMLElement) => {
    const r = e.getBoundingClientRect();
    return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true };
  };
  const a = center(el(from));
  const b = center(el(to));
  el(from).dispatchEvent(new MouseEvent('mousedown', { ...a, button: 0 }));
  const frame = () => new Promise((resolve) => setTimeout(resolve, 50));
  for (const t of [0.1, 0.5, 1]) {
    await frame();
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: a.clientX + (b.clientX - a.clientX) * t + (t === 0.1 ? 10 : 0),
        clientY: a.clientY + (b.clientY - a.clientY) * t + (t === 0.1 ? 10 : 0),
      })
    );
  }
  await frame();
  document.dispatchEvent(new MouseEvent('mouseup', { ...b }));
}

describe('HighlightedBadgesInput', () => {
  test('numbers pins consecutively when a saved id is no longer owned', async () => {
    // 99 is saved between two owned badges but has no tile. Pick order differs from tile order.
    await renderWithProviders(
      <HighlightedBadgesInput badges={badges} value={[3, 99, 1, 2]} onChange={vi.fn()} />
    );
    await expect.element(page.getByRole('listitem', { name: 'Pin 1: Three' })).toBeVisible();
    await expect.element(page.getByRole('listitem', { name: 'Pin 2: One' })).toBeVisible();
    await expect.element(page.getByRole('listitem', { name: 'Pin 3: Two' })).toBeVisible();
    // The grid repeats no number.
    await expect.element(page.getByRole('button', { name: 'Three' })).not.toHaveTextContent('1');
  });

  test('pinned strip sits above an "All badges" divider; with one pin neither shows', async () => {
    const view = await renderWithProviders(
      <HighlightedBadgesInput badges={badges} value={[1, 2]} onChange={vi.fn()} />
    );
    const list = page.getByRole('list', { name: 'Pin order' }).element();
    const label = page.getByText('All badges').element();
    await expect.element(page.getByText('Drag to reorder')).toBeVisible();
    expect(list.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await view.rerender(<HighlightedBadgesInput badges={badges} value={[1]} onChange={vi.fn()} />);
    expect(page.getByText('All badges').elements()).toHaveLength(0);
    expect(page.getByText('Drag to reorder').elements()).toHaveLength(0);
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
    await expect
      .element(page.getByRole('button', { name: 'Placer' }))
      .toHaveAttribute('aria-pressed', 'true');
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

  test('pin numbers count tiles, not sibling ids', async () => {
    await renderWithProviders(
      <HighlightedBadgesInput badges={siblings} value={[10, 11, 12]} onChange={vi.fn()} />
    );
    await expect.element(page.getByRole('listitem', { name: 'Pin 2: Other' })).toBeVisible();
  });

  describe('reordering pins', () => {
    const pinned = [1, 2, 3];

    test('keyboard: lifting the first pin and moving it right swaps it past the second', async () => {
      const onChange = vi.fn();
      await renderWithProviders(
        <HighlightedBadgesInput badges={badges} value={pinned} onChange={onChange} />
      );
      const first = page.getByRole('listitem', { name: 'Pin 1: One' });
      (first.element() as HTMLElement).focus();
      await userEvent.keyboard(' ');
      // The test page has no Mantine CSS, so the strip may stack; whichever axis has a
      // neighbour moves the pin, the other is a no-op.
      await userEvent.keyboard('{ArrowRight}');
      await userEvent.keyboard('{ArrowDown}');
      await userEvent.keyboard(' ');
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([2, 1, 3]));
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('mouse: dragging the last pin onto the first moves it to the front', async () => {
      const onChange = vi.fn();
      await renderWithProviders(
        <HighlightedBadgesInput badges={badges} value={pinned} onChange={onChange} />
      );
      await dragPin('Pin 3: Three', 'Pin 1: One');
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([3, 1, 2]));
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('reordering leaves an unowned saved id in its slot', async () => {
      const onChange = vi.fn();
      await renderWithProviders(
        <HighlightedBadgesInput badges={badges} value={[1, 99, 2]} onChange={onChange} />
      );
      await dragPin('Pin 2: Two', 'Pin 1: One');
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([2, 99, 1]));
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('a sibling id after the pin stays put when pins swap', async () => {
      const onChange = vi.fn();
      await renderWithProviders(
        <HighlightedBadgesInput badges={siblings} value={[12, 10, 11]} onChange={onChange} />
      );
      await dragPin('Pin 2: Placer', 'Pin 1: Other');
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([10, 12, 11]));
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('a press with no movement does not reorder', async () => {
      const onChange = vi.fn();
      await renderWithProviders(
        <HighlightedBadgesInput badges={badges} value={pinned} onChange={onChange} />
      );
      const el = page.getByRole('listitem', { name: 'Pin 1: One' }).element() as HTMLElement;
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(onChange).not.toHaveBeenCalled();
    });

    test('no strip with fewer than two pins', async () => {
      await renderWithProviders(
        <HighlightedBadgesInput badges={badges} value={[1]} onChange={vi.fn()} />
      );
      expect(page.getByRole('listitem').elements()).toHaveLength(0);
    });

    test('hide variant has no strip', async () => {
      await renderWithProviders(
        <HighlightedBadgesInput variant="hide" badges={badges} value={[1, 2]} onChange={vi.fn()} />
      );
      expect(page.getByRole('listitem').elements()).toHaveLength(0);
    });
  });

  describe('hidden badges in the highlight picker', () => {
    test('a visible badge, and a hidden one that is already pinned, keep the plain tooltip', async () => {
      await renderWithProviders(
        <HighlightedBadgesInput badges={badges} value={[1]} hiddenIds={[1, 2]} onChange={vi.fn()} />
      );
      await page.getByRole('button', { name: 'Three' }).hover();
      await expect.element(page.getByRole('tooltip')).toHaveTextContent(/^Three$/);
      await page.getByRole('button', { name: 'One' }).hover();
      await expect.element(page.getByRole('tooltip')).toHaveTextContent(/^One$/);
    });

    test('an unpinned hidden badge is marked in its tooltip and stays selectable', async () => {
      const onChange = vi.fn();
      await renderWithProviders(
        <HighlightedBadgesInput badges={badges} value={[1]} hiddenIds={[2]} onChange={onChange} />
      );
      const tile = page.getByRole('button', { name: 'Two' });
      await tile.hover();
      await expect.element(page.getByText('Two (hidden: pinning shows it)')).toBeVisible();
      await tile.click();
      expect(onChange).toHaveBeenCalledWith([1, 2]);
    });
  });
});
