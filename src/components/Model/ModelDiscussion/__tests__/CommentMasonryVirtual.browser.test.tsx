import React, { useRef, useState } from 'react';
import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ScrollAreaContext } from '~/components/ScrollArea/ScrollAreaContext';
import { renderWithProviders } from '../../../../../test/component-setup';

const { CommentMasonryVirtual } = await import(
  '~/components/Model/ModelDiscussion/CommentMasonryVirtual'
);

// Stands in for the real card, whose Show More control grows the same wrapper the same way.
function Card({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={`card-${id}`} style={{ border: '1px solid' }}>
      <div style={{ height: open ? 600 : 100 }}>card {id}</div>
      <button type="button" onClick={() => setOpen((v) => !v)}>
        toggle {id}
      </button>
    </div>
  );
}

function Harness({ ids, width = 700 }: { ids: number[]; width?: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <ScrollAreaContext.Provider value={{ ref: scrollRef as React.RefObject<HTMLDivElement> }}>
      <div ref={scrollRef} style={{ height: 800, width, overflowY: 'auto', position: 'relative' }}>
        <CommentMasonryVirtual
          comments={ids.map((id) => ({ id })) as never}
          renderItem={(comment) => <Card id={comment.id} />}
        />
      </div>
    </ScrollAreaContext.Provider>
  );
}

const rect = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect();
const gap = () => rect('card-3').top - rect('card-1').bottom;

describe('the comment masonry', () => {
  test('keeps every card in its own slot after the column width changes', async () => {
    const screen = await renderWithProviders(<Harness ids={[1, 2, 3, 4]} width={700} />);
    await expect.element(page.getByTestId('card-3')).toBeVisible();
    await expect.poll(gap).toBe(16);
    const widthBefore = rect('card-1').width;

    screen.rerender(<Harness ids={[1, 2, 3, 4]} width={640} />);
    await expect.poll(() => rect('card-1').width).toBeLessThan(widthBefore - 20);
    await expect.poll(gap).toBe(16);
  });

  test('moves the next card down by the growth when a card expands', async () => {
    await renderWithProviders(<Harness ids={[1, 2, 3, 4, 5, 6]} />);
    await expect.element(page.getByTestId('card-3')).toBeVisible();
    await expect.poll(gap).toBe(16);
    const before = { card1: rect('card-1'), card3: rect('card-3') };

    await userEvent.click(page.getByText('toggle 1'));
    await expect.poll(() => rect('card-1').height).toBeGreaterThan(before.card1.height + 400);

    const growth = rect('card-1').height - before.card1.height;
    await expect.poll(() => rect('card-3').top - before.card3.top).toBeCloseTo(growth, 0);
    expect(gap()).toBe(16);
  });
});
