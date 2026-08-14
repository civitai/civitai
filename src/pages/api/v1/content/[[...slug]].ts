import type { NextApiRequest, NextApiResponse } from 'next';
import { publicApiContext2 } from '~/server/createContext';
import { handleEndpointError, PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default PublicEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  // const apiCaller = appRouter.createCaller(publicApiContext(req, res));
  const apiCaller = await publicApiContext2(req, res);

  try {
    const result = await apiCaller.content.get({ slug: req.query.slug });
    return res.status(200).json(result);
  } catch (error) {
    // civitai#3845 (population B): `{ error: error.cause }` served the WRAPPED
    // error, which for a `throwDbError`-produced TRPCError is the driver error
    // itself — the most direct leak of the whole set. It also answered a hard 500
    // for every TRPCError, so a NOT_FOUND slug was reported as a server fault;
    // delegating gives it its real status.
    return handleEndpointError(res, error);
  }
});
