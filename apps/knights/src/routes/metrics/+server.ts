import { register } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

/** Prometheus scrape endpoint, served to in-cluster scrapes only. */
export const GET: RequestHandler = async ({ request }) => {
  if (request.headers.has('x-forwarded-for')) {
    return new Response('Not Found', { status: 404 });
  }
  return new Response(await register.metrics(), {
    headers: { 'content-type': register.contentType },
  });
};
