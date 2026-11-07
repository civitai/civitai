import type { RequestHandler } from './$types';

// Probe target: answers from the process alone. Never add a database, Redis or Flipt read here; a
// dependency outage would then restart every pod at once. The user guard skips this path
// (hooks.server.ts).
export const GET: RequestHandler = () =>
  new Response('ok', {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
