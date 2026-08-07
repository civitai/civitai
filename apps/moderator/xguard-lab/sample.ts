/**
 * Pull a stratified sample of live prompts from ClickHouse into the lab DB.
 *
 *   pnpm exec tsx --env-file=.env apps/moderator/xguard-lab/sample.ts \
 *     --batch 2026-08-04-age --size 500
 *
 * Stratifies on a label's live XGuard score rather than sampling uniformly.
 * `Young` currently scores >= 0.5 on 81% of all traffic, so a uniform sample is
 * almost entirely high-score rows and tells us nothing about where the boundary
 * actually sits. Equal-sized score bands spend review time where the decision
 * is genuinely in doubt.
 *
 * Read-only against ClickHouse. Writes only to the lab Postgres.
 */
import pg from 'pg';

type Args = {
  batch: string;
  size: number;
  label: string;
  bands: number;
  days: number;
  labDb: string;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const batch = get('--batch');
  if (!batch) throw new Error('--batch is required (e.g. --batch 2026-08-04-age)');
  return {
    batch,
    size: Number(get('--size') ?? 500),
    label: get('--label') ?? 'Young',
    bands: Number(get('--bands') ?? 5),
    days: Number(get('--days') ?? 7),
    labDb:
      get('--lab-db') ??
      process.env.MODERATOR_DATABASE_URL ??
      'postgres://xguard:xguard@localhost:5433/xguard_lab',
  };
}

type ChRow = {
  promptHash: string;
  promptCreatedAt: string;
  userId: number;
  positivePrompt: string;
  scores: Record<string, number>;
};

async function clickhouse<T>(sql: string): Promise<T[]> {
  const host = process.env.CLICKHOUSE_HOST;
  if (!host) throw new Error('CLICKHOUSE_HOST not set');
  const auth = Buffer.from(
    `${process.env.CLICKHOUSE_USERNAME ?? 'default'}:${process.env.CLICKHOUSE_PASSWORD ?? ''}`
  ).toString('base64');

  const res = await fetch(host, {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const perBand = Math.max(1, Math.floor(args.size / args.bands));

  // One query per band. Cheaper and clearer than a windowed single query, and it
  // makes a short band obvious instead of silently rebalancing.
  const rows: ChRow[] = [];
  for (let b = 0; b < args.bands; b++) {
    const lo = b / args.bands;
    const hi = (b + 1) / args.bands;
    const band = await clickhouse<ChRow>(`
      SELECT promptHash, toString(createdAt) AS promptCreatedAt, userId, positivePrompt, scores
      FROM orchestration.xguardPromptResults
      WHERE createdAt >= now() - INTERVAL ${args.days} DAY
        AND mapContains(scores, '${args.label}')
        AND scores['${args.label}'] >= ${lo} AND scores['${args.label}'] < ${hi}
        AND length(positivePrompt) BETWEEN 10 AND 8000
      ORDER BY cityHash64(promptHash)
      LIMIT ${perBand}
    `);
    console.log(`  band ${lo.toFixed(2)}-${hi.toFixed(2)}: ${band.length} rows`);
    rows.push(...band);
  }

  // Same prompt can land in one band only, but guard anyway - a hash colliding
  // across bands would violate the (batch, prompt_hash) unique constraint.
  const seen = new Set<string>();
  const unique = rows.filter((r) => !seen.has(r.promptHash) && seen.add(r.promptHash));

  const client = new pg.Client({ connectionString: args.labDb });
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
          args.batch,
          r.userId,
          r.positivePrompt,
          JSON.stringify(r.scores),
          r.promptCreatedAt,
        ]
      );
      inserted += res.rowCount ?? 0;
    }
    console.log(`\nbatch "${args.batch}": ${inserted} inserted, ${unique.length - inserted} already present`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
