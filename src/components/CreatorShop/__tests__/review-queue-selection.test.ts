import { describe, expect, it } from 'vitest';
import { nextQueueSelection } from '../review-queue-selection';

const ids = (...list: number[]) => list.map((id) => ({ id }));

describe('nextQueueSelection', () => {
  it('moves to the item after the one just reviewed, not the top of the queue', () => {
    expect(nextQueueSelection(ids(1, 2, 3, 4), ids(1, 2, 4), 3)).toBe(4);
  });

  it('falls back to the top when the reviewed item was the last one', () => {
    expect(nextQueueSelection(ids(1, 2, 3), ids(1, 2), 3)).toBe(1);
  });

  it('keeps the current selection while it is still in the queue', () => {
    expect(nextQueueSelection(ids(1, 2, 3), ids(1, 2, 3, 5), 2)).toBe(2);
  });

  it('selects the first item when nothing was selected', () => {
    expect(nextQueueSelection([], ids(7, 8), null)).toBe(7);
    expect(nextQueueSelection([], [], null)).toBe(null);
  });
});
