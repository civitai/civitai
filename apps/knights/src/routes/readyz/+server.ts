import { readiness } from '$lib/server/readiness';
import type { RequestHandler } from './$types';

// Readiness probe: 503 until the system Redis has answered once, then 200 for the life of the pod. Liveness
// stays on /healthz, which never touches a dependency. The user guard skips this path (hooks.server.ts).
export const GET: RequestHandler = async () => {
  const ready = await readiness.check();
  return new Response(ready ? 'ok' : 'not ready', {
    status: ready ? 200 : 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
};
