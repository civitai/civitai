import { Model3DStatus } from '~/shared/utils/prisma/enums';

/**
 * Pure visibility rule shared by every Model3D read surface. Mirrors
 * `getModel3DById`: mods see everything, the owner sees their own (any
 * status), the public sees only Published + not-Deleted.
 *
 * Kept in its own dependency-light module (only the Prisma enum) so it's
 * trivially unit-testable, and so the SAME predicate gates both the chip lookup
 * (`getModel3DByPostId`) and the inlined `image.get` enrichment
 * (`getVisibleModel3DIdForPost`). Exposing a `model3dId` on the image payload
 * must never reveal a Model3D the viewer couldn't otherwise see.
 */
export const canViewModel3d = ({
  status,
  deletedAt,
  ownerId,
  userId,
  isModerator = false,
}: {
  status: Model3DStatus;
  deletedAt: Date | null;
  ownerId: number;
  userId?: number;
  isModerator?: boolean;
}): boolean => {
  if (isModerator) return true;
  const isOwner = !!userId && ownerId === userId;
  if (isOwner) return true;
  if (status !== Model3DStatus.Published) return false;
  if (deletedAt) return false;
  return true;
};
