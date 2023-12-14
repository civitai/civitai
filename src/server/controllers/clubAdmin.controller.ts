import { throwAuthorizationError, throwDbError } from '~/server/utils/errorHandling';
import { Context } from '~/server/createContext';
import { userContributingClubs } from '~/server/services/club.service';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  AcceptClubAdminInviteInput,
  DeleteClubAdminInput,
  DeleteClubAdminInviteInput,
  GetPagedClubAdminInviteSchema,
  GetPagedClubAdminSchema,
  UpdateClubAdminInput,
  UpsertClubAdminInviteInput,
} from '../schema/clubAdmin.schema';
import {
  acceptClubAdminInvite,
  deleteClubAdmin,
  deleteClubAdminInvite,
  getClubAdminInvites,
  getClubAdmins,
  updateClubAdmin,
  upsertClubAdminInvite,
} from '~/server/services/clubAdmin.service';

export const getPagedClubAdminInvitesHandler = async ({
  input,
  ctx,
}: {
  input: GetPagedClubAdminInviteSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;
  const limit = input.limit + 1 ?? 10;
  const clubId = input.clubId;

  const [userClub] = await userContributingClubs({ userId: user.id, clubIds: [clubId] });
  const isClubOwner = userClub.userId === user.id;
  const isModerator = user.isModerator;

  if (!isClubOwner && !isModerator) {
    throw throwAuthorizationError('You are not authorized to view club invites for this club');
  }

  try {
    return getClubAdminInvites({
      input: { ...input, limit },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        permissions: true,
      },
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getPagedClubAdminsHandler = async ({
  input,
  ctx,
}: {
  input: GetPagedClubAdminSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;
  const limit = input.limit + 1 ?? 10;
  const clubId = input.clubId;

  const [userClub] = await userContributingClubs({ userId: user.id, clubIds: [clubId] });
  const isClubOwner = userClub.userId === user.id;
  const isModerator = user.isModerator;

  if (!isClubOwner && !isModerator) {
    throw throwAuthorizationError('You are not authorized to view club admins for this club');
  }

  try {
    return getClubAdmins({
      input: { ...input, limit },
      select: {
        createdAt: true,
        permissions: true,
        clubId: true,
        userId: true,
        user: {
          select: userWithCosmeticsSelect,
        },
      },
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertClubAdminInviteHandler = async ({
  input,
  ctx,
}: {
  input: UpsertClubAdminInviteInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;
  const clubId = input.clubId;

  const [userClub] = await userContributingClubs({ userId: user.id, clubIds: [clubId] });
  const isClubOwner = userClub.userId === user.id;
  const isModerator = user.isModerator;

  if (!isClubOwner && !isModerator) {
    throw throwAuthorizationError('You are not authorized to create or update club invites');
  }

  try {
    return upsertClubAdminInvite({ input });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteClubAdminInviteHandler = async ({
  input,
  ctx,
}: {
  input: DeleteClubAdminInviteInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;
  const clubId = input.clubId;

  const [userClub] = await userContributingClubs({ userId: user.id, clubIds: [clubId] });
  const isClubOwner = userClub.userId === user.id;
  const isModerator = user.isModerator;

  if (!isClubOwner && !isModerator) {
    throw throwAuthorizationError('You are not authorized to delete club invites');
  }

  try {
    return deleteClubAdminInvite({ input });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const acceptClubAdminInviteHandler = async ({
  input,
  ctx,
}: {
  input: AcceptClubAdminInviteInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return acceptClubAdminInvite({
      input: {
        ...input,
        userId: ctx.user.id,
      },
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const updateClubAdminHandler = async ({
  input,
  ctx,
}: {
  input: UpdateClubAdminInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;
  const clubId = input.clubId;

  const [userClub] = await userContributingClubs({ userId: user.id, clubIds: [clubId] });
  const isClubOwner = userClub.userId === user.id;
  const isModerator = user.isModerator;

  if (!isClubOwner && !isModerator) {
    throw throwAuthorizationError('You are not authorized to update this club admin');
  }

  try {
    return updateClubAdmin({ input });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const deleteClubAdminHandler = async ({
  input,
  ctx,
}: {
  input: DeleteClubAdminInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;
  const clubId = input.clubId;

  const [userClub] = await userContributingClubs({ userId: user.id, clubIds: [clubId] });
  const isClubOwner = userClub.userId === user.id;
  const isModerator = user.isModerator;

  if (!isClubOwner && !isModerator) {
    throw throwAuthorizationError('You are not authorized remove a club admin');
  }

  try {
    return deleteClubAdmin({ input });
  } catch (error) {
    throw throwDbError(error);
  }
};
