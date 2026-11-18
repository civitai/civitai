import type { Kysely } from 'kysely';
import type { LabDB } from './xguard-lab';

export const MAX_NAMED_SAMPLES = 500;

export type NamedSampleRequest = {
  batch: string;
  /** `promptHash` values from `orchestration.xguardPromptResults`. */
  generated?: string[];
  /** Refused prompts, keyed by `refusedPromptHash` and the day they were refused. */
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

/**
 * `prohibitedRequests` has no prompt key, so a refused prompt is named by this hash of its text. A
 * caller choosing rows must compute it with this same expression.
 */
export const REFUSED_PROMPT_HASH_SQL =
  "reinterpretAsInt64(cityHash64(prompt, ifNull(negativePrompt, '')))";

const INT64 = /^-?\d{1,20}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

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
  if (req.blind && !Number.isSafeInteger(req.blind.seed))
    throw new Error('blind.seed must be an integer');
  const generated = req.generated ?? [];
  const refused = req.refused ?? [];
  if (generated.length + refused.length > MAX_NAMED_SAMPLES) {
    throw new Error(`at most ${MAX_NAMED_SAMPLES} samples per call`);
  }
  for (const hash of generated) if (!INT64.test(hash)) throw new Error(`invalid hash "${hash}"`);
  for (const { hash, date } of refused) {
    if (!INT64.test(hash)) throw new Error(`invalid hash "${hash}"`);
    if (!DAY.test(date)) throw new Error(`invalid date "${date}"`);
  }
  return { generated, refused };
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

export async function importNamedSamples(
  req: NamedSampleRequest,
  { query, db }: NamedSampleDeps
): Promise<NamedSampleSummary> {
  const { generated, refused } = validate(req);

  const [generatedRows, refusedRows] = await Promise.all([
    generated.length
      ? query<ChRow>(`
          SELECT toString(promptHash) AS promptHash, toString(min(createdAt)) AS promptCreatedAt,
                 any(userId) AS userId, any(positivePrompt) AS positivePrompt,
                 any(negativePrompt) AS negativePrompt, any(scores) AS scores
          FROM orchestration.xguardPromptResults
          WHERE promptHash IN (${generated.join(',')})
          GROUP BY promptHash`)
      : [],
    refused.length
      ? query<ChRow>(`
          SELECT toString(${REFUSED_PROMPT_HASH_SQL}) AS promptHash, toString(min(time)) AS promptCreatedAt,
                 any(userId) AS userId, prompt AS positivePrompt, ifNull(negativePrompt, '') AS negativePrompt
          FROM default.prohibitedRequests
          WHERE createdDate IN (${[...new Set(refused.map((r) => `'${r.date}'`))].join(',')})
            AND ${REFUSED_PROMPT_HASH_SQL} IN (${refused.map((r) => r.hash).join(',')})
          GROUP BY prompt, negativePrompt`)
      : [],
  ]);

  const blind = req.blind;
  const toRow = (r: ChRow, source: string) => ({
    prompt_hash: r.promptHash,
    source: blind ? 'named' : source,
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
  // Review order follows insertion order (sample id), which would otherwise group rows by origin.
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
      refused: refused.map((r) => r.hash).filter((h) => !foundRefused.has(h)),
    },
  };
}
