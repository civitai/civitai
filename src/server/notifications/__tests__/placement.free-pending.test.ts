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
    // `AND p.free\b` alone survives widening to `AND p.free IS NOT NULL`, which
    // is true of every row — the column is NOT NULL — so the free notification
    // would fire for every pending submission, paid ones included, under a
    // toggle their owner never opted into.
    expect(query).not.toContain('IS NOT NULL');
  });

  it.each(['remix-gallery-pending', 'remix-gallery-free-pending'])(
    '%s honours its own toggle',
    async (type) => {
      // A row in `UserNotificationSettings` means opted OUT, and there is no
      // global filter — a processor without this clause renders a setting that
      // saves and does nothing, which is what the paid type did until now.
      //
      // Asserted per type rather than once, because the two toggles are separate
      // switches: silencing free submissions must not silence the paid queue a
      // creator is being paid for.
      //
      // Pinned as ONE whole clause rather than by prefix. A prefix match stays
      // green if the recipient column drifts to `p."placerId"` — silencing the
      // submitter's setting instead of the owner's — or if the type string is
      // copy-pasted from its sibling, which mutes the wrong toggle. Both are the
      // realistic edits here, and neither changes the prefix.
      expect(await queryFor(type)).toContain(
        `NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = p."ownerId" AND type = '${type}')`
      );
      expect(placementNotifications[type].optIn).toBeFalsy();
    }
  );

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
