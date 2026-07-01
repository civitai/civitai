import Fastify, { type FastifyInstance } from 'fastify';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from './trpc/router';
import { createContext } from './trpc/context';
import { register } from './lib/server/metrics';

// tRPC is mounted under this base path. Keeping /api/trpc matches the monolith's mount so the eventual
// same-origin path-prefix cutover (P2, Traefik `PathPrefix(/api/trpc/orchestrator)`) is a routing change
// only — the client base URL and `trpc.orchestrator.*` call shape are unchanged.
const TRPC_PREFIX = '/api/trpc';

/**
 * Convert a Fastify request into a WHATWG `Request` so the @trpc/server fetch adapter (framework-agnostic)
 * can handle it. Fastify parses the body; we re-serialize it for the adapter. GET/HEAD carry no body.
 */
function toFetchRequest(req: import('fastify').FastifyRequest): Request {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody && req.body !== undefined ? JSON.stringify(req.body) : undefined;
  return new Request(url.toString(), { method, headers, body });
}

/**
 * Build the Fastify server (no listen — the entrypoint in server.ts calls listen; tests use `.inject`).
 * Registers:
 *   - GET /health   — no-auth liveness+readiness (must not depend on tRPC / DB / redis so it can't flap).
 *   - GET /metrics  — Prometheus scrape, private-by-XFF (mirrors the auth hub's exposure guard).
 *   - ALL /api/trpc/* — the tRPC router over the framework-agnostic fetch adapter.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Trust the proxy chain so req.ip reflects the client IP behind Cloudflare/Traefik (matches auth's
    // ADDRESS_HEADER/XFF posture). Depth is bounded by Traefik; Fastify just needs the flag on.
    trustProxy: true,
  });

  // --- liveness/readiness: zero external dependencies, so a transient DB/redis blip can't flap the pod ---
  app.get('/health', async () => ({ status: 'ok', service: 'orchestrator-api' }));

  // --- Prometheus scrape. EXPOSURE GUARD: any request carrying x-forwarded-for came through the public
  // ingress (Traefik always sets it); the in-cluster ServiceMonitor scrapes the Pod IP directly with NO
  // XFF. So XFF present ⇒ 404. Mirrors apps/auth/src/routes/metrics/+server.ts. ---
  app.get('/metrics', async (req, reply) => {
    if (req.headers['x-forwarded-for'] !== undefined) {
      return reply.code(404).type('text/plain').send('Not Found');
    }
    reply.header('content-type', register.contentType);
    return register.metrics();
  });

  // --- tRPC over the fetch adapter, mounted at /api/trpc/* ---
  app.all(`${TRPC_PREFIX}/*`, async (req, reply) => {
    const fetchReq = toFetchRequest(req);
    const response = await fetchRequestHandler({
      endpoint: TRPC_PREFIX,
      req: fetchReq,
      router: appRouter,
      createContext: ({ req }) => createContext({ req }),
    });

    reply.code(response.status);
    response.headers.forEach((value, key) => reply.header(key, value));
    const text = await response.text();
    return reply.send(text);
  });

  return app;
}

export { Fastify };
