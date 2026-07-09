import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { publicApiContext2 } from '~/server/createContext';
import { logToAxiom } from '~/server/logging/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { isClientAbortError } from '~/server/utils/errorHandling';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const toStringArray = (v: string | string[] | undefined) => {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  const out = arr
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
};

const toBoundedInt = (
  v: string | string[] | undefined,
  { min, max }: { min: number; max: number }
) => {
  const raw = first(v);
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return undefined;
  if (n < min || n > max) return undefined;
  return n;
};

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const apiCaller = await publicApiContext2(req, res);
  try {
    const { limit, cursor, statuses, includeClosed, tags, search } = req.query as Record<
      string,
      string | string[] | undefined
    >;

    const { items, nextCursor } = await apiCaller.bug.getInfinite({
      limit: toBoundedInt(limit, { min: 1, max: 200 }),
      cursor: toBoundedInt(cursor, { min: 0, max: Number.MAX_SAFE_INTEGER }),
      statuses: toStringArray(statuses),
      includeClosed: first(includeClosed) === 'true',
      tags: toStringArray(tags),
      search: first(search),
    });

    return res.status(200).json({ items, metadata: { nextCursor } });
  } catch (error) {
    if (isClientAbortError(error)) {
      if (!res.headersSent) res.status(499).end();
      return;
    }
    if (error instanceof TRPCError) {
      const status = getHTTPStatusCodeFromError(error);
      const parsedError = (() => {
        try {
          return JSON.parse(error.message);
        } catch {
          return { message: error.message };
        }
      })();
      return res.status(status).json(parsedError);
    }
    logToAxiom(
      {
        type: 'error',
        name: 'bugs-api-error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'webhooks'
    ).catch(() => null);
    return res.status(500).json({ message: 'An unexpected error occurred' });
  }
});
