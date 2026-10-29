import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { VirtualGrid } from './VirtualGrid';

const ITEM_HEIGHT = 20;
const SCROLLBAR = 17;

// Rigid like the badges the grid holds, so a row too wide overflows instead of squeezing.
function Cell({ data, width }: { data: number; width: number }) {
  return (
    <div data-testid="cell" style={{ width, height: ITEM_HEIGHT, flexShrink: 0 }}>
      item-{data}
    </div>
  );
}

const cells = () => document.querySelectorAll<HTMLElement>('[data-testid="cell"]');
const rect = (i: number) => cells()[i].getBoundingClientRect();
const scrollBox = () => {
  const box = cells()[0]?.parentElement?.parentElement?.parentElement;
  if (!box) throw new Error('no scroll box');
  return box;
};

const items = Array.from({ length: 10_000 }, (_, i) => i);

async function renderGrid(width = 640) {
  await renderWithProviders(
    <div style={{ width }} className="grid-under-test">
      {/* The test browser hides scrollbars; a border takes width from the box the same way. */}
      <style>{`.grid-under-test > div { border-right: ${SCROLLBAR}px solid transparent; }`}</style>
      <VirtualGrid
        items={items}
        render={Cell}
        getKey={(x) => x}
        columnWidth={140}
        maxColumnCount={4}
        gap={4}
        estimateRowHeight={ITEM_HEIGHT}
        maxHeight={250}
      />
    </div>
  );
  await expect.element(page.getByText('item-0', { exact: true })).toBeInTheDocument();
  // Column count follows the measured width, which lands after mount.
  await expect.poll(() => rect(3).top).toBe(rect(0).top);
}

describe('VirtualGrid', () => {
  test('mounts only the rows near the viewport', async () => {
    await renderGrid();
    expect(cells().length).toBeGreaterThan(0);
    expect(cells().length).toBeLessThan(200);
  });

  test('stretches cells to fill the row', async () => {
    await renderGrid();
    const rowWidth = rect(3).right - rect(0).left;
    expect(rowWidth).toBeLessThanOrEqual(scrollBox().clientWidth);
    expect(rowWidth).toBeGreaterThan(scrollBox().clientWidth - 4);
  });

  test('caps a row at maxColumnCount when more columns would fit', async () => {
    await renderGrid(1200);
    expect(rect(4).top).toBeGreaterThan(rect(0).top);
  });

  test('rows fit beside a scrollbar that takes width, so nothing scrolls sideways', async () => {
    await renderGrid();
    const box = scrollBox();
    expect(box.offsetWidth - box.clientWidth).toBeGreaterThanOrEqual(SCROLLBAR);
    expect(box.scrollWidth).toBe(box.clientWidth);
  });

  test('scrolling to the end mounts the last item', async () => {
    await renderGrid();
    const box = scrollBox();
    box.scrollTop = box.scrollHeight;
    await expect.element(page.getByText('item-9999', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('item-0', { exact: true })).not.toBeInTheDocument();
  });
});
