import { NextApiResponse } from "next";
import client from "prom-client";
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

client.collectDefaultMetrics({
  register: client.register
});

const handler = WebhookEndpoint(async (_, res: NextApiResponse) => {
  const metrics = await client.register.metrics();

  res.setHeader("Content-type", client.register.contentType);
  res.send(metrics);
});

export default handler;