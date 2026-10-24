import { describe, expect, it } from 'vitest';
import { alsoDecidable } from '../hold-author';
import { canRemoveHeld } from '../hold-entity';

const hold = (
  id: number,
  entityType: string,
  status = 'Pending',
  textHash: string | null = `h-${id}`
) => ({
  id,
  entityType,
  status,
  textHash,
});

describe('alsoDecidable', () => {
  const others = [
    hold(1, 'Post'),
    hold(2, 'Weird'),
    hold(3, 'Model', 'Dismissed', null),
    hold(4, 'Model', 'Pending', null),
  ];

  it('takes the pending holds a removal can be carried out for', () => {
    expect(alsoDecidable(others, 'remove', canRemoveHeld)).toEqual([
      { holdId: 1, textHash: 'h-1' },
    ]);
  });

  it('takes every pending hold with a hash for a dismissal, whatever the type', () => {
    expect(alsoDecidable(others, 'dismiss', canRemoveHeld)).toEqual([
      { holdId: 1, textHash: 'h-1' },
      { holdId: 2, textHash: 'h-2' },
    ]);
  });
});
