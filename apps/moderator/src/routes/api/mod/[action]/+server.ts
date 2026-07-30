import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { modActions } from '$lib/server/mod-actions/registry';

// Ingress the main app POSTs to, delegating a mutation the spoke owns. Auth = shared WEBHOOK_TOKEN (not a
// session cookie; hooks.server.ts bypasses its session guard for `/api/mod/*`). The caller already gated on
// `moderatorProcedure`, so the body's `userId` is trusted here.
export const POST: RequestHandler = async ({ params, request }) => {
  const secret = env.WEBHOOK_TOKEN;
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) throw error(401, 'unauthorized');

  // Object.hasOwn so a params.action of `__proto__`/`constructor` can't resolve to an inherited member.
  if (!Object.hasOwn(modActions, params.action))
    throw error(404, `unknown action: ${params.action}`);
  const action = modActions[params.action];

  const parsed = action.schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw error(400, parsed.error.message);

  try {
    const result = await action.handler(parsed.data);
    return json({ ok: true, result });
  } catch (e) {
    // A handler can reject a request with a 4xx (e.g. a conflicting moderation verdict); pass that status
    // through. Anything else is a genuine server fault → 500.
    const status = (e as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500)
      throw error(status, (e as Error).message);
    throw e;
  }
};
