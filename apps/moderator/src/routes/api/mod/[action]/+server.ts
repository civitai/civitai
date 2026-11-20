import { error, json } from '@sveltejs/kit';
import { CASE_ACTIONS, modActionResponse, type ModActionName } from '@civitai/moderation';
import type { RequestHandler } from './$types';
import { WebhookEndpoint } from '$lib/server/webhook-endpoint';
import { modActions } from '$lib/server/mod-actions/registry';

// Ingress the main app POSTs to, delegating a mutation the spoke owns. The token is verified in
// hooks.server.ts ($lib/server/webhook-endpoint). Two credentials reach here, each for its own actions
// only: the general one for the moderation actions (the caller already gated on `moderatorProcedure`, so
// the body's `userId` is trusted), and the scoped intake one for CASE_ACTIONS, which have no acting user.
export const POST: RequestHandler = WebhookEndpoint(
  async ({ params, request, locals }) => {
    const client = locals.tokenClient;
    // Object.hasOwn so a params.action of `__proto__`/`constructor` can't resolve to an inherited member.
    if (!Object.hasOwn(modActions, params.action))
      throw error(404, `unknown action: ${params.action}`);
    if (CASE_ACTIONS.has(params.action as ModActionName) !== (client === 'cases'))
      error(403, 'This credential cannot call this action.');
    const action = modActions[params.action];

    const parsed = action.schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw error(400, parsed.error.message);

    try {
      const result = await action.handler(parsed.data);
      return json(modActionResponse(result));
    } catch (e) {
      // A handler can reject a request with a 4xx (e.g. a conflicting moderation verdict); pass that status
      // through. Anything else is a genuine server fault → 500.
      const status = (e as { status?: number }).status;
      // A refused form comes back with every field's problem, so the page can show them together. The
      // messages are fixed strings; none quotes what was submitted.
      // A refusal worded for the person filing is marked `public`; the page shows it as written.
      const err = e as { fieldErrors?: Record<string, string>; public?: boolean };
      if (err.public && typeof status === 'number' && status >= 400 && status < 500)
        return json(
          { message: (e as Error).message, public: true, fieldErrors: err.fieldErrors },
          { status }
        );
      if (typeof status === 'number' && status >= 400 && status < 500)
        throw error(status, (e as Error).message);
      throw e;
    }
  },
  { alsoCases: true }
);
