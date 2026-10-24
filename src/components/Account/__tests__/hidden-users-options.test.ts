import { describe, expect, it } from 'vitest';
import { toHideableOptions } from '~/components/Account/hidden-users-options';

// 868kurj0y. This search box is a second `kind: 'user'` writer that is not a
// HideUserButton call site, so the block gate on that component does not reach it.
describe('toHideableOptions', () => {
  const users = [
    { id: 1, username: 'alice' },
    { id: 2, username: 'bob' },
  ];

  it('drops a blocked user', () => {
    expect(toHideableOptions(users, [{ id: 2 }])).toEqual([{ id: 1, value: 'alice' }]);
  });

  // Negative control: returning [] unconditionally would pass the case above.
  it('keeps an unblocked user', () => {
    expect(toHideableOptions(users, [])).toEqual([
      { id: 1, value: 'alice' },
      { id: 2, value: 'bob' },
    ]);
  });

  it('still drops a null username', () => {
    expect(toHideableOptions([{ id: 3, username: null }], [])).toEqual([]);
  });

  it('handles the query not having resolved', () => {
    expect(toHideableOptions(undefined, [])).toEqual([]);
  });
});
