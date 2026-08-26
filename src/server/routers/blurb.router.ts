import {
  createBlurbHandler,
  deleteBlurbHandler,
  getMyBlurbsHandler,
  updateBlurbHandler,
} from '~/server/controllers/blurb.controller';
import {
  createBlurbInputSchema,
  deleteBlurbInputSchema,
  updateBlurbInputSchema,
} from '~/server/schema/blurb.schema';
import { guardedProcedure, isFlagProtected, protectedProcedure, router } from '~/server/trpc';

const blurbProcedure = protectedProcedure.use(isFlagProtected('textBlurbs'));

// Writes sit on `guardedProcedure`, matching the host surfaces (article/model/bounty upsert)
// rather than the bare `protectedProcedure` reads use. A blurb edit is an edit of already-
// published content — the fan-out rewrites every entity referencing it, and nothing downstream
// of this rung re-checks the actor — so a muted user reaching `blurb.update` bypasses the mute
// on text they have already placed. Reading your own list stays ungated.
const blurbWriteProcedure = guardedProcedure.use(isFlagProtected('textBlurbs'));

export const blurbRouter = router({
  getMine: blurbProcedure.query(getMyBlurbsHandler),
  create: blurbWriteProcedure.input(createBlurbInputSchema).mutation(createBlurbHandler),
  update: blurbWriteProcedure.input(updateBlurbInputSchema).mutation(updateBlurbHandler),
  delete: blurbWriteProcedure.input(deleteBlurbInputSchema).mutation(deleteBlurbHandler),
});
