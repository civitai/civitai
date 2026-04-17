import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clearCacheByPattern } from '~/server/utils/cache-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  pattern: z.string(),
  stream: z.string().optional(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { pattern, stream } = schema.parse(req.query);

  // SSE mode: keep the connection alive with periodic heartbeats so Cloudflare
  // doesn't 502 when scanning a large keyspace (clearCacheByPattern can take
  // minutes on millions of keys).
  if (stream === '1') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('start', { pattern });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

    try {
      const cleared = await clearCacheByPattern(pattern, (count) => {
        send('progress', { cleared: count });
      });
      send('done', { cleared: cleared.length });
    } catch (e) {
      send('error', { error: (e as Error).message });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
    return;
  }

  const cleared = await clearCacheByPattern(pattern);
  return res.status(200).json({
    ok: true,
    cleared: cleared.length,
  });
});
