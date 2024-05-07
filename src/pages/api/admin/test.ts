import dayjs from 'dayjs';
import { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import ncmecCaller from '~/server/http/ncmec/ncmec.caller';
import { REDIS_KEYS } from '~/server/redis/client';
import { generateFormSchema, textToImageFormSchema } from '~/server/schema/generation.schema';
import { getTopContributors } from '~/server/services/buzz.service';
import { deleteImagesForModelVersionCache } from '~/server/services/image.service';
import {
  formatTextToImageResponses,
  getTextToImageRequests,
  textToImage,
} from '~/server/services/orchestrator/textToImage';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { bustCachedArray } from '~/server/utils/cache-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  // const teamAccounts = eventEngine.getTeamAccounts('holiday2023');
  // const accountIds = Object.values(teamAccounts);
  // const start = dayjs().subtract(1, 'day').toDate();
  // const dayContributorsByAccount = await getTopContributors({ accountIds, limit: 500, start });
  // return res.send(dayContributorsByAccount);

  // await eventEngine.processEngagement({
  //   entityType: 'model',
  //   type: 'published',
  //   entityId: 218322,
  //   userId: 969069,
  // });
  // const test = await getAllHiddenForUser({ userId: 5418, refreshCache: true });
  // const test = await getAllHiddenForUser({ userId: 5, refreshCache: true });
  // await deleteImagesForModelVersionCache(11745);
  const session = await getServerAuthSession({ req, res });
  console.dir(
    textToImageFormSchema.parse({
      prompt: '',
      negativePrompt: 'EasyNegative,watermark, center opening,bad_prompt,bad-hands-5,',
      cfgScale: 5.5,
      sampler: 'DPM++ 2M Karras',
      seed: -1,
      steps: 20,
      clipSkip: 2,
      quantity: 1,
      nsfw: false,
      aspectRatio: 2,
      draft: true,
      baseModel: 'SDXL',
      resources: [
        {
          id: 93208,
        },
        {
          id: 18521,
          triggerWord: 'keqing (genshin impact)',
          strength: 1,
        },
        {
          id: 28569,
          strength: 1,
        },
      ],
    }),
    { depth: null }
  );
  const user = session?.user;
  if (user) {
    // const response = await getTextToImageRequests({ user });
    // const response = await textToImage({
    //   params: {
    //     prompt:
    //       'vvi(artstyle), 2girl, solo, keqing (opulent splendor) (genshin impact), keqing (genshin impact), official alternate costume, dress, cone hair bun,jewelry, parted lips, looking at viewer, portrait,earrings, red orange hair, hair between eyes, upper body,very long hair, low twintails, bangs,  smile, street background,floating hair,hair ornament,night light, latent, ruins, bridge, river, hair flower, facing viewer, arms behind back, close-up, <lora:yoneyamaMaiStyle:0.7>,<lora:keqingGenshinImpact:0.9>,cloudy,gradient  cloud  color,splash art',
    //     negativePrompt: 'EasyNegative,watermark, center opening,bad_prompt,bad-hands-5,',
    //     cfgScale: 5.5,
    //     sampler: 'DPM++ 2M Karras',
    //     seed: -1,
    //     steps: 20,
    //     clipSkip: 2,
    //     quantity: 1,
    //     nsfw: false,
    //     aspectRatio: 2,
    //     draft: true,
    //     baseModel: 'SDXL',
    //   },
    //   resources: [
    //     {
    //       id: 93208,
    //     },
    //     {
    //       id: 18521,
    //       triggerWord: 'keqing (genshin impact)',
    //       strength: 1,
    //     },
    //     {
    //       id: 28569,
    //       strength: 1,
    //     },
    //   ],
    //   user,
    //   // whatIf: true,
    // });
    // console.dir(response, { depth: null });
  }

  return res.status(200).json({
    ok: true,
  });
});
