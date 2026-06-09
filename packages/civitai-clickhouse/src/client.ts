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
    host: config.host,
    username: config.username,
    password: config.password,
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
