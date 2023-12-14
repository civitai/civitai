import { isFlagProtected, protectedProcedure, router, middleware } from '~/server/trpc';
import {
  acceptClubAdminInviteInput,
  deleteClubAdminInput,
  deleteClubAdminInviteInput,
  getPagedClubAdminInviteSchema,
  getPagedClubAdminSchema,
  updateClubAdminInput,
  upsertClubAdminInviteInput,
} from '../schema/clubAdmin.schema';
import {
  acceptClubAdminInviteHandler,
  deleteClubAdminHandler,
  deleteClubAdminInviteHandler,
  getPagedClubAdminInvitesHandler,
  getPagedClubAdminsHandler,
  updateClubAdminHandler,
  upsertClubAdminInviteHandler,
} from '~/server/controllers/clubAdmin.controller';
import { throwAuthorizationError, throwBadRequestError } from '../utils/errorHandling';
import { userContributingClubs } from '../services/club.service';

const isOwnerOrModerator = middleware(async ({ ctx, input, next }) => {
  if (!ctx.user) throw throwAuthorizationError();
  if (ctx.user.isModerator) return next({ ctx: { user: ctx.user } });

  const { id: userId } = ctx.user;
  const { id: inputId, clubId } = input as { id?: number; clubId?: number };
  const id = clubId ?? inputId;

  if (!id) throw throwBadRequestError();

  const [userClub] = await userContributingClubs({ userId, clubIds: [id] });

  if (!userClub || userClub.userId !== userId) throw throwAuthorizationError();

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const clubAdminRouter = router({
  getInvitesPaged: protectedProcedure
    .input(getPagedClubAdminInviteSchema)
    .use(isFlagProtected('clubs'))
    .use(isOwnerOrModerator)
    .query(getPagedClubAdminInvitesHandler),
  getAdminsPaged: protectedProcedure
    .input(getPagedClubAdminSchema)
    .use(isFlagProtected('clubs'))
    .use(isOwnerOrModerator)
    .query(getPagedClubAdminsHandler),
  upsertInvite: protectedProcedure
    .input(upsertClubAdminInviteInput)
    .use(isFlagProtected('clubs'))
    .use(isOwnerOrModerator)
    .mutation(upsertClubAdminInviteHandler),
  deleteInvite: protectedProcedure
    .input(deleteClubAdminInviteInput)
    .use(isFlagProtected('clubs'))
    .use(isOwnerOrModerator)
    .mutation(deleteClubAdminInviteHandler),
  acceptInvite: protectedProcedure
    .input(acceptClubAdminInviteInput)
    .use(isFlagProtected('clubs'))
    .mutation(acceptClubAdminInviteHandler),
  update: protectedProcedure
    .input(updateClubAdminInput)
    .use(isFlagProtected('clubs'))
    .use(isOwnerOrModerator)
    .mutation(updateClubAdminHandler),
  delete: protectedProcedure
    .input(deleteClubAdminInput)
    .use(isFlagProtected('clubs'))
    .use(isOwnerOrModerator)
    .mutation(deleteClubAdminHandler),
});
