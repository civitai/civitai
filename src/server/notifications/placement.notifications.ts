import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import {
  imageWithStickersUrl,
  REMIX_QUEUE_RECEIVED_URL,
  STICKER_QUEUE_RECEIVED_URL,
} from '~/components/Placement/queue-routes';

/**
 * A pending placement is invisible to the creator until something tells them.
 *
 * Without this the review path is a trap: the placer's Buzz sits in escrow, the
 * owner never learns there is anything to answer, and the only thing that
 * resolves it is the 48-hour expiry — which reads to both sides as the feature
 * being broken rather than as nobody having looked.
 *
 * The two sticker notifications link to the **queue**, not to the image.
 *
 * They used to link to the image, on the reasoning that answering means seeing
 * the sticker on the work it was placed on. That reasoning is still true and it
 * still lost: measured on prod 2026-08-20, 96 placements sat `pending` against
 * 251 approved while the feature took 306,819 Buzz across 461 purchases. People
 * were not refusing to answer — they were answering one placement, landing on an
 * image, and never learning that a queue existed. The queue page carries the
 * artwork per row and links each one to its image, so the in-situ view is one
 * click away rather than absent, and the owner sees the other fifteen.
 *
 * The remix ones go the same way, to the same page's remix surface. They were
 * left alone the first time round, correctly — one surface's fix should not
 * silently become another's. That stopped being a widening the moment the two
 * queues became one page: a remix notification landing on an image, when the
 * queue it belongs to is a tab away from the sticker queue, is the same trap
 * this change exists to close.
 */

/**
 * Shared by both surfaces; only the nouns differ.
 *
 * `wasLive` is `takenDownAt IS NOT NULL`, not a status -- a live takedown and a
 * pending removal both land on `removed`. It decides the money half: a pending
 * cosmetic takedown is the one mode that returns the escrow, so "not refunded"
 * there would be a false statement about someone's Buzz.
 */
function moderatorRemovalMessage({
  noun,
  pendingNoun,
  location,
  details,
}: {
  noun: string;
  /** What the thing is called before it went live — a sticker is placed, a remix is submitted. */
  pendingNoun: string;
  location: string;
  details: Record<string, unknown>;
}) {
  const cosmetic = details.removedBy === 'cosmeticTakedown';
  const wasLive = !!details.wasLive;
  const paid = Number(details.amount ?? 0) > 0;

  // Saying "a moderator removed your sticker" on a cosmetic takedown tells
  // someone their own placement was the problem when the artwork's maker's was.
  const what = cosmetic
    ? wasLive
      ? `Your ${noun} was removed from ${location} because a moderator took its artwork down.`
      : `Your ${pendingNoun} was cancelled because a moderator took its artwork down.`
    : wasLive
    ? `A moderator removed your ${noun} from ${location}.`
    : `A moderator removed your ${pendingNoun} before it was reviewed.`;

  // A free row is amount 0 by DB constraint; neither money sentence is true of it.
  if (!paid) return what;

  return cosmetic && !wasLive
    ? `${what} Your Buzz has been refunded.`
    : `${what} The Buzz you paid is not refunded.`;
}

/**
 * Whether this row moved any of the placer's Buzz at all.
 *
 * A free placement is `amount` 0 by DB constraint, so every sentence about money
 * is false of it -- including "your Buzz has been refunded", which would have
 * someone looking for a credit that never existed.
 */
const paidPlacement = (details: Record<string, unknown>) => Number(details.amount ?? 0) > 0;

