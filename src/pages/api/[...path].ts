import type { NextApiRequest, NextApiResponse } from 'next';
import { apiRoutes } from '~/server/api-routes/registry';

// Preview for hq:b_serve_api_gm8f: every API route without its own `config` is served from here
// instead of being its own build entry. Routes with a `config` (body parser, size limits) and the
// existing catch-alls stay as files, and Next routes a file ahead of this one.
function match(segments: string[], parts: string[]): Record<string, string | string[]> | null {
  if (segments.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.startsWith('[')) params[seg.slice(1, -1)] = decodeURIComponent(parts[i]);
    else if (seg !== parts[i]) return null;
  }
  return params;
}

export default async function apiRouter(req: NextApiRequest, res: NextApiResponse) {
  const raw = req.query.path;
  const parts = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const route of apiRoutes) {
    const params = match(route.segments, parts);
    if (!params) continue;
    const { path: _path, ...rest } = req.query;
    req.query = { ...rest, ...params };
    return route.handler(req, res);
  }
  return res.status(404).json({ error: 'Not found' });
}
