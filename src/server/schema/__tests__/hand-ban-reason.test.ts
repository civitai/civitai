import { describe, expect, it } from 'vitest';
import { banUserQuerySchema } from '~/pages/api/mod/ban-user';
import { toggleBanUserSchema } from '~/server/schema/user.schema';

describe('a system-only ban reason is refused from a hand ban', () => {
  it('in the tRPC toggleBan input', () => {
    expect(toggleBanUserSchema.safeParse({ id: 1, reasonCode: 'Chargeback' }).success).toBe(false);
    expect(toggleBanUserSchema.safeParse({ id: 1, reasonCode: 'Harassment' }).success).toBe(true);
  });

  it('in the moderator ban endpoint', () => {
    expect(banUserQuerySchema.safeParse({ userId: '1', reasonCode: 'Chargeback' }).success).toBe(
      false
    );
    expect(banUserQuerySchema.safeParse({ userId: '1', reasonCode: 'Harassment' }).success).toBe(
      true
    );
  });
});
