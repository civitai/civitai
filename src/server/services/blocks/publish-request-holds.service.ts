import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  HOLD_LABEL_MAX,
  HOLD_REASON_MAX,
  HOLD_REASON_MIN,
  MAX_OPEN_HOLDS_PER_APP,
  APPROVE_CLAIM_TTL_MINUTES,
  type PublishRequestHoldKind,
} from '~/shared/constants/publish-request-holds.constants';

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** Advisory-lock class for review holds ('ARVH'), so its keys never meet another lock's. */
const HOLD_LOCK_CLASS = 0x41525648;

export type { PublishRequestHoldKind };

export type PublishRequestHold = {
  id: number;
  slug: string;
  publishRequestId: string;
  requestKind: PublishRequestHoldKind;
  placedByUserId: number;
  placedByUsername: string | null;
  placedByLabel: string;
  reason: string;
  createdAt: Date;
  clearedAt: Date | null;
  clearedByUserId: number | null;
  clearedKind: 'cleared' | 'overridden' | null;
  clearedReason: string | null;
};

/** Thrown when an approve meets an open hold it may not pass. Its message is moderator-facing. */
export class PublishRequestHeldError extends Error {
  constructor(message: string, readonly holds: PublishRequestHold[]) {
    super(message);
    this.name = 'PublishRequestHeldError';
  }
}

export class PublishRequestHoldInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishRequestHoldInputError';
  }
}

const REQUEST_TABLE: Record<PublishRequestHoldKind, Prisma.Sql> = {
  onsite: Prisma.raw('app_block_publish_requests'),
  listing: Prisma.raw('app_listing_publish_requests'),
};

const HOLD_COLUMNS = Prisma.sql`
  h.id, h.slug, h.publish_request_id AS "publishRequestId", h.request_kind AS "requestKind",
  h.placed_by_user_id AS "placedByUserId", u.username AS "placedByUsername",
  h.placed_by_label AS "placedByLabel", h.reason, h.created_at AS "createdAt",
  h.cleared_at AS "clearedAt", h.cleared_by_user_id AS "clearedByUserId",
  h.cleared_kind AS "clearedKind", h.cleared_reason AS "clearedReason"`;

function assertReason(reason: string | null | undefined, what: string): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < HOLD_REASON_MIN || trimmed.length > HOLD_REASON_MAX)
    throw new PublishRequestHoldInputError(
      `${what} must be ${HOLD_REASON_MIN}–${HOLD_REASON_MAX} characters`
    );
  return trimmed;
}

/**
 * Serialises hold writes against an approve's final check for the same app. Held until the
 * enclosing transaction ends, so every caller must run inside one.
 */
async function lockApp(tx: RawClient, slug: string) {
  await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${HOLD_LOCK_CLASS}::int, hashtext(${slug}))::text`;
}

export async function getOpenHoldsBySlug(
  db: RawClient,
  slugs: string[]
): Promise<PublishRequestHold[]> {
  if (!slugs.length) return [];
  return db.$queryRaw<PublishRequestHold[]>`
    SELECT ${HOLD_COLUMNS}
    FROM app_publish_request_holds h LEFT JOIN "User" u ON u.id = h.placed_by_user_id
    WHERE h.slug = ANY(${slugs}::text[]) AND h.cleared_at IS NULL
    ORDER BY h.created_at`;
}

export async function listHoldsBySlug(
  db: RawClient,
  slugs: string[],
  opts: { includeCleared?: boolean } = {}
): Promise<PublishRequestHold[]> {
  if (!opts.includeCleared) return getOpenHoldsBySlug(db, slugs);
  if (!slugs.length) return [];
  return db.$queryRaw<PublishRequestHold[]>`
    SELECT ${HOLD_COLUMNS}
    FROM app_publish_request_holds h LEFT JOIN "User" u ON u.id = h.placed_by_user_id
    WHERE h.slug = ANY(${slugs}::text[])
    ORDER BY h.created_at DESC
    LIMIT 500`;
}

/**
 * Open-hold counts per slug for the review queue. Fails open (returns an empty map) so the queue
 * still loads where the table has not been applied; the approve paths read the table directly
 * and fail closed.
 */
export async function getOpenHoldCountsBySlug(
  db: RawClient,
  slugs: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!slugs.length) return counts;
  try {
    const rows = await db.$queryRaw<{ slug: string; n: number }[]>`
      SELECT slug, count(*)::int AS n FROM app_publish_request_holds
      WHERE slug = ANY(${slugs}::text[]) AND cleared_at IS NULL
      GROUP BY slug`;
    for (const r of rows) counts.set(r.slug, r.n);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[publish-request-holds] open-hold count read failed', err);
  }
  return counts;
}

async function liveClaimExists(tx: RawClient, slug: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT 1 AS n FROM app_publish_request_approve_claims
    WHERE slug = ${slug}
      AND claimed_at > now() - make_interval(mins => ${Prisma.raw(
        String(APPROVE_CLAIM_TTL_MINUTES)
      )})`;
  return rows.length > 0;
}

