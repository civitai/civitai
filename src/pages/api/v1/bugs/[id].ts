import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { publicApiContext2 } from '~/server/createContext';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const apiCaller = await publicApiContext2(req, res);
  try {
    const id = Number(req.query.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    const bug = await apiCaller.bug.getById({ id });
    return res.status(200).json(bug);
  } catch (error) {
    if (error instanceof TRPCError) {
      const status = getHTTPStatusCodeFromError(error);
      const parsedError = (() => {
        try {
          return JSON.parse(error.message);
        } catch {
          return { message: error.message };
        }
      })();
      res.status(status).json(parsedError);
    } else {
      res.status(500).json({ message: 'An unexpected error occurred', error });
    }
  }
});
