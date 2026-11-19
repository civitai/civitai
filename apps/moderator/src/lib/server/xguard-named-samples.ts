import type { Kysely } from 'kysely';
import type { LabDB } from './xguard-lab';

export const MAX_NAMED_SAMPLES = 500;
export const MAX_REFUSED_DAYS = 31;

/** An Int64 written the way ClickHouse's toString writes it, so a found row matches its request. */
export const INT64_PATTERN = /^(0|-?[1-9]\d{0,18})$/;
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type NamedSampleRequest = {
  batch: string;
  /** `promptHash` values from `orchestration.xguardPromptResults`. */
  generated?: string[];
  /** Refused prompts, keyed by `REFUSED_PROMPT_HASH_SQL` and the day they were refused. */
  refused?: { hash: string; date: string }[];
  /** Review without hints: no scores, owner, date or origin on the rows, in a seeded shuffled order. */
  blind?: { seed: number };
};

export type NamedSampleSummary = {
  batch: string;
  requested: number;
  inserted: number;
  duplicates: number;
  missing: { generated: string[]; refused: string[] };
};

export type NamedSampleDeps = {
  query: <T>(sql: string) => Promise<T[]>;
  db: Kysely<LabDB>;
};

/** The caller's mistake, as opposed to ClickHouse or the database failing. */
export class NamedSampleInputError extends Error {}

/**
 * `prohibitedRequests` has no prompt key, so a refused prompt is named by this hash of its text. A
 * caller choosing rows must compute it with this same expression.
 */
export const REFUSED_PROMPT_HASH_SQL =
  "reinterpretAsInt64(cityHash64(prompt, ifNull(negativePrompt, '')))";

const BLIND_SOURCE = 'named';

type ChRow = {
  promptHash: string;
  promptCreatedAt: string;
  userId: number | null;
  positivePrompt: string;
  negativePrompt: string | null;
  scores?: Record<string, number>;
};

