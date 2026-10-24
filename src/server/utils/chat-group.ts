import { ChatMemberStatus } from '~/shared/utils/prisma/enums';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { getChatHash } from '~/server/utils/chat';
import { activeMemberStatuses } from '~/shared/utils/chat';

export type GroupChatLike = {
  isGroup: boolean;
  ownerId: number;
};

export type GroupMemberLike = {
  id: number;
  userId: number;
  isOwner: boolean;
  status: ChatMemberStatus;
  createdAt: Date;
  joinedAt?: Date | null;
};

export const isActiveMember = (member: Pick<GroupMemberLike, 'status'>) =>
  activeMemberStatuses.includes(member.status);

/**
 * A group name is optional, so blank and absent have to mean the same thing —
 * otherwise a cleared field stores `''` and renders as a nameless title bar
 * rather than falling back to the member list.
 */
export const normalizeChatName = (name?: string | null) => {
  const trimmed = name?.trim();
  return trimmed?.length ? trimmed : null;
};

/**
 * Identity of a new chat. A 1:1 keeps the member-set hash so re-opening a DM
 * returns the existing thread; a group gets none, because two groups with the
 * same people are two different groups.
 */
export const resolveChatIdentity = ({
  userIds,
  isGroup,
}: {
  userIds: number[];
  isGroup?: boolean;
}) => {
  const group = isGroup ?? new Set(userIds).size > 2;
  return { isGroup: group, hash: group ? null : getChatHash(userIds) };
};

/**
 * Gate for every membership change only an admin may make: adding, removing and
 * handing over the group. Moderators pass so they can unstick a group whose
 * owner is gone.
 */
export const assertGroupAdmin = ({
  chat,
  actorId,
  isModerator,
}: {
  chat: GroupChatLike;
  actorId: number;
  isModerator?: boolean;
}) => {
  if (!chat.isGroup) {
    throw throwBadRequestError('This conversation is not a group chat');
  }
  if (chat.ownerId !== actorId && !isModerator) {
    throw throwAuthorizationError('Only the group admin can manage members');
  }
};

/**
 * Seats are counted over active members only — a member who left or was removed
 * has given theirs back.
 */
export const assertRoomForMembers = ({
  members,
  adding,
  limit,
}: {
  members: Pick<GroupMemberLike, 'status'>[];
  adding: number;
  limit: number;
}) => {
  const occupied = members.filter(isActiveMember).length;
  if (occupied + adding > limit) {
    throw throwBadRequestError(`A group chat cannot have more than ${limit} members`);
  }
};

export const assertCanPromote = ({
  chat,
  target,
  actorId,
  isModerator,
}: {
  chat: GroupChatLike;
  target: Pick<GroupMemberLike, 'userId' | 'status' | 'isOwner'>;
  actorId: number;
  isModerator?: boolean;
}) => {
  assertGroupAdmin({ chat, actorId, isModerator });
  if (target.isOwner) {
    throw throwBadRequestError('This member is already the group admin');
  }
  if (target.status !== ChatMemberStatus.Joined) {
    throw throwBadRequestError('Only a member who has joined the group can be made admin');
  }
};

/**
 * Who inherits a group when its admin leaves. Longest-joined first, so the
 * group lands with whoever has been in it longest rather than whoever was
 * invited most recently; ties break on member id to keep the choice stable.
 */
export const selectNextOwner = (
  members: GroupMemberLike[],
  leavingMemberId: number
): GroupMemberLike | undefined => {
  const seniority = (m: GroupMemberLike) => (m.joinedAt ?? m.createdAt).getTime();
  const eligible = members.filter((m) => m.id !== leavingMemberId && isActiveMember(m));
  const joined = eligible.filter((m) => m.status === ChatMemberStatus.Joined);
  // Nobody has accepted yet: an invited member still beats leaving the group
  // ownerless, since an ownerless group can never be administered again.
  const pool = joined.length ? joined : eligible;

  return [...pool].sort((a, b) => seniority(a) - seniority(b) || a.id - b.id)[0];
};
