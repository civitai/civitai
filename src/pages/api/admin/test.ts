import { NextApiRequest, NextApiResponse } from 'next';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { queryWorkflows, submitWorkflow } from '~/server/services/orchestrator/workflows';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { env } from '~/env/server';
import { getSystemPermissions } from '~/server/services/system-cache';
import { addGenerationEngine } from '~/server/services/generation/engines';
import { dbWrite } from '~/server/db/client';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { getModelVersionsForGeneration } from '~/server/services/generation/generation.service';

type Row = {
  userId: number;
  cosmeticId: number;
  claimKey: string;
  data: any[];
  fixedData?: Record<string, any>;
};

const covered = [1288397, 1288372, 1288371, 1288358, 1282254, 1281249];
const notCovered = [474453, 379259];

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerAuthSession({ req, res });
    const modelVersions = await getModelVersionsForGeneration({
      ids: [...covered, ...notCovered],
      userId: session?.user?.id,
      isModerator: session?.user?.isModerator,
    });
    res.status(200).send(modelVersions);
  } catch (e) {
    res.status(400).end();
  }
});
