import type { DefaultOptions } from '@tanstack/react-query';
import { QueryClient, useQuery } from '@tanstack/react-query';

/**
 * A `trpc` React client whose queries run on a REAL React Query client, for tests that count
 * network requests: seeding (`initialData`), staleness and `enabled` behave as React Query
 * decides, and every request that would reach the server is recorded by procedure path.
 *
 * Use it instead of `makeTrpcProxy` (`test/trpcProxyStub.ts`) when the claim under test is "this
 * page load does / does not issue request X": that stub's hooks are inert spies, so they can say
 * a hook was called but never whether React Query would have fetched.
 *
 * Pass the app's own defaults (`queryClient.getDefaultOptions()` from the real `~/utils/trpc`),
 * never a literal: a test pinned to its own copy of `staleTime`/`refetchOnWindowFocus` cannot see
 * a change to the app's.
 *
 * Keys are `[path, input ?? null]`, not tRPC's own key shape, so a test can speak to React Query
 * semantics but not to tRPC key equality. An unscripted path rejects rather than resolving empty.
 */
export function makeQueryClientTrpcFake(defaultOptions: DefaultOptions) {
  const client = new QueryClient({ defaultOptions });
  const calls: string[] = [];
  const responses: Record<string, () => unknown> = {};

  const hook = (path: string) => ({
    useQuery: (input: unknown, opts: Record<string, unknown> = {}) => {
      const { trpc: _trpc, ...rest } = opts;
      return useQuery(
        {
          queryKey: [path, input ?? null],
          queryFn: async () => {
            calls.push(path);
            const respond = responses[path];
            if (!respond) throw new Error(`no response scripted for ${path}`);
            return respond();
          },
          ...rest,
        },
        client
      );
    },
  });

  const trpc = new Proxy(
    {},
    {
      get: (_r, router) =>
        new Proxy({}, { get: (_p, name) => hook(`${String(router)}.${String(name)}`) }),
    }
  );

  return {
    trpc,
    /** Requests issued so far for `path`. */
    callsTo: (path: string) => calls.filter((p) => p === path).length,
    /** Every request issued so far, in order. */
    calls: () => [...calls],
    /** Replace the scripted responses and forget the cache and the request log. */
    reset(next: Record<string, () => unknown>) {
      calls.length = 0;
      for (const key of Object.keys(responses)) delete responses[key];
      Object.assign(responses, next);
      client.clear();
    },
  };
}

export type QueryClientTrpcFake = ReturnType<typeof makeQueryClientTrpcFake>;
