import { NextApiRequest, NextApiResponse } from 'next';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { queryWorkflows, submitWorkflow } from '~/server/services/orchestrator/workflows';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { env } from '~/env/server.mjs';
import { getSystemPermissions } from '~/server/services/system-cache';
import { addGenerationEngine } from '~/server/services/generation/engines';
import { dbWrite } from '~/server/db/client';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';

type Row = {
  userId: number;
  cosmeticId: number;
  claimKey: string;
  data: any[];
  fixedData?: Record<string, any>;
};

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    res.status(200).send({});
  } catch (e) {
    res.status(400).end();
  }
});
