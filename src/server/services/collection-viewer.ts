import type { BearerCredential } from '~/server/auth/full-user-credential';
import { credentialViews } from '~/server/services/oauth/enforce-token-scope';
import {
  canSeeCollectionDetails,
  getCollectionById,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';

type ViewerCtx = BearerCredential & {
  apiKeyId?: number | null;
  user?: { id: number; isModerator?: boolean } | null;
};

/**
 * A collection's permissions for this request, and the collection when they let the viewer see its
 * details (null otherwise). Moderator rights and the owner's cover view hold only on a session or a
 * full-access key.
 */
export async function readCollectionForViewer(ctx: ViewerCtx, id: number) {
  const views = credentialViews(ctx);
  const permissions = await getUserCollectionPermissionsById({
    id,
    userId: ctx.user?.id,
    isModerator: views.asModerator,
  });
  if (!canSeeCollectionDetails(permissions)) return { permissions, collection: null };
  const collection = await getCollectionById({
    input: { id },
    viewer: views.asOwner ? ctx.user : undefined,
  });
  return { permissions, collection };
}
