import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { createContext } from '~/server/createContext';
import { appRouter } from '~/server/routers';
import { modelUpsertSchema } from '~/server/schema/model.schema';
import { upsertModel } from '~/server/services/model.service';
import { createCallerFactory } from '~/server/trpc';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { dbRead } from '~/server/db/client';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { SessionUser } from '~/types/session';

const createCaller = createCallerFactory(appRouter);

const faceFields = modelUpsertSchema.pick({ sfwName: true, sfwDescription: true });
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('draft'), modelId: z.number().int().positive() }),
  faceFields.extend({
    action: z.literal('save'),
    modelId: z.number().int().positive(),
    sfwName: z.string().trim().min(1),
    sfwCoverImageId: z.number().int().positive(),
  }),
]);

const isSafeImage = (nsfwLevel: number) =>
  nsfwLevel !== 0 && (nsfwLevel & sfwBrowsingLevelsFlag) === nsfwLevel;

/**
 * Creator Studio's bulk "make it safe": the model editor's "Draft a civitai.com version" flow for one
 * model at a time. `draft` runs the editor's own draft procedure (its rate limit and gates included)
 * and picks the first PG/PG-13 image as the cover; `save` stores the face through `upsertModel`.
 */
export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });
    const input = parsed.data;

    const model = await dbRead.model.findUnique({
      where: { id: input.modelId },
      select: {
        id: true,
        userId: true,
        name: true,
        description: true,
        type: true,
        uploadType: true,
        status: true,
        nsfw: true,
        lockedProperties: true,
        deletedAt: true,
      },
    });
    if (!model || model.deletedAt) return res.status(404).json({ error: 'Model not found' });
    if (model.userId !== user.id)
      return res.status(403).json({ error: 'You do not own this model' });
    if (model.nsfw && model.lockedProperties.includes('nsfw'))
      return res
        .status(409)
        .json({
          error:
            'A moderator has locked this model as mature, so it cannot get a civitai.com version. You can dispute the lock from the model page.',
          code: 'locked',
        });

    try {
      if (input.action === 'draft') {
        const caller = createCaller(await createContext({ req, res }));
        const candidates = await caller.model.getCoverCandidates({ id: model.id });
        const cover = candidates.find((image) => isSafeImage(image.nsfwLevel));
        if (!cover)
          return res
            .status(422)
            .json({
              error:
                'This model has no PG or PG-13 image to use as a civitai.com cover. Add one first.',
              code: 'no-cover',
            });
        const draft = await caller.model.draftSfwFace({
          name: model.name,
          description: model.description,
          modelId: model.id,
        });
        return res.status(200).json({
          ...draft,
          sfwCoverImageId: cover.id,
          coverUrl: cover.url,
          coverType: cover.type,
        });
      }

      await upsertModel({
        id: model.id,
        userId: user.id,
        name: model.name,
        type: model.type,
        uploadType: model.uploadType,
        status: model.status,
        sfwName: input.sfwName,
        sfwDescription: input.sfwDescription ?? null,
        sfwCoverImageId: input.sfwCoverImageId,
      });
      return res.status(200).json({ ok: true });
    } catch (error) {
      return handleEndpointError(res, error);
    }
  },
  ['POST']
);
