import { NextApiRequest, NextApiResponse } from 'next';
import z from 'zod';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  status: z.enum(['success', 'failure']),
  user_declared: z.object({
    content: z.object({
      id: z.number(),
      name: z.string(),
      POI: z.boolean(),
      NSFW: z.boolean(),
      minor: z.boolean(),
      triggerwords: z.string().array().nullish(),
      image_urls: z.string().array().nullish(),
      links: z.string().array().nullish(),
    }),
  }),
  flags: z.object({
    POI_flag: z.boolean(),
    NSFW_flag: z.boolean(),
    minor_flag: z.boolean(),
    triggerwords_flag: z.boolean(),
  }),
});

const logWebhook = (data: MixedObject) => {
  logToAxiom({ name: 'model-scan-result', type: 'error', ...data }, 'webhooks').catch(() => null);
};

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    logWebhook({ message: 'Wrong method', data: { method: req.method, input: req.body } });
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const result = schema.safeParse(req.body);
  if (!result.success) {
    logWebhook({
      message: 'Could not parse body',
      data: { error: result.error.format(), input: req.body },
    });
    return res.status(400).json({ error: 'Invalid Request', details: result.error.format() });
  }

  const data = result.data;
  if (data.status === 'failure') {
    logWebhook({
      message: 'Model scan failed',
      data: { input: req.body },
    });
    return res.status(500).json({ error: 'Could not scan model' });
  }

  try {
    // Check scan results and handle accordingly
    await dbWrite.model.update({
      where: { id: data.user_declared.content.id },
      data: { scannedAt: new Date() },
    });
    await dbWrite.$executeRaw`
      INSERT INTO "ModelFlag" ("modelId", "poi", "nsfw", "minor", "triggerWords")
      VALUES (${data.user_declared.content.id}, ${data.flags.POI_flag}, ${data.flags.NSFW_flag}, ${data.flags.minor_flag}, ${data.flags.triggerwords_flag})
      ON CONFLICT ("modelId") DO UPDATE SET
        "poi" = EXCLUDED."poi",
        "nsfw" = EXCLUDED."nsfw",
        "minor" = EXCLUDED."minor",
        "triggerWords" = EXCLUDED."triggerWords";
    `;
    return res.status(200).json({ ok: true });
  } catch (error) {
    logWebhook({
      message: 'Unhandled exception',
      data: { error, input: req.body },
    });
    return res.status(500).json({ error: 'Internal Server Error', details: error });
  }
});