/**
 * What a decline actually cost, in one sentence.
 *
 * Three cases, because the money is genuinely three different things:
 *
 * - **Free.** Nothing moved. The daily allowance is spent either way, but that is
 *   a fact about the allowance rather than about a refund.
 * - **Fee waived.** `declineByBlock` and `declineUnshowableHost` return the whole
 *   escrow (`FEE_WAIVING_ACTIONS`), so "they kept N Buzz" would be a false
 *   statement about someone's balance. `feeWaived` is a column on the row --
 *   `removedBy` is NULL on a decline and cannot tell these apart.
 * - **Fee taken.** `declined` splits `toOwner = declineFeeAmount(...)` and
 *   `toPlacer = amount - toOwner`, so part of the payment stays with the creator.
 *
 * The number comes from the `feeToOwner` ledger row rather than from recomputing
 * `declineFeeAmount`: the rate is per-space and can move between the placement
 * and the decline, so a recomputed figure would eventually disagree with the one
 * on `/user/transactions` for the same event.
 */
function declineMessage(details: Record<string, unknown>) {
  const declined = `${details.ownerUsername} declined your sticker`;

  // No `paidPlacement` check here, deliberately. A free row is `amount` 0 and
  // has no escrow, so it has no `feeToOwner` leg either — the "fee outcome
  // unknown" return below already covers it, and a second guard in front of it
  // was dead code that two tests were nonetheless claiming to exercise. Measured
  // by deleting it: nothing changed. The expiry branch still needs its own
  // check, because its money sentence is not behind a fee test.
  const fee = Number(details.feeToOwner ?? 0);
  const refunded = details.refundPaid ? ' Your Buzz has been refunded.' : '';
  const rest = details.refundPaid ? '; the rest has been refunded' : '';

  // Waived: the whole escrow comes back, so the refund clause is the only thing
  // to say and `refundPaid` decides whether it is true yet.
  if (details.feeWaived) return `${declined}.${refunded}`;

  // 🔴 Neither waived nor carrying a receipted fee means this decline has not
  // finished settling, and "your Buzz has been refunded" would be wrong in the
  // direction that matters: a fee is still owed and will be taken. It is
  // reachable because `planPayout` re-reads the legs with no `orderBy`, so a
  // sweeper-driven resume can receipt the placer's refund while the fee leg is
  // still stranded. Saying nothing about money is true at every moment.
  if (!(fee > 0)) return `${declined}.`;

  return `${declined}. They kept ${fee} Buzz${rest}.`;
}

