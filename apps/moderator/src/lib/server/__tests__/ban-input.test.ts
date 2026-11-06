import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { banFieldsSchema } = await import('../ban-input');

describe('banFieldsSchema', () => {
  it('refuses a reason only the system sets', () => {
    expect(banFieldsSchema.safeParse({ reasonCode: 'Chargeback' }).success).toBe(false);
    expect(banFieldsSchema.safeParse({ reasonCode: 'Other' }).success).toBe(true);
  });
});
