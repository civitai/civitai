import { describe, expect, it } from 'vitest';
import { handOffRoutes } from './hand-off';

describe('handOffRoutes', () => {
  it('leaves the privacy button out entirely while its grant is off; the other three always show', () => {
    const actions = (canPrivacy: boolean) =>
      handOffRoutes(canPrivacy)
        .map((r) => r.action)
        .sort();
    expect(actions(false)).toEqual(['escalate', 'fileBug', 'modLead']);
    expect(actions(true)).toEqual(['escalate', 'fileBug', 'modLead', 'privacy']);
  });
});
