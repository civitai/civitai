import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { createContext } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { appRouter } from '~/server/routers';
import { createCallerFactory } from '~/server/trpc';
import type { ModelMeta } from '~/server/schema/model.schema';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { isJsonRequest } from '~/server/utils/origin-helpers';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import {
  COM_FACE_CHECK_UNAVAILABLE_MESSAGE,
  COM_FACE_REFUSED_MESSAGE,
  isComSafeLevel,
} from '~/shared/utils/model-sfw-face';
import { ModelModifier } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

const createCaller = createCallerFactory(appRouter);

const cardMessages: Record<string, string> = {
  [COM_FACE_REFUSED_MESSAGE]:
    "Its civitai.red title, description or trigger words can't be shown on civitai.com. Edit them in the model editor.",
  [COM_FACE_CHECK_UNAVAILABLE_MESSAGE]:
    "Couldn't check its civitai.red listing just now. Try again later.",
};

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('draft'), modelId: z.number().int().positive() }),
  z.object({
    action: z.literal('save'),
    modelId: z.number().int().positive(),
    sfwName: z.string().trim().min(1),
    sfwDescription: z.string().nullish(),
    sfwCoverImageId: z.number().int().positive(),
  }),
]);

/** Creator Studio's bulk "make it safe". It must go through the editor's own procedures. */
export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    // Only Creator Studio's JSON call: a cross-site form post cannot send this content type.
    if (!isJsonRequest(req)) return res.status(415).json({ error: 'Send this request as JSON' });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });
    const input = parsed.data;

    // Primary: the save writes these flags back, and a lagging replica would revert a fresh change.
    const model = await dbWrite.model.findUnique({
      where: { id: input.modelId },
      select: {
        id: true,
        userId: true,
        name: true,
        description: true,
        type: true,
        uploadType: true,
        status: true,
        checkpointType: true,
        availability: true,
        nsfw: true,
        poi: true,
        minor: true,
        sfwOnly: true,
        mode: true,
        deletedAt: true,
        sfwName: true,
        sfwDescription: true,
        sfwCoverImageId: true,
        meta: true,
      },
    });
    if (!model || model.deletedAt) return res.status(404).json({ error: 'Model not found' });
    if (model.userId !== user.id)
      return res.status(403).json({ error: 'You do not own this model' });
    if (model.minor || model.poi || model.sfwOnly || model.mode === ModelModifier.TakenDown)
      return res
        .status(409)
        .json({ error: "This model can't get a civitai.com version.", code: 'skipped' });
    // Bulk only fills a missing face: an existing one may be hand-written, and the editor owns it.
    // A face the listing re-check removed is the exception: bulk may draft it again.
    const faceRemoved =
      model.sfwCoverImageId == null && !!(model.meta as ModelMeta | null)?.comFaceRemoved;
    if (
      !faceRemoved &&
      (model.sfwName != null || model.sfwDescription != null || model.sfwCoverImageId != null)
    )
      return res.status(409).json({
        error: 'Already has a civitai.com version. Edit it in the model editor.',
        code: 'skipped',
      });
    if (!model.nsfw)
      return res.status(409).json({
        error:
          'Not marked mature: where it is listed follows its images, not a civitai.com version.',
        code: 'skipped',
      });

    try {
      const ctx = await createContext({ req, res });
      // Creator Studio calls server to server, with no Origin or Referer; the JSON check above is
      // what rules out the cross-site form post the origin check exists for.
      const caller = createCaller({ ...ctx, acceptableOrigin: true });

      if (input.action === 'draft') {
        const candidates = await caller.model.getCoverCandidates({ id: model.id });
        const cover = candidates.find((image) => isComSafeLevel(image.nsfwLevel));
        if (!cover)
          return res.status(422).json({
            error:
              'This model has no PG or PG-13 image to use as a civitai.com cover. Add one first.',
            code: 'no-cover',
          });
        const draft = await caller.model.draftSfwFace({
          name: model.name,
          description: model.description,
          modelId: model.id,
        });
        return res.status(200).json({ ...draft, sfwCoverImageId: cover.id, coverUrl: cover.url });
      }

      // The editor's save, with every flag the upsert schema would otherwise default passed back as
      // stored: an omitted `minor` or `sfwOnly` parses as false.
      await caller.model.upsert({
        id: model.id,
        name: model.name,
        type: model.type,
        uploadType: model.uploadType,
        status: model.status,
        checkpointType: model.checkpointType,
        availability: model.availability,
        nsfw: model.nsfw,
        poi: model.poi,
        minor: model.minor,
        sfwOnly: model.sfwOnly,
        sfwName: input.sfwName,
        sfwDescription: input.sfwDescription ?? null,
        sfwCoverImageId: input.sfwCoverImageId,
      });
      // The face lists the model on .com only once its cover counts toward the model's level, which
      // the save recomputes after its own write; the primary, as a replica can lag that.
      const after = await dbWrite.model.findUnique({
        where: { id: model.id },
        select: { nsfwLevel: true },
      });
      return res
        .status(200)
        .json({ listedOnCom: ((after?.nsfwLevel ?? 0) & sfwBrowsingLevelsFlag) !== 0 });
    } catch (error) {
      // Creator Studio shows the message on the model's card, away from the editor's tabs.
      const message = error instanceof Error ? cardMessages[error.message] : undefined;
      return handleEndpointError(
        res,
        message ? new TRPCError({ code: 'BAD_REQUEST', message }) : error
      );
    }
  },
  ['POST']
);
