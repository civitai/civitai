import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A grant that came with the request being served (a patch), for the conversation store to act with
 * when no run of that conversation holds one. In memory for that request only.
 */
const requestGrant = new AsyncLocalStorage<{
  userId: string;
  conversationId: string;
  token: string;
}>();

export function withRequestGrant<T>(
  grant: { userId: string; conversationId: string; token: string } | undefined,
  fn: () => Promise<T>
): Promise<T> {
  return grant ? requestGrant.run(grant, fn) : fn();
}

/** The grant the request being served carried, when it is for this user's conversation. */
export function requestGrantFor(userId: string, conversationId: string): string | undefined {
  const own = requestGrant.getStore();
  return own && own.userId === userId && own.conversationId === conversationId
    ? own.token
    : undefined;
}
