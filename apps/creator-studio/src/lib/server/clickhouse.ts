import { createClickhouseClient, type CustomClickHouseClient } from '@civitai/clickhouse';

// App shim around `@civitai/clickhouse`. The factory reads CLICKHOUSE_* from process.env (the vite.config shim
// bridges .env → process.env). Lazily constructed (so `vite build`/prerender never instantiates it) and cached
// on globalThis (so dev HMR re-imports reuse one client rather than leaking one per reload).
const globalForClickhouse = globalThis as unknown as { clickhouse?: CustomClickHouseClient };

export function getClickhouse(): CustomClickHouseClient {
  if (!globalForClickhouse.clickhouse) {
    globalForClickhouse.clickhouse = createClickhouseClient();
  }
  return globalForClickhouse.clickhouse;
}
