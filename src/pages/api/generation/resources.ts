import { getResourceData } from '~/server/services/generation/generation.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import z from 'zod';

const schema = z.object({
  ids: z
    .union([z.array(z.coerce.number()), z.coerce.number()])
    .transform((val) => (Array.isArray(val) ? val : [val])),
});

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      const session = await getServerAuthSession({ req, res });
      const { ids } = schema.parse(req.query);
      const queryResult = await getResourceData(ids, session?.user, false, true);
      return res.status(200).json(queryResult);
    } catch (e: any) {
      res.status(400).send({ message: e.message });
    }
  },
  ['GET']
);
