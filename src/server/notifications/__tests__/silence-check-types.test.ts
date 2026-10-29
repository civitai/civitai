import { describe, expect, it } from 'vitest';
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
