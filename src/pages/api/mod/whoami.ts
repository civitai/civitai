import * as z from 'zod';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

/**
 * The diagnostic for "is my moderator access working, and as whom". Deliberately a real
 * `defineModeratorEndpoint`, not a bespoke handler: it exercises the same `resolveActor`, moderator
 * gate, rate limit and audit row every other moderator endpoint runs, so a green answer here means
 * those work — not merely that this file does.
 *
 * GET so it can be opened in a browser tab while signed in. It writes nothing, which is the only
 * reason GET is safe: a browser sends the session cookie on a top-level cross-site GET, so a mutating
 * endpoint must stay POST, where SameSite=Lax withholds it.
 */
export default defineModeratorEndpoint('whoami', {
  method: 'GET',
  summary: 'Report the moderator this request resolved to.',
  returns: '{ id, username, isModerator, permissions, echo }',
  notes: [
    'Reads nothing and writes nothing — safe to hit from a browser to confirm access.',
    'Every call still emits an audit row, so this also proves the audit path is wired.',
  ],
  input: z.object({
    echo: z.string().trim().max(100).optional().describe('Any string; returned unchanged.'),
  }),
  async handler(input, ctx) {
    return {
      id: ctx.actor.id,
      username: ctx.actor.username ?? null,
      isModerator: ctx.actor.isModerator ?? false,
      // Which per-action permissions this account holds — the same list the `privileged` gate checks,
      // so an unexpected 403 elsewhere can be diagnosed from here.
      permissions: ctx.actor.permissions ?? [],
      echo: input.echo ?? null,
    };
  },
});
