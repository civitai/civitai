import {
  actionEntityCollaboratorInviteInput,
  getEntityCollaboratorsInput,
  removeEntityCollaboratorInput,
  upsertEntityCollaboratorInput,
} from '~/server/schema/entity-collaborator.schema';
import {
  actionEntityCollaborationInvite,
  getEntityCollaborators,
  removeEntityCollaborator,
  upsertEntityCollaborator,
} from '~/server/services/entity-collaborator.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const entityCollaboratorRouter = router({
  upsert: protectedProcedure
    .input(upsertEntityCollaboratorInput)
    .mutation(({ input, ctx }) => upsertEntityCollaborator({ ...input, userId: ctx.user.id })),
  get: publicProcedure
    .input(getEntityCollaboratorsInput)
    .query(({ input, ctx }) =>
      getEntityCollaborators({ ...input, userId: ctx.user?.id, isModerator: ctx.user?.isModerator })
    ),
  remove: protectedProcedure
    .input(removeEntityCollaboratorInput)
    .mutation(({ input, ctx }) =>
      removeEntityCollaborator({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  action: protectedProcedure.input(actionEntityCollaboratorInviteInput).mutation(({ input, ctx }) =>
    actionEntityCollaborationInvite({
      ...input,
      userId: ctx.user.id,
    })
  ),
});
