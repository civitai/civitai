import { readiness } from '$lib/server/readiness';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  const ready = await readiness.check();
  return new Response(ready ? 'ok' : 'not ready', {
    status: ready ? 200 : 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
};
