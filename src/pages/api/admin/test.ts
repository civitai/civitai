import { NextApiRequest, NextApiResponse } from 'next';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { env } from '~/env/server';
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
  const records = await dbWrite.$queryRaw<Row[]>`
    SELECT
      uc."userId",
      uc."cosmeticId",
      uc."claimKey",
      uc.data
    FROM "UserCosmetic" uc
    JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
    WHERE c.name LIKE 'Holiday Garland 2024%'
    AND jsonb_typeof(uc.data) = 'array';
  `;

  const updateTasks: Task[] = [];
  for (const record of records) {
    record.fixedData = {};
    for (let item of record.data) {
      if (!item || (typeof item === 'object' && !Object.keys(item).length)) continue;
      if (typeof item === 'string' && item.startsWith('{')) {
        item = JSON.parse(item);
        record.data.push(item);
        continue;
      }

      if (typeof item === 'object') {
        for (const key in item) {
          if (record.fixedData[key] && typeof item[key] === 'number') {
            record.fixedData[key] += item[key];
          } else {
            record.fixedData[key] = item[key];
          }
        }
      }
    }

    if (record.fixedData !== record.data) {
      updateTasks.push(async () => {
        await dbWrite.$executeRawUnsafe(`
          UPDATE "UserCosmetic"
          SET data = to_jsonb('${JSON.stringify(record.fixedData)}'::jsonb)
          WHERE "userId" = ${record.userId}
          AND "cosmeticId" = ${record.cosmeticId}
          AND "claimKey" = '${record.claimKey}';
        `);
      });
    }
  }

  await limitConcurrency(updateTasks, 10);

  res.status(200).send(records);
});
