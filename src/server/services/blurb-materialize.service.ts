import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { findBlurbSpans, replaceBlurbSpans, unwrapBlurbSpans } from '~/server/utils/blurb-html';

export type BlurbUse = { blurbId: number; contentHash: string };

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
   */
  restrictToBlurbIds?: number[];
}) {
  // Keyed on the owner rather than the actor so a percentage rollout picks a sticky subset of
  // creators. Off means the spans are left exactly as the client sent them and no reference row
  // is claimed — deliberately NOT the same as unwrapping, which would strip a creator's blurbs
  // the moment they fell out of the rollout. The fan-out job is not gated on this; see
  // blurb-fanout.service.ts.
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.TEXT_BLURBS, String(userId))))
    return { html, uses: [] as BlurbUse[] };

  const spans = findBlurbSpans(html);
  if (!spans.length) return { html, uses: [] as BlurbUse[] };

  const spanIds = [...new Set(spans.map((s) => s.blurbId))];
  const allowed = restrictToBlurbIds && new Set(restrictToBlurbIds);
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
}: {
  entityType: string;
  entityId: number;
  uses: BlurbUse[];
}) {
  const current = await dbRead.blurbReference.findMany({
    where: { entityType, entityId },
    select: { blurbId: true },
  });

  const keep = new Set(uses.map((u) => u.blurbId));
  const remove = current.map((r) => r.blurbId).filter((id) => !keep.has(id));

  if (remove.length)
    await dbWrite.blurbReference.deleteMany({
      where: { entityType, entityId, blurbId: { in: remove } },
    });

  const now = new Date();
  for (const use of uses) {
    await dbWrite.blurbReference.upsert({
      where: {
        blurbId_entityType_entityId: { blurbId: use.blurbId, entityType, entityId },
      },
      create: {
        blurbId: use.blurbId,
        entityType,
        entityId,
        materializedHash: use.contentHash,
        materializedAt: now,
      },
      update: { materializedHash: use.contentHash, materializedAt: now },
    });
  }
}
