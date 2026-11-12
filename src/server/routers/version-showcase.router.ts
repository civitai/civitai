import {
  getVersionShowcaseEditorSchema,
  myImageShowcaseFeaturesSchema,
  setVersionShowcaseCoverSchema,
  setVersionShowcaseSchema,
  versionShowcaseImageSchema,
} from '~/server/schema/version-showcase.schema';
import {
  getMyImageShowcaseFeatures,
  getVersionShowcaseEditor,
  moderatorRemoveFromVersionShowcase,
  removeMyImageFromVersionShowcase,
  setVersionShowcase,
  setVersionShowcaseCover,
} from '~/server/services/version-showcase.service';
import { isFlagProtected, moderatorProcedure, protectedProcedure, router } from '~/server/trpc';

// Curating is behind the flag. Removals are not: turning the flag off must not take away the
// author's or a moderator's way to take an image down.
export const versionShowcaseRouter = router({
  getEditor: protectedProcedure
    .input(getVersionShowcaseEditorSchema)
    .use(isFlagProtected('modelVersionShowcase'))
    .query(({ input, ctx }) =>
      getVersionShowcaseEditor({
        ...input,
        userId: ctx.user.id,
        isModerator: !!ctx.user.isModerator,
      })
    ),
  set: protectedProcedure
    .input(setVersionShowcaseSchema)
    .use(isFlagProtected('modelVersionShowcase'))
    .mutation(({ input, ctx }) =>
      setVersionShowcase({ ...input, userId: ctx.user.id, isModerator: !!ctx.user.isModerator })
    ),
  setCover: protectedProcedure
    .input(setVersionShowcaseCoverSchema)
    .use(isFlagProtected('modelVersionShowcase'))
    .mutation(({ input, ctx }) =>
      setVersionShowcaseCover({
        ...input,
        userId: ctx.user.id,
        isModerator: !!ctx.user.isModerator,
      })
    ),
  getMyImageFeatures: protectedProcedure
    .input(myImageShowcaseFeaturesSchema)
    .query(({ input, ctx }) => getMyImageShowcaseFeatures({ ...input, userId: ctx.user.id })),
  removeMine: protectedProcedure
    .input(versionShowcaseImageSchema)
    .mutation(({ input, ctx }) =>
      removeMyImageFromVersionShowcase({ ...input, userId: ctx.user.id })
    ),
  moderatorRemove: moderatorProcedure
    .input(versionShowcaseImageSchema)
    .mutation(({ input }) => moderatorRemoveFromVersionShowcase(input)),
});
