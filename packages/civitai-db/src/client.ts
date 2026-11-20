// Prisma read/write client factory. The generated client + types come from the
// @civitai/db-schema contract package, never @prisma/client directly.
import type { Prisma } from '@civitai/db-schema';
import { PrismaClient } from '@civitai/db-schema';
import { loadDbEnv, type DbConfig } from './env';

export type PrismaClients = { dbRead: PrismaClient; dbWrite: PrismaClient };

/** A statement carrying this comment is logged without its values. */
export const REDACT_LOG_MARKER = '/* log:redact */';

/**
 * A query event as it may be logged: its params filled in, so it can be copied and run. A statement
 * carrying REDACT_LOG_MARKER keeps only its text before VALUES, since it holds values inline.
 */
export function loggableQuery(e: { query: string; params: string }): string {
  if (e.query.includes(REDACT_LOG_MARKER)) {
    const at = e.query.search(/\bVALUES\b/i);
    return at < 0 ? `${REDACT_LOG_MARKER} <redacted>` : `${e.query.slice(0, at)}VALUES <redacted>`;
  }
  let query = e.query;
  const params = JSON.parse(e.params);
  // Replace $X variables with params in query so it's possible to copy/paste and optimize
  for (let i = 0; i < params.length; i++) {
    // Negative lookahead for no more numbers, ie. replace $1 in '$1' but not '$11'
    const re = new RegExp('\\$' + ((i as number) + 1) + '(?!\\d)', 'g');
    // If string, will quote - if bool or numeric, will not - does the job here
    if (typeof params[i] === 'string') params[i] = "'" + params[i].replace(/'/g, "\\'") + "'";
    query = query.replace(re, params[i]);
  }
  return query;
}

/**
 * The levels whose lines reach `onLog`. info and query are printed only: a debug query log is one
 * line per statement.
 */
export const FORWARDED_PRISMA_LOG_LEVELS = ['error', 'warn'] as const;
export type ForwardedPrismaLogLevel = (typeof FORWARDED_PRISMA_LOG_LEVELS)[number];

export type PrismaLogLine = { level: ForwardedPrismaLogLevel; line: string };

export type CreatePrismaClientsOptions = Partial<DbConfig> & {
  /** Structured slow-query telemetry (the old logToAxiom call). Injected by the app. */
  onSlowQuery?: (e: { query: string; duration: number; target: 'read' | 'write' }) => void;
  /** Receives each printed `prisma:error` / `prisma:warn` line after it is written to stdout. */
  onLog?: (e: PrismaLogLine) => void;
  /** Writes every line this factory prints. Defaults to `console.log`. */
  print?: PrintLine;
};

export type PrintLine = (...args: unknown[]) => void;

// Looked up per call, not captured, so a console replaced after the clients are built still applies.
const consoleLog: PrintLine = (...args) => console.log(...args);

/**
 * The client `log` definitions for a LOGGING list, and the levels to print. Every level is
 * `emit: 'event'` so the app can forward the line as well as print it.
 */
export function prismaLogConfig(logging: string[]): {
  log: Prisma.LogDefinition[];
  printed: Prisma.LogLevel[];
} {
  const printed = new Set(
    logging
      .filter((x) => x.startsWith('prisma:'))
      .map((x) => x.replace('prisma:', '') as Prisma.LogLevel)
  );
  const slow = logging.some((x) => x.includes('prisma-slow'));
  if (slow) printed.delete('query');
  const levels = new Set(printed);
  if (slow) levels.add('query');
  return {
    log: [...levels].map((level) => ({ emit: 'event' as const, level })),
    printed: [...printed],
  };
}

/**
 * The handler for one printed level: the line Prisma's own `emit: 'stdout'` writes (without its
 * terminal-only colour), then `onLog` for a forwarded level. A throwing `onLog` is contained.
 */
export function prismaLogPrinter(
  level: Prisma.LogLevel,
  onLog?: (e: PrismaLogLine) => void,
  print: PrintLine = consoleLog
) {
  const tag = `prisma:${level}`;
  const forward = isForwardedLevel(level) ? onLog : undefined;
  return function printPrismaLog(e: { message?: string; query?: string }) {
    const text = e.message || e.query;
    print(tag, text);
    if (!forward) return;
    try {
      forward({ level: level as ForwardedPrismaLogLevel, line: `${tag} ${text}` });
    } catch {}
  };
}

function isForwardedLevel(level: Prisma.LogLevel): level is ForwardedPrismaLogLevel {
  return (FORWARDED_PRISMA_LOG_LEVELS as readonly string[]).includes(level);
}

/** The handler for a client's query events: logs a statement slower than 2 s, as `loggableQuery`. */
export function slowQueryLogger({
  target,
  isProd,
  onSlowQuery,
  print = consoleLog,
}: {
  target: 'write' | 'read';
  isProd: boolean;
  onSlowQuery: CreatePrismaClientsOptions['onSlowQuery'];
  print?: PrintLine;
}) {
  return async function logQuery(e: { query: string; params: string; duration: number }) {
    if (e.duration < 2000) return;
    const query = loggableQuery(e);

    if (!isProd) print(query);
    else onSlowQuery?.({ query, duration: e.duration, target });
  };
}

/**
 * Build the Prisma read/write clients. Connection config defaults come from the
 * package env schema (./env, overridable via options); app behavior (logger, slow-query
 * sink) is injected. HMR/global caching and the Next build guard live in the app shim
 * that calls this. See the `~/server/db/client` shim.
 */
export function createPrismaClients(options: CreatePrismaClientsOptions = {}): PrismaClients {
  const { onSlowQuery, onLog, print = consoleLog, ...envOverrides } = options;
  const config = { ...loadDbEnv(), ...envOverrides };

  const singleClient = config.replicaUrl === config.databaseUrl;

  const logFor = (target: 'write' | 'read') =>
    slowQueryLogger({ target, isProd: config.isProd, onSlowQuery, print });

  const logConfig = prismaLogConfig(config.logging);

  const createPrismaClient = ({ readonly }: { readonly: boolean }): PrismaClient => {
    const dbUrl = readonly ? config.replicaUrl : config.databaseUrl;
    const clientOptions = {
      log: logConfig.log,
      datasources: { db: { url: dbUrl } },
      // A legacy billing pointer no client may see. Runtime only: the types still list the field,
      // because typing the clients with this omit runs `tsc` out of memory. Read it with an explicit
      // `omit: { subscriptionId: false }` or `select`.
      omit: { user: { subscriptionId: true } },
    } as Prisma.PrismaClientOptions;
    const prisma = new PrismaClient(clientOptions);
    for (const level of logConfig.printed) {
      // @ts-ignore - necessary to get the log event
      prisma.$on(level, prismaLogPrinter(level, onLog, print));
    }

    // use with prisma-slow,prisma-showparams
    if (config.logging.some((x) => x === 'prisma-showparams')) {
      // @ts-ignore
      prisma.$on('query', async (e: { query: string; params: string; duration: number }) => {
        print(loggableQuery(e));
      });
    }
    return prisma;
  };

  const dbWrite = createPrismaClient({ readonly: false });
  const dbRead = singleClient ? dbWrite : createPrismaClient({ readonly: true });

  if (config.logging.includes('prisma-slow-write'))
    // @ts-ignore - necessary to get the query event
    dbWrite.$on('query', logFor('write'));
  if (config.logging.includes('prisma-slow-read'))
    // @ts-ignore - necessary to get the query event
    dbRead.$on('query', logFor('read'));

  return { dbRead, dbWrite };
}
