import { env } from '~/env/server';

/**
 * The caller a model-version lookup is answered as. An account listed in
 * ORCHESTRATOR_LOOKUP_USER_IDS looks versions up on behalf of others, so it is answered as an
 * anonymous caller: public resources only, and no model counts as its own.
 */
export function lookupViewer<T extends { id: number }>(user: T | undefined): T | undefined {
  return user && env.ORCHESTRATOR_LOOKUP_USER_IDS.includes(user.id) ? undefined : user;
}
