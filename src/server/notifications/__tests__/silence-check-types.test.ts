import { describe, expect, it, vi } from 'vitest';
import { createSilenceCheckTypeAges } from '~/server/notifications/silence-check';
import { silenceCheckTypes } from '~/server/notifications/utils.notifications';

describe('silenceCheckTypes', () => {
  it('lists the opt-out types a user can switch off, without the externally sent ones', () => {
    expect(silenceCheckTypes).toContain('new-order-smite-received');
    expect(silenceCheckTypes).not.toContain('knights-verdicts-in');
    expect(silenceCheckTypes).not.toContain('knights-streak-ends-soon');
    expect(silenceCheckTypes).not.toContain('knights-new-images');
  });

  it('leaves out opt-in types, whose row means subscribed', () => {
    expect(silenceCheckTypes).not.toContain('sticker-placement-auto-accepted');
  });
});

describe('silenceCheckTypeAges', () => {
  it('lists each type with when it was first switched off, and asks the database once an hour', async () => {
    const query = vi.fn(async () => [
      { type: 'new-order-smite-received', firstSeen: new Date('2026-01-01T00:00:00Z') },
    ]);
    let now = new Date('2026-12-01T00:00:00Z');
    const ages = createSilenceCheckTypeAges({ query, now: () => now });

    expect(await ages(silenceCheckTypes)).toEqual([
      { type: 'new-order-smite-received', firstSeen: '2026-01-01T00:00:00.000Z' },
    ]);
    now = new Date('2026-12-01T00:59:00Z');
    await ages(silenceCheckTypes);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(silenceCheckTypes);

    now = new Date('2026-12-01T01:01:00Z');
    await ages(silenceCheckTypes);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
