import {
  buildRightsAffirmation,
  hasCurrentRightsAffirmation,
  type RightsAffirmation,
} from '@civitai/buzz';
import { dbRead } from '~/server/db/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';

export const RIGHTS_AFFIRMATION_REQUIRED_MESSAGE =
  'You must confirm you hold the rights to monetize this model before setting a price.';

/**
 * Resolve the affirmation to persist for a monetizing write, or throw if the creator hasn't given one.
 * Returns undefined when nothing needs recording, so callers can spread it into `meta` unconditionally.
 *
 * A version keeps its first affirmation: re-pricing something already affirmed doesn't ask again. The
 * moderator carve-out is scoped to OTHER people's models — a moderator pricing someone else's model
 * isn't claiming any rights of their own, so they neither affirm nor overwrite the creator's record.
 * Staff monetizing their own models are creators like anyone else and still have to affirm.
 */
export async function resolveRightsAffirmation({
  userId,
  ownerId,
  versionId,
  monetizes,
  rightsAffirmed,
  isModerator,
  existingMeta,
}: {
  userId: number;
  /** The model's owner. Omit only when it isn't known; the carve-out then never applies. */
  ownerId?: number;
  versionId?: number;
  monetizes: boolean;
  rightsAffirmed?: boolean;
  isModerator?: boolean;
  /** Pass when the caller already loaded the version, to skip the lookup. */
  existingMeta?: unknown;
}): Promise<RightsAffirmation | undefined> {
  if (!monetizes) return undefined;
  if (isModerator && ownerId != null && ownerId !== userId) return undefined;

  const meta =
    existingMeta !== undefined
      ? existingMeta
      : versionId
      ? (await dbRead.modelVersion.findUnique({ where: { id: versionId }, select: { meta: true } }))
          ?.meta
      : null;
  if (hasCurrentRightsAffirmation(meta, ownerId)) return undefined;

  if (!rightsAffirmed) throw throwBadRequestError(RIGHTS_AFFIRMATION_REQUIRED_MESSAGE);
  return buildRightsAffirmation(userId);
}
