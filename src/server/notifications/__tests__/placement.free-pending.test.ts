import { describe, expect, it } from 'vitest';
import { placementNotifications } from '~/server/notifications/placement.notifications';

/**
 * The two remix-gallery pending types partition the pending rows between them.
 *
 * Asserted on the SQL rather than through a database, the same way the polarity
 * guard is: what these tests protect is a `WHERE` clause, and the failure they
 * exist to catch — one row producing both notifications, or neither — is a
 * property of the predicate and not of any particular row.
 */
describe('remix gallery pending notifications', () => {
  const queryFor = async (type: string) =>
    (await placementNotifications[type].prepareQuery!({
      lastSent: '2026-01-01',
      lastSentDate: new Date('2026-01-01'),
      clickhouse: undefined,
    })) as string;

  it('sends the paid type for paid rows only', async () => {
    // Without this the paid message goes out for a free submission quoting
    // "for 0 Buzz", and a creator who turned the free type off still gets one.
    expect(await queryFor('remix-gallery-pending')).toContain('AND NOT p.free');
  });

  it('sends the free type for free rows only', async () => {
    const query = await queryFor('remix-gallery-free-pending');
    expect(query).toMatch(/AND p\.free\b/);
    expect(query).not.toContain('AND NOT p.free');
  });

  it('honours the free type’s own toggle, which the paid ones do not have', async () => {
    // A row in `UserNotificationSettings` means opted OUT. The paid types carry
    // no such clause at all, so their toggles render and change nothing — this
    // one is wired, and that difference is the point of giving free its own type.
    expect(await queryFor('remix-gallery-free-pending')).toContain(
      'NOT EXISTS (SELECT 1 FROM "UserNotificationSettings"'
    );
    expect(placementNotifications['remix-gallery-free-pending'].optIn).toBeFalsy();
  });

  it('quotes no amount on a free submission', async () => {
    // A free row's `amount` is 0 and the DB enforces it, so any wording built
    // around a number here would tell a creator they are being offered 0 Buzz.
    const message = placementNotifications['remix-gallery-free-pending'].prepareMessage({
      details: { placementId: 5, imageId: 74, placerId: 52, placerUsername: 'someone' },
    });

    expect(message!.message).toContain('someone');
    expect(message!.message).not.toMatch(/buzz|\d/i);
    expect(message!.url).toBe('/images/74');
  });
});
