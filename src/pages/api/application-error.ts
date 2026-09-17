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
   * Opt OUT of server-side sourcemap resolution for this report.
   *
   * `applySourceMaps` is `await`ed on this request path. For each distinct frame file that names a
   * build chunk it reads the chunk, reads its map and builds a `SourceMapConsumer` — synchronous
   * file reads and a parse, on the pool that serves pages, sized by build output rather than by
   * anything this request carries. That work is bounded in `applySourceMaps` itself — a fixed cap
   * on how many distinct frame files one call resolves, spent only on frames that name a build
   * chunk, and a process-wide cache of parsed maps so repeat reports naming the same chunk do not
   * re-parse it.
   *
   * A caller sets this when it already knows resolution will not pay for itself, so the server can
   * skip work it would otherwise do. The two cases: a stack that carries no build-chunk frames at
   * all (a React `componentStack`), where resolution is a no-op; and a reporting path that can
   * fire repeatedly for one underlying fault, such as a render that fails and retries, where the
   * useful signal is the message and the unresolved frames rather than a resolved stack per
   * repeat. `src/components/ErrorBoundary/reportBoundaryError.ts` is the second case.
   *
   * The other callers of `reportApplicationError` do not set it and do not need to: they report
   * once per user action. Note that they also pass no `stack`, so what they send is the error's own
   * stack and it IS resolved — the resolver is not a no-op for them, which is why the bound above
   * is in `applySourceMaps` rather than in each caller's choice of this flag.
   *
   * The stack is stored either way. Unresolved, it stays resolvable later against the browser maps
   * that ship in the runtime image for that build — see `~/utils/application-error`.
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
