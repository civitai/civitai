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
import { dbWrite, dbRead } from '~/server/db/client';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { getResourceData } from '~/server/services/generation/generation.service';
import { Prisma } from '@prisma/client';
import { getCommentsThreadDetails2 } from '~/server/services/commentsv2.service';

type Row = {
  userId: number;
  cosmeticId: number;
  claimKey: string;
  data: any[];
  fixedData?: Record<string, any>;
};

const covered = [1288397, 1288372, 1288371, 1288358, 1282254, 1281249];
const notCovered = [474453, 379259];
const test = [1183765, 164821];

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerAuthSession({ req, res });
    const modelVersions = await getResourceData({
      ids: [1182093],
      user: session?.user,
    });
    // const modelVersions = await dbRead.$queryRaw`
    //   SELECT
    //     mv."id",
    //     mv."name",
    //     mv."trainedWords",
    //     mv."baseModel",
    //     mv."settings",
    //     mv."availability",
    //     mv."clipSkip",
    //     mv."vaeId",
    //     mv."earlyAccessEndsAt",
    //     (CASE WHEN mv."availability" = 'EarlyAccess' THEN mv."earlyAccessConfig" END) as "earlyAccessConfig",
    //     gc."covered",
    //     (
    //       SELECT to_json(obj)
    //       FROM (
    //         SELECT
    //           m."id",
    //           m."name",
    //           m."type",
    //           m."nsfw",
    //           m."poi",
    //           m."minor",
    //           m."userId"
    //         FROM "Model" m
    //         WHERE m.id = mv."modelId"
    //       ) as obj
    //     ) as model
    //   FROM "ModelVersion" mv
    //   LEFT JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id
    //   WHERE mv.id IN (${Prisma.join([1325378])})
    // `;

    // const thread = await getCommentsThreadDetails2({
    //   entityId: 10936,
    //   entityType: 'article',
    // });

    res.status(200).send(modelVersions);
  } catch (e) {
    console.log(e);
    res.status(400).end();
  }
});