/** Run inside a transaction: the app lock it takes is what orders it against an approve. */
export async function placeHold(
  tx: RawClient,
  input: {
    publishRequestId: string;
    kind: PublishRequestHoldKind;
    actorUserId: number;
    reason: string;
    label: string;
  }
): Promise<PublishRequestHold> {
  const reason = assertReason(input.reason, 'A hold reason');
  const label = input.label.trim();
  if (!label || label.length > HOLD_LABEL_MAX)
    throw new PublishRequestHoldInputError(`A hold label must be 1–${HOLD_LABEL_MAX} characters`);

  const [request] = await tx.$queryRaw<{ slug: string; status: string }[]>`
    SELECT slug, status FROM ${REQUEST_TABLE[input.kind]} WHERE id = ${input.publishRequestId}`;
  if (!request) throw new PublishRequestHoldInputError('Publish request not found');

  await lockApp(tx, request.slug);
  const [current] = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM ${REQUEST_TABLE[input.kind]} WHERE id = ${input.publishRequestId}`;
  if (current?.status === 'approved')
    throw new PublishRequestHoldInputError('This request is already approved');
  const claim = await liveClaimExists(tx, request.slug);
  if (claim)
    throw new PublishRequestHoldInputError(
      'A moderator is approving this app right now; the hold would not stop it. Check the request once the approve finishes.'
    );

  const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app_publish_request_holds
    WHERE slug = ${request.slug} AND cleared_at IS NULL`;
  if (n >= MAX_OPEN_HOLDS_PER_APP)
    throw new PublishRequestHoldInputError(
      `This app already has ${MAX_OPEN_HOLDS_PER_APP} open holds`
    );

  const [{ id }] = await tx.$queryRaw<{ id: number }[]>`
    INSERT INTO app_publish_request_holds
      (slug, publish_request_id, request_kind, placed_by_user_id, placed_by_label, reason)
    VALUES (${request.slug}, ${input.publishRequestId}, ${input.kind}, ${input.actorUserId},
            ${label}, ${reason})
    RETURNING id`;
  const [hold] = await tx.$queryRaw<PublishRequestHold[]>`
    SELECT ${HOLD_COLUMNS}
    FROM app_publish_request_holds h LEFT JOIN "User" u ON u.id = h.placed_by_user_id
    WHERE h.id = ${id}`;
  return hold;
}

export async function clearHold(
  tx: RawClient,
  input: { holdId: number; actorUserId: number; reason: string }
): Promise<void> {
  const reason = assertReason(input.reason, 'A clear reason');
  const cleared = await tx.$executeRaw`
    UPDATE app_publish_request_holds
    SET cleared_at = now(), cleared_by_user_id = ${input.actorUserId},
        cleared_kind = 'cleared', cleared_reason = ${reason}
    WHERE id = ${input.holdId} AND cleared_at IS NULL`;
  if (cleared === 0) throw new PublishRequestHoldInputError('Hold not found or already cleared');
}

function describeHolds(holds: PublishRequestHold[]) {
  return holds
    .map(
      (h) => `${h.placedByLabel} (${h.placedByUsername ?? `user ${h.placedByUserId}`}): ${h.reason}`
    )
    .join('; ');
}

function heldError(holds: PublishRequestHold[], suffix: string) {
  return new PublishRequestHeldError(
    `This app has ${holds.length} open review hold${holds.length === 1 ? '' : 's'}: ` +
      `${describeHolds(holds)}. ${suffix}`,
    holds
  );
}

/**
 * An approve may pass only the holds the moderator was shown (`shownHoldIds`, sent by the review
 * page) and only with an override reason. A hold placed after the page loaded refuses.
 */
