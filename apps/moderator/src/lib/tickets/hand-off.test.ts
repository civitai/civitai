import { describe, expect, it } from 'vitest';
import { handOffRoutes } from './hand-off';

describe('handOffRoutes', () => {
  it('leaves the privacy button out entirely while its grant is off; the other three always show', () => {
    expect(handOffRoutes(false).map((r) => r.action)).toEqual(['fileBug', 'modLead', 'escalate']);
    expect(handOffRoutes(true).map((r) => r.action)).toEqual([
      'fileBug',
      'privacy',
      'modLead',
      'escalate',
    ]);
  });
});
