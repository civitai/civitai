import { isFlagProtected, protectedProcedure, router, middleware } from '~/server/trpc';
import {
  getPagedClubAdminInviteSchema,
  getPagedClubAdminSchema,
  upsertClubAdminInviteInput,
} from '../schema/clubAdmin.schema';
import {
  getPagedClubAdminInvitesHandler,
  getPagedClubAdminsHandler,
  upsertClubAdminInviteHandler,
} from '~/server/controllers/clubAdmin.controller';
import { throwAuthorizationError, throwBadRequestError } from '../utils/errorHandling';
import { userContributingClubs } from '../services/club.service';

const isOwnerOrModerator = middleware(async ({ ctx, input, next }) => {
  if (!ctx.user) throw throwAuthorizationError();
  if (ctx.user.isModerator) return next({ ctx: { user: ctx.user } });

  const { id: userId } = ctx.user;
  const { id: inputId, clubId } = input as { id?: number; clubId?: number };
  const id = inputId ?? clubId;

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
});
