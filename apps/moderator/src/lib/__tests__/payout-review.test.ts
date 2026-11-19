import { describe, expect, it } from 'vitest';
import { allowedActions } from '../payout-review';

describe('allowedActions', () => {
  it.each([
    ['open', ['clear', 'escalate', 'withhold']],
    ['escalated', ['clear', 'withhold']],
    ['withheld', ['clear']],
    ['cleared', ['escalate', 'withhold']],
  ])('offers on %s only what the endpoint accepts', (status, expected) => {
    expect(allowedActions(status)).toEqual(expected);
  });
});
