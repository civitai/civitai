import { createClickhouseClient, type CustomClickHouseClient } from '@civitai/clickhouse';

// Lazy + cached on globalThis so `vite build` never instantiates it and dev HMR reuses one client (not a
// fresh leak per reload).
const globalForClickhouse = globalThis as unknown as { clickhouse?: CustomClickHouseClient };

export function getClickhouse(): CustomClickHouseClient {
  if (!globalForClickhouse.clickhouse) {
    globalForClickhouse.clickhouse = createClickhouseClient();
  }
  return globalForClickhouse.clickhouse;
}
