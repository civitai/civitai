import { dbRead, dbWrite } from '~/server/db/client';
import { getUserCollectionPermissionsById } from '~/server/services/collection.service';
import {
  CollectionCollaboratorRole,
  CollectionContributorPermission,
  CollectionInviteStatus,
  CollectionMode,
} from '~/shared/utils/prisma/enums';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';

export const COLLABORATOR_CAP = 25;
export const MANAGER_CAP = 5;
export const INVITE_EXPIRY_DAYS = 7;

export const ROLE_PERMISSIONS: Record<
  CollectionCollaboratorRole,
  CollectionContributorPermission[]
> = {
  [CollectionCollaboratorRole.Contributor]: [
    CollectionContributorPermission.VIEW,
    CollectionContributorPermission.ADD,
  ],
  [CollectionCollaboratorRole.Manager]: [
    CollectionContributorPermission.VIEW,
    CollectionContributorPermission.ADD,
    CollectionContributorPermission.MANAGE,
  ],
};

export type Collaborator = { userId: number; role: CollectionCollaboratorRole };
export type PendingInvite = {
  id: number;
  userId: number;
  role: CollectionCollaboratorRole;
  createdAt: Date;
};

function inviteExpiryCutoff() {
  return new Date(Date.now() - INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}

function roleFromPermissions(
  permissions: CollectionContributorPermission[]
): CollectionCollaboratorRole {
  return permissions.includes(CollectionContributorPermission.MANAGE)
    ? CollectionCollaboratorRole.Manager
    : CollectionCollaboratorRole.Contributor;
}

// Both counts must include non-expired pending invites, not just accepted rows — counting
// only accepted rows would let someone issue hundreds of invites and stay under the cap
// until they all land. `excludeUserId` is the invite target: re-inviting them replaces
// their existing row rather than adding a new one, so they shouldn't count against the
// cap they're about to occupy.
async function countCollaborators(
  collectionId: number,
  excludeUserId: number
): Promise<[collaborators: number, managers: number]> {
  return dbWrite.$transaction(async (tx) => {
    const cutoff = inviteExpiryCutoff();

    const collaboratorRows = await tx.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*) as "count" FROM (
        SELECT cc."userId" FROM "CollectionContributor" cc
        WHERE cc."collectionId" = ${collectionId}
          AND cc."userId" <> ${excludeUserId}
          AND cc.permissions && ARRAY['ADD','MANAGE']::"CollectionContributorPermission"[]
        UNION
        SELECT ci."userId" FROM "CollectionInvite" ci
        WHERE ci."collectionId" = ${collectionId}
          AND ci."userId" <> ${excludeUserId}
          AND ci.status = 'Pending'
          AND ci."createdAt" >= ${cutoff}
      ) x
    `;

    const managerRows = await tx.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*) as "count" FROM (
        SELECT cc."userId" FROM "CollectionContributor" cc
        WHERE cc."collectionId" = ${collectionId}
          AND cc."userId" <> ${excludeUserId}
          AND cc.permissions && ARRAY['MANAGE']::"CollectionContributorPermission"[]
        UNION
        SELECT ci."userId" FROM "CollectionInvite" ci
        WHERE ci."collectionId" = ${collectionId}
          AND ci."userId" <> ${excludeUserId}
          AND ci.status = 'Pending'
          AND ci.role = 'Manager'
          AND ci."createdAt" >= ${cutoff}
      ) x
    `;

    return [Number(collaboratorRows[0]?.count ?? 0), Number(managerRows[0]?.count ?? 0)];
  });
}

export async function inviteCollaborator({
  collectionId,
  userId,
  targetUserId,
  role,
  isModerator,
}: {
  collectionId: number;
  userId: number;
  targetUserId: number;
  role: CollectionCollaboratorRole;
  isModerator?: boolean;
}) {
  const permission = await getUserCollectionPermissionsById({
    id: collectionId,
    userId,
    isModerator,
  });

  if (!permission.manage) {
    throw throwAuthorizationError('You do not have permission to manage this collection.');
  }

  if (
    permission.collectionMode === CollectionMode.Bookmark ||
    permission.collectionMode === CollectionMode.Contest
  ) {
    throw throwBadRequestError('This collection does not support collaborators.');
  }

  if (permission.collaborationDisabled) {
    throw throwBadRequestError('This collection is not accepting new collaborators right now.');
  }

  if (!permission.isOwner && !isModerator && role === CollectionCollaboratorRole.Manager) {
    throw throwAuthorizationError('Only the collection owner can grant the Manager role.');
  }

  if (targetUserId === userId) {
    throw throwBadRequestError('You cannot invite yourself.');
  }

  const collection = await dbRead.collection.findUnique({
    where: { id: collectionId },
    select: { userId: true },
  });
  if (collection?.userId === targetUserId) {
    throw throwBadRequestError('The collection owner is already a collaborator.');
  }

  const [collaborators, managers] = await countCollaborators(collectionId, targetUserId);

  if (collaborators >= COLLABORATOR_CAP) {
    throw throwBadRequestError(`A collection can have at most ${COLLABORATOR_CAP} collaborators.`);
  }
  if (role === CollectionCollaboratorRole.Manager && managers >= MANAGER_CAP) {
    throw throwBadRequestError(`A collection can have at most ${MANAGER_CAP} managers.`);
  }

  return dbWrite.collectionInvite.upsert({
    where: { collectionId_userId: { collectionId, userId: targetUserId } },
    create: { collectionId, userId: targetUserId, invitedById: userId, role },
    update: {
      role,
      invitedById: userId,
      status: CollectionInviteStatus.Pending,
      createdAt: new Date(),
      respondedAt: null,
    },
  });
}

