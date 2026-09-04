#!/usr/bin/env node

/**
 * Applies src/server/clickhouse/migrations/2026-09-04-user-activity-rollup.sql.
 *
 * We do not auto-run DDL, so this is a hand-run operator tool, not part of any deploy. It exists because
 * the migration is 30 statements — one CREATE, 25 pageViews partitions, three whole-table arms, and the
 * verification — and pasting those into a web console that drops connections is how half a backfill
 * happens without anyone noticing.
 *
 *   node scripts/apply-user-activity-rollup.mjs             # dry run: prints the plan, writes nothing
 *   node scripts/apply-user-activity-rollup.mjs --apply     # actually applies
 *   node scripts/apply-user-activity-rollup.mjs --apply --from 202505   # resume at a partition
 *
 * SAFE TO RE-RUN, IN FULL, AT ANY POINT. The target merges on `max`/`argMax`, both idempotent, so a
 * statement applied twice yields the same merged state. That is a property of this table's engine and not
 * of rollups in general — the two SharedSummingMergeTree targets in this codebase silently double when
 * re-run. If a run dies half way, the correct response is to run it again.
 *
 * Credentials come from CLICKHOUSE_HOST/USERNAME/PASSWORD, read from .claude/skills/clickhouse-query/.env
 * then .env, exactly as the clickhouse-query skill does. Nothing new to configure.
 */

import { createClient } from '@clickhouse/client';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

for (const envPath of [
  resolve(projectRoot, '.claude/skills/clickhouse-query/.env'),
  resolve(projectRoot, '.env'),
]) {
  try {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1);
    }
  } catch {
    /* absent is fine as long as one of them, or the ambient env, supplies the vars */
  }
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fromArg = args[args.indexOf('--from') + 1];
const resumeFrom = args.includes('--from') ? Number(fromArg) : null;
if (args.includes('--from') && !Number.isFinite(resumeFrom)) {
  console.error('--from needs a partition like 202505');
  process.exit(1);
}

// Every partition `pageViews` holds, read 2026-09-04. Listed rather than discovered so a dry run shows the
// real plan, and so a new month appearing mid-backfill cannot change what this applies. Re-derive with:
//   SELECT DISTINCT toYYYYMM(time) AS p FROM default.pageViews ORDER BY p;
const PAGEVIEW_PARTITIONS = [
  202409, 202410, 202411, 202412, 202501, 202502, 202503, 202504, 202505, 202506, 202507, 202508,
  202509, 202510, 202511, 202512, 202601, 202602, 202603, 202604, 202605, 202606, 202607, 202608,
  202609,
];

const CREATE = `
CREATE TABLE IF NOT EXISTS default.user_activity_rollup
(
    \`userId\`   Int32,
    \`lastSeen\` SimpleAggregateFunction(max, DateTime),
    \`country\`  AggregateFunction(argMax, String, DateTime)
)
ENGINE = SharedAggregatingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
ORDER BY userId
SETTINGS index_granularity = 8192`;

const pageViewsArm = (partition) => `
INSERT INTO default.user_activity_rollup
SELECT userId, max(time) AS lastSeen, argMaxState(CAST(country AS String), time) AS country
FROM default.pageViews
WHERE userId > 0 AND toYYYYMM(time) = ${partition}
GROUP BY userId`;

// No country on these three, so they stamp a losing state at the epoch and can never win the argMax.
const plainArm = (table) => `
INSERT INTO default.user_activity_rollup
SELECT userId, max(time) AS lastSeen, argMaxState(CAST('' AS String), toDateTime(0)) AS country
FROM default.${table}
WHERE userId > 0
GROUP BY userId`;

const steps = [
  { label: 'create table', sql: CREATE, timeout: 60 },
  ...PAGEVIEW_PARTITIONS.filter((p) => resumeFrom === null || p >= resumeFrom).map((p) => ({
    label: `pageViews ${p}`,
    sql: pageViewsArm(p),
    timeout: 300,
  })),
  // `views` is the largest table on the cluster (7.78B rows) and measured 78s whole. The timeout is
  // generous because a timeout here is not a failure to retry blindly — it means the cluster is loaded.
  { label: 'views (whole)', sql: plainArm('views'), timeout: 900 },
  { label: 'reactions (whole)', sql: plainArm('reactions'), timeout: 600 },
  { label: 'userActivities (whole)', sql: plainArm('userActivities'), timeout: 300 },
];

