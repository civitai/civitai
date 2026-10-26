import { getAutoLabelWorkflowSchema } from '~/server/schema/training.schema';
import { getAutoLabelWorkflow } from '~/server/services/training.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';

/**
 * Poll one Training Studio auto-label workflow submitted through `./index.ts`. It runs on the system
 * token, so `getAutoLabelWorkflow` scopes it to the caller by its metadata (404 otherwise).
 * GET → 200 { status, steps: [{ name, status, filename, output }] }.
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!(await allowTrainingStudio(req, res, user, { pageFlag: false }))) return;

    const input = getAutoLabelWorkflowSchema.safeParse({ workflowId: req.query.workflowId });
    if (!input.success) return res.status(400).json({ error: 'Invalid workflow id.' });

    try {
      const workflow = await getAutoLabelWorkflow({ ...input.data, userId: user.id });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(workflow);
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['GET']
);