function assertHoldsOverridable(
  holds: PublishRequestHold[],
  input: { overrideReason?: string | null; shownHoldIds?: number[] | null }
): string | null {
  if (!holds.length) return null;
  const shown = new Set(input.shownHoldIds ?? []);
  const unseen = holds.filter((h) => !shown.has(h.id));
  const clearOrOverride = 'Clear them, or approve with an override reason.';
  if (unseen.length)
    throw heldError(
      unseen,
      input.overrideReason
        ? 'It was placed after this review was loaded; reload and review it.'
        : clearOrOverride
    );
  if (!input.overrideReason) throw heldError(holds, clearOrOverride);
  return assertReason(input.overrideReason, 'An override reason');
}

type ApproveHoldInput = {
  slug: string;
  overrideReason?: string | null;
  shownHoldIds?: number[] | null;
};

/** The approve paths' first check, before any side effect. */
export async function checkHoldsBeforeApprove(db: RawClient, input: ApproveHoldInput) {
  let holds: PublishRequestHold[];
  try {
    holds = await getOpenHoldsBySlug(db, [input.slug]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[publish-request-holds] hold read failed; refusing approve', err);
    throw new PublishRequestHeldError(
      "Could not read this app's review holds, so approve is refused. Try again, or ask an engineer to check the review-holds tables.",
      []
    );
  }
  assertHoldsOverridable(holds, input);
}

/**
 * For an approve whose writes span outside I/O (on-site): re-checks the holds under the app lock
 * and records that an approve is running, so {@link placeHold} refuses until
 * {@link releaseApproveClaim}. A claim older than {@link APPROVE_CLAIM_TTL_MINUTES} is ignored, so
 * a crashed approve does not block holds for long.
 */
export async function claimApprove(
  tx: RawClient,
  input: ApproveHoldInput & { publishRequestId: string; actorUserId: number }
): Promise<ApproveClaim> {
  await lockApp(tx, input.slug);
  assertHoldsOverridable(await getOpenHoldsBySlug(tx, [input.slug]), input);
  if (await liveClaimExists(tx, input.slug))
    throw new PublishRequestHeldError(
      'Another approve of this app is already running. Wait for it to finish, then reload.',
      []
    );
  const token = randomUUID();
  await tx.$executeRaw`
    INSERT INTO app_publish_request_approve_claims
      (slug, publish_request_id, claimed_by_user_id, claimed_at, claim_token)
    VALUES (${input.slug}, ${input.publishRequestId}, ${input.actorUserId}, now(), ${token})
    ON CONFLICT (slug) DO UPDATE SET publish_request_id = EXCLUDED.publish_request_id,
      claimed_by_user_id = EXCLUDED.claimed_by_user_id, claimed_at = now(),
      claim_token = EXCLUDED.claim_token`;
  return { slug: input.slug, token };
}

export type ApproveClaim = { slug: string; token: string };

/** Releases only the claim this approve took, never one a concurrent approve holds. */
export async function releaseApproveClaim(db: RawClient, claim: ApproveClaim) {
  await db.$executeRaw`
    DELETE FROM app_publish_request_approve_claims
    WHERE slug = ${claim.slug} AND claim_token = ${claim.token}`;
}

/**
 * The approve paths' final check, inside the transaction that flips the request to approved:
 * refuses as {@link checkHoldsBeforeApprove} does, else marks the holds overridden and records a
 * ModActivity row for each.
 */
export async function resolveHoldsAtApprove(
  tx: RawClient,
  input: ApproveHoldInput & { actorUserId: number }
): Promise<number[]> {
  await lockApp(tx, input.slug);
  const holds = await getOpenHoldsBySlug(tx, [input.slug]);
  const reason = assertHoldsOverridable(holds, input);
  if (!reason) return [];
  const ids = holds.map((h) => h.id);
  await tx.$executeRaw`
    UPDATE app_publish_request_holds
    SET cleared_at = now(), cleared_by_user_id = ${input.actorUserId},
        cleared_kind = 'overridden', cleared_reason = ${reason}
    WHERE id = ANY(${ids}::int[]) AND cleared_at IS NULL`;
  await trackModActivity(
    input.actorUserId,
    { entityType: 'publishRequestHold', activity: 'publishRequestHoldOverride', entityId: ids },
    tx
  );
  return ids;
}
