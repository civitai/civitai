import { getResourceData } from '~/server/services/generation/generation.service';
import { handleEndpointError, PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
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

      // 🔴 civitai#3845 TIER 1 — see `generation/data.ts` for the full reasoning.
      // Same shape of bug and same fix: the catch answered EVERY failure with
      // `400 { message: e.message }` on a `PublicEndpoint`, so driver text reached
      // anonymous callers. `safeParse` lifts the one legitimate 4xx — a malformed
      // `?ids=` — out of the catch so it keeps its 400 AND its byte-identical
      // body; everything past the parse delegates and gets genericized + logged.
      const parsed = schema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.message });

      const sfwOnly = getRequestDomainColor(req) === 'green';
      const queryResult = await getResourceData(parsed.data.ids, {
        user: session?.user,
        withPreview: true,
        sfwOnly,
      });
      return res.status(200).json(queryResult);
    } catch (e) {
      if (res.headersSent) return;
      // `getResourceData` has no client-rejection path of its own — it returns []
      // for an empty id list — so everything reaching here is a server-side
      // failure. No 4xx is lost by delegating.
      return handleEndpointError(res, e);
    }
  },
  ['GET']
);
