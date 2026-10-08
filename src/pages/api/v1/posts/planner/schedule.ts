import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { plannerPublishNowSchema, plannerRescheduleSchema } from '~/server/schema/post.schema';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import {
  createPlannerCaller,
  handlePlannerError,
  requireJsonBody,
} from '~/server/utils/planner-endpoint';
import type { SessionUser } from '~/types/session';

const scheduleSchema = z.union([
  plannerRescheduleSchema,
  plannerPublishNowSchema.extend({ publishNow: z.literal(true) }),
]);

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    try {
      if (!requireJsonBody(req, res)) return;
      const parsed = scheduleSchema.safeParse(req.body ?? {});
      if (!parsed.success)
        return res.status(400).json({ error: 'Invalid schedule request', code: 'BAD_REQUEST' });

      const caller = createPlannerCaller(req, res, user);
      const result =
        'publishNow' in parsed.data
          ? await caller.post.publishNow({
              id: parsed.data.id,
              expectedScope: parsed.data.expectedScope,
            })
          : await caller.post.reschedule(parsed.data);
      return res.status(200).json(result);
    } catch (error) {
      return handlePlannerError(res, error);
    }
  },
  ['POST']
);
