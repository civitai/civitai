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

  it('names the owner and links to the image with its stickers shown', async () => {
    const message = defs['sticker-placement-resolved'].prepareMessage({
      type: 'sticker-placement-resolved',
      details: { imageId: 74, ownerUsername: 'somebody', status: 'approved' },
    } as Parameters<Def['prepareMessage']>[0])!;

    expect(message.message).toBe('somebody accepted your sticker');
    // With the reveal param. Placed stickers are hidden by default site-wide, so
    // the bare `/images/74` lands the placer on an image that looks exactly like
    // one their sticker was removed from.
    expect(message.url).toBe('/images/74?stickers=1');
    // The message test hand-builds its details, so it cannot see where imageId
    // comes from. Sourcing it from `p.id` instead links every notification to
    // /images/<placementId> — a dead link, and one nothing above would catch.
    expect(await query('sticker-placement-resolved')).toContain('\'imageId\', p."targetId"');
  });

  /**
   * `pending` is the one that must never be here: it would tell a placer their
   * placement was resolved while it is still waiting, and the row would be
   * selected again for real when it settles.
   *
   * `declined` and `expired` joined the set on 2026-08-24 (`868kv5d36`). They were
   * excluded on 2026-08-18 on the grounds that a declined sticker never appeared
   * anywhere — true of the sticker, and not of the money, which is why the call
   * was reversed.
   */
  it('selects every settled outcome and nothing pending', async () => {
    expect(statusesSelectedBy(await query('sticker-placement-resolved'))).toBe(
      'approved,declined,expired,removed'
    );
  });

  /**
   * 🔴 Every sentence here is a claim about someone's Buzz, so each case asserts
   * the WHOLE string rather than a fragment. A `toContain('declined')` passes
   * against all three of these, including the two where the money sentence is
   * wrong.
   *
   * The money itself, read off `placementPaymentSplit`: `declined` keeps
   * `declineFeeAmount(...)` with the owner and refunds the rest; `expired`
   * refunds everything. `feeWaived` is the column that separates a decline that
   * refunded in full from one that did not — `removedBy` is NULL on a decline.
   */
  const resolved = (details: Record<string, unknown>) =>
    defs['sticker-placement-resolved'].prepareMessage({
      type: 'sticker-placement-resolved',
      details: { imageId: 74, ownerUsername: 'somebody', ...details },
    } as Parameters<Def['prepareMessage']>[0])!;

  it('quotes what a decline actually kept', () => {
    expect(
      resolved({ status: 'declined', amount: 500, feeToOwner: 25, refundPaid: true }).message
    ).toBe('somebody declined your sticker. They kept 25 Buzz; the rest has been refunded.');
  });

  it('promises no refund a free decline never earned', () => {
    // amount 0 by DB constraint. "Your Buzz has been refunded" would send someone
    // looking for a credit that never existed.
    // `refundPaid: true` so the receipt gate is not what is doing the work here.
    // What suppresses the money sentence on a free decline is the fee test — a
    // free row has no escrow and so no `feeToOwner` leg — and that is the guard
    // this pins. The `paidPlacement` check that used to sit in front of it was
    // deleted as dead code once this fixture proved removing it changed nothing.
    expect(resolved({ status: 'declined', amount: 0, refundPaid: true }).message).toBe(
      'somebody declined your sticker.'
    );
  });

  it('says the whole escrow came back when the fee was waived', () => {
    // declineByBlock and declineUnshowableHost. Claiming a fee was kept here is a
    // false statement about a balance, and `removedBy` is NULL so it cannot be
    // used to tell this from the case above.
    // 🔴 `feeToOwner` is what makes this able to fail. Without a fee row the fee
    // is 0, `!(0 > 0)` is already true, and the right-hand disjunct alone
    // produces the asserted string — so deleting `details.feeWaived ||` passed
    // the test named for that flag. The fixture has to carry a fee for the flag
    // to be the thing under test, and the test above it is then its control.
    expect(
      resolved({
        status: 'declined',
        amount: 500,
        feeWaived: true,
        feeToOwner: 25,
        refundPaid: true,
      }).message
    ).toBe('somebody declined your sticker. Your Buzz has been refunded.');
  });

  it('tells a placer their Buzz came back when nobody answered', () => {
    expect(resolved({ status: 'expired', amount: 500, refundPaid: true }).message).toBe(
      "Your sticker placement on somebody's image expired. Your Buzz has been refunded."
    );
  });

  it('says nothing about money when a free placement expires', () => {
    // `refundPaid: true` for the same reason as the free decline above.
    expect(resolved({ status: 'expired', amount: 0, refundPaid: true }).message).toBe(
      "Your sticker placement on somebody's image expired."
    );
  });

  /* Deleted: a test asserting both new branches return `/images/74`.
     `url` is computed once before any branch and every branch returns it, so no
     change to either new branch could turn it red — and the one mutation it did
     catch, editing that shared line, is already covered above. It also named a
     "reveal URL" that does not exist in this file. */

  /**
   * 🔴 The refund sentence is a claim about money that MOVED. Until the leg has a
   * receipt it has not, and a leg that exhausts its attempts never will.
   *
   * Both directions, because a message that never promises a refund would pass a
   * one-sided version of this and be useless.
   */
  it('promises a refund only once the refund has a receipt', () => {
    const unpaid = resolved({ status: 'expired', amount: 500 }).message;
    const paid = resolved({ status: 'expired', amount: 500, refundPaid: true }).message;

    expect(unpaid).toBe("Your sticker placement on somebody's image expired.");
    expect(paid).toBe(
      "Your sticker placement on somebody's image expired. Your Buzz has been refunded."
    );
  });

  /**
   * A decline that is neither waived nor carrying a receipted fee has not
   * finished settling. `planPayout` re-reads the legs with no `orderBy`, so a
   * resume can pay the placer's refund while the fee leg is still stranded —
   * and "your Buzz has been refunded" would then be wrong in the expensive
   * direction, because the fee is still owed and will be taken.
   */
  it('says nothing about money while the fee outcome is still unknown', () => {
    expect(resolved({ status: 'declined', amount: 500, refundPaid: true }).message).toBe(
      'somebody declined your sticker.'
    );
  });

  it('states the fee it kept even while the rest is still in flight', () => {
    // The fee half is observed — it has its own receipt — so it is still true
    // when the placer's leg has not landed. Dropping the whole sentence there
    // would tell someone nothing happened.
    expect(resolved({ status: 'declined', amount: 500, feeToOwner: 25 }).message).toBe(
      'somebody declined your sticker. They kept 25 Buzz.'
    );
  });

  it('reads the fee from the ledger row rather than recomputing it', async () => {
    const sql = await query('sticker-placement-resolved');

    // The per-space rate can move between the placement and the decline, so a
    // recomputed figure eventually disagrees with /user/transactions for the same
    // event. The unique index on (placementId, kind) makes this a lookup.
    expect(sql).toContain("'feeToOwner', (");
    // 🔴 A receipt, not a plan. settlePlacement writes the legs with a NULL
    // transactionId and the Buzz calls happen afterwards, outside that
    // transaction — so without these filters the message promises a refund that
    // may never have moved, and on a stranded leg never will.
    // 🔴 Anchored to their OWN occurrences. `pt."transactionId" IS NOT NULL`
    // appears twice, so a single file-wide `toContain` is satisfied by either —
    // deleting it from the fee subselect alone would ship "They kept 25 Buzz"
    // on a fee that has not moved, printing nothing.
    const stripped = sql.replace(/--[^\n]*/g, '');

    expect(stripped).toMatch(
      new RegExp(String.raw`pt\.kind = 'feeToOwner'[\s\S]{0,80}pt\."transactionId" IS NOT NULL`)
    );
    expect(stripped).toMatch(
      new RegExp(String.raw`'refundPaid', EXISTS \([\s\S]{0,200}pt\."transactionId" IS NOT NULL`)
    );

    // 🔴 The kind list is what gives `refundPaid` its meaning, and it was the
    // key name alone that was pinned. Swapping it to `feeToOwner` turns the flag
    // into "the OWNER got paid", so a non-waived decline says "the rest has been
    // refunded" while the placer's leg is exactly as stranded as before — which
    // is the failure this gate exists to prevent, reachable in one word.
    expect(stripped).toContain("pt.kind IN ('principalToPlacer', 'feeToPlacer')");
    expect(sql).toContain("pt.kind = 'feeToOwner'");
    expect(sql).toContain(`'feeWaived', p."feeWaived"`);
  });

  /**
   * 🔴 Each new branch's OWN time window, not just "resolvedAt appears somewhere".
   * The approved branch satisfies a file-wide `toContain` on its own, so swapping
   * the expired branch to `expiresAt` — which is exactly what its comment says it
   * is avoiding — passed every other assertion in this file.
   */
  it.each(['declined', 'expired'])('windows the %s branch on resolvedAt', async (status) => {
    // Comments stripped locally: `withoutSqlComments` lives in a later describe
    // block and is not in scope here. The prose in these branches names both
    // `resolvedAt` and `expiresAt`, so an unstripped match would pass on a
    // comment.
    const sql = (await query('sticker-placement-resolved')).replace(/--[^\n]*/g, '');

    expect(sql).toMatch(
      new RegExp(String.raw`p\.status = '${status}'[\s\S]{0,160}p\."resolvedAt" > '`)
    );
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

      // 🔴 `status` is the worst key in this object to lose, and nothing checked
      // it. Every message test fabricates it, so dropping `'status', p.status`
      // from the jsonb passes all of them — and `prepareMessage` then falls
      // through every branch and returns the trailing "accepted your sticker".
      // Every decline, expiry and takedown would tell the placer their sticker
      // was accepted.
      //
      // The dedupe-key test below reads `p.status "status"`, the outer projected
      // COLUMN. That is a different expression and survives the mutation intact,
      // which is why it does not cover this.
      expect(sql).toContain("'status', p.status");

      // Without these the sentence reads "undefined declined your sticker".
      // Four of the five money assertions are about the sentence around this
      // name and none of them can see where the name comes from.
      expect(sql).toContain("'ownerUsername', u.username");
      expect(sql).toContain('JOIN "User" u ON u.id = p."ownerId"');

      // Feeds the notification's actor, so losing it blanks the avatar. The
      // detail-fetcher's own suite hand-builds `ownerId`, so both sides of that
      // seam are fabricated and neither goes red.
      expect(sql).toContain('\'ownerId\', p."ownerId"');
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

  // Deliberate, and the reason it is pinned: the approval branch carries
  // `?stickers=1` so the placer can see what they paid for. A removal has
  // nothing to show, and turning the site-wide reveal on to display an absence
  // is worse than leaving it off. Do not make the two branches share a URL.
  it('links a removal to the plain image, without the reveal param', () => {
    const removed = defs['sticker-placement-resolved'].prepareMessage({
      type: 'sticker-placement-resolved',
      details: {
        imageId: 74,
        ownerUsername: 'somebody',
        status: 'removed',
        removedBy: 'moderator',
        wasLive: true,
        amount: 500,
      },
    } as Parameters<Def['prepareMessage']>[0])!;

    expect(removed.url).toBe('/images/74');
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
