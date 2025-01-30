import { getGenerationDataSchema } from '~/server/schema/generation.schema';
import { getGenerationData } from '~/server/services/generation/generation.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      const session = await getServerAuthSession({ req, res });
      const queryInput = getGenerationDataSchema.parse(req.query);
      const queryResult = await getGenerationData({ query: queryInput, user: session?.user });
      return res.status(200).json(queryResult);
    } catch (e: any) {
      res.status(400).send({ message: e.message });
    }
  },
  ['GET']
);
