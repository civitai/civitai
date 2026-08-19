import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { dedupeOrder, useDedupedCappedItems } from '~/components/HomeBlocks/homeBlockDedupe';
import { ITEMS_PER_ROW } from '~/components/HomeBlocks/homeBlockItems';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import '../../../test/component-setup';

/**
 * Covers the effect lifecycle, which the pure-function suite cannot reach: a block that fails to
 * release its claim on unmount goes on suppressing those items for every later block, and nothing
 * looks wrong — the later block just quietly shows different items forever.
 */

const pool = Array.from({ length: ITEMS_PER_ROW * 2 }, (_, i) => ({ id: i + 1, user: { id: 1 } }));
const firstRow = pool
  .slice(0, ITEMS_PER_ROW)
  .map((x) => x.id)
  .join(',');

function Block({ order, testId }: { order: number; testId: string }) {
  const visible = useDedupedCappedItems(pool, { order, entity: 'image', rows: 1 });
  return <div data-testid={testId}>{visible.map((x) => x.id).join(',')}</div>;
}

function Page() {
  const [showFirst, setShowFirst] = useState(true);
  return (
    <>
      {showFirst && <Block order={dedupeOrder(0)} testId="first" />}
      <Block order={dedupeOrder(1)} testId="second" />
      <button onClick={() => setShowFirst(false)}>drop first</button>
    </>
  );
}

describe('useDedupedCappedItems lifecycle', () => {
  test('the later block avoids the earlier one, then reclaims its items once it unmounts', async () => {
    render(<Page />);

    // Every state asserted here is absorbing — nothing is on a timer — so no assertion is racing
    // a value that leaves.
    await expect.element(page.getByTestId('first')).toHaveTextContent(firstRow);
    await expect.element(page.getByTestId('second')).not.toHaveTextContent(firstRow);

    await page.getByRole('button', { name: 'drop first' }).click();

    await expect.element(page.getByTestId('second')).toHaveTextContent(firstRow);
  });
});