// Values reach ClickHouse inside the SQL text, so anything not shaped like a hash or a day is refused
// rather than escaped.
function validate(req: NamedSampleRequest) {
  const fail = (message: string) => {
    throw new NamedSampleInputError(message);
  };
  if (req.blind && !Number.isSafeInteger(req.blind.seed)) fail('blind.seed must be an integer');
  const generated = [...new Set(req.generated ?? [])];
  const refused = [...new Set((req.refused ?? []).map((r) => r.hash))];
  if (generated.length + refused.length > MAX_NAMED_SAMPLES) {
    fail(`at most ${MAX_NAMED_SAMPLES} samples per call`);
  }
  for (const hash of generated) if (!INT64_PATTERN.test(hash)) fail(`invalid hash "${hash}"`);
  for (const { hash, date } of req.refused ?? []) {
    if (!INT64_PATTERN.test(hash)) fail(`invalid hash "${hash}"`);
    if (!DAY_PATTERN.test(date)) fail(`invalid date "${date}"`);
  }
  // A hash given with several days is looked up on all of them.
  const days = [...new Set((req.refused ?? []).map((r) => r.date))];
  if (days.length > MAX_REFUSED_DAYS) fail(`at most ${MAX_REFUSED_DAYS} distinct days per call`);
  return { generated, refused, days };
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function buildNamedSampleQueries(generated: string[], refused: string[], days: string[]) {
  return {
    // argMin keeps every column from the earliest row, so scores and owner match the date.
    generated: generated.length
      ? `
          SELECT toString(promptHash) AS promptHash, toString(min(createdAt)) AS promptCreatedAt,
                 argMin(userId, createdAt) AS userId, argMin(positivePrompt, createdAt) AS positivePrompt,
                 argMin(negativePrompt, createdAt) AS negativePrompt, argMin(scores, createdAt) AS scores
          FROM orchestration.xguardPromptResults
          WHERE promptHash IN (${generated.join(',')})
          GROUP BY promptHash`
      : null,
    // The filter runs in a subquery: an outer alias named like a column would be substituted into
    // the hash expression in WHERE.
    refused: refused.length
      ? `
          SELECT toString(h) AS promptHash, toString(min(time)) AS promptCreatedAt,
                 argMin(userId, time) AS userId, any(p) AS positivePrompt, any(n) AS negativePrompt
          FROM (
            SELECT ${REFUSED_PROMPT_HASH_SQL} AS h, time, userId, prompt AS p,
                   ifNull(negativePrompt, '') AS n
            FROM default.prohibitedRequests
            WHERE createdDate IN (${days.map((d) => `'${d}'`).join(',')})
              AND ${REFUSED_PROMPT_HASH_SQL} IN (${refused.join(',')})
          )
          GROUP BY h`
      : null,
  };
}

// A blind batch is loaded in one call into an empty batch: the shuffle covers one call only, and
// ON CONFLICT keeps an existing row, so a second load would leave its rows in a revealing order or
// mix plain rows in. A plain load into a blind batch is refused for the same reason.
async function assertBatchMode(db: Kysely<LabDB>, batch: string, blind: boolean) {
  let clash = db.selectFrom('sample').select('id').where('batch', '=', batch);
  if (!blind) clash = clash.where('source', '=', BLIND_SOURCE);
  if (await clash.limit(1).executeTakeFirst()) {
    throw new NamedSampleInputError(
      blind
        ? `batch "${batch}" is not empty; a blind batch is loaded in one call`
        : `batch "${batch}" is blind; it takes no further rows`
    );
  }
}

export async function importNamedSamples(
  req: NamedSampleRequest,
  { query, db }: NamedSampleDeps
): Promise<NamedSampleSummary> {
  const { generated, refused, days } = validate(req);
  const blind = req.blind;
  // The lab schema enforces the batch mode on every insert; this check answers early, with a 400.
  await assertBatchMode(db, req.batch, !!blind);

  const queries = buildNamedSampleQueries(generated, refused, days);
  const [generatedRows, refusedRows] = await Promise.all([
    queries.generated ? query<ChRow>(queries.generated) : [],
    queries.refused ? query<ChRow>(queries.refused) : [],
  ]);

  const toRow = (r: ChRow, source: string) => ({
    prompt_hash: r.promptHash,
    source: blind ? BLIND_SOURCE : source,
    batch: req.batch,
    user_id: blind ? null : r.userId ?? null,
    positive_prompt: r.positivePrompt,
    negative_prompt: r.negativePrompt || null,
    live_scores: blind ? null : r.scores ?? null,
    prompt_created_at: blind ? null : new Date(`${r.promptCreatedAt.replace(' ', 'T')}Z`),
  });
  const rows = [
    ...generatedRows.map((r) => toRow(r, 'xguardPromptResults')),
    ...refusedRows.map((r) => toRow(r, 'prohibitedRequests')),
  ];
  // The review queue orders by sample id within each AI verdict; unshuffled, ids would group by origin.
  const values = blind ? seededShuffle(rows, blind.seed) : rows;

  let inserted = 0;
  if (values.length) {
    const result = await db
      .insertInto('sample')
      .values(values)
      .onConflict((oc) => oc.columns(['batch', 'prompt_hash']).doNothing())
      .executeTakeFirst();
    inserted = Number(result.numInsertedOrUpdatedRows ?? 0);
  }

  const found = (rows: ChRow[]) => new Set(rows.map((r) => r.promptHash));
  const foundGenerated = found(generatedRows);
  const foundRefused = found(refusedRows);
  return {
    batch: req.batch,
    requested: generated.length + refused.length,
    inserted,
    duplicates: values.length - inserted,
    missing: {
      generated: generated.filter((h) => !foundGenerated.has(h)),
      refused: refused.filter((h) => !foundRefused.has(h)),
    },
  };
}

/** The lab's ClickHouse connection for this path: read-only and time-boxed, since its SQL is built from caller input. */
export function namedSampleClickhouseConfig(env: {
  host?: string;
  username?: string;
  password?: string;
}) {
  if (!env.host) throw new Error('CLICKHOUSE_HOST not set');
  const url = new URL(env.host);
  url.searchParams.set('readonly', '2');
  url.searchParams.set('max_execution_time', '30');
  return { host: url.toString(), username: env.username, password: env.password };
}
