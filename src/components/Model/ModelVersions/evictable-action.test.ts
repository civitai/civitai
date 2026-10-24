import { describe, expect, it } from 'vitest';
import { getEvictableAction } from './evictable-action';

// The server write is idempotent, so a menu that requested the current state would
// silently do nothing on every click. `next` must always be the opposite state.
describe('getEvictableAction', () => {
  it('offers to pin an evictable version, and requests not-evictable', () => {
    expect(getEvictableAction(true)).toMatchObject({ label: 'Mark not evictable', next: false });
  });

  it('offers to unpin a pinned version, and requests evictable', () => {
    expect(getEvictableAction(false)).toMatchObject({ label: 'Mark evictable', next: true });
  });
});
