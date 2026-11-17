import { createTRPCClient, httpLink, type CreateTRPCClient } from '@trpc/client';
import type { AppRouter } from '~/server/routers';
import { clientTransformer } from '~/shared/utils/trpc-union-transformer';
import { pageRouteHeaders } from '~/utils/page-route-header';
import { trpcClientHeaders } from '~/utils/trpc-client-headers';

/**
 * A mutation client whose requests SURVIVE THE PAGE UNLOADING: every request is sent with
 * `fetch(…, { keepalive: true })`, so a send started from `pagehide` / `visibilitychange`
 * (closing or leaving the tab) is not cancelled with the document. Same endpoint, identity
 * headers, transformer and wire format as `~/utils/trpc`'s unbatched link — that link with one
 * extra fetch option — and auth rides the same-origin cookies, as everywhere else.
 *
 * Mutations only: no batching, no edge-cache routing. Keepalive bodies share a ~64 KiB
 * per-page budget, so keep what goes through here small (an approval's input is ~100 bytes).
 * Used by the review page's delayed "Approve & next" (`pendingApprovalQueue`).
 */
export const trpcKeepalive: CreateTRPCClient<AppRouter> = createTRPCClient<AppRouter>({
  links: [
    httpLink({
      transformer: clientTransformer,
      // The same endpoint as `~/utils/trpc`.
      url: '/api/trpc',
      headers: () => ({ ...trpcClientHeaders, ...pageRouteHeaders() }),
      // Read `globalThis.fetch` per call (not captured at module init) so a test can stub it.
      fetch: (input, init) =>
        globalThis.fetch(input, { ...(init as RequestInit), keepalive: true }),
    }),
  ],
});
