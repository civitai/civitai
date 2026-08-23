import { describe, expect, it } from 'vitest';
import { placementNotifications } from '~/server/notifications/placement.notifications';

/**
 * What a placer is told once someone acts on their placement.
 *
 * Approval on both surfaces, the owner-removal the remix type already had, and
 * every way a moderator can end a placement. These assert the SQL as text — the
 * queries are built as strings and never parsed in a unit run — so what they can
 * catch is the scope of each processor, which is exactly what changed here and
 * exactly what is invisible in production when it is wrong.
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

/**
 * Every placement status the query can select, read back out of the SQL.
 *
 * A set comparison rather than a pair of contains/not-contains assertions: it
 * fails with both sides printed, so putting `declined` back reads as
 * `'approved,declined' to be 'approved'` rather than as an anonymous false. It
 * also cannot pass by the processor having stopped selecting anything at all —
 * an empty set fails against a non-empty expectation, which is the failure mode
 * a bare "declined is absent" assertion would sail through.
 *
 * Comments are stripped first: these queries carry a lot of prose, and a status
 * named in one would otherwise read as a status selected.
 */
const statusesSelectedBy = (sql: string) =>
  [
    ...new Set(
      [
        ...sql.replace(/--[^\n]*/g, '').matchAll(/'(pending|approved|declined|expired|removed)'/g),
      ].map((m) => m[1])
    ),
  ]
    .sort()
    .join(',');

describe('the sticker placer hears about an acceptance', () => {
  it('is registered, toggleable, and not opt-in', () => {
    const def = defs['sticker-placement-resolved'];

    expect(def).toBeTruthy();
    expect(def.category).toBe('Creator');
    // `optIn` inverts what a settings row MEANS, and may only be set by a
    // processor that derives recipients by joining that table. This one excludes
    // with NOT EXISTS, so opting in here would ship it on while the UI drew it off.
    expect(def.optIn).toBeUndefined();
  });

  it('goes to the placer, not to the owner who just accepted it', async () => {
    const sql = await query('sticker-placement-resolved');

    // The whole point of the type. Selecting `ownerId` here sends the creator
    // who clicked Accept a message naming themselves, and sends the placer —
    // the only person this exists for — nothing at all. Both directions
    // asserted: the recipient is the placer AND is not the owner.
    expect(sql).toMatch(/p\."placerId"\s+"userId"/);
    expect(sql).not.toMatch(/p\."ownerId"\s+"userId"/);
  });

  it('reads the sticker surface', async () => {
    // The likeliest mistake in a processor written beside three others: every
    // other assertion here passes with `remixGallery` in this clause, which
    // would announce remix approvals as stickers and stickers not at all.
    const sql = await query('sticker-placement-resolved');

    expect(sql).toContain("p.surface = 'sticker'");
    expect(sql).not.toContain("p.surface = 'remixGallery'");
  });

  it('names the owner and links to the image', async () => {
    const message = defs['sticker-placement-resolved'].prepareMessage({
      type: 'sticker-placement-resolved',
      details: { imageId: 74, ownerUsername: 'somebody', status: 'approved' },
    } as Parameters<Def['prepareMessage']>[0])!;

    expect(message.message).toBe('somebody accepted your sticker');
    expect(message.url).toBe('/images/74');
    // The message test hand-builds its details, so it cannot see where imageId
    // comes from. Sourcing it from `p.id` instead links every notification to
    // /images/<placementId> — a dead link, and one nothing above would catch.
    expect(await query('sticker-placement-resolved')).toContain('\'imageId\', p."targetId"');
  });

  it('selects approvals and moderator removals, nothing else', async () => {
    // Not `declined` and not `expired`: a declined sticker never appeared
    // anywhere, and an expiry is nobody deciding anything.
    expect(statusesSelectedBy(await query('sticker-placement-resolved'))).toBe('approved,removed');
  });

  it('reads the moment the owner acted, not the moment the placement was made', async () => {
    const sql = await query('sticker-placement-resolved');

    // A placement made before the last run and accepted after it is missed
    // entirely by a createdAt window — the failure is a notification that never
    // arrives for exactly the placements that waited longest.
    expect(sql).toContain('p."resolvedAt" > \'2026-08-16 00:00:00\'');
    expect(sql).not.toContain('p."createdAt" >');
  });

  it('leaves an owner removing a sticker from their own image silent', async () => {
    const sql = await query('sticker-placement-resolved');

    // Adding 'owner' here announces a creator's own housekeeping to the placer,
    // and every other assertion in this file passes with it added.
    expect(sql).not.toMatch(/'owner'/);
  });

  it('carries the status in the dedupe key', async () => {
    // Keying on the id alone means a later branch — a removal, say — collides
    // with the approval's key and is deduped away in silence.
    expect(await query('sticker-placement-resolved')).toContain(
      'CONCAT(\'sticker-placement-resolved:\',"status",\':\',"placementId")'
    );
  });

  it('covers free placements as well as paid', async () => {
    // The pending pair splits on `free` because their messages quote an amount.
    // This one names none, so one type serves both — and a `free` clause here
    // would silence exactly the tier that ships at daily volume.
    //
    // Matched as a word rather than as `p.free`, which the quoted spelling
    // `p."free"` walks straight past. Comments are stripped first because the
    // one above this clause says the word.
    const sql = (await query('sticker-placement-resolved')).replace(/--[^\n]*/g, '');

    expect(sql).not.toMatch(/\bfree\b/i);
  });
});

