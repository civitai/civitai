import * as React from 'react';
import { vi } from 'vitest';

/**
 * A wrapper giving a render test the real tRPC client, over an API that answers every query with
 * an empty list. A component that reads from the API then renders as it would for an entity
 * nothing else refers to, without mocking it. Stubs `fetch`, the network boundary.
 */
export async function emptyApiTrpcWrapper() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const calls = new URL(url, 'http://localhost').pathname.split('/').pop()!.split(',');
      return new Response(JSON.stringify(calls.map(() => ({ result: { data: { json: [] } } }))), {
        headers: { 'content-type': 'application/json' },
      });
    })
  );
  const { trpc } = await import('~/utils/trpc');
  return trpc.withTRPC(({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children)
  ) as unknown as React.ComponentType<{ children?: React.ReactNode }>;
}
