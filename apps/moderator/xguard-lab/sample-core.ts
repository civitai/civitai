/**
 * Pull a stratified sample of live prompts from ClickHouse into the lab DB.
 *
 * Stratifies on a label's live XGuard score rather than sampling uniformly. `Young` currently scores
 * >= 0.5 on 81% of all traffic, so a uniform sample is almost entirely high-score rows and tells us
 * nothing about where the boundary actually sits. Equal-sized score bands spend review time where the
 * decision is genuinely in doubt.
 *
 * Read-only against ClickHouse. Writes only to the lab Postgres.
 */
import pg from 'pg';

export type ClickHouseConfig = { host: string; username?: string; password?: string };

export type SampleOptions = {
  connectionString: string;
  batch: string;
  size?: number;
  label?: string;
  bands?: number;
  days?: number;
  /** Supply when the caller reads env some other way than `process.env` (the SvelteKit routes do). */
  clickhouse?: Partial<ClickHouseConfig>;
};

export type SampleSummary = {
  batch: string;
  label: string;
  /** Per-band row counts. A short band is visible here rather than being silently rebalanced away. */
  bands: { lo: number; hi: number; rows: number }[];
  fetched: number;
  unique: number;
  inserted: number;
  /** Already present in this batch — a re-run is idempotent, not additive. */
  duplicates: number;
};

type ChRow = {
  promptHash: string;
  promptCreatedAt: string;
  userId: number;
  positivePrompt: string;
  scores: Record<string, number>;
};

// The label reaches ClickHouse inside a string literal, so anything but a plain identifier is refused
// rather than escaped — this is a parameter an HTTP caller now controls.
const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

async function clickhouse<T>(sql: string, config: ClickHouseConfig): Promise<T[]> {
  const auth = Buffer.from(`${config.username ?? 'default'}:${config.password ?? ''}`).toString(
    'base64'
  );

  const res = await fetch(config.host, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/plain' },
    body: `${sql} FORMAT JSONEachRow`,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.slice(0, 400)}`);
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

export async function sampleBatch(opts: SampleOptions): Promise<SampleSummary> {
  const host = opts.clickhouse?.host ?? process.env.CLICKHOUSE_HOST;
  if (!host) throw new Error('CLICKHOUSE_HOST not set');
  const config: ClickHouseConfig = {
    host,
    username: opts.clickhouse?.username ?? process.env.CLICKHOUSE_USERNAME,
    password: opts.clickhouse?.password ?? process.env.CLICKHOUSE_PASSWORD,
  };

  const label = opts.label ?? 'Young';
  if (!LABEL_PATTERN.test(label)) throw new Error(`invalid label "${label}"`);
  const size = Math.trunc(opts.size ?? 500);
  const bandCount = Math.trunc(opts.bands ?? 5);
  const days = Math.trunc(opts.days ?? 7);
  if (size < 1) throw new Error('size must be at least 1');
  if (bandCount < 1) throw new Error('bands must be at least 1');
  if (days < 1) throw new Error('days must be at least 1');

  const perBand = Math.max(1, Math.floor(size / bandCount));

  // One query per band. Cheaper and clearer than a windowed single query, and it makes a short band
  // obvious instead of silently rebalancing.
  const rows: ChRow[] = [];
  const bands: SampleSummary['bands'] = [];
  for (let b = 0; b < bandCount; b++) {
    const lo = b / bandCount;
    const hi = (b + 1) / bandCount;
    const band = await clickhouse<ChRow>(
      `
      SELECT promptHash, toString(createdAt) AS promptCreatedAt, userId, positivePrompt, scores
      FROM orchestration.xguardPromptResults
      WHERE createdAt >= now() - INTERVAL ${days} DAY
        AND mapContains(scores, '${label}')
        AND scores['${label}'] >= ${lo} AND scores['${label}'] < ${hi}
        AND length(positivePrompt) BETWEEN 10 AND 8000
      ORDER BY cityHash64(promptHash)
      LIMIT ${perBand}
    `,
      config
    );
    bands.push({ lo, hi, rows: band.length });
    rows.push(...band);
  }

  // Same prompt can land in one band only, but guard anyway - a hash colliding across bands would
  // violate the (batch, prompt_hash) unique constraint.
  const seen = new Set<string>();
  const unique = rows.filter((r) => !seen.has(r.promptHash) && seen.add(r.promptHash));

  const client = new pg.Client({ connectionString: opts.connectionString });
  await client.connect();
  try {
    let inserted = 0;
    for (const r of unique) {
      const res = await client.query(
        `INSERT INTO sample
           (prompt_hash, source, batch, user_id, positive_prompt, live_scores, prompt_created_at)
         VALUES ($1, 'xguardPromptResults', $2, $3, $4, $5, $6)
         ON CONFLICT (batch, prompt_hash) DO NOTHING`,
        [
          r.promptHash,
          opts.batch,
          r.userId,
          r.positivePrompt,
          JSON.stringify(r.scores),
          r.promptCreatedAt,
        ]
      );
      inserted += res.rowCount ?? 0;
    }
    return {
      batch: opts.batch,
      label,
      bands,
      fetched: rows.length,
      unique: unique.length,
      inserted,
      duplicates: unique.length - inserted,
    };
  } finally {
    await client.end();
  }
}
