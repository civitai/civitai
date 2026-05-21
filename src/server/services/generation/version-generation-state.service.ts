import { dbRead } from '~/server/db/client';
import { WildcardSetKind } from '~/shared/utils/prisma/enums';

/**
 * Resolve the visible System-kind `WildcardSet` id for each of the given
 * Wildcards-type ModelVersion ids. Used by read paths that override the
 * standard `canGenerate` gate for Wildcards entries — the override fires
 * exactly when this helper returns a set id.
 *
 * Visibility rules:
 *   - System-kind set only (User-kind sets aren't tied to a ModelVersion)
 *   - `isInvalidated = false`
 *   - `usable = true` (Phase 2 column: true iff ≥1 Clean category)
 *   - `nsfw = false` on `.com` (sfwOnly); `.red` shows every usable set
 *
 * One round-trip regardless of N.
 */
export async function getVisibleSystemWildcardSetIdsByVersionId(
  modelVersionIds: number[],
  { sfwOnly }: { sfwOnly: boolean }
): Promise<Map<number, number>> {
  if (modelVersionIds.length === 0) return new Map();
  const sets = await dbRead.wildcardSet.findMany({
    where: {
      kind: WildcardSetKind.System,
      modelVersionId: { in: modelVersionIds },
      isInvalidated: false,
      usable: true,
      ...(sfwOnly ? { nsfw: false } : {}),
    },
    select: { id: true, modelVersionId: true },
  });
  const result = new Map<number, number>();
  for (const s of sets) {
    if (s.modelVersionId != null) result.set(s.modelVersionId, s.id);
  }
  return result;
}
