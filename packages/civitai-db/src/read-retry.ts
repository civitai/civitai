// Bounded retry of Prisma READS across a brief database primary failover. For a few seconds the
// pooler refuses new logins and connections already in Prisma's pool are found closed, so without a
// retry every read in that window fails, though the same read a moment later would succeed.
//
// Only a read is retried, and only outside a transaction. A connection can drop after the server
// committed a write but before the reply arrived, so a write is never run twice here.
//
// A read killed by hand (pg_terminate_backend, 57P01) is retried like a switchover's shutdown and
// issued again within the budget; DB_READ_RETRY=off (env.ts) turns the retry off without a release.
//
// No request-scoped abort signal reaches the Prisma call path (no request context carries one), so
// a read keeps retrying within its budget after its client has gone away.
import client from 'prom-client';
import { isRetryableReadError } from './db-errors';

/** Total time (ms), from the first attempt, after which a read is not started again. */
export const READ_RETRY_BUDGET_MS = 5_000;
/** Delay before the first retry (ms); each later one doubles, up to READ_RETRY_MAX_DELAY_MS. */
export const READ_RETRY_BASE_DELAY_MS = 100;
export const READ_RETRY_MAX_DELAY_MS = 1_000;
/**
 * Reads retrying at once, process-wide. Past it, a read that fails is not retried: a failover that
 * fails every read must not hold an unbounded number of them waiting in this process.
 */
export const READ_RETRY_MAX_CONCURRENT = 32;

/** In-flight retrying reads. One per process unless a caller passes its own (tests). */
export type ReadRetrySlots = { inFlight: number };
const processRetrySlots: ReadRetrySlots = { inFlight: 0 };

/** The Prisma model operations that only read. */
export const RETRYABLE_READ_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

// Raw operations that can return rows. A raw statement is retried only when its text is a read
// (isReadOnlySql); `$executeRaw*` never is.
const RAW_QUERY_OPERATIONS: ReadonlySet<string> = new Set(['$queryRaw', '$queryRawUnsafe']);

// A SELECT can still write through a data-modifying CTE or SELECT INTO.
const WRITE_KEYWORD = /\b(?:insert|update|delete|merge|into)\b/i;

// A SELECT can also write through a function it calls (nextval, a lock, any user-defined function),
// so every name followed by `(` must be a keyword or a built-in known not to change data. Anything
// else, a quoted name included, makes the statement unprovable, and it is not retried. Not seen: an
// operator, cast or view backed by a user-defined function that writes.
// prettier-ignore
const PAREN_KEYWORDS = [
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'any', 'all', 'some', 'exists', 'on',
  'join', 'using', 'as', 'over', 'filter', 'within', 'values', 'case', 'when', 'then', 'else',
  'by', 'having', 'lateral', 'union', 'intersect', 'except', 'is', 'distinct', 'between', 'like',
  'ilike', 'array', 'row', 'cast', 'limit', 'offset', 'with', 'recursive', 'interval',
];
// prettier-ignore
const PAREN_TYPES = [
  'varchar', 'char', 'character', 'numeric', 'decimal', 'timestamp', 'timestamptz', 'time',
  'bit', 'varbit',
];
// prettier-ignore
const PURE_FUNCTIONS = [
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'greatest', 'least', 'extract',
  'bool_or', 'bool_and', 'every', 'array_agg', 'string_agg', 'json_agg', 'jsonb_agg',
  'json_object_agg', 'jsonb_object_agg', 'json_build_object', 'jsonb_build_object',
  'json_build_array', 'jsonb_build_array', 'to_json', 'to_jsonb', 'row_to_json',
  'jsonb_array_elements', 'jsonb_array_elements_text', 'json_array_elements', 'jsonb_typeof',
  'jsonb_array_length', 'jsonb_extract_path_text', 'jsonb_strip_nulls', 'array_length',
  'array_remove', 'array_position', 'array_append', 'array_cat', 'array_to_string',
  'string_to_array', 'cardinality', 'unnest', 'generate_series', 'lower', 'upper', 'trim',
  'length', 'char_length', 'substring', 'substr', 'concat', 'concat_ws', 'replace', 'split_part',
  'left', 'right', 'position', 'strpos', 'starts_with', 'regexp_replace', 'regexp_match', 'md5',
  'encode', 'decode', 'round', 'floor', 'ceil', 'ceiling', 'abs', 'sign', 'mod', 'power', 'sqrt',
  'ln', 'log', 'exp', 'now', 'date_trunc', 'date_part', 'to_char', 'to_timestamp', 'to_date',
  'age', 'timezone', 'make_interval', 'row_number', 'rank', 'dense_rank', 'percent_rank', 'lag',
  'lead', 'first_value', 'last_value', 'ntile', 'percentile_cont', 'percentile_disc', 'mode',
  'stddev', 'variance', 'to_tsvector', 'to_tsquery', 'plainto_tsquery', 'websearch_to_tsquery',
  'ts_rank',
];
const ALLOWED_BEFORE_PAREN: ReadonlySet<string> = new Set([
  ...PAREN_KEYWORDS,
  ...PAREN_TYPES,
  ...PURE_FUNCTIONS,
]);
const NAME_BEFORE_PAREN = /("[^"]*"|[a-z_][a-z0-9_$]*)\s*\(/gi;
const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

