import type { NextApiRequest, NextApiResponse } from 'next';
import { logToAxiom, safeError } from '~/server/logging/client';
import { fetchDownloadLink } from '~/server/services/download-link/download-link.service';

/**
 * A download link: no auth, the id is the whole credential. Every refusal is the same plain 404.
 *
 * 🔴 Never log `req.url` or `req.query` here: the path carries the id. That is also why this route
 * is not wrapped in an endpoint helper — `withAxiom` attaches the request path to every event.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // On every response, refusals and errors included. no-store also overrides any CDN default.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // GET only: every request counts toward the fetch cap, so a HEAD would spend one.
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const url = await fetchDownloadLink({ id: req.query.id, req, res });
    if (!url) return res.status(404).json({ error: 'Not found' });
    return res.redirect(302, url);
  } catch (error) {
    logToAxiom({
      ...safeError(error),
      name: 'download-link',
      type: 'error',
      message: 'use-failed',
    }).catch(() => undefined);
    if (res.headersSent) return;
    // A literal, not handleEndpointError: that helper logs the request's route, and this path is the id.
    return res.status(500).json({ error: 'An unexpected error occurred' });
  }
}
