import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { publicApiContext2 } from '~/server/createContext';
import { logToAxiom } from '~/server/logging/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { isClientAbortError } from '~/server/utils/errorHandling';

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const apiCaller = await publicApiContext2(req, res);
  try {
    const rawId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    const bug = await apiCaller.bug.getById({ id });
    return res.status(200).json(bug);
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
