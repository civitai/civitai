import { fail, type RequestEvent } from '@sveltejs/kit';
import { GENERATOR_RESTRICTIONS_PATH, GENERATOR_RESTRICTION_TYPES } from '$lib/restriction-types';
import { NOT_PERMITTED, checkTicketTarget, type TicketActionDeps } from './panel-write';
import { ruleTicketRestriction, type RestrictionRulingDeps } from './restriction-ruling';

export type GeneratorWriteDeps = TicketActionDeps &
  RestrictionRulingDeps & {
    /** The viewer's grant on a page, checked as the page's own action is. */
    canAct: (user: App.Locals['user'], path: string) => boolean;
  };

/**
 * 🔴 GATED AS THE GENERATOR RESTRICTIONS PAGE'S OWN `resolve` IS: its page grant and nothing more (that
 * page's `resolve` carries no `requiresGrant`; only its `ban` does), on the page's own path, and only for
 * the types that page's queue holds. The restriction ruled on is the ticket user's own and still Pending.
 */
export function createTicketGeneratorActions(deps: GeneratorWriteDeps) {
  return {
    generatorResolveRestriction: async (event: RequestEvent) => {
      if (!deps.canAct(event.locals.user, GENERATOR_RESTRICTIONS_PATH))
        return fail(403, { error: NOT_PERMITTED });
      const ok = await checkTicketTarget(deps.linkedUser, event);
      if (ok.refused) return ok.refused;
      return ruleTicketRestriction(deps, event, ok, GENERATOR_RESTRICTION_TYPES);
    },
  };
}
