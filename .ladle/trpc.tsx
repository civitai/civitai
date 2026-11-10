import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError, createTRPCClient, type TRPCLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import { observable } from '@trpc/server/observable';
import { useState, type ReactNode } from 'react';
import type { AppRouter } from '~/server/routers';

/**
 * Procedure path (`'orchestrator.getVideoMetadata'`) → its output, or a function of the input
 * that returns it. A function that throws makes the query/mutation fail with that message.
 */
export type StoryTRPCMocks = Record<string, unknown>;

/**
 * `createTRPCNext` (the app's `trpc`) and `createTRPCReact` read the same default tRPC context,
 * so this Provider satisfies every `trpc.*.useQuery` / `useMutation` / `useUtils` in `src/`
 * without going through `withTRPC`, whose links would call `/api/trpc` on the Ladle server.
 */
const { Provider: TRPCProvider } = createTRPCReact<AppRouter>();

/** Answers mocked paths; every other operation never emits, so it stays pending without a request. */
function mockLink(mocks: StoryTRPCMocks): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        if (!(op.path in mocks)) return;
        try {
          const mock = mocks[op.path];
          const data = typeof mock === 'function' ? mock(op.input) : mock;
          observer.next({ result: { type: 'data', data } });
          observer.complete();
        } catch (error) {
          observer.error(TRPCClientError.from(error as Error));
        }
      });
}

/**
 * The global Ladle provider mounts this with no mocks, so tRPC-using components render instead of
 * throwing "Unable to find tRPC Context". A story that needs data wraps itself in another one.
 */
export function StoryTRPCProvider({
  mocks = {},
  children,
}: {
  mocks?: StoryTRPCMocks;
  children: ReactNode;
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [client] = useState(() => createTRPCClient<AppRouter>({ links: [mockLink(mocks)] }));

  return (
    <TRPCProvider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TRPCProvider>
  );
}
