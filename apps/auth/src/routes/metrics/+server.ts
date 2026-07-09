import type { RequestHandler } from './$types';
import { register } from '$lib/server/metrics';

// Prometheus scrape endpoint. Served on the same adapter-node :3000 server as everything else.
//
// EXPOSURE GUARD: if the request carries an `x-forwarded-for` header, return 404.
// Rationale: the public Traefik ingress ALWAYS sets X-Forwarded-For, but the in-cluster Prometheus
// ServiceMonitor scrapes the pod directly (Pod IP:3000, no proxy) so it sends NO X-Forwarded-For.
// This makes /metrics effectively private — reachable only from inside the cluster — without needing a
// Traefik route change to block it. (Any external request reaching us has gone through the ingress and
// therefore carries XFF → 404.)
export const GET: RequestHandler = async ({ request }) => {
  if (request.headers.has('x-forwarded-for')) {
    return new Response('Not Found', { status: 404 });
  }

  const body = await register.metrics();
  return new Response(body, {
    status: 200,
    headers: { 'content-type': register.contentType },
  });
};
