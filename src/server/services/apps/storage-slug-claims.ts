import { sanitizeAppSlug } from '~/server/utils/apps-slug';

/**
 * Every block that claims each storage slug (its schema is `app_<slug>`).
 *
 * `sanitizeAppSlug` is not injective — it folds a run of hyphens to one `_`, and the
 * blockId pattern allows such runs — so a slug can have more than one claimant. A
 * block whose blockId yields no valid storage slug claims nothing and is left out.
 */
export function groupBlocksByStorageSlug<T extends { blockId: string }>(
  blocks: readonly T[]
): Map<string, T[]> {
  const claimants = new Map<string, T[]>();
  for (const block of blocks) {
    const storageSlug = sanitizeAppSlug(block.blockId);
    if (!storageSlug) continue;
    const existing = claimants.get(storageSlug);
    if (existing) existing.push(block);
    else claimants.set(storageSlug, [block]);
  }
  return claimants;
}

/**
 * Why a NEW `blockId` may not be registered, or `null` when it may.
 *
 * Returns `null` for a blockId that already has its own app block (a new version, not a
 * new claim).
 *
 * `includePendingRequests` also counts first-version submissions still awaiting review.
 * Leave it off where a pending request is being turned into an app block, or two
 * colliding pending requests would each block the other's approval.
 *
 * This is a read-then-write check with no database constraint behind it, so two
 * simultaneous callers can both pass. Every path that creates an app block runs it just
 * before creating, which narrows that window but does not close it.
 */
export async function storageSlugConflictMessage(
  blockId: string,
  { includePendingRequests }: { includePendingRequests: boolean }
): Promise<string | null> {
  const storageSlug = sanitizeAppSlug(blockId);
  if (!storageSlug) return null;

  // Read the primary: a block approved moments ago must be visible here.
  const { dbWrite } = await import('~/server/db/client');
  const blocks = await dbWrite.appBlock.findMany({ select: { blockId: true } });
  const claimants = groupBlocksByStorageSlug(blocks).get(storageSlug) ?? [];
  if (claimants.some((b) => b.blockId === blockId)) return null;

  const explanation = `both would use the storage name "${storageSlug}", because a run of hyphens counts as a single separator`;
  if (claimants.length > 0) {
    return `blockId "${blockId}" is too similar to the existing app "${claimants[0].blockId}": ${explanation}. Choose a different blockId.`;
  }

  if (!includePendingRequests) return null;
  const pending = await dbWrite.appBlockPublishRequest.findMany({
    where: { status: 'pending', slug: { not: blockId } },
    select: { slug: true },
  });
  if (pending.some((p) => sanitizeAppSlug(p.slug) === storageSlug)) {
    // The other submission's blockId is deliberately not named: it is unreleased.
    return `blockId "${blockId}" is too similar to the blockId of another app that is awaiting review: ${explanation}. Choose a different blockId.`;
  }
  return null;
}