describe('the remix type stops announcing declines', () => {
  /**
   * Both halves in one run, deliberately. "Declines produce nothing" also passes
   * when the processor produces nothing at all, so the approval assertion beside
   * it is what makes this legible on revert rather than merely green.
   */
  it('selects approvals and removals, not declines', async () => {
    const sql = await query('remix-gallery-resolved');

    expect(statusesSelectedBy(sql)).toBe('approved,removed');
    // Narrowing this back to 'owner' is the shape that shipped, and it is what
    // left a moderator takedown telling nobody.
    expect(sql).toContain("p.\"removedBy\" IN ('owner', 'moderator', 'cosmeticTakedown')");
    // Same two mutations the sticker type is guarded against, and they survive
    // every assertion above on this one too.
    expect(sql).toMatch(/p\."placerId"\s+"userId"/);
    expect(sql).toContain("p.surface = 'remixGallery'");
  });

  it('still renders a decline that was already delivered', () => {
    // The message is built at READ time from stored details, so the rows sent
    // before this change would blank out if the branch were deleted with the
    // query clause.
    const message = defs['remix-gallery-resolved'].prepareMessage({
      type: 'remix-gallery-resolved',
      details: { imageId: 7, ownerUsername: 'somebody', status: 'declined' },
    } as Parameters<Def['prepareMessage']>[0])!;

    expect(message.message).toBe('somebody declined your remix submission');
  });
});

/**
 * Ticket 868ku94c2: a moderator takedown notified nobody on either surface.
 *
 * Two SQL branches, because a live takedown stamps `takenDownAt` while a pending
 * removal goes through `settlePlacement`, which stamps `resolvedAt`. One branch
 * on `status = 'removed'` takes the right rows and reads the wrong timestamp for
 * half of them.
 */
