import type { NextApiRequest, NextApiResponse } from 'next';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { createPlannerCaller, handlePlannerError } from '~/server/utils/planner-endpoint';
import type { SessionUser } from '~/types/session';

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    try {
      const { from, to, modelVersionId } = req.query;
      const result = await createPlannerCaller(req, res, user).post.getScheduled({
        from: from as unknown as Date,
        to: to as unknown as Date,
        modelVersionId: modelVersionId as unknown as number | undefined,
      });
      return res.status(200).json(result);
    } catch (error) {
      return handlePlannerError(res, error);
    }
  },
  ['GET']
);
