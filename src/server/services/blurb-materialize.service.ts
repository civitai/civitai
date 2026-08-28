import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { findBlurbSpans, replaceBlurbSpans, unwrapBlurbSpans } from '~/server/utils/blurb-html';

export type BlurbUse = { blurbId: number; contentHash: string };

/**
 * Two facts a caller must never conflate: "the flag is off, so nothing was evaluated" and
 * "evaluated, and this content uses no blurbs". Both leave the html alone, but only the second
 * means the entity's reference rows should be reconciled to empty.
 *
 * Reconciling the first DELETES every reference row the moment a creator falls out of the
 * rollout, and the fan-out then has nothing left to maintain — the same stranding the job is
 * deliberately left ungated to avoid. Discriminated rather than a nullable `uses` so `uses` is
 * unreachable at a call site that has not checked.
 */
export type BlurbExpansion =
  | { evaluated: true; html: string; uses: BlurbUse[] }
  | { evaluated: false; html: string };

/**
 * Re-expands every blurb span from its row before the entity is stored.
 *
 * The inner text arrives from the client and is never trusted: a hand-crafted
 * request could claim a blurb says anything, or name a blurb belonging to someone
 * else. Ownership is enforced by the query's `userId` filter, so a span the caller
 * does not own resolves to nothing and is unwrapped to its plain text.
 *
 * This is the single place that decides whose blurb a `data-id` may resolve to.
 * Widening it (team or shared blurbs) is a change to this predicate and nothing else.
 */
export async function expandBlurbs({
  userId,
  html,
  restrictToBlurbIds,
}: {
  userId: number;
  html: string;
  /**
   * Narrows the resolvable set further, on top of ownership. An editor who is not the
   * owner passes the ids the entity already references: they can keep the blurbs that are
   * there, but a `data-id` they invent resolves to nothing instead of splicing the owner's
   * private blurb text into a response the editor reads back.
   *
   * A RESOLVER, not an array, because producing that set means reading `BlurbReference` and
   * this function owns the two conditions under which any blurb table may be read at all: the
   * flag is on for the owner, and the content actually names a blurb. A caller that awaited the
   * ids itself did the read before either had been evaluated — so the feature's kill switch did
   * not switch it off, and every ordinary save (no spans, which is nearly all of them) paid for
   * a set with nothing to filter. The thunk makes that call-site shape unrepresentable rather
   * than merely discouraged; `undefined` still means "no restriction" and `() => []` means
   * "restricted to nothing", which an array could not distinguish from unset.
   */
  restrictToBlurbIds?: () => number[] | Promise<number[]>;
}): Promise<BlurbExpansion> {
  // Keyed on the owner rather than the actor so a rollout picks a sticky subset of creators.
  //
  // 🔴 Percentage or boolean rollouts only — a segment rollout matches nothing here. See the note
  // on FLIPT_FEATURE_FLAGS.TEXT_BLURBS.
  //
  // Off returns `evaluated: false`, not an empty result: the spans are left exactly as the
  // client sent them and — critically — the caller must NOT reconcile, or a creator who falls
  // out of the rollout loses every reference row on their next save. The fan-out job is not
  // gated on this.
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.TEXT_BLURBS, String(userId))))
    return { evaluated: false, html };

  const spans = findBlurbSpans(html);
  if (!spans.length) return { evaluated: true, html, uses: [] };

  const spanIds = [...new Set(spans.map((s) => s.blurbId))];
  // Resolved HERE — after the flag gate and after the no-spans return — because that is the
  // first point at which the set is actually needed. See the `restrictToBlurbIds` doc above.
  const allowed = restrictToBlurbIds && new Set(await restrictToBlurbIds());
  const ids = allowed ? spanIds.filter((id) => allowed.has(id)) : spanIds;

  const blurbs = ids.length
    ? await dbRead.blurb.findMany({
        where: { id: { in: ids }, userId, deletedAt: null },
        select: { id: true, content: true, contentHash: true },
      })
    : [];

  const byId = new Map(blurbs.map((b) => [b.id, b]));
  // Over every span id, not just the resolvable ones: a span the caller may not resolve
  // has to be unwrapped to its plain text, exactly like one naming a deleted blurb.
  const orphaned = new Set(spanIds.filter((id) => !byId.has(id)));

  let next = replaceBlurbSpans(html, new Map(blurbs.map((b) => [b.id, b.content])));
  if (orphaned.size) next = unwrapBlurbSpans(next, orphaned);

  return {
    evaluated: true,
    html: next,
    uses: blurbs.map((b) => ({ blurbId: b.id, contentHash: b.contentHash })),
  };
}

/**
 * The blurb ids an entity already references — the allowed set for an editor who does not
 * own the blurbs. See `restrictToBlurbIds`.
 */
export async function getReferencedBlurbIds({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: number;
}) {
  const refs = await dbRead.blurbReference.findMany({
    where: { entityType, entityId },
    select: { blurbId: true },
  });
  return refs.map((r) => r.blurbId);
}

export async function reconcileBlurbReferences({
  entityType,
  entityId,
  uses,
  tx,
}: {
  entityType: string;
  entityId: number;
  uses: BlurbUse[];
  /**
   * The entity write's transaction client. Without one, a throw in here leaves the entity
   * committed and its reference rows unwritten — on a create that is an orphan row the creator
   * cannot see or reuse, so they retry and make another (562 of them on 2026-08-27).
   */
  tx?: Prisma.TransactionClient;
}) {
  // Reads go to the same client as the writes, never the replica: this is a read-then-write, and
  // a lagging replica hides reference rows that then survive the delete below.
  const client = tx ?? dbWrite;

  const current = await client.blurbReference.findMany({
    where: { entityType, entityId },
    select: { blurbId: true },
  });

  const keep = new Set(uses.map((u) => u.blurbId));
  const remove = current.map((r) => r.blurbId).filter((id) => !keep.has(id));

  if (remove.length)
    await client.blurbReference.deleteMany({
      where: { entityType, entityId, blurbId: { in: remove } },
    });

  if (!uses.length) return;

  // One statement rather than an upsert per use. The per-use loop this replaced cost a round trip
  // each, up to the 20-blurb per-creator cap, and now runs inside the caller's transaction holding
  // the entity row.
  //
  // `pendingSince: NULL` because this row was just materialized BY this save. Leave it set and the
  // fan-out re-does work the save already did.
  const now = new Date();
  await client.$executeRaw`
    INSERT INTO "BlurbReference" ("blurbId", "entityType", "entityId", "materializedHash", "materializedAt", "pendingSince")
    SELECT u.id, ${entityType}, ${entityId}::int, u.hash, ${now}, NULL
    FROM unnest(${uses.map((u) => u.blurbId)}::int[], ${uses.map(
    (u) => u.contentHash
  )}::text[]) AS u(id, hash)
    ON CONFLICT ("blurbId", "entityType", "entityId") DO UPDATE
      SET "materializedHash" = EXCLUDED."materializedHash",
          "materializedAt"   = EXCLUDED."materializedAt",
          "pendingSince"     = NULL
  `;
}
