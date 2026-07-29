import * as z from 'zod';
import { moderatorProcedure, router } from '~/server/trpc';

// Temporary diagnostic: perturbs the server module graph without touching contest
// scoring, to test whether the production build failure is a chunk-name collision
// rather than a defect in this branch.
export const probeRouter = router({
  ping: moderatorProcedure.input(z.object({ n: z.number() })).query(({ input }) => input.n),
});
