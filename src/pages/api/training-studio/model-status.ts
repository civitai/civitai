import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { studioModelNotOwnerDeleted } from '~/server/services/orchestrator/training/studio-draft-filter';
import { studioWithheldWorkflowIds } from '~/server/services/orchestrator/training/studio-withheld';

const schema = z.object({
  id: z.coerce.number().int().positive(),
  versionId: z.coerce.number().int().positive().optional(),
});
const MAX_WORKFLOW_IDS = 100;
const workflowIdsSchema = z.object({
  userId: z.coerce.number().int().positive(),
  workflowIds: z
    .string()
    .transform((s) => [...new Set(s.split(',').filter(Boolean))])
    .pipe(z.array(z.string().max(128)).min(1).max(MAX_WORKFLOW_IDS)),
});

export default AuthedEndpoint(async (req, res, user) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.query.workflowIds !== undefined) {
    const input = workflowIdsSchema.safeParse(req.query);
    if (!input.success) return res.status(400).json({ error: 'Invalid workflow ids.' });
    // The Studio names the user it asks for; a session that is someone else gets no answer.
    if (input.data.userId !== user.id) return res.status(403).json({ error: 'Wrong user.' });
    const withheld = user.isModerator
      ? []
      : await studioWithheldWorkflowIds(user.id, input.data.workflowIds);
    return res.json({ withheld });
  }

  const input = schema.safeParse(req.query);
  if (!input.success) return res.status(400).json({ error: 'Invalid model id.' });

  const model = await dbWrite.model.findFirst({
    where: {
      id: input.data.id,
      userId: user.id,
      ...studioModelNotOwnerDeleted(user.id),
      // A run added to an existing model is that model's version: deleting it (a hard delete)
      // ends the run's link while the model lives on.
      ...(input.data.versionId && { modelVersions: { some: { id: input.data.versionId } } }),
    },
    select: { id: true },
  });
  return res.json({ live: model !== null });
});
