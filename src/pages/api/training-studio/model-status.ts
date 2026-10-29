import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { ModelStatus } from '~/shared/utils/prisma/enums';

const schema = z.object({ id: z.coerce.number().int().positive() });

/**
 * Whether a Training Studio run's model still exists for the caller: both Studio surfaces ask before
 * linking a run's draft, since the run keeps its modelId after the model is deleted.
 * GET ?id= → 200 { live }; live is false for a missing, Deleted or someone else's model.
 */
export default AuthedEndpoint(async (req, res, user) => {
  const input = schema.safeParse(req.query);
  if (!input.success) return res.status(400).json({ error: 'Invalid model id.' });

  // Primary, not the replica: this is read right after the owner deletes the draft.
  const model = await dbWrite.model.findFirst({
    where: { id: input.data.id, userId: user.id, status: { not: ModelStatus.Deleted } },
    select: { id: true },
  });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ live: model !== null });
});
