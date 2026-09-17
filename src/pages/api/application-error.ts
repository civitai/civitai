import * as z from 'zod';
import { isProd } from '~/env/other';
import { logToAxiom } from '~/server/logging/client';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { applySourceMaps } from '~/server/utils/errorHandling';

/**
 * Exported so callers can be TESTED against the real contract rather than a copy of it. `message`
 * and `stack` are REQUIRED strings: a caller that lets either go `undefined` has the key dropped by
 * `JSON.stringify`, `parse` throws, and this endpoint answers 400 — a silently lost report, since
 * `fetch` does not reject on a 4xx.
 */
export const applicationErrorSchema = z.object({
  message: z.string(),
  stack: z.string(),
  name: z.string().optional(),
  /**
   * 🔴 Opt OUT of server-side sourcemap resolution. `applySourceMaps` is `await`ed on this
   * request path, and for each distinct `.next/static/**` frame file it does a `readFileSync` of
   * the chunk AND its `.map` (single maps here exceed 4 MB) and builds a `SourceMapConsumer` —
   * with the consumer cache scoped INSIDE the function, so nothing is reused across requests.
   *
   * Callers sending a React `componentStack` are unaffected: it carries no file frames, so the
   * resolver's loop never runs. The hazard is a caller sending a REAL minified browser stack that
   * can fire once per failed render — a client-side render loop would then turn each report into
   * several megabytes of synchronous parsing on the pool that serves pages, making the
   * instrumentation an amplifier of the outage it exists to observe.
   *
   * Client-controlled, and safe in that direction: it can only ever REDUCE server work, never
   * increase it. The stack is still stored, just unresolved — and remains resolvable offline
   * against the `civitai-web-maps:<tag>` artifact via `scripts/resolve-cpuprofile.mjs`.
   */
  resolveStack: z.boolean().optional(),
});

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      const session = await getServerAuthSession({ req, res });
      const queryInput = applicationErrorSchema.parse(JSON.parse(req.body));
      if (isProd) {
        const payload = {
          name: queryInput.name ?? 'application-error',
          type: 'error',
          url: req.headers.referer,
          userId: session?.user?.id,
          browser: req.headers['user-agent'],
          message: queryInput.message,
          // this won't work in dev
          stack:
            queryInput.resolveStack === false
              ? queryInput.stack
              : await applySourceMaps(queryInput.stack),
        };
        await logToAxiom(payload);
      }
      return res.status(200).end();
    } catch (e: any) {
      res.status(400).send({ message: e.message });
    }
  },
  ['POST']
);
