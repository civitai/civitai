# @civitai/clickhouse

ClickHouse client for Civitai apps — analytics/event/metrics queries. Wraps `@clickhouse/client` with a
tagged-template `$query` helper and the standard connection/settings config.

## Add to an app

```jsonc
// package.json
"@civitai/clickhouse": "workspace:*"
```

Transpile (raw TS): Next `transpilePackages: ['@civitai/clickhouse']`, Vite `ssr.noExternal: ['@civitai/clickhouse']`.

## Env

| Var | Req | Notes |
|---|---|---|
| `CLICKHOUSE_HOST` | prod only | required in prod (`NODE_ENV=production`), optional in dev |
| `CLICKHOUSE_USERNAME` | prod only | |
| `CLICKHOUSE_PASSWORD` | prod only | |

In dev the client builds with empty config (queries fail at call time, not import time), so an app that
only sometimes hits ClickHouse won't crash on boot.

## Use

```ts
import { createClickhouseClient } from '@civitai/clickhouse';

const clickhouse = createClickhouseClient();
const rows = await clickhouse.$query<{ count: number }>`
  SELECT count() AS count FROM events WHERE type = ${eventType}
`;
```

`$query` interpolates values with ClickHouse-safe formatting. Override connection per-call via
`createClickhouseClient({ host, username, password, log })`.

## Gotchas

- 64-bit integers are returned as numbers (`output_format_json_quote_64bit_integers: 0`), not strings.
- Async inserts are enabled (`async_insert: 1, wait_for_async_insert: 0`) — writes are fire-and-forget.
- HMR/global caching + the Next build guard belong in the app shim that calls the factory.