export const placementNotifications = createNotificationProcessor({
  'sticker-placement-pending': {
    displayName: 'Sticker awaiting your review',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      message: `${details.placerUsername} wants to place a sticker on your image for ${details.amount} Buzz`,
      // The queue, not `/images/${details.imageId}` — see the note at the top of
      // this file. Static, because the whole point is the rows this owner has
      // not seen; a per-placement URL would land them back on one image.
      url: STICKER_QUEUE_RECEIVED_URL,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          p."ownerId" "userId",
          p.id "placementId",
          jsonb_build_object(
            'placementId', p.id,
            'imageId', p."targetId",
            'placerId', p."placerId",
            'placerUsername', u.username,
            'amount', p.amount
          ) as "details"
        FROM "Placement" p
        JOIN "User" u ON u.id = p."placerId"
        WHERE p.surface = 'sticker'
          AND p."targetType" = 'image'
          -- Paid rows only. A free one carries amount 0, so without this it
          -- reads "wants to place a sticker on your image for 0 Buzz" and is
          -- silenced by the toggle for the paid kind.
          AND p.free = false
          -- Only rows that are still waiting. A placement approved, declined or
          -- expired between the last run and this one has already been answered,
          -- and telling someone to review it sends them to a dead link.
          AND p.status = 'pending'
          -- Stamped by holdPlacementEscrow, so on the rows THIS query can see its
          -- presence means the escrow has at least been attempted. The row is
          -- created before that runs, and a notification landing in the gap would
          -- send someone to review a placement about to be unwound, or one in an
          -- auto space that approves itself seconds later.
          --
          -- ⚠️ The escrow half of that reasoning holds only because of the
          -- p.free = false above. A free row gets its deadline from the same
          -- INSERT that creates it and never touches escrow, so this gate alone
          -- would pass one straight through — announced as a paid placement,
          -- quoting 0 Buzz. The two clauses are load-bearing together.
          AND p."expiresAt" IS NOT NULL
          AND p."createdAt" > '${lastSent}'
      )
      SELECT
        CONCAT('sticker-placement-pending:',"placementId") "key",
        "userId",
        'sticker-placement-pending' "type",
        details
      FROM data
      -- A row means opted OUT. There is no global filter — every processor that
      -- honours its own toggle writes this clause itself — so without it the
      -- setting renders, saves, and does nothing. Kept on one line because the
      -- notification-settings-polarity guard matches the clause as a literal.
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = 'sticker-placement-pending')
    `,
  },

  /**
   * Its own type, not a branch of the paid one, because it is a different
   * decision to make and a different one to mute.
   *
   * A creator who has opened free capacity has said yes to the free tier in
   * particular, and one who wants only the paid queue in their notifications
   * needs to be able to say so without silencing the placements they are being
   * paid for. One type with a branching message would make those two settings
   * the same switch.
   *
   * The message carries no amount for the obvious reason and one less obvious
   * one: "0 Buzz" reads as a bug rather than as the offer, and the thing worth
   * saying instead is that a slot is being held while they decide.
   *
   * Only ever fires for a review-mode space. An auto space approves the row at
   * the call site before the job next runs, and `status = 'pending'` is what
   * keeps this from telling someone to review something already live.
   */
  'sticker-placement-free-pending': {
    displayName: 'Free sticker awaiting your review',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      message: `${details.placerUsername} wants to place a free sticker on your image`,
      // Same queue as the paid one: a free placement holds a slot and expires
      // the same way, and splitting the two destinations would teach an owner
      // two different routes for one job.
      url: STICKER_QUEUE_RECEIVED_URL,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          p."ownerId" "userId",
          p.id "placementId",
          jsonb_build_object(
            'placementId', p.id,
            'imageId', p."targetId",
            'placerId', p."placerId",
            'placerUsername', u.username
          ) as "details"
        FROM "Placement" p
        JOIN "User" u ON u.id = p."placerId"
        WHERE p.surface = 'sticker'
          AND p."targetType" = 'image'
          AND p.free = true
          AND p.status = 'pending'
          -- Written by the same INSERT that creates a free row rather than
          -- stamped afterwards, so unlike the paid path there is no window where
          -- this is null. Kept anyway: it is the one column that says the row is
          -- reachable by the expiry sweep, and a free row that is not would hold
          -- one of the creator's slots forever.
          AND p."expiresAt" IS NOT NULL
          AND p."createdAt" > '${lastSent}'
      )
      SELECT
        CONCAT('sticker-placement-free-pending:',"placementId") "key",
        "userId",
        'sticker-placement-free-pending' "type",
        details
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = 'sticker-placement-free-pending')
    `,
  },

  /**
   * Same trap as the sticker one, with a longer fuse: a gallery submission the
   * owner never sees expires at 48 hours and refunds, so silence costs the
   * submitter two days of held Buzz and tells the owner nothing.
   *
   * Links to the host image rather than to a queue: deciding whether a remix
   * belongs next to your work means seeing your work.
   */
  'remix-gallery-pending': {
    displayName: 'Remix awaiting your review',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      message: `${details.placerUsername} wants to add a remix to your gallery for ${details.amount} Buzz`,
      url: REMIX_QUEUE_RECEIVED_URL,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          p."ownerId" "userId",
          p.id "placementId",
          jsonb_build_object(
            'placementId', p.id,
            'imageId', p."targetId",
            'placerId', p."placerId",
            'placerUsername', u.username,
            'amount', p.amount
          ) as "details"
        FROM "Placement" p
        JOIN "User" u ON u.id = p."placerId"
        WHERE p.surface = 'remixGallery'
          AND p."targetType" = 'image'
          AND p.status = 'pending'
          -- Free submissions are their own type, with their own toggle. Excluded
          -- here rather than left to fall through both: this message quotes an
          -- amount, and a free row's amount is 0.
          AND NOT p.free
          -- Stamped by holdPlacementEscrow. Its absence means the row exists but
          -- the escrow has not been attempted, and a notification landing in that
          -- gap sends someone to review a submission about to be unwound.
          AND p."expiresAt" IS NOT NULL
          AND p."createdAt" > '${lastSent}'
          -- A row means opted OUT, and there is no global filter — every
          -- processor that honours its own toggle writes this clause itself. It
          -- was missing here, so the setting rendered, saved, and did nothing.
          --
          -- Inside the CTE and against p."ownerId", which is the recipient; the
          -- projected "userId" outside the CTE is the same value and would work
          -- there too. Kept on one line either way, because the polarity guard
          -- matches the clause as a literal.
          AND NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = p."ownerId" AND type = 'remix-gallery-pending')
      )
      SELECT
        CONCAT('remix-gallery-pending:',"placementId") "key",
        "userId",
        'remix-gallery-pending' "type",
        details
      FROM data
    `,
  },

  /**
   * The free tier's own type, so a creator can take one stream and not the other.
   *
   * Separate rather than a branch inside the paid message, because the two are
   * different offers: the paid one quotes Buzz and the free one spends one of the
   * creator's own slots and pays them nothing until they accept. A creator who
   * wants only paid submissions announced has no way to say so if both arrive
   * under one type.
   *
   * `expiresAt` is not checked here. It gates the paid types because
   * `holdPlacementEscrow` stamps it in a second statement, so its absence means
   * the escrow has not been attempted yet; a free row is written with its
   * deadline by the same INSERT, so there is no such gap to wait out.
   */
  'remix-gallery-free-pending': {
    displayName: 'Free remix awaiting your review',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => ({
      message: `${details.placerUsername} submitted a free remix to your gallery`,
      url: REMIX_QUEUE_RECEIVED_URL,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          p."ownerId" "userId",
          p.id "placementId",
          jsonb_build_object(
            'placementId', p.id,
            'imageId', p."targetId",
            'placerId', p."placerId",
            'placerUsername', u.username
          ) as "details"
        FROM "Placement" p
        JOIN "User" u ON u.id = p."placerId"
        WHERE p.surface = 'remixGallery'
          AND p."targetType" = 'image'
          AND p.status = 'pending'
          AND p.free
          AND p."createdAt" > '${lastSent}'
          -- A row here means opted OUT, and its own type rather than the paid
          -- one's: silencing free submissions must not silence the queue a
          -- creator is being paid for.
          AND NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = p."ownerId" AND type = 'remix-gallery-free-pending')
      )
      SELECT
        CONCAT('remix-gallery-free-pending:',"placementId") "key",
        "userId",
        'remix-gallery-free-pending' "type",
        details
      FROM data
    `,
  },

  /**
   * The submitter's side of the same decision. They paid and then waited, and
   * without this the only signal that anything happened is their Buzz balance.
   *
   * Announces an outcome the submitter benefits from hearing and stays silent on
   * the ones they don't: approval, an owner removing an entry that was already
   * live in their gallery, and every way a moderator can end one — live takedown,
   * pending removal, cosmetic takedown (Justin, 2026-08-21). A decline is
   * deliberately not announced —
   * Justin's call, 2026-08-18 — on the grounds that "X declined you" mostly buys
   * the placer a grudge against a creator who is entitled to say no. The
   * placements page still shows it.
   *
   * Also excludes `expired`, for a different reason: nobody decided anything and
   * the refund is full, so any message here would describe a decision that was
   * never made.
   */
  'remix-gallery-resolved': {
    displayName: 'Your remix submission was answered',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => {
      const url = `/images/${details.imageId}`;
      if (details.status === 'approved')
        return { message: `${details.ownerUsername} added your remix to their gallery`, url };
      // An OWNER removal is not a decline — it happened after the entry was live,
      // and approval had already paid the owner, so nothing is refunded. Saying
      // "declined" would imply a fee they never paid; promising a refund would be
      // worse. The moderator modes reach rows that never went live, and a pending
      // cosmetic takedown IS refunded, so their money sentence is
      // `moderatorRemovalMessage`'s call rather than this rule's.
      if (details.status === 'removed')
        return {
          message:
            details.removedBy === 'owner'
              ? `${details.ownerUsername} removed your remix from their gallery`
              : moderatorRemovalMessage({
                  noun: 'remix',
                  pendingNoun: 'remix submission',
                  location: `${details.ownerUsername}'s gallery`,
                  details,
                }),
          url,
        };
      // Unreachable for anything sent from now on -- the query stopped selecting
      // declines. Kept because the message is rendered at READ time from the
      // stored details, so deleting this branch would blank the notifications
      // already delivered to people who were declined before that changed.
      return { message: `${details.ownerUsername} declined your remix submission`, url };
    },
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          p."placerId" "userId",
          p.id "placementId",
          p.status "status",
          jsonb_build_object(
            'placementId', p.id,
            'imageId', p."targetId",
            'ownerId', p."ownerId",
            'ownerUsername', u.username,
            'status', p.status,
            'removedBy', p."removedBy",
            'wasLive', p."takenDownAt" IS NOT NULL,
            'amount', p.amount
          ) as "details"
        FROM "Placement" p
        JOIN "User" u ON u.id = p."ownerId"
        WHERE p.surface = 'remixGallery'
          AND p."targetType" = 'image'
          -- Each branch keys off the moment its own actor acted, never off
          -- createdAt: a submission made before the last run and answered after
          -- it would be missed entirely by a createdAt window.
          --
          -- Removal is deliberately a separate branch on takenDownAt, because
          -- taking a live entry down does not touch resolvedAt -- that column
          -- records who approved it, and this path must not destroy the
          -- approval trail.
          AND (
            (
              p.status = 'approved'
              AND p."resolvedAt" IS NOT NULL
              AND p."resolvedAt" > '${lastSent}'
            )
            OR (
              p.status = 'removed'
              -- Keying on the actor instead (takenDownById = ownerId) looks like
              -- the same test and is not: it reads a moderator-mode removal on
              -- their own gallery as a creator's. Tried in #4148 and reverted.
              AND p."removedBy" IN ('owner', 'moderator', 'cosmeticTakedown')
              AND p."takenDownAt" IS NOT NULL
              AND p."takenDownAt" > '${lastSent}'
            )
            OR (
              -- A moderator ending a PENDING submission. It never went live, so
              -- there is no takedown to record and settlePlacement stamps
              -- resolvedAt like every other settled outcome -- which is why this
              -- cannot share the branch above, and why it excludes rows that DO
              -- carry a takedown rather than leaving them to match both.
              --
              -- A pending removeByModerator forfeits the whole escrow, fee and
              -- principal; a pending removeByCosmeticTakedown refunds it in full.
              --
              -- No 'owner' here. An owner ending a pending submission is a
              -- decline, which is deliberately silent, and the remove path only
              -- ever touches rows that are already approved.
              p.status = 'removed'
              AND p."removedBy" IN ('moderator', 'cosmeticTakedown')
              AND p."takenDownAt" IS NULL
              AND p."resolvedAt" IS NOT NULL
              AND p."resolvedAt" > '${lastSent}'
            )
          )
      )
      SELECT
        -- The status is part of the key because one placement legitimately
        -- produces two of these: approved, then removed later. Keying on the id
        -- alone means the approval burns the key and the removal is deduped
        -- away silently.
        CONCAT('remix-gallery-resolved:',"status",':',"placementId") "key",
        "userId",
        'remix-gallery-resolved' "type",
        details
      FROM data
      -- A row means opted OUT. This type shipped without the clause, so its
      -- toggle rendered, saved, and changed nothing -- there is no global filter
      -- on this path (createNotificationsBulk does no settings lookup), so a
      -- processor that omits it is unmuteable. Kept on one line because the
      -- polarity guard matches the clause as a literal.
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = 'remix-gallery-resolved')
    `,
  },

  /**
   * The one refund that needs explaining: a submission paid for from the post
   * editor whose image never became submittable.
   *
   * Deliberately NOT a general expiry notification. `remix-gallery-resolved`
   * excludes `expired` because "nobody decided anything and the refund is full,
   * so any message here would describe a decision that was never made" — and
   * that reasoning still holds for a creator who simply never answered. This
   * covers the other cause, where we took the money and then could not deliver:
   * the image stayed a draft, was blocked, or came back rated above what the
   * creator accepts.
   *
   * The two are told apart by `awaitingReadiness`, which the readiness pass
   * CLEARS when it starts the clock. So a row still carrying it at expiry never
   * reached the owner's queue, and one without it did — a distinction no status
   * column records, which is why this reads the surface's own payload.
   */
  'remix-gallery-undelivered': {
    displayName: 'A remix submission could not be delivered',
    category: NotificationCategory.Creator,
    // The money sentence comes from `amount`, not from `free` — a free row moved
    // no Buzz, and telling someone their Buzz came back when none was spent is
    // false in a way they can check. Same rule the sticker type follows, and the
    // reason one type can serve both.
    prepareMessage: ({ details }) => ({
      message:
        Number(details.amount ?? 0) > 0
          ? `Your remix couldn't be submitted to ${details.ownerUsername}'s gallery, so your Buzz has been returned.`
          : `Your remix couldn't be submitted to ${details.ownerUsername}'s gallery.`,
      url: `/images/${details.imageId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          p."placerId" "userId",
          p.id "placementId",
          jsonb_build_object(
            'placementId', p.id,
            'imageId', p."targetId",
            -- The party to name on the avatar. This notification is addressed to
            -- the PLACER, so the other party is the owner; without the id the row
            -- falls back to a generic bell.
            'ownerId', p."ownerId",
            'ownerUsername', u.username,
            -- Decides the money sentence above. A free row is 0 and must not be
            -- told about Buzz that never moved.
            'amount', p.amount
          ) as "details"
        FROM "Placement" p
        JOIN "User" u ON u.id = p."ownerId"
        WHERE p.surface = 'remixGallery'
          AND p."targetType" = 'image'
          AND p.status = 'expired'
          -- Refused for something about the IMAGE, not by a deadline passing.
          -- A draft the submitter simply never published also ends as expired
          -- with the same refund, and telling THEM we could not deliver would be
          -- the false-blame message the resolved type exists to avoid. Only the
          -- readiness pass sets this.
          AND p.data ->> 'undeliverable' = 'true'
          -- Keyed off when it was settled, not when it was created: a submission
          -- made before the last run and expired after it would be missed by a
          -- createdAt window.
          AND p."resolvedAt" IS NOT NULL
          AND p."resolvedAt" > '${lastSent}'
      )
      SELECT
        CONCAT('remix-gallery-undelivered:',"placementId") "key",
        "userId",
        'remix-gallery-undelivered' "type",
        details
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = 'remix-gallery-undelivered')
    `,
  },

  /**
   * The sticker placer's side, and the gap Ellie reported: a placement could be
   * accepted and the only signal was the placer's Buzz balance moving.
   *
   * Approval, the moderator removal modes, DECLINE and EXPIRY. An OWNER removal
   * is still silent here and is not on the remix type -- that asymmetry is
   * deliberate (Justin, 2026-08-21).
   *
   * Decline and expiry were deliberately excluded on 2026-08-18, on the grounds
   * that a declined sticker never appeared anywhere. Reversed on 2026-08-24
   * (`868kv5d36`) because that reasoning covers the sticker and not the money: a
   * decline keeps the placer's fee, so the only signal they had was a balance
   * that went down. Justin also asked for expiry, so a placer learns their Buzz
   * came back rather than inferring it.
   *
   * Covers free placements as well as paid, unlike the pending pair, which split
   * because their messages quote an amount and a free row's is 0. The branches
   * here choose their own sentence about money from `amount`, `feeWaived` and
   * `refundPaid` -- NOT from `free`, which is a column on the row and is not in
   * this payload -- so a free placement is never told about Buzz that did not
   * move and one type still serves both.
   *
   * `refundPaid` is a receipt rather than a plan. See the subquery that builds
   * it: a settled row's payout legs exist before the Buzz calls do, so a refund
   * sentence derived from the status alone can be permanently false.
   *
   * An `auto` space approves at the call site, so its placer gets this seconds
   * after placing, confirming something they watched happen. Left that way on
   * purpose: no column distinguishes an auto approval from a fast one, and the
   * only discriminator available -- the gap between `createdAt` and
   * `resolvedAt` -- would be a rule we invented and would have to keep true.
   */
  'sticker-placement-resolved': {
    // "Resolved", not "answered": expiry is the outcome where nobody answered,
    // and this is the label on the mute switch.
    displayName: 'Your sticker placement was resolved',
    category: NotificationCategory.Creator,
    prepareMessage: ({ details }) => {
      if (details.status === 'removed')
        return {
          message: moderatorRemovalMessage({
            noun: 'sticker',
            pendingNoun: 'sticker placement',
            location: `${details.ownerUsername}'s image`,
            details,
          }),
          // The plain image URL, not the revealing one: this sticker is gone, and
          // turning the whole reveal on to show its absence is the opposite of
          // what the link is for.
          url: `/images/${details.imageId}`,
        };
      // The plain image URL for every outcome the sticker is not there to see.
      // Only an approval gets the revealing one.
      const plain = `/images/${details.imageId}`;

      if (details.status === 'declined') return { message: declineMessage(details), url: plain };

      if (details.status === 'expired')
        return {
          // Not "they did not answer in time". The outcome is the same whether
          // the creator was busy or away, and what a placer needs from this
          // sentence is what happened to their Buzz, not whose fault it was.
          message: `Your sticker placement on ${details.ownerUsername}'s image expired.${
            paidPlacement(details) && details.refundPaid ? ' Your Buzz has been refunded.' : ''
          }`,
          url: plain,
        };

      return {
        message: `${details.ownerUsername} accepted your sticker`,
        url: imageWithStickersUrl(details.imageId),
      };
    },
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          p."placerId" "userId",
          p.id "placementId",
          p.status "status",
          jsonb_build_object(
            'placementId', p.id,
            'imageId', p."targetId",
            'ownerId', p."ownerId",
            'ownerUsername', u.username,
            'status', p.status,
            'removedBy', p."removedBy",
            'wasLive', p."takenDownAt" IS NOT NULL,
            'amount', p.amount,
            -- The two things a decline's money sentence turns on, and both are
            -- columns on the row rather than a join: removedBy is NULL on a
            -- decline and cannot tell a waived fee from a taken one.
            'feeWaived', p."feeWaived",
            -- What was actually taken, not what today's rate would compute. The
            -- rate is per-space and can move between the placement and the
            -- decline. NULL where no fee leg was ever claimed, which is the
            -- waived and free cases. Hits the unique index on
            -- (placementId, kind), so it is a lookup rather than a scan.
            'feeToOwner', (
              SELECT pt.amount FROM "PlacementTransaction" pt
              WHERE pt."placementId" = p.id AND pt.kind = 'feeToOwner'
                AND pt."transactionId" IS NOT NULL
            ),
            -- 🔴 Whether the placer's money has actually MOVED, not whether it
            -- was planned. settlePlacement writes the status flip and the payout
            -- legs in one transaction with transactionId NULL on every leg; the
            -- Buzz calls happen afterwards, outside it, and runLeg can decline
            -- the lock, fail, or exhaust its attempts and stop. The
            -- notification job runs every minute off the committed row, so
            -- without this "your Buzz has been refunded" is a claim about a
            -- movement nobody has observed -- and on a stranded leg it stays
            -- false, with the placer's balance as the thing disagreeing.
            --
            -- One flag for both placer-directed kinds. A partial payout (the
            -- principal receipted, the fee refund not) reads as refunded, which
            -- is the direction that errs toward saying less rather than saying
            -- something false.
            'refundPaid', EXISTS (
              SELECT 1 FROM "PlacementTransaction" pt
              WHERE pt."placementId" = p.id
                AND pt.kind IN ('principalToPlacer', 'feeToPlacer')
                AND pt."transactionId" IS NOT NULL
            )
          ) as "details"
        FROM "Placement" p
        JOIN "User" u ON u.id = p."ownerId"
        WHERE p.surface = 'sticker'
          AND p."targetType" = 'image'
          -- Each branch keys off the moment its own actor acted, never off
          -- createdAt: a placement made before the last run and answered after
          -- it would be missed entirely by a createdAt window.
          AND (
            (
              p.status = 'approved'
              AND p."resolvedAt" IS NOT NULL
              AND p."resolvedAt" > '${lastSent}'
            )
            OR (
              -- The MODE the remover acted in, not their role. An OWNER removal
              -- stays silent -- taking a sticker off your own image is your
              -- choice to make -- so only the two moderator modes are here.
              --
              -- takenDownAt is its own column, and the reason this is a separate
              -- branch: taking a live placement down does not touch resolvedAt,
              -- which records who approved it.
              p.status = 'removed'
              AND p."removedBy" IN ('moderator', 'cosmeticTakedown')
              AND p."takenDownAt" IS NOT NULL
              AND p."takenDownAt" > '${lastSent}'
            )
            OR (
              -- A moderator ending a PENDING placement. It never went live, so
              -- there is no takedown to record and settlePlacement stamps
              -- resolvedAt like every other settled outcome -- which is why this
              -- cannot share the branch above, and why it excludes rows that DO
              -- carry a takedown rather than leaving them to match both.
              --
              -- A pending removeByModerator forfeits the whole escrow, fee and
              -- principal; a pending removeByCosmeticTakedown refunds it in full.
              p.status = 'removed'
              AND p."removedBy" IN ('moderator', 'cosmeticTakedown')
              AND p."takenDownAt" IS NULL
              AND p."resolvedAt" IS NOT NULL
              AND p."resolvedAt" > '${lastSent}'
            )
            OR (
              -- The creator said no. settlePlacement stamps resolvedAt for every
              -- decline mode, including the two that waive the fee, so one branch
              -- covers all three and the MESSAGE picks its money sentence from
              -- feeWaived and amount.
              p.status = 'declined'
              AND p."resolvedAt" IS NOT NULL
              AND p."resolvedAt" > '${lastSent}'
            )
            OR (
              -- Nobody answered. expirePlacements runs over status = 'pending'
              -- regardless of free, and 'expire' stamps resolvedAt like any other
              -- settled outcome -- so this needs no expiresAt window of its own,
              -- which would re-report a row whose deadline passed long before the
              -- job reached it.
              -- ⚠️ This also selects a FAILED CREATION. createStickerPlacement
              -- compensates a failure by calling settlePlacement with 'expire',
              -- so the row is indistinguishable from one that timed out -- and
              -- the placer, who already saw an error, is told it "expired".
              -- Accepted knowingly (Justin, 2026-08-24) rather than missed: the
              -- path is rare and the receipt gate above keeps the sentence from
              -- claiming a refund that did not happen. Telling the two apart
              -- needs a column the row does not carry, so do not "fix" this with
              -- a WHERE clause -- it would need the unwind to mark itself first.
              p.status = 'expired'
              AND p."resolvedAt" IS NOT NULL
              AND p."resolvedAt" > '${lastSent}'
            )
          )
      )
      SELECT
        -- The status is part of the key because one placement legitimately
        -- produces two of these: accepted, then taken down later. Keying on the
        -- id alone means the acceptance burns the key and the takedown is
        -- deduped away silently.
        CONCAT('sticker-placement-resolved:',"status",':',"placementId") "key",
        "userId",
        'sticker-placement-resolved' "type",
        details
      FROM data
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = data."userId" AND type = 'sticker-placement-resolved')
    `,
  },
});
