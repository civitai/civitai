import type { Kysely } from 'kysely';
import type { LabDB } from './xguard-lab';

export const MAX_NAMED_SAMPLES = 500;

export type NamedSampleRequest = {
  batch: string;
  /** `promptHash` values from `orchestration.xguardPromptResults`. */
  generated?: string[];
  /** Refused prompts, keyed by `refusedPromptHash` and the day they were refused. */
  refused?: { hash: string; date: string }[];
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

  const toRow = (r: ChRow, source: string) => ({
    prompt_hash: r.promptHash,
    source,
    batch: req.batch,
    user_id: r.userId ?? null,
    positive_prompt: r.positivePrompt,
    negative_prompt: r.negativePrompt || null,
    live_scores: r.scores ?? null,
    prompt_created_at: new Date(`${r.promptCreatedAt.replace(' ', 'T')}Z`),
  });
  const values = [
    ...generatedRows.map((r) => toRow(r, 'xguardPromptResults')),
    ...refusedRows.map((r) => toRow(r, 'prohibitedRequests')),
  ];

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
