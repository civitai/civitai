import { throwAuthorizationError, throwDbError } from '~/server/utils/errorHandling';
import { Context } from '~/server/createContext';
import { userContributingClubs } from '~/server/services/club.service';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  AcceptClubAdminInviteInput,
  DeleteClubAdminInviteInput,
  GetPagedClubAdminInviteSchema,
  GetPagedClubAdminSchema,
  UpsertClubAdminInviteInput,
} from '../schema/clubAdmin.schema';
import {
  acceptClubAdminInvite,
  deleteClubAdminInvite,
  getClubAdminInvites,
  getClubAdmins,
  upsertClubAdminInvite,
} from '~/server/services/clubAdmin.service';
import { GetByIdStringInput } from '../schema/base.schema';

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
    throw throwAuthorizationError('You are not authorized to view this page');
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
    throw throwAuthorizationError('You are not authorized to view this page');
  }

  try {
    return getClubAdmins({
      input: { ...input, limit },
      select: {
        createdAt: true,
        permissions: true,
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
    throw throwAuthorizationError('You are not authorized to view this page');
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
    throw throwAuthorizationError('You are not authorized to view this page');
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
