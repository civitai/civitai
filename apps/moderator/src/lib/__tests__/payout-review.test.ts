import { describe, expect, it } from 'vitest';
import { allowedActions } from '../payout-review';

// Drift from the main app's TRANSITIONS is pinned on the main-app side, by
// src/server/services/creator-program-prepayout-review/__tests__/spoke-transitions.test.ts.
describe('allowedActions', () => {
  it.each([
    ['open', ['clear', 'escalate', 'withhold']],
    ['escalated', ['clear', 'withhold']],
    ['withheld', ['clear']],
    ['cleared', ['escalate', 'withhold']],
    ['superseded', []],
  ])('offers on %s only what the endpoint accepts', (status, expected) => {
    expect(allowedActions(status)).toEqual(expected);
  });
});
