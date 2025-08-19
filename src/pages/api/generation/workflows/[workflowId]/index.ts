import { formatGenerationResponse } from '~/server/services/orchestrator/common';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { OrchestratorEndpoint } from '~/server/utils/endpoint-helpers';

export default OrchestratorEndpoint(
  async function handler(req, res, user, token) {
    const { workflowId } = req.query;
    const result = await getWorkflow({ token, path: { workflowId: workflowId as string } });
    const [formatted] = await formatGenerationResponse([result]);
    return res.status(200).send(formatted);
  },
  ['GET']
);
