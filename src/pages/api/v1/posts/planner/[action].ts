import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  isPlannerAction,
  PLANNER_ACTIONS,
  type PlannerAction,
} from '@civitai/post-planner/contract';
import { plannerPublishNowSchema, plannerRescheduleSchema } from '~/server/schema/post.schema';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import {
  createPlannerCaller,
  handlePlannerError,
  requireJsonBody,
  type PlannerCaller,
} from '~/server/utils/planner-endpoint';
import type { SessionUser } from '~/types/session';

const scheduleSchema = z.union([
  plannerRescheduleSchema,
  plannerPublishNowSchema.extend({ publishNow: z.literal(true) }),
]);

type Input = Record<string, unknown>;

const procedures: Record<PlannerAction, (caller: PlannerCaller, input: Input) => Promise<unknown>> =
  {
    scheduled: (caller, query) => caller.post.getScheduled(query as never),
    detail: (caller, query) => caller.post.getPlannerDetail(query as never),
    schedule: (caller, body) => {
      const parsed = scheduleSchema.safeParse(body);
      if (!parsed.success)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid schedule request' });
      return 'publishNow' in parsed.data
        ? caller.post.publishNow({ id: parsed.data.id, expectedScope: parsed.data.expectedScope })
        : caller.post.reschedule(parsed.data);
    },
    unschedule: (caller, body) => caller.post.unschedule(body as never),
    shift: (caller, body) => caller.post.shiftSchedule(body as never),
  };

async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  const { action, ...query } = req.query as { action: PlannerAction } & Input;
  try {
    const isRead = PLANNER_ACTIONS[action].method === 'GET';
    if (!isRead && !requireJsonBody(req, res)) return;
    const result = await procedures[action](
      createPlannerCaller(req, res, user),
      isRead ? query : req.body ?? {}
    );
    return res.status(200).json(result);
  } catch (error) {
    return handlePlannerError(res, error);
  }
}

// One wrapper per method so an action's CORS allow-methods names only its own.
const byMethod = {
  GET: AuthedEndpoint(handler, ['GET']),
  POST: AuthedEndpoint(handler, ['POST']),
};

export default function plannerRoute(req: NextApiRequest, res: NextApiResponse) {
  const action = req.query.action;
  if (typeof action !== 'string' || !isPlannerAction(action))
    return res.status(404).json({ error: 'Not found' });
  return byMethod[PLANNER_ACTIONS[action].method](req, res);
}
