import { createBuzzClient } from '@civitai/buzz';

// App shim around `@civitai/buzz`. `createBuzzClient()` reads BUZZ_ENDPOINT from process.env (the vite.config
// shim bridges .env → process.env). Lazily constructed (so `vite build` never resolves the endpoint) and cached
// on globalThis (dev HMR reuse). This is the authoritative source for buzz-account balances (incl. cash) — the
// buzz service, NOT the ClickHouse buzzTransactions mirror.
type BuzzClient = ReturnType<typeof createBuzzClient>;
const g = globalThis as unknown as { buzzClient?: BuzzClient };

export function getBuzz(): BuzzClient {
  if (!g.buzzClient) g.buzzClient = createBuzzClient();
  return g.buzzClient;
}
