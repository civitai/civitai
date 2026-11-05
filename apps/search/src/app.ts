import Fastify, { type FastifyInstance } from 'fastify';
import { imageSearchInput } from '@civitai/search';
import { logLevel } from './env';
import { isAuthorized } from './lib/server/auth';
import { getSearchDeps, type SearchDeps } from './lib/server/deps';
import { SearchError } from './lib/server/errors';
import { searchImages } from './lib/server/images';
import { registry, searchDuration } from './lib/server/metrics';

/**
 * Build the Fastify server (no listen — server.ts calls listen; tests use `.inject`).
 * Ops routes: GET /health (no-dep liveness), GET /metrics (private-by-XFF).
 * Authed API (bearer token): POST /images/search → ranked image ids.
 */
export async function buildServer(options: { deps?: SearchDeps } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: logLevel }, trustProxy: true });
  const deps = () => options.deps ?? getSearchDeps((msg, details) => app.log.error(details, msg));

  app.get('/health', async () => ({ status: 'ok', service: 'search' }));

  // Requests through the public ingress carry x-forwarded-for; the in-cluster scrape does not.
  app.get('/metrics', async (req, reply) => {
    if (req.headers['x-forwarded-for'] !== undefined)
      return reply.code(404).type('text/plain').send('Not Found');
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  app.post('/images/search', async (req, reply) => {
    if (!isAuthorized(req.headers)) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = imageSearchInput.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'Invalid payload', issues: parsed.error.issues });

    const kind = 'text' in parsed.data.query ? 'text' : 'similar';
    const end = searchDuration.startTimer({ index: 'images', kind });
    try {
      const result = await searchImages(parsed.data, deps().images);
      end({ outcome: 'ok' });
      return result;
    } catch (err) {
      if (err instanceof SearchError) {
        end({ outcome: String(err.status) });
        if (err.status !== 404) req.log.warn({ err }, 'image search failed');
        return reply.code(err.status).send({ error: err.message });
      }
      end({ outcome: '500' });
      req.log.error({ err }, 'image search failed');
      return reply.code(500).send({ error: 'Internal error' });
    }
  });

  return app;
}
