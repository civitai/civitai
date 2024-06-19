import {
  getEntityCollaboratorsInput,
  upsertEntityCollaboratorInput,
} from '~/server/schema/entity-collaborator.schema';
import {
  toggleHiddenSchema,
  toggleHiddenTagsSchema,
} from '~/server/schema/user-preferences.schema';
import {
  getEntityCollaborators,
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
});
