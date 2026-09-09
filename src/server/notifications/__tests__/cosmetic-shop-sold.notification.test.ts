import { describe, expect, it } from 'vitest';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

// The processor's SQL is raw and never executed in unit tests, so these pin the
// shape a revert would break. The defect (868kxcdrx) was that recipients came
// from `si.meta->'paidToUserIds'`, unset on ~1,076 of 1,381 items, so
// `jsonb_array_elements(NULL)` yielded no rows and ~18,000 sales notified no one.
// The fix reads the authoritative payout record both purchase paths write.
const query = notificationProcessors['cosmetic-shop-item-sold'].prepareQuery?.({
  lastSent: '2026-01-01',
  lastSentDate: new Date('2026-01-01'),
  clickhouse: undefined,
}) as string;

describe('cosmetic-shop-item-sold recipient resolution', () => {
  it('resolves recipients from the recorded payout, not the legacy paidToUserIds field', () => {
    expect(query).toContain(`cp.meta->'payouts'`);
    // The bug source is gone: reading it again would silence the same ~1,076 items.
    expect(query).not.toContain('paidToUserIds');
  });

  it('sums the per-color split rows per owner so a recipient is notified once for their total', () => {
    expect(query).toContain(`SUM((payout->>'amount')::int)`);
    expect(query).toMatch(/GROUP BY[\s\S]*\(payout->>'userId'\)::int/);
  });

  it('normalizes a null/non-array payouts value to an empty array before expanding it', () => {
    // The recurrence guard: jsonb_array_elements ERRORS on a scalar/object json and
    // yields no rows on SQL NULL. Without this CASE a row whose meta.payouts is absent
    // or malformed reintroduces the defect — either a silent no-notification or a
    // throw that fails the whole cron batch.
    expect(query).toMatch(/jsonb_typeof\(cp\.meta->'payouts'\)\s*=\s*'array'/);
  });

  it('keys the notification per recipient so one transaction fanning out to several owners does not collapse', () => {
    // send-notifications merges additions by `key` alone and shares one details
    // blob; without ownerId in the key, every seller but one loses their sale.
    expect(query).toMatch(
      /CONCAT\('cosmetic-shop-item-sold:',\s*"buzzTransactionId",\s*':',\s*"ownerId"\)/
    );
  });
});