/**
 * Whether `sql`, as far as its text shows, only reads: it starts with SELECT or WITH, has no
 * data-modifying keyword, and calls no function outside a fixed list of built-ins (the limits of a
 * text check are listed above ALLOWED_BEFORE_PAREN's inputs). Conservative on purpose: a
 * keyword inside a string literal, a column named like one, or an unlisted pure function makes it
 * false, which only means the statement is not retried.
 */
export function isReadOnlySql(sql: string): boolean {
  const body = sql.replace(LEADING_COMMENTS, '');
  if (!/^(?:select|with)\b/i.test(body)) return false;
  // A comment can sit between a function's name and its `(`; past the leading ones, none is read.
  if (body.includes('/*') || body.includes('--')) return false;
  if (WRITE_KEYWORD.test(body)) return false;
  for (const [, name] of body.matchAll(NAME_BEFORE_PAREN))
    if (!ALLOWED_BEFORE_PAREN.has(name.toLowerCase())) return false;
  return true;
}

/** A raw operation's SQL text: `$queryRaw` gets a Sql object, `$queryRawUnsafe` `[text, ...values]`. */
function rawSqlText(args: unknown): string | undefined {
  if (Array.isArray(args)) return typeof args[0] === 'string' ? args[0] : undefined;
  if (!args || typeof args !== 'object') return undefined;
  const { sql, strings } = args as { sql?: unknown; strings?: unknown };
  if (typeof sql === 'string') return sql;
  if (Array.isArray(strings) && strings.every((s) => typeof s === 'string'))
    return strings.join('$0');
  return undefined;
}

/** Whether `operation` (with these `args`) only reads, so running it twice is safe. */
export function isRetryableRead(operation: string, args: unknown): boolean {
  if (RETRYABLE_READ_OPERATIONS.has(operation)) return true;
  if (!RAW_QUERY_OPERATIONS.has(operation)) return false;
  const sql = rawSqlText(args);
  return sql !== undefined && isReadOnlySql(sql);
}

/**
 * `failed`: a retry ran, then the read failed with an error that is not retried. `capped`: the read
 * failed with a retryable error but READ_RETRY_MAX_CONCURRENT reads were already retrying.
 */
export const READ_RETRY_OUTCOMES = ['recovered', 'exhausted', 'failed', 'capped'] as const;
export type ReadRetryOutcome = (typeof READ_RETRY_OUTCOMES)[number];

