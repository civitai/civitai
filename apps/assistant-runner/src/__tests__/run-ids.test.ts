import { describe, expect, it } from 'vitest';

import { runIdFor } from '../core/run-ids';

describe('runIdFor', () => {
  it('is the same run for the same viewer and key, and another for anyone else', () => {
    expect(runIdFor('u1', 'k1')).toBe(runIdFor('u1', 'k1'));
    expect(runIdFor('u2', 'k1')).not.toBe(runIdFor('u1', 'k1'));
    // No split of the pair reads as another viewer's.
    expect(runIdFor('a\nb', 'c')).not.toBe(runIdFor('a', 'b\nc'));
  });
});