export async function respondToInvite({
  inviteId,
  userId,
  accept,
}: {
  inviteId: number;
  userId: number;
  accept: boolean;
}) {
  const invite = await dbWrite.collectionInvite.findUnique({ where: { id: inviteId } });

  if (!invite) throw throwBadRequestError('Invite not found.');
  if (invite.userId !== userId) {
    throw throwAuthorizationError('This invite was not sent to you.');
  }
  if (invite.status !== CollectionInviteStatus.Pending) {
    throw throwBadRequestError('This invite has already been answered.');
  }
  if (invite.createdAt < inviteExpiryCutoff()) {
    throw throwBadRequestError('This invite has expired.');
  }

  if (!accept) {
    await dbWrite.collectionInvite.update({
      where: { id: inviteId },
      data: { status: CollectionInviteStatus.Declined, respondedAt: new Date() },
    });
    return { accepted: false };
  }

  await dbWrite.$transaction(async (tx) => {
    const existing = await tx.collectionContributor.findUnique({
      where: { userId_collectionId: { userId, collectionId: invite.collectionId } },
      select: { permissions: true },
    });

    // Union onto whatever the row already has — the invitee may already hold
    // follow-derived permissions, and accepting must not take those away.
    const merged = Array.from(
      new Set([...(existing?.permissions ?? []), ...ROLE_PERMISSIONS[invite.role]])
    );

    await tx.collectionContributor.upsert({
      where: { userId_collectionId: { userId, collectionId: invite.collectionId } },
      create: { userId, collectionId: invite.collectionId, permissions: merged },
      update: { permissions: merged },
    });

    await tx.collectionInvite.update({
      where: { id: inviteId },
      data: { status: CollectionInviteStatus.Accepted, respondedAt: new Date() },
    });
  });

  return { accepted: true };
}

export async function removeCollaborator({
  collectionId,
  userId,
  targetUserId,
  isModerator,
}: {
  collectionId: number;
  userId: number;
  targetUserId: number;
  isModerator?: boolean;
}) {
  const collection = await dbRead.collection.findUnique({
    where: { id: collectionId },
    select: { userId: true },
  });
  if (collection?.userId === targetUserId) {
    throw throwBadRequestError('The collection owner cannot be removed.');
  }

  const isSelf = userId === targetUserId;

  if (!isSelf) {
    const permission = await getUserCollectionPermissionsById({
      id: collectionId,
      userId,
      isModerator,
    });

    if (!permission.manage) {
      throw throwAuthorizationError('You do not have permission to manage this collection.');
    }

    if (!permission.isOwner && !isModerator) {
      const target = await dbWrite.collectionContributor.findUnique({
        where: { userId_collectionId: { userId: targetUserId, collectionId } },
        select: { permissions: true },
      });
      if (target?.permissions.includes(CollectionContributorPermission.MANAGE)) {
        throw throwAuthorizationError('Only the collection owner can remove a manager.');
      }
    }
  }

  await dbWrite.collectionInvite.deleteMany({ where: { collectionId, userId: targetUserId } });

  try {
    await dbWrite.collectionContributor.delete({
      where: { userId_collectionId: { userId: targetUserId, collectionId } },
    });
  } catch {
    // Self-removal (or a pending-only invite) may have no contributor row to delete.
  }
}

export async function getCollaborators({
  collectionId,
  userId,
  isModerator,
}: {
  collectionId: number;
  userId?: number;
  isModerator?: boolean;
}): Promise<{ collaborators: Collaborator[]; invites: PendingInvite[] }> {
  const permission = await getUserCollectionPermissionsById({
    id: collectionId,
    userId,
    isModerator,
  });

  if (!permission.read) {
    throw throwAuthorizationError('You do not have access to this collection.');
  }

  // CollectionContributor also holds follow rows (VIEW/ADD_REVIEW only) — filtering on
  // ADD/MANAGE keeps this from publishing a collection's entire follower list, which is
  // not exposed anywhere in the product today.
  const rows = await dbRead.collectionContributor.findMany({
    where: {
      collectionId,
      permissions: {
        hasSome: [CollectionContributorPermission.ADD, CollectionContributorPermission.MANAGE],
      },
    },
    select: { userId: true, permissions: true },
  });

  const collaborators = rows.map((row) => ({
    userId: row.userId,
    role: roleFromPermissions(row.permissions),
  }));

  if (!permission.manage) return { collaborators, invites: [] };

  const invites = await dbRead.collectionInvite.findMany({
    where: {
      collectionId,
      status: CollectionInviteStatus.Pending,
      createdAt: { gte: inviteExpiryCutoff() },
    },
    select: { id: true, userId: true, role: true, createdAt: true },
  });

  return { collaborators, invites };
}

export async function getMyInvites({ userId }: { userId: number }) {
  return dbRead.collectionInvite.findMany({
    where: {
      userId,
      status: CollectionInviteStatus.Pending,
      createdAt: { gte: inviteExpiryCutoff() },
    },
    select: {
      id: true,
      role: true,
      createdAt: true,
      invitedById: true,
      collection: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
}
