import { NextApiRequest, NextApiResponse } from 'next';
import { SessionUser } from 'next-auth';
import { getTextToImageRequests, textToImage } from '~/server/services/orchestrator/textToImage';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  const user = session?.user;
  if (!user) return;

  async function submitRequest({ user }: { user: SessionUser }) {
    return await textToImage({
      params: {
        prompt:
          'vvi(artstyle), 2girl, solo, keqing (opulent splendor) (genshin impact), keqing (genshin impact), official alternate costume, dress, cone hair bun,jewelry, parted lips, looking at viewer, portrait,earrings, red orange hair, hair between eyes, upper body,very long hair, low twintails, bangs,  smile, street background,floating hair,hair ornament,night light, latent, ruins, bridge, river, hair flower, facing viewer, arms behind back, close-up, <lora:yoneyamaMaiStyle:0.7>,<lora:keqingGenshinImpact:0.9>,cloudy,gradient  cloud  color,splash art',
        negativePrompt: 'EasyNegative,watermark, center opening,bad_prompt,bad-hands-5,',
        cfgScale: 5.5,
        sampler: 'DPM++ 2M Karras',
        steps: 20,
        clipSkip: 2,
        quantity: 4,
        nsfw: false,
        aspectRatio: 2,
        draft: true,
        baseModel: 'SD1',
      },
      resources: [
        {
          id: 93208,
        },
        {
          id: 18521,
          strength: 1,
        },
        {
          id: 28569,
          strength: 1,
        },
      ],
      user,
      // whatIf: true,
    });
  }

  // const response = await getTextToImageRequests({ user, take: 10 });
  const response = await submitRequest({ user });

  // console.dir(response, { depth: null });

  return res.status(200).json(response);
});
