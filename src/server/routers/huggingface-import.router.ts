import { createFileHandler } from '~/server/controllers/model-file.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  attachHuggingFaceImportSchema,
  renameHuggingFaceGroupSchema,
  enqueueHuggingFaceImportSchema,
  getHuggingFaceImportsSchema,
  lookupHuggingFaceRepoSchema,
} from '~/server/schema/huggingface-import.schema';
import {
  buildAttachInput,
  cancelImport,
  detachImport,
  enqueueImports,
  getImports,
  linkImportToFile,
  renameGroup,
  resolveRepoForImport,
  retryImport,
} from '~/server/services/huggingface-import.service';
import { HuggingFaceError, parseHuggingFaceRepo } from '~/server/services/huggingface.service';
import { moderatorProcedure, router } from '~/server/trpc';
import { throwBadRequestError } from '~/server/utils/errorHandling';

/**
 * 🔴 Opening this beyond moderators needs more than a procedure swap: a per-user quota, and a
 * `userId` in the `(repo, revision, filename)` unique index — without that last one, one user's
 * queued import silently swallows another's.
 */
export const huggingFaceImportRouter = router({
  getAll: moderatorProcedure.input(getHuggingFaceImportsSchema).query(({ input, ctx }) =>
    getImports({
      ...input,
      userId: ctx.user.id,
      isModerator: !!ctx.user.isModerator,
    })
  ),

  lookup: moderatorProcedure.input(lookupHuggingFaceRepoSchema).mutation(async ({ input }) => {
    const target = parseHuggingFaceRepo(input.source);
    if (!target)
      throw throwBadRequestError(
        'Could not read an owner/name out of that. Paste the model page URL.'
      );

    try {
      return await resolveRepoForImport(target);
    } catch (error) {
      if (error instanceof HuggingFaceError) throw throwBadRequestError(error.message);
      throw error;
    }
  }),

  enqueue: moderatorProcedure
    .input(enqueueHuggingFaceImportSchema)
    .mutation(async ({ input, ctx }) => {
      // The tree is re-read rather than trusting the sizes and hashes the client posted back: they
      // decide what we store and what we skip as already held.
      const repo = await resolveRepoForImport({ repo: input.repo, revision: input.revision });
      const result = await enqueueImports({
        repo,
        paths: input.paths,
        userId: ctx.user.id,
        groupName: input.groupName,
      });
      if (!result.queued && !result.skipped)
        throw throwBadRequestError('None of those files exist at that revision.');
      return result;
    }),

  attach: moderatorProcedure
    .input(attachHuggingFaceImportSchema)
    .mutation(async ({ input, ctx }) => {
      const { importId, ...fileInput } = await buildAttachInput({
        ...input,
        userId: ctx.user.id,
        isModerator: !!ctx.user.isModerator,
      });
      const file = await createFileHandler({ input: fileInput, ctx });
      const linked = await linkImportToFile({
        id: importId,
        modelFileId: file.id,
        modelVersionId: input.modelVersionId,
      });
      if (!linked)
        throw throwBadRequestError(
          `Created model file ${file.id}, but this import was attached by someone else first. Delete file ${file.id}.`
        );
      return { modelFileId: file.id, modelVersionId: input.modelVersionId };
    }),

  renameGroup: moderatorProcedure
    .input(renameHuggingFaceGroupSchema)
    .mutation(({ input, ctx }) =>
      renameGroup({ ...input, userId: ctx.user.id, isModerator: !!ctx.user.isModerator })
    ),

  detach: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) =>
      detachImport({ id: input.id, userId: ctx.user.id, isModerator: !!ctx.user.isModerator })
    ),

  retry: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) =>
      retryImport({ id: input.id, userId: ctx.user.id, isModerator: !!ctx.user.isModerator })
    ),

  cancel: moderatorProcedure
    .input(getByIdSchema)
    .mutation(({ input, ctx }) =>
      cancelImport({ id: input.id, userId: ctx.user.id, isModerator: !!ctx.user.isModerator })
    ),
});
