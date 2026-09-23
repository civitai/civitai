import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { placementNotifications } from '~/server/notifications/placement.notifications';
import {
  notificationCategoryTypes,
  optInNotificationTypes,
} from '~/server/notifications/utils.notifications';
import { NotificationCategory } from '~/server/common/enums';
import { imageWithStickersUrl } from '~/components/Placement/queue-routes';
import { STICKER_AUTO_SPACE_KEY } from '~/shared/utils/sticker-placement';

/**
 * The owner-facing notification for a space on `auto`, which has no review step.
 *
 * Asserted on the generated SQL rather than through a database, like the polarity
 * guard and the pending tests beside it: what this protects is a `WHERE` clause,
 * and every failure it exists to catch — firing for a reviewed placement, firing
 * for someone who never subscribed, never firing at all — is a property of the
 * predicate rather than of any particular row.
 */
const TYPE = 'sticker-placement-auto-accepted';

const queryFor = async (type: string) =>
  (await placementNotifications[type].prepareQuery!({
    lastSent: '2026-01-01',
    lastSentDate: new Date('2026-01-01'),
    clickhouse: undefined,
  })) as string;

describe('sticker auto-accepted notification', () => {
  it('goes to the owner, about the placer', async () => {
    const query = await queryFor(TYPE);

    // The recipient is the whole point of this type: `sticker-placement-resolved`
    // covers the same approval from the placer's side, and a copy-paste that left
    // `p."placerId"` here would tell the placer twice and the owner never.
    expect(query).toContain('p."ownerId" "userId"');
    expect(query).not.toContain('p."placerId" "userId"');
    // The username in the message is the other party's, so the join has to be on
    // the placer. Joining the owner reads as "you placed a sticker on your image".
    expect(query).toContain('JOIN "User" u ON u.id = p."placerId"');
  });

  /**
   * 🔴 Opt-IN, which INVERTS what a `UserNotificationSettings` row means here: a
   * row is subscribed, and no row is off.
   *
   * Deliberate, not an oversight to be tidied up later. Choosing "Accept all" is
   * already a decision to stop being asked about each placement, so defaulting
   * this on would hand that creator a notification per sticker in exchange for
   * the setting they picked to avoid exactly that. Flipping it to the ordinary
   * opt-out shape is a product reversal, and it fails here rather than passing
   * quietly.
   */
  it('subscribes rather than suppresses, and never both', async () => {
    const query = await queryFor(TYPE);

    expect(placementNotifications[TYPE].optIn).toBe(true);
    // An INNER join, scoped to the recipient. A LEFT JOIN restricts nobody and
    // would send this to every creator on the site; a join left unscoped would
    // cross every subscriber with every placement.
    expect(query).toContain(
      `JOIN "UserNotificationSettings" uns ON uns."userId" = p."ownerId" AND uns.type = '${TYPE}'`
    );
    // Not redundant with the line above, which was the mistake that deleted it:
    // a LEFT JOIN line CONTAINS that substring, so `toContain` passes while the
    // join restricts nobody and this goes to every creator on the site. The
    // polarity guard's lookbehind catches it too, in another file; this one
    // fails where a reader of this feature is already looking.
    expect(query).not.toContain('LEFT JOIN "UserNotificationSettings"');
    // The opt-out clause would make one row mean subscribed AND muted at once,
    // which resolves as nobody ever receiving this.
    expect(query).not.toContain('NOT EXISTS (SELECT 1 FROM "UserNotificationSettings"');
  });

  /**
   * The gate that makes this type distinct from an owner approving by hand.
   *
   * Both go through `settlePlacement({ action: 'approve', actorId: ownerId })`, so
   * `status`, `resolvedAt` and `resolvedById` are identical between them. Without
   * this clause the notification fires for every approval, including the ones the
   * owner made themselves in their own queue.
   */
  it('fires only for an approval nobody reviewed', async () => {
    const query = await queryFor(TYPE);

    expect(query).toContain("AND p.status = 'approved'");
    expect(query).toContain(`AND p.data ->> '${STICKER_AUTO_SPACE_KEY}' = 'true'`);
    // Keyed off the approval, not the creation: the two are seconds apart here,
    // but a createdAt window still misses a row created just before a run and
    // approved just after it.
    expect(query).toContain(`AND p."resolvedAt" > '2026-01-01'`);
    expect(query).not.toContain('p."createdAt" >');
    // Scoped to this surface and target. Only stickers stamp the key today, so
    // dropping these changes nothing right now -- which is exactly why a later
    // surface could widen it without anyone noticing.
    expect(query).toContain(`p.surface = 'sticker'`);
    expect(query).toContain(`p."targetType" = 'image'`);
  });

  /**
   * The keys `prepareMessage` reads, tied to the columns the query puts them in.
   *
   * The message test below hands in a hand-made details object, so it cannot see
   * this mapping at all: rename `placerUsername` to `username` in the SQL and
   * every notification reads "undefined placed a sticker on your image", with
   * nothing red. Same for the image id, which would silently link everyone to the
   * wrong page.
   */
  it('builds the details keys the message reads', async () => {
    const query = await queryFor(TYPE);

    expect(query).toContain(`'placerUsername', u.username`);
    expect(query).toContain(`'imageId', p."targetId"`);
  });

  it('links to the image with the stickers revealed', () => {
    const message = placementNotifications[TYPE].prepareMessage({
      details: { placementId: 3, imageId: 91, placerId: 12, placerUsername: 'someone' },
    });

    expect(message!.message).toBe('someone placed a sticker on your image');
    // Placed stickers are hidden site-wide by default, so the plain image URL
    // lands the owner on work that looks untouched — indistinguishable from the
    // sticker having been removed.
    expect(message!.url).toBe(imageWithStickersUrl(91));
    expect(message!.url).toContain('?stickers=1');
  });

  /**
   * One placement produces one of these. `sticker-placement-resolved` puts the
   * status in its key because a placement is legitimately accepted and then taken
   * down later; here the takedown is the placer's notification, so a status in the
   * key would only ever be 'approved' and would read as though it varied.
   */
  it('keys on the placement alone', async () => {
    expect(await queryFor(TYPE)).toContain(`CONCAT('${TYPE}:',"placementId")`);
  });

  /**
   * The settings pointer carries this type as a bare string -- the module that
   * owns the type list drags 36 processors into any client bundle that imports
   * it -- so the coupling has to live here instead.
   *
   * 🔴 Pinned against the lists the COMPONENT actually reads, not against
   * `placementNotifications`. The alert's condition walks the rows of
   * `user.getNotificationSettings` and the checkbox is rendered from
   * `notificationCategoryTypes`; a processor is absent from both the moment it
   * carries `toggleable: false`, which `getNotificationTypes` filters on. That
   * one word would silence the alert, the checkbox and -- since this type is
   * opt-in and would then be unsubscribable -- the notification itself, for
   * everyone, with `placementNotifications[TYPE]` still defined and nothing red.
   */
  it('is reachable through the lists the settings UI reads', () => {
    const section = readFileSync('src/components/Account/PlacementSpaceSection.tsx', 'utf8');

    expect(section).toContain(`const AUTO_ACCEPTED_NOTIFICATION = '${TYPE}';`);
    // The declaration alone passes on a constant that is declared and never
    // read, which is a component whose prompt silently stopped rendering.
    expect(section).toContain('setting.type === AUTO_ACCEPTED_NOTIFICATION');
    expect(optInNotificationTypes).toContain(TYPE);
    expect(notificationCategoryTypes[NotificationCategory.Creator].map((s) => s.type)).toContain(
      TYPE
    );
  });
});
