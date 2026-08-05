import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import {
  clearCacheByPattern,
  clearCacheByPatterns,
  scopeCachePatternToNamespace,
} from '~/server/utils/cache-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  // Accept either a single pattern or a comma-separated list.
  pattern: z.string().optional(),
  patterns: z.string().optional(),
  stream: z.string().optional(),
  // Which Redis instance to target. Defaults to the main cache cluster.
  target: z.enum(['main', 'sys']).optional(),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const parsed = schema.parse(req.query);
  const target = parsed.target ?? 'main';
  const rawPatterns = parsed.patterns
    ? parsed.patterns
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : parsed.pattern
    ? [parsed.pattern]
    : [];

  // 🔴 A cache-clear glob is written against the PRODUCTION key shape (`packed:caches:*`), and
  // every deployment shares one cache instance. On a deployment whose cache keys are namespaced
  // that glob matches production's keys and none of this deployment's own, so an unscoped clear
  // from here would purge production while leaving the environment it was aimed at untouched.
  // Scoping it to this deployment's namespace makes the endpoint able to address ONLY its own
  // keyspace. Identity in production (no namespace ⇒ no prefix ⇒ the exact patterns as typed).
  //
  // `target: 'sys'` is deliberately NOT scoped — that keyspace is a separate per-deployment
  // instance whose keys are unprefixed by construction; see `scopeCachePatternToNamespace`.
  const patterns = rawPatterns.map((p) => scopeCachePatternToNamespace(p, target));

  if (patterns.length === 0) {
    res.status(400).json({ error: 'Provide either ?pattern= or ?patterns=a,b,c' });
    return;
  }

  // SSE mode: keep the connection alive with periodic heartbeats so Cloudflare
  // doesn't 502 when scanning a large keyspace.
  if (parsed.stream === '1') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('start', { patterns, target });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

    try {
      const results = await clearCacheByPatterns(
        patterns,
        (progress) => send('progress', progress),
        target
      );
      const total = results.reduce((s, r) => s + r.cleared, 0);
      send('done', { total, perPattern: results });
    } catch (e) {
      send('error', { error: (e as Error).message });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
    return;
  }

  if (patterns.length === 1) {
    const cleared = await clearCacheByPattern(patterns[0], undefined, target);
    return res.status(200).json({ ok: true, cleared: cleared.length, target });
  }

  const results = await clearCacheByPatterns(patterns, undefined, target);
  const total = results.reduce((s, r) => s + r.cleared, 0);
  return res.status(200).json({ ok: true, cleared: total, target, perPattern: results });
});
