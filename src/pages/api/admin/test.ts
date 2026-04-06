import type { NextApiRequest, NextApiResponse } from 'next';
import { createTextModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const DEFAULT_TEST_PROMPT =
  'lazypos, masterpiece, best quality, ultra-detailed, sharp focus, 1girl, solo, mature woman, 32 years old, beautiful, sexy, petite, curvy body, narrow waist, big firm ass, detailed blonde hair, french braid, perfect big eyes, green eyes, pale skin, realistic skin texture, fine pores, skin indentations, crop top lifted exposing breasts, hotpants, parted lips, nipples, relaxed posture chest forward, dynamic side close-up angle, locker room, wooden lockers, tiled floor, BREAK partially illuminated, dramatic lighting, volumetric lighting, cinematic lighting';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const text = (req.query.text as string) ?? DEFAULT_TEST_PROMPT;

    const result = await createTextModerationRequest({
      entityType: 'Article',
      entityId: 0,
      content: text,
      wait: 30,
    });

    res.status(200).json(result);
  } catch (e) {
    console.log(e);
    res.status(400).json({ error: (e as Error).message });
  }
});
