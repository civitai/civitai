import { Prisma } from '@prisma/client';
import { sessionClient } from '~/server/auth/session-client';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { getUserCollectionPermissionsById } from '~/server/services/collection.service';
import { inviteExpiryCutoff, liveInviteWhere } from '~/server/services/collection-invite.utils';
import { createNotification } from '~/server/services/notification.service';
import {
  CollectionCollaboratorRole,
  CollectionContributorPermission,
  CollectionInviteStatus,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionWriteConfiguration,
} from '~/shared/utils/prisma/enums';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';

export const COLLABORATOR_CAP = 25;
export const MANAGER_CAP = 5;

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

function roleFromPermissions(
  permissions: CollectionContributorPermission[]
): CollectionCollaboratorRole {
  return permissions.includes(CollectionContributorPermission.MANAGE)
    ? CollectionCollaboratorRole.Manager
    : CollectionCollaboratorRole.Contributor;
}

// What the collection already grants everyone for free, independent of who's asking.
// Sourced from the collection's own read/write columns — NOT from `followPermissions` on
// `getUserCollectionPermissionsById`'s result, which the collaborationDisabledAt lapse
// filter prunes; using that would misreport a lapsed collection's free ADD grant as
// elevated and undercount every follower's real standing.
function freeGrantBaseline(collection: {
  read: CollectionReadConfiguration;
  write: CollectionWriteConfiguration;
}): Set<CollectionContributorPermission> {
  const baseline = new Set<CollectionContributorPermission>();
  if (
    collection.read === CollectionReadConfiguration.Public ||
    collection.read === CollectionReadConfiguration.Unlisted
  ) {
    baseline.add(CollectionContributorPermission.VIEW);
  }
  if (collection.write === CollectionWriteConfiguration.Public) {
    baseline.add(CollectionContributorPermission.ADD);
  }
  if (collection.write === CollectionWriteConfiguration.Review) {
    baseline.add(CollectionContributorPermission.ADD_REVIEW);
  }
  return baseline;
}

// Mirrors Task 2's `isCollaborator`: a row only counts as a collaborator when it holds
// ADD/MANAGE beyond the free baseline. A plain Follow on a write:Public collection writes
// a CollectionContributor row carrying ADD too — that row must NOT read as elevated.
function hasElevatedPermission(
  permissions: CollectionContributorPermission[],
  freeBaseline: Set<CollectionContributorPermission>
): boolean {
  return permissions.some(
    (p) =>
      (p === CollectionContributorPermission.ADD ||
        p === CollectionContributorPermission.MANAGE) &&
      !freeBaseline.has(p)
  );
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
  const [collection, contributorRows, inviteRows] = await Promise.all([
    dbRead.collection.findUnique({
      where: { id: collectionId },
      select: { userId: true, read: true, write: true },
    }),
    dbRead.collectionContributor.findMany({
      where: {
        collectionId,
        userId: { not: excludeUserId },
        permissions: {
          hasSome: [CollectionContributorPermission.ADD, CollectionContributorPermission.MANAGE],
        },
      },
      select: { userId: true, permissions: true },
    }),
    dbRead.collectionInvite.findMany({
      where: { ...liveInviteWhere(collectionId), userId: { not: excludeUserId } },
      select: { userId: true, role: true, status: true },
    }),
  ]);

  const freeBaseline = collection
    ? freeGrantBaseline(collection)
    : new Set<CollectionContributorPermission>();
  const ownerId = collection?.userId;

  const collaboratorIds = new Set<number>();
  const managerIds = new Set<number>();
  const contributorIds = new Set(contributorRows.map((row) => row.userId));

  for (const row of contributorRows) {
    if (row.userId === ownerId) continue;
    if (!hasElevatedPermission(row.permissions, freeBaseline)) continue;
    collaboratorIds.add(row.userId);
    if (row.permissions.includes(CollectionContributorPermission.MANAGE)) {
      managerIds.add(row.userId);
    }
  }

  for (const row of inviteRows) {
    if (row.userId === ownerId) continue;
    // An Accepted invite with no contributor row left is a departed collaborator — "Unfollow"
    // deletes the row and leaves the invite Accepted. Charging for it burns a seat with no
    // roster entry to remove, so the owner eventually can't invite anyone.
    if (row.status === CollectionInviteStatus.Accepted && !contributorIds.has(row.userId)) continue;
    collaboratorIds.add(row.userId);
    if (row.role === CollectionCollaboratorRole.Manager) managerIds.add(row.userId);
  }

  return [collaboratorIds.size, managerIds.size];
}

// The collection owner's membership is what licenses collaboration, so a Manager inviting on
// the owner's behalf has to be checked against the OWNER's tier. `getSessionUserById` is the
// same hub-backed resolver `ctx.user.tier` comes from, so both sides of the gate agree.
async function isMemberUser(userId?: number) {
  if (!userId || userId <= 0) return false;
  const user = await sessionClient.getSessionUserById(userId);
  return !!user?.tier && user.tier !== 'free';
}