describe('a moderator ending a placement reaches the person who paid', () => {
  // Stripped, because the prose in these queries repeats the clauses verbatim —
  // a bare toContain would pass on a comment.
  const withoutSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

  it.each(['sticker-placement-resolved', 'remix-gallery-resolved'])(
    '%s selects the live takedown off takenDownAt',
    async (type) => {
      const sql = withoutSqlComments(await query(type));

      expect(sql).toContain('p."takenDownAt" IS NOT NULL');
      expect(sql).toContain('p."takenDownAt" > \'2026-08-16 00:00:00\'');
    }
  );

  it.each(['sticker-placement-resolved', 'remix-gallery-resolved'])(
    '%s selects the pending removal off resolvedAt, and only where no takedown was stamped',
    async (type) => {
      const sql = withoutSqlComments(await query(type));

      // The exclusion is what stops a live takedown matching BOTH branches. It
      // would not duplicate the notification — the dedupe key is per status —
      // but it would make the pending branch's window decide which run a live
      // takedown lands in, which is a different set of rows on every run.
      expect(sql).toContain('p."takenDownAt" IS NULL');
      expect(sql).toContain("p.\"removedBy\" IN ('moderator', 'cosmeticTakedown')");
    }
  );

  it('carries what the message has to branch on into the details', async () => {
    // Rendered at READ time from stored details, so an unprojected field is
    // `undefined`, not missing, and every ternary in moderatorRemovalMessage
    // takes its else: a cosmetic takedown reads as "a moderator removed your
    // sticker", a pending refund as "not refunded". Invisible in the SQL and in
    // the message code alike.
    for (const type of ['sticker-placement-resolved', 'remix-gallery-resolved']) {
      const sql = await query(type);

      expect(sql).toContain('\'removedBy\', p."removedBy"');
      expect(sql).toContain('\'wasLive\', p."takenDownAt" IS NOT NULL');
      expect(sql).toContain("'amount', p.amount");
    }
  });

  const message = (type: string, details: Record<string, unknown>) =>
    defs[type].prepareMessage({ type, details } as Parameters<Def['prepareMessage']>[0])!.message;

  const removal = (type: string, extra: Record<string, unknown>) =>
    message(type, {
      imageId: 7,
      ownerUsername: 'somebody',
      status: 'removed',
      amount: 500,
      ...extra,
    });

  it.each([
    ['sticker-placement-resolved', 'sticker', "somebody's image"],
    ['remix-gallery-resolved', 'remix', "somebody's gallery"],
  ])('%s names a moderator, not the creator', (type, noun, location) => {
    const live = removal(type, { removedBy: 'moderator', wasLive: true });

    expect(live).toBe(
      `A moderator removed your ${noun} from ${location}. The Buzz you paid is not refunded.`
    );
    // The failure this rules out is the sentence reading as the creator's
    // decision, which is what an owner-shaped message would do on this row.
    expect(live).not.toMatch(/^somebody /);
  });

  it.each([
    ['sticker-placement-resolved', 'sticker placement'],
    ['remix-gallery-resolved', 'remix submission'],
  ])('%s says a pending one was never reviewed rather than removed from anywhere', (type, noun) => {
    const pending = removal(type, { removedBy: 'moderator', wasLive: false });

    expect(pending).toBe(
      `A moderator removed your ${noun} before it was reviewed. The Buzz you paid is not refunded.`
    );
    // It never appeared on the image, so naming a place it came off is a
    // description of something that did not happen.
    expect(pending).not.toMatch(/somebody's/);
  });

  /**
   * The one branch that returns the money, and the reason `wasLive` exists.
   *
   * A pending cosmetic takedown settles through `removeByCosmeticTakedown`,
   * whose payout is principal AND fee back to the placer. Telling that person
   * their Buzz is gone is a false statement about their balance, and it is the
   * mistake a single "moderator removals are not refunded" rule would make.
   */
  it.each(['sticker-placement-resolved', 'remix-gallery-resolved'])(
    '%s promises the refund a pending cosmetic takedown actually pays',
    (type) => {
      expect(removal(type, { removedBy: 'cosmeticTakedown', wasLive: false })).toMatch(
        /Your Buzz has been refunded\./
      );
      // ...and does NOT promise it on the live one, where no money moves at all.
      expect(removal(type, { removedBy: 'cosmeticTakedown', wasLive: true })).toMatch(
        /The Buzz you paid is not refunded\./
      );
    }
  );

  it.each(['sticker-placement-resolved', 'remix-gallery-resolved'])(
    '%s blames the artwork rather than the placer on a cosmetic takedown',
    (type) => {
      for (const wasLive of [true, false])
        expect(removal(type, { removedBy: 'cosmeticTakedown', wasLive })).toMatch(
          /because a moderator took its artwork down/
        );
    }
  );

  it.each(['sticker-placement-resolved', 'remix-gallery-resolved'])(
    '%s says nothing about money on a free placement',
    (type) => {
      for (const removedBy of ['moderator', 'cosmeticTakedown'])
        for (const wasLive of [true, false]) {
          const free = removal(type, { removedBy, wasLive, amount: 0 });

          expect(free).not.toMatch(/refund|Buzz/);
          // Not empty, and not the paid sentence with the money clause merely
          // absent from a regex — the event itself is still described.
          expect(free).toMatch(/moderator/);
        }
    }
  );

  it('leaves the remix owner-removal sentence exactly as it was', () => {
    // The only removal that is not a moderator's, and the only one that keeps
    // the creator's name at the front. Folding it into the moderator wording
    // tells a submitter a moderator acted when a creator did.
    expect(removal('remix-gallery-resolved', { removedBy: 'owner', wasLive: true })).toBe(
      'somebody removed your remix from their gallery'
    );
  });
});

describe('both resolved types honour their own setting', () => {
  // There is no global opt-out filter on this path — createNotificationsBulk
  // does no settings lookup — so a processor that omits this clause cannot be
  // muted at all, however its toggle renders.
  it.each(['sticker-placement-resolved', 'remix-gallery-resolved'])('%s', async (type) => {
    expect(await query(type)).toContain(
      `WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = '${type}')`
    );
  });
});
