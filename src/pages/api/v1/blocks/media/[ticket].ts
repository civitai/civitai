import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import { resolveBlockMediaFetch } from '~/server/services/blocks/block-media-serving';

const PENDING_RETRY_AFTER_SECONDS = 5;

/**
 * App Block workflow media. Tokenless on purpose: a `<video>`/`<img>` GET
 * carries no block token, so the sealed ticket in the path is the whole
 * credential, and it names the viewer it is judged for. `*` CORS with no
 * credentials, because App Blocks run in opaque-origin frames and fetch clips
 * into a `blob:` URL.
 */
export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).end();
    return;
  }

  const result = await resolveBlockMediaFetch(req.query.ticket);
  if (result.state === 'redirect') {
    res.setHeader('Location', result.location);
    res.status(302).end();
    return;
  }
  if (result.state === 'pending') {
    res.setHeader('Retry-After', String(PENDING_RETRY_AFTER_SECONDS));
    res.status(409).end();
    return;
  }
  res.status(404).end();
});
