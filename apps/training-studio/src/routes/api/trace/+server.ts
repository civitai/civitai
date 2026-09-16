import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

// The orchestrator host from config, plus any civitai.com subdomain (the presigned trace URLs may come
// from a sibling orchestration host, e.g. orchestration-new.civitai.com). Anchored on a leading dot so
// `evil-civitai.com` / `xcivitai.com` do NOT match — only real subdomains of civitai.com.
const ORCH_HOST = (() => {
  try {
    return env.ORCHESTRATOR_ENDPOINT ? new URL(env.ORCHESTRATOR_ENDPOINT).hostname : '';
  } catch {
    return '';
  }
})();
function isAllowedTraceHost(hostname: string): boolean {
  return (
    (ORCH_HOST !== '' && hostname === ORCH_HOST) ||
    hostname === 'civitai.com' ||
    hostname.endsWith('.civitai.com')
  );
}

// Tail an epoch's live training trace. The `url` is the orchestrator-issued presigned traceUrl from the
// workflow output; we proxy the chunked stream (rather than fetch it from the browser) to sidestep CORS
// and keep it server-side. Locked to the orchestrator host with no redirect-follow, so it can't be turned
// into an SSRF/open proxy. The route is session-gated by hooks; the traceUrl is self-authenticating (signed).
export const GET: RequestHandler = async ({ url, fetch }) => {
  const target = url.searchParams.get('url');
  if (!target) error(400, 'Missing trace url.');

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    error(400, 'Bad trace url.');
  }
  if (parsed.protocol !== 'https:' || !isAllowedTraceHost(parsed.hostname)) {
    error(400, 'Disallowed trace host.');
  }

  let upstream: Response;
  try {
    // Do NOT follow redirects — a 3xx to an internal/metadata host must not be chased.
    upstream = await fetch(target, { redirect: 'manual' });
  } catch (err) {
    console.warn('[training-studio] trace fetch failed', err);
    error(502, 'Trace unavailable.');
  }
  // 404 until the worker writes its first line — surface it so the client retries.
  if (upstream.status === 404) error(404, 'Trace not ready.');
  // Anything other than a 2xx (incl. an opaque redirect) is not a trace stream.
  if (!upstream.ok || !upstream.body) error(502, 'Trace unavailable.');

  // Pass the chunked body straight through; the client reads it as it arrives.
  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/x-ndjson',
      'cache-control': 'no-store',
    },
  });
};