const client = createClient({
  host: process.env.CLICKHOUSE_HOST,
  username: process.env.CLICKHOUSE_USERNAME,
  password: process.env.CLICKHOUSE_PASSWORD,
  request_timeout: 900_000,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries exist for the dropped connections and 5xx this cluster hands out, not for query errors. A
// malformed statement fails the same way every attempt, so retrying one wastes fifteen minutes and buries
// the message; bad SQL and a bad gateway are told apart below.
function isRetryable(err) {
  const msg = String(err?.message ?? err);
  if (/Syntax error|UNKNOWN_IDENTIFIER|UNKNOWN_TABLE|TYPE_MISMATCH|ILLEGAL_TYPE|NOT_FOUND_COLUMN/i.test(msg)) {
    return false;
  }
  return /socket|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|502|503|504|timeout|aborted|network/i.test(
    msg
  );
}

async function runStep(step) {
  const started = Date.now();
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await client.command({
        query: step.sql,
        clickhouse_settings: { max_execution_time: step.timeout },
      });
      return { seconds: ((Date.now() - started) / 1000).toFixed(1), attempts: attempt };
    } catch (err) {
      if (attempt === 5 || !isRetryable(err)) throw err;
      const backoff = 2 ** attempt * 1000;
      console.log(
        `      attempt ${attempt} failed (${String(err.message ?? err).slice(0, 90)}) — retrying in ${
          backoff / 1000
        }s`
      );
      await sleep(backoff);
    }
  }
}

async function verify() {
  const users = await client
    .query({ query: 'SELECT uniqExact(userId) AS users FROM default.user_activity_rollup', format: 'JSON' })
    .then((r) => r.json());
  const countries = await client
    .query({
      query: `SELECT country, count() AS users FROM (
                SELECT userId, argMaxMerge(country) AS country
                FROM default.user_activity_rollup GROUP BY userId
              ) GROUP BY country ORDER BY users DESC LIMIT 10`,
      format: 'JSON',
    })
    .then((r) => r.json());

  const total = Number(users.data[0].users);
  console.log(`\nDistinct users: ${total.toLocaleString()}`);
  // 10,719,260 on the first application, 2026-09-04. Well under that means an arm did not land — which
  // does not error, it just leaves those users reading as dormant with an unknown country.
  console.log(
    total < 10_000_000
      ? '⚠️  Lower than the ~10.7M expected — an arm probably did not land. Re-run; every statement is idempotent.'
      : '✓ In the expected range (~10.7M).'
  );
  console.log('\nTop countries:');
  for (const row of countries.data) {
    console.log(`  ${(row.country || '(unknown)').padEnd(12)} ${Number(row.users).toLocaleString()}`);
  }
}

async function main() {
  if (!process.env.CLICKHOUSE_HOST) {
    console.error('CLICKHOUSE_HOST is not set — expected it in .claude/skills/clickhouse-query/.env or .env');
    process.exit(1);
  }

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${steps.length} statements against ${process.env.CLICKHOUSE_HOST}`);
  if (resumeFrom !== null) console.log(`Resuming from partition ${resumeFrom}`);

  if (!apply) {
    steps.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s.label}`));
    console.log('\nNothing was written. Re-run with --apply to execute.');
    await client.close();
    return;
  }

  const started = Date.now();
  for (const [i, step] of steps.entries()) {
    process.stdout.write(`  ${String(i + 1).padStart(2)}/${steps.length}  ${step.label.padEnd(24)}`);
    try {
      const { seconds, attempts } = await runStep(step);
      console.log(`ok  ${seconds}s${attempts > 1 ? ` (${attempts} attempts)` : ''}`);
    } catch (err) {
      console.log('FAILED');
      console.error(`\n${err.message ?? err}\n`);
      const partition = step.label.startsWith('pageViews ') ? step.label.split(' ')[1] : null;
      console.error(
        partition
          ? `Resume with:\n  node scripts/apply-user-activity-rollup.mjs --apply --from ${partition}`
          : 'Re-run the whole script — every statement is idempotent, so nothing double-counts.'
      );
      await client.close();
      process.exit(1);
    }
  }

  console.log(`\nAll statements applied in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
  await verify();
  console.log('\nThe rollup is populated. The user-activity-rollup cron keeps it current from here.');
  await client.close();
}

main().catch(async (err) => {
  console.error(err);
  await client.close();
  process.exit(1);
});
