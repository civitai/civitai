import { describe, expect, it } from 'vitest';
import { placementNotifications } from '~/server/notifications/placement.notifications';

/**
 * The free placement's own notification, and the paid one it must not collide
 * with.
 *
 * These assert the SQL as text, which is what every other notification test
 * here does and is weaker than running it — the queries are built as strings
 * and never parsed in a unit run. What they can still catch is the whole reason
 * this type exists: that the two are scoped apart, and that each honours its own
 * setting. Both of those failures are silent in production — one sends the wrong
 * sentence, the other ignores a switch the UI shows as working.
 */
type Def = (typeof placementNotifications)['sticker-placement-pending'];
const defs = placementNotifications as Record<string, Def>;

const LAST_SENT = '2026-08-16 00:00:00';
const query = async (type: string) =>
  (await defs[type].prepareQuery!({
    lastSent: LAST_SENT,
    lastSentDate: new Date(0),
    clickhouse: undefined,
  })) as string;

describe('the free sticker notification is its own type', () => {
  it('is registered and toggleable, in the creator category', () => {
    const def = defs['sticker-placement-free-pending'];

    expect(def).toBeTruthy();
    expect(def.category).toBe('Creator');
    // Not opt-in. `optIn` inverts what a settings row MEANS, and it may only be
    // set by a processor that derives its recipients by joining that table —
    // this one derives them from the placement and excludes with NOT EXISTS, so
    // opting in here would ship the notification on while the UI drew it off.
    expect(def.optIn).toBeUndefined();
  });

  it('names no amount, because there is none to name', () => {
    const message = defs['sticker-placement-free-pending'].prepareMessage({
      type: 'sticker-placement-free-pending',
      details: { imageId: 74, placerUsername: 'somebody' },
    } as Parameters<Def['prepareMessage']>[0])!;

    expect(message.message).toBe('somebody wants to place a free sticker on your image');
    // "0 Buzz" reads as a bug rather than as the offer.
    expect(message.message).not.toMatch(/buzz|\b0\b/i);
    // Destination is asserted once, for both types, in the URL block below —
    // this test is about the amount.
  });
});

describe('the two sticker notifications are scoped apart', () => {
  it('sends the paid one for paid rows only', async () => {
    expect(await query('sticker-placement-pending')).toMatch(/AND\s+p\.free\s*=\s*false/);
  });

  it('sends the free one for free rows only', async () => {
    expect(await query('sticker-placement-free-pending')).toMatch(/AND\s+p\.free\s*=\s*true/);
  });

  /**
   * Without both halves a free placement produces two notifications, one of
   * which offers to review it "for 0 Buzz", and muting either kind mutes the
   * wrong one. Asserted as a pair rather than twice, because it is the pair that
   * has to partition.
   */
  it('gives each its own dedupe key', async () => {
    expect(await query('sticker-placement-pending')).toContain("'sticker-placement-pending:'");
    expect(await query('sticker-placement-free-pending')).toContain(
      "'sticker-placement-free-pending:'"
    );
  });
});

/**
 * Who hears about it, and where it sends them.
 *
 * Both are one identifier in a `jsonb_build_object`, and both swaps are green:
 * `p."ownerId"` -> `p."placerId"` notifies the placer that they themselves want
 * to place something, and `p."targetId"` -> `p.id` builds `/images/<placementId>`
 * — a dead URL for the one person who has to act.
 */
describe('the free notification reaches the creator, about the right image', () => {
  it.each(['sticker-placement-pending', 'sticker-placement-free-pending'])(
    '%s notifies the owner, not the placer',
    async (type) => {
      const sql = await query(type);

      expect(sql).toMatch(/p\."ownerId"\s+"userId"/);
      // The placer is carried in the details for the message, so its presence is
      // not the thing to assert — the recipient column is.
      expect(sql).not.toMatch(/p\."placerId"\s+"userId"/);
    }
  );

  it.each(['sticker-placement-pending', 'sticker-placement-free-pending'])(
    '%s links to the image rather than to the placement',
    async (type) => {
      const sql = await query(type);

      expect(sql).toMatch(/'imageId',\s*p\."targetId"/);
      expect(sql).not.toMatch(/'imageId',\s*p\.id/);
    }
  );

  /**
   * Both sticker notifications send the creator to their queue, not to the one
   * image. Measured 2026-08-20: 96 placements pending against 251 approved,
   * because an owner who answered one placement on its image never learned the
   * rest existed. The queue row still links to the image.
   *
   * `remix-gallery-pending` is deliberately excluded — same shape, separate
   * decision, and asserting it here would quietly widen this change.
   */
  it.each(['sticker-placement-pending', 'sticker-placement-free-pending'])(
    '%s sends the creator to the queue, not to the single image',
    (type) => {
      const message = defs[type].prepareMessage({
        type,
        details: { imageId: 74, placerId: 52, placerUsername: 'somebody', amount: 100 },
      } as Parameters<Def['prepareMessage']>[0])!;

      expect(message.url).toBe('/user/sticker-placements?tab=received');
      // Named explicitly: the failure this guards is a revert to the old
      // per-image link, which would still be a valid-looking URL.
      expect(message.url).not.toContain('/images/');
    }
  );

  it('the placer still hears about their own sticker on the image it went on', () => {
    const message = defs['sticker-placement-resolved'].prepareMessage({
      type: 'sticker-placement-resolved',
      details: { imageId: 74, ownerUsername: 'somebody' },
    } as Parameters<Def['prepareMessage']>[0])!;

    // The queue is the OWNER's surface. Sending the placer there would show them
    // a list of other people's placements waiting on their own images.
    expect(message.url).toBe('/images/74');
  });
});

describe('each honours its own setting', () => {
  /**
   * 🔴 A settings row means opted OUT, and nothing applies that globally — every
   * processor that honours its toggle writes the clause itself. Without it the
   * setting renders, saves, and does nothing, which is a toggle that is a
   * listing rather than a guard.
   */
  it.each(['sticker-placement-pending', 'sticker-placement-free-pending'])(
    '%s excludes users who have opted out of that exact type',
    async (type) => {
      const sql = await query(type);

      expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM "UserNotificationSettings"/);
      // The type in the clause has to be this one. A copy-paste carrying the
      // other type's name would silence the wrong notification and leave this
      // one unmutable, and every other assertion here would still pass.
      expect(sql).toMatch(new RegExp(`type = '${type}'\\s*\\n?\\s*\\)`));
    }
  );
});

describe('neither notifies about a row that is no longer waiting', () => {
  it.each(['sticker-placement-pending', 'sticker-placement-free-pending'])(
    '%s requires pending status and a deadline',
    async (type) => {
      const sql = await query(type);

      // Pending is what keeps an auto-accept space out of this entirely: the
      // call site approves the row before the job next runs.
      expect(sql).toContain("p.status = 'pending'");
      expect(sql).toContain('p."expiresAt" IS NOT NULL');
      expect(sql).toContain(LAST_SENT);
    }
  );
});
