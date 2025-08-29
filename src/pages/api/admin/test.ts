import type { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { removeBlockedImagesRecursive } from '~/server/jobs/image-ingestion';
import { refreshImageResources } from '~/server/services/image.service';
import { updateCollectionsNsfwLevels } from '~/server/services/nsfwLevels.service';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { TaskBatcher } from '~/utils/taskBatcher';

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
    // const modelVersions = await getResourceData({
    //   ids: [1182093],
    //   user: session?.user,
    // });
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

    // await upsertTagsOnImageNew([
    //   {
    //     imageId: 1,
    //     tagId: 1,
    //     // source: 'User',
    //     confidence: 70,
    //     // automated: true,
    //     // disabled: false,
    //     // needsReview: false,
    //   },
    // ]);
    // for (const workflow of workflows) {
    //   setWorkflowDefinition(workflow.key, workflow);
    // }

    // const data = await getGenerationResourceData({ ids: [1703341] });

    // await setExperimentalConfig({ userIds: [5] });
    // const data = await updateCollectionsNsfwLevels([24004]);

    // const imageResources = await dbRead.$queryRaw<{ imageId: number }[]>`
    //   select * from "ImageResourceNew" where "modelVersionId" = 690425 and detected
    // `;

    // await Limiter({ batchSize: 1, limit: 10 }).process(imageResources, async ([{ imageId }]) => {
    //   await refreshImageResources(imageId);
    // });

    // res.status(200).send({ data });
    // await removeBlockedImagesRecursive(undefined, undefined, 10000);
    res.status(200).send({});
  } catch (e) {
    console.log(e);
    res.status(400).end();
  }
});