export async function inviteCollaborator({
  collectionId,
  userId,
  targetUserId,
  role,
  isModerator,
  isMember,
}: {
  collectionId: number;
  userId: number;
  targetUserId: number;
  role: CollectionCollaboratorRole;
  isModerator?: boolean;
  isMember?: boolean;
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
    select: { userId: true, name: true },
  });
  if (collection?.userId === targetUserId) {
    throw throwBadRequestError('The collection owner is already a collaborator.');
  }

  if (!isModerator) {
    const ownerIsMember = permission.isOwner ? !!isMember : await isMemberUser(collection?.userId);
    if (!ownerIsMember) {
      throw throwAuthorizationError(
        'A membership is required to add collaborators to this collection.'
      );
    }
  }

  const [collaborators, managers] = await countCollaborators(collectionId, targetUserId);

  if (collaborators >= COLLABORATOR_CAP) {
    throw throwBadRequestError(`A collection can have at most ${COLLABORATOR_CAP} collaborators.`);
  }
  if (role === CollectionCollaboratorRole.Manager && managers >= MANAGER_CAP) {
    throw throwBadRequestError(`A collection can have at most ${MANAGER_CAP} managers.`);
  }

  const invite = await dbWrite.collectionInvite.upsert({
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

  await createNotification({
    userId: targetUserId,
    type: 'collection-invite-received',
    category: NotificationCategory.Update,
    key: `collection-invite-received:${collectionId}:${targetUserId}`,
    details: { collectionId, collectionName: collection?.name ?? 'a collection' },
  });

  return invite;
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

  // The collection can change between send and accept; a mode that `inviteCollaborator`
  // refuses must not be reachable by accepting an invite issued before the flip. Checked
  // after the decline branch so a stale invite can always be cleared off the inbox.
  const collection = await dbRead.collection.findUnique({
    where: { id: invite.collectionId },
    select: { mode: true },
  });
  if (
    collection?.mode === CollectionMode.Bookmark ||
    collection?.mode === CollectionMode.Contest
  ) {
    throw throwBadRequestError('This collection does not support collaborators.');
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
  } catch (error) {
    // Self-removal (or a pending-only invite) may have no contributor row to delete — but
    // only that specific case is tolerated; anything else (a dropped connection, a
    // permission error) must propagate rather than be reported as a successful removal.
    const isNotFound =
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
    if (!isNotFound) throw error;
  }
}

// Curated collections (Contest/Bookmark) and the system-owned curation set carry staff
// ADD/MANAGE rows that are an internal roster, not a collaboration — publishing them would
// hand every reader of e.g. Featured Models the list of who curates it.
function collectionSupportsCollaborators(collection: {
  userId: number;
  mode: CollectionMode | null;
}): boolean {
  return collection.mode === null && collection.userId > 0;
}

/**
 * The roster derivation shared by `getCollaborators` and `collection.getById`. It returns an empty
 * roster for collections that don't support collaborators rather than throwing, so a caller that
 * also serves curated and system-owned collections can call it unconditionally. Never returns
 * pending invites — those are `getCollaborators`' business and are gated on `manage` there.
 */
export async function getCollectionRoster(collection: {
  id: number;
  userId: number;
  read: CollectionReadConfiguration;
  write: CollectionWriteConfiguration;
  mode: CollectionMode | null;
}): Promise<Collaborator[]> {
  if (!collectionSupportsCollaborators(collection)) return [];

  const freeBaseline = freeGrantBaseline(collection);

  // CollectionContributor also holds follow rows — on a write:Public collection a plain
  // Follow carries ADD too, so this must never return every row for the collection. A row
  // qualifies as a roster entry when its permissions are elevated beyond the free baseline,
  // or (to catch a Contributor invite accepted on a write:Public collection, whose granted
  // {VIEW, ADD} is otherwise indistinguishable from a follower's) when the user holds an
  // invite that occupies a seat — a signal only the invite/accept flow produces.
  const [rows, seatedInvites] = await Promise.all([
    dbRead.collectionContributor.findMany({
      where: {
        collectionId: collection.id,
        userId: { not: collection.userId },
        permissions: {
          hasSome: [CollectionContributorPermission.ADD, CollectionContributorPermission.MANAGE],
        },
      },
      select: { userId: true, permissions: true },
    }),
    dbRead.collectionInvite.findMany({
      where: liveInviteWhere(collection.id),
      select: { userId: true },
    }),
  ]);

  const seatedInviteUserIds = new Set(seatedInvites.map((invite) => invite.userId));

  return rows
    .filter(
      (row) =>
        hasElevatedPermission(row.permissions, freeBaseline) || seatedInviteUserIds.has(row.userId)
    )
    .map((row) => ({
      userId: row.userId,
      role: roleFromPermissions(row.permissions),
    }));
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

  const collection = await dbRead.collection.findUnique({
    where: { id: collectionId },
    select: { id: true, userId: true, read: true, write: true, mode: true },
  });

  if (!collection || !collectionSupportsCollaborators(collection)) {
    throw throwBadRequestError('This collection does not support collaborators.');
  }

  const collaborators = await getCollectionRoster(collection);

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
      invitedBy: { select: { id: true, username: true, deletedAt: true } },
      collection: {
        select: {
          id: true,
          name: true,
          image: {
            select: {
              id: true,
              url: true,
              nsfwLevel: true,
              hash: true,
              width: true,
              height: true,
              type: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}
