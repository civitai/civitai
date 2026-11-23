import { describe, expect, it } from 'vitest';
import { csamQueueHeldText } from '../held-url';

describe('csamQueueHeldText', () => {
  // Callers pass a numeric id as a string (String(offeringId)); it must stay a literal, not be read
  // as a column reference.
  it('takes an integer literal as the entity', () => {
    const text = csamQueueHeldText('ServiceOffering', '123');
    expect(text).toContain('"entityId" = 123');
  });

  it('takes a column reference as the entity', () => {
    expect(csamQueueHeldText('ServiceOffering', 'cso."id"')).toContain('"entityId" = cso."id"');
  });

  it('takes a column of an alias that only starts like one of its own', () => {
    expect(csamQueueHeldText('ServiceOffering', 'qhx."id"')).toContain('"entityId" = qhx."id"');
  });

  it('refuses an entity that names one of its own aliases', () => {
    expect(() => csamQueueHeldText('ServiceOffering', 'qh."id"')).toThrow(/Alias taken/);
  });
});
