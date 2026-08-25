import { dbRead, dbWrite } from '~/server/db/client';
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
export async function expandBlurbs({ userId, html }: { userId: number; html: string }) {
  const spans = findBlurbSpans(html);
  if (!spans.length) return { html, uses: [] as BlurbUse[] };

  const ids = [...new Set(spans.map((s) => s.blurbId))];
  const blurbs = await dbRead.blurb.findMany({
    where: { id: { in: ids }, userId, deletedAt: null },
    select: { id: true, content: true, contentHash: true },
  });

  const byId = new Map(blurbs.map((b) => [b.id, b]));
  const orphaned = new Set(ids.filter((id) => !byId.has(id)));

  let next = replaceBlurbSpans(html, new Map(blurbs.map((b) => [b.id, b.content])));
  if (orphaned.size) next = unwrapBlurbSpans(next, orphaned);

  return {
    html: next,
    uses: blurbs.map((b) => ({ blurbId: b.id, contentHash: b.contentHash })),
  };
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
