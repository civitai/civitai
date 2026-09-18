// Base ClickHouse client. The Tracker (request/session/schema-coupled event recorder)
// lives in the app (src/server/clickhouse/tracker.ts), not here.
import type { ClickHouseClient } from '@clickhouse/client';
import { createClient } from '@clickhouse/client';
import dayjs from 'dayjs';
import { loadClickhouseEnv, type ClickhouseConfig } from './env';

export type CustomClickHouseClient = ClickHouseClient & {
  $query: <T extends object>(
    query: TemplateStringsArray | string,
    ...values: any[]
  ) => Promise<T[]>;
  $exec: (query: TemplateStringsArray | string, ...values: any[]) => Promise<void>;
};

export type ClickhouseLogFn = (message: string, ...args: unknown[]) => void;

export type CreateClickhouseClientOptions = Partial<ClickhouseConfig> & {
  /** Debug logger (app-defined). Defaults to a no-op. */
  log?: ClickhouseLogFn;
};

function formatSqlType(value: any): string {
  // Catch any dates being passed in as a string
  if (
    typeof value === 'string' &&
    (value.endsWith('(Coordinated Universal Time)') || /\.\d{3}Z$/.test(value))
  ) {
    value = new Date(value);
  }
  if (value instanceof Date) return "parseDateTimeBestEffort('" + dayjs(value).toISOString() + "')";
  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.map(formatSqlType).join(',');
    if (value === null) return 'null';
    return JSON.stringify(value);
  }

  return value;
}

/**
 * Build the base ClickHouse client. Connection config defaults come from the package
 * env schema (./env, overridable via options); the debug logger is injected. HMR/global
 * caching and the Next build guard live in the app shim. See `~/server/clickhouse/client`.
 */
export function createClickhouseClient(
  options: CreateClickhouseClientOptions = {}
): CustomClickHouseClient {
  const { log: logOption, ...envOverrides } = options;
  const config = { ...loadClickhouseEnv(), ...envOverrides };
  const log: ClickhouseLogFn = logOption ?? (() => {});

  console.log('Creating ClickHouse client');
  const client = createClient({
    url: config.host,
    username: config.username,
    password: config.password,
    // 2.5s is the client default and stays under the server's 10s keep_alive_timeout, so an idle
    // socket is retired before the server closes it out from under the next request.
    //
    // 🔴 `eagerly_destroy_stale_sockets` is NOT a pin — it is a deliberate non-default, and
    // 0.2.x had no equivalent. 0.2.x enforced its TTL at socket ASSIGNMENT and put a 3-attempt
    // retry behind that check; 1.x removed the retry entirely and stamps the clock at RELEASE, so
    // the age it measures excludes the query's own duration and is strictly more permissive. This
    // sweep is the closest 1.x offers, not a restoration: leaving it false would ship less socket
    // protection than production has today, and `false` is no more neutral than `true`. It
    // therefore CONFOUNDS the before/after socket-hangup comparison on ClickUp 868m6uc51, and that
    // is recorded there.
    keep_alive: { enabled: true, idle_socket_ttl: 2500, eagerly_destroy_stale_sockets: true },
    // The three values below are pins: 0.2.x resolved each to exactly this and 1.x resolves it to
    // something else, so setting them keeps the upgrade a transport change and nothing else.
    //
    // 1.x defaults to 10. Prod measures ~4 concurrent connections per pod at the busiest second of
    // the day, so 10 would not bind today — but a request queued behind a full pool gets no timer
    // at all (`socket.setTimeout` is attached only once a socket is assigned), so a bound turns a
    // slow request into a hung one.
    max_open_connections: Infinity,
    // 1.x defaults to 30_000. 0.2.x resolved 300_000 at runtime, which its own JSDoc contradicted
    // (`client-common/dist/client.js` read `config.request_timeout ?? 300000`). Jobs on this client
    // run multi-minute queries with no bound of their own; the hot feed read has its own much
    // tighter one (CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS). Above 60_000 and without
    // `send_progress_in_http_headers`, 1.x warns at construction that a long request_timeout can
    // itself surface as a socket hang up past a load balancer's idle timeout.
    request_timeout: 300_000,
    // 1.x normalizes an unset value to disabled; 0.2.x defaulted it on.
    compression: { response: true },
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
      output_format_json_quote_64bit_integers: 0, // otherwise they come as strings
    },
  }) as CustomClickHouseClient;

  client.$query = async function <T extends object>(
    query: TemplateStringsArray | string,
    ...values: any[]
  ) {
    if (typeof query !== 'string') {
      query = query.reduce((acc, part, i) => acc + part + formatSqlType(values[i] ?? ''), '');
    }

    log('$query', query);

    try {
      const response = await client.query({ query, format: 'JSONEachRow' });
      const data = await response?.json<T>();
      return data;
    } catch (e) {
      const error = e as Error;
      throw new Error(`ClickHouse query failed: ${error.message}\nQuery: ${query}`);
    }
  };

  client.$exec = async function (query: TemplateStringsArray | string, ...values: any[]) {
    if (typeof query !== 'string') {
      query = query.reduce((acc, part, i) => acc + part + formatSqlType(values[i] ?? ''), '');
    }

    log('$exec', query);

    await client.exec({ query });
  };

  return client;
}
