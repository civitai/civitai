import { createClickhouseClient, type CustomClickHouseClient } from '@civitai/clickhouse';

// App shim around `@civitai/clickhouse`. The factory reads CLICKHOUSE_* from process.env (the
// vite.config shim bridges .env → process.env). The client is configured with
// `async_insert: 1, wait_for_async_insert: 0`, so per-row inserts are coalesced into batches
// ClickHouse-side — no app-level buffering needed and writes are fire-and-forget.
//
// Lazily constructed (so `vite build`/prerender never instantiates it) and cached on globalThis
// (so dev HMR re-imports reuse one client instead of leaking a new one per reload). In dev the
// client builds with empty config and only fails at query time, so an unconfigured local env
// won't crash the app — visit logging just no-ops.
const globalForClickhouse = globalThis as unknown as { clickhouse?: CustomClickHouseClient };

export function getClickhouse(): CustomClickHouseClient {
  if (!globalForClickhouse.clickhouse) {
    globalForClickhouse.clickhouse = createClickhouseClient();
  }
  return globalForClickhouse.clickhouse;
}
