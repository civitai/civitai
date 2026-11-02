import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { PreviewRestarts, RestartErrorCode } from './app-assistant/preview-restart';
import { buildRunApp, type RunAppOptions, type RunRoutes } from './core/app';
import { GRANT_HEADER } from './core/protocol';
import { MintRefusedError } from './minter';
import type { TokenVerifier } from './tokens';

export { lastEventId, loggerOptions } from './core/app';

export interface AppOptions extends Omit<RunAppOptions, 'grants' | 'routes' | 'patchRefusal'> {
  /**
   * Whether a start (or a patch) may name this model: `isAppAssistantModel` in a deployment, so it
   * never takes a model id the page does not offer. Required, so no deployment can leave it out;
   * tests running scripted models pass their own.
   */
  acceptsModel(model: string): boolean;
  /** Checks the run grant a start (or a patch) carries. Without one every start is refused. */
  grants?: Pick<TokenVerifier, 'grant'>;
  /** The page's Restart preview (`POST apps/:app/preview`). Without it that answers 503. */
  previews?: PreviewRestarts;
}

/** What each refused Restart preview answers with. */
const RESTART_STATUS: Record<RestartErrorCode, number> = {
  refused: 403,
  'not-found': 404,
  'not-running': 409,
  'rate-limited': 429,
  failed: 502,
  unavailable: 503,
};

const previewBody = z.object({ v: z.literal(1) });

/**
 * The run API (`core/app.ts`) as civitai serves it: civitai's grants, mint refusals, App Assistant's
 * models and Restart preview.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const { previews, ...run } = options;
  return buildRunApp({
    ...run,
    patchRefusal: mintRefusal,
    routes: (api, helpers) => previewRoute(api, helpers, previews),
  });
}

/** A patch whose store could not mint: the client's to fix, so it is refused (403) with these words. */
function mintRefusal(error: unknown): string | undefined {
  if (!(error instanceof MintRefusedError)) return undefined;
  // No grant to write it with (none sent, no run of the chat live): the client's to fix.
  if (error.code === 'invalid_grant')
    return `This chat needs a current run grant in ${GRANT_HEADER} to be changed now.`;
  // The user is refused, or turned the assistant off: the same answer the run would get.
  if (error.code === 'refused' || error.code === 'consent_required') return error.message;
  return undefined;
}

/**
 * The page's Restart preview: opens the app's live preview again with no reply (no model call, no
 * Buzz), after a reload found none live. Answers the block and host shown, never the tunnel's id.
 * Needs a preview grant for this app (`X-Run-Grant`), which civitai signs for the viewer.
 */
function previewRoute(
  api: FastifyInstance,
  { authed, grantFor, refuse }: RunRoutes,
  previews: PreviewRestarts | undefined
): void {
  api.post<{ Params: { app: string } }>(
    '/apps/:app/preview',
    { preHandler: authed },
    async (request, reply) => {
      if (!previewBody.safeParse(request.body ?? { v: 1 }).success)
        return refuse(reply, 'bad-request', 'The restart request is not one this runner reads.');
      if (!previews) return refuse(reply, 'unavailable', 'The live preview is not set up here.');
      const appKey = request.params.app;
      const conversation = previews.grantConversation(appKey);
      if (!conversation) return refuse(reply, 'bad-request', 'That is not an app key.');
      const grant = await grantFor(request, conversation, undefined, true);
      if (!grant)
        return refuse(
          reply,
          'refused',
          `This restart needs a current preview grant for this app in ${GRANT_HEADER}.`
        );
      const outcome = await previews.restart(request.userId, appKey, grant.token, grant.expiresAt);
      if (outcome.ok) return { v: 1, blockId: outcome.blockId, host: outcome.host };
      return reply
        .code(RESTART_STATUS[outcome.error])
        .send({ v: 1, error: outcome.error, message: outcome.message });
    }
  );
}
