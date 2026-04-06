import { getWorkflowStatusUpdate } from '~/server/services/orchestrator/orchestration-new.service';
import { OrchestratorEndpoint } from '~/server/utils/endpoint-helpers';

export default OrchestratorEndpoint(
  async function handler(req, res, user, token) {
    const { workflowId } = req.query;
    const result = await getWorkflowStatusUpdate({ token, workflowId: workflowId as string });
    return res.status(200).send(result);
  },
  ['GET']
);
