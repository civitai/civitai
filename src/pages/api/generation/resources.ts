import { getResourceData } from '~/server/services/generation/generation.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { getRequestDomainColor } from '~/server/utils/server-domain';
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
      const sfwOnly = getRequestDomainColor(req) === 'green';
      // Resolve features here (not in tRPC ctx) so the Wildcards canGenerate
      // override fires for the model detail page's Generate button — the
      // page hits this REST endpoint, not the tRPC controller, so without
      // `wildcardsEnabled` `getResourceData` skips the override and every
      // Wildcards-type version comes back `canGenerate: false`.
      const features = getFeatureFlagsLazy({ user: session?.user, req });
      const queryResult = await getResourceData(ids, {
        user: session?.user,
        withPreview: true,
        sfwOnly,
        wildcardsEnabled: features.wildcards,
      });
      return res.status(200).json(queryResult);
    } catch (e: any) {
      if (!res.headersSent) return res.status(400).json({ message: e.message });
      return;
    }
  },
  ['GET']
);