export type ReadRetryOptions = {
  budgetMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxConcurrentRetries?: number;
  slots?: ReadRetrySlots;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** [0, 1); each delay is scaled by 0.5 + random(), so callers do not retry in step. */
  random?: () => number;
  /** Called once when a retried read settles. A throwing hook is contained. */
  onResult?: (outcome: ReadRetryOutcome, retries: number) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `read`, running it again after a jittered, doubling delay while it fails with a transient
 * connection error (isRetryableReadError) and the next attempt would still start within the
 * budget. A read takes a slot for as long as it is retrying; when every slot is taken it is not
 * retried. Any other error, or the last connection error, is thrown as is.
 */
export async function retryRead<T>(
  read: () => Promise<T>,
  opts: ReadRetryOptions = {}
): Promise<T> {
  const budgetMs = opts.budgetMs ?? READ_RETRY_BUDGET_MS;
  const baseDelayMs = Math.max(1, opts.baseDelayMs ?? READ_RETRY_BASE_DELAY_MS);
  const maxDelayMs = opts.maxDelayMs ?? READ_RETRY_MAX_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const maxConcurrent = opts.maxConcurrentRetries ?? READ_RETRY_MAX_CONCURRENT;
  const slots = opts.slots ?? processRetrySlots;
  const report = (outcome: ReadRetryOutcome, retries: number) => {
    if (retries === 0 && outcome !== 'capped') return;
    try {
      opts.onResult?.(outcome, retries);
    } catch {
      // A broken hook must not change what the caller gets.
    }
  };

  const startedAt = now();
  let holdsSlot = false;
  try {
    for (let retries = 0; ; retries++) {
      try {
        const value = await read();
        report('recovered', retries);
        return value;
      } catch (err) {
        if (!isRetryableReadError(err)) {
          report('failed', retries);
          throw err;
        }
        if (!holdsSlot) {
          if (slots.inFlight >= maxConcurrent) {
            report('capped', retries);
            throw err;
          }
          slots.inFlight++;
          holdsSlot = true;
        }
        const delay = Math.round(
          Math.min(maxDelayMs, baseDelayMs * 2 ** retries) * (0.5 + random())
        );
        if (now() - startedAt + delay > budgetMs) {
          report('exhausted', retries);
          throw err;
        }
        await sleep(delay);
      }
    }
  } finally {
    if (holdsSlot) slots.inFlight--;
  }
}

/** What Prisma passes a query extension's `$allOperations`. `__internalParams` is not in its types. */
export type QueryHookParams = {
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
  __internalParams?: { transaction?: unknown };
};

/**
 * The `$allOperations` hook: a read outside a transaction goes through retryRead, anything else
 * straight to `query`. Prisma sets `__internalParams.transaction` for an interactive and a batch
 * `$transaction`; a retry there would re-run one statement of a transaction the failure already
 * ended. Should a Prisma upgrade stop passing `__internalParams`, nothing is retried.
 */
export function readRetryHook(opts: ReadRetryOptions = {}) {
  return function retryReadOperation({
    operation,
    args,
    query,
    __internalParams,
  }: QueryHookParams) {
    const outsideTransaction = !!__internalParams && __internalParams.transaction === undefined;
    if (!outsideTransaction || !isRetryableRead(operation, args)) return query(args);
    return retryRead(() => query(args), opts);
  };
}

export const PRISMA_READ_RETRY_COUNTER_NAME = 'prisma_read_retry_total';
type ReadRetryCounter = client.Counter<'target' | 'outcome'>;

// Lazy, and reused on HMR re-registration (prom-client throws on a duplicate name).
let readRetryCounter: ReadRetryCounter | undefined;
function getReadRetryCounter(): ReadRetryCounter {
  if (readRetryCounter) return readRetryCounter;
  try {
    readRetryCounter = new client.Counter({
      name: PRISMA_READ_RETRY_COUNTER_NAME,
      help: 'Prisma reads retried after a transient connection error, by client and how they ended',
      labelNames: ['target', 'outcome'] as const,
    });
    // Every series from the start at 0, so a first retry reads as an increase, not a new series.
    for (const target of ['read', 'write'] as const)
      for (const outcome of READ_RETRY_OUTCOMES) readRetryCounter.inc({ target, outcome }, 0);
  } catch {
    readRetryCounter = client.register.getSingleMetric(
      PRISMA_READ_RETRY_COUNTER_NAME
    ) as ReadRetryCounter;
  }
  return readRetryCounter;
}

type ExtendableClient = { $extends: (extension: never) => unknown };

/**
 * `prisma` with reads retried across a brief failover (readRetryHook). Each retried read is counted
 * in PRISMA_READ_RETRY_COUNTER_NAME by `target` and outcome.
 *
 * The budget is per read, not per request: there is no request-wide cap, so a request that makes N
 * reads during a failover can wait up to N budgets before its last one fails, and a caller that
 * catches a failed read has already waited out that read's budget. The process-wide cap on reads
 * retrying at once (READ_RETRY_MAX_CONCURRENT) bounds how many wait.
 */
export function withReadRetry<C extends ExtendableClient>(
  prisma: C,
  target: 'read' | 'write',
  opts: ReadRetryOptions = {}
): C {
  // Created here, not at the first retry, so the series exist at 0 before a failover.
  const counter = opts.onResult ? undefined : getReadRetryCounter();
  const onResult =
    opts.onResult ?? ((outcome: ReadRetryOutcome) => counter?.inc({ target, outcome }));
  const extension = {
    name: 'read-retry',
    query: { $allOperations: readRetryHook({ ...opts, onResult }) },
  };
  // `as C`: a query-only extension adds no methods or result fields, so the extended client has the
  // same API; its own type (DynamicClientExtensionThis) would change PrismaClients for every caller.
  return prisma.$extends(extension as never) as C;
}
