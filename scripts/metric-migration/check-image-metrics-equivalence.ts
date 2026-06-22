/**
 * check-image-metrics-equivalence.ts
 *
 * Correctness harness / equivalence proof for the image-metrics point-table
 * read path (Flipt flag `image-metrics-use-current-totals`).
 *
 * For a sample of real Image ids it runs BOTH:
 *   (A) the existing app read — the aggregating VIEW `entityMetricDailyAgg_v2`
 *       query (same shape getImageMetricsObject's MetricService leg issues), and
 *   (B) the new point-table read — `SELECT entityId, metricType, total FROM
 *       entityMetricCurrentTotals_v2 WHERE entityType='Image' AND entityId IN
 *       (...) AND metricType IN (...)` (exactly what fetchImageMetricsFromCurrentTotals
 *       issues),
 * and reports any per-(id, metricType) mismatch. A correct point table => 0
 * mismatches. Run this (and require 0) BEFORE flipping the flag on in prod.
 *
 * READ-ONLY. LIMIT-bounded sampling. Does NOT add the heavy view load at scale —
 * it issues exactly two bounded queries over the sampled ids.
 *
 * Usage:
 *   CLICKHOUSE_URL='https://default:PASSWORD@host:8443' \
 *     tsx scripts/metric-migration/check-image-metrics-equivalence.ts [--sample 100] [--ids 1,2,3]
 *
 * Get the prod read-only password from the cluster:
 *   kubectl get configmap -n civitai-dp-prod civitai-cfg-primary -o jsonpath='{.data.CLICKHOUSE_PASSWORD}'
 */
import { createClient } from '@clickhouse/client';
import * as dotenv from 'dotenv';

dotenv.config();

const METRIC_TYPES = ['Like', 'Heart', 'Laugh', 'Cry', 'commentCount', 'Collection', 'tippedAmount'];
const VIEW = 'entityMetricDailyAgg_v2';
const POINT_TABLE = 'entityMetricCurrentTotals_v2';

function parseArgs() {
  const args = process.argv.slice(2);
  let sample = 100;
  let ids: number[] | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sample') sample = parseInt(args[++i], 10);
    else if (args[i] === '--ids') ids = args[++i].split(',').map((s) => parseInt(s.trim(), 10));
  }
  return { sample, ids };
}

async function main() {
  const url = process.env.CLICKHOUSE_URL;
  if (!url) throw new Error('CLICKHOUSE_URL is not defined');
  const { sample, ids: explicitIds } = parseArgs();

  const client = createClient({ url, request_timeout: 120_000 });
  try {
    // 1. Sample real Image ids that appear in the point table (so we exercise
    //    populated rows), unless the caller pinned a set.
    let ids = explicitIds;
    if (!ids) {
      const res = await client.query({
        query: `SELECT DISTINCT entityId FROM ${POINT_TABLE} WHERE entityType='Image' ORDER BY entityId DESC LIMIT ${sample}`,
        format: 'JSONEachRow',
      });
      ids = ((await res.json()) as Array<{ entityId: number }>).map((r) => r.entityId);
    }
    if (!ids.length) {
      console.error('No Image ids to check (point table empty?). Has the backfill/refresh run?');
      process.exit(2);
    }
    const idList = ids.join(',');
    const metricList = METRIC_TYPES.map((m) => `'${m}'`).join(',');
    console.log(`Comparing ${ids.length} Image ids across ${METRIC_TYPES.length} metric types...\n`);

    // 2A. App view query (ground truth).
    const viewRes = await client.query({
      query: `
        SELECT entityId, metricType, sum(total) AS value
        FROM ${VIEW}
        WHERE entityType='Image' AND entityId IN (${idList}) AND metricType IN (${metricList})
        GROUP BY entityId, metricType HAVING value > 0`,
      format: 'JSONEachRow',
    });
    const viewRows = (await viewRes.json()) as Array<{ entityId: number; metricType: string; value: number }>;

    // 2B. Point-table read (matches fetchImageMetricsFromCurrentTotals).
    const ptRes = await client.query({
      query: `
        SELECT entityId, metricType, total AS value
        FROM ${POINT_TABLE}
        WHERE entityType='Image' AND entityId IN (${idList}) AND metricType IN (${metricList})`,
      format: 'JSONEachRow',
    });
    const ptRows = (await ptRes.json()) as Array<{ entityId: number; metricType: string; value: number }>;

    // 3. Diff. Note: the view filters HAVING value>0; the point table may store a
    //    0 row — treat absent and 0 as equal so the comparison matches what the
    //    app actually shapes (`total || null`).
    const key = (id: number, m: string) => `${id}|${m}`;
    const viewMap = new Map<string, number>();
    for (const r of viewRows) viewMap.set(key(r.entityId, r.metricType), Number(r.value));
    const ptMap = new Map<string, number>();
    for (const r of ptRows) ptMap.set(key(r.entityId, r.metricType), Number(r.value));

    const allKeys = new Set<string>([...viewMap.keys(), ...ptMap.keys()]);
    const mismatches: Array<{ key: string; view: number; point: number }> = [];
    for (const k of allKeys) {
      const v = viewMap.get(k) ?? 0;
      const p = ptMap.get(k) ?? 0;
      if (v !== p) mismatches.push({ key: k, view: v, point: p });
    }

    console.log(`view rows: ${viewRows.length}   point rows: ${ptRows.length}`);
    console.log(`compared keys: ${allKeys.size}`);
    console.log(`MISMATCHES: ${mismatches.length}`);
    if (mismatches.length) {
      console.log('\nFirst up to 50 mismatches (key, view, point):');
      for (const m of mismatches.slice(0, 50)) console.log(`  ${m.key}\tview=${m.view}\tpoint=${m.point}`);
      process.exitCode = 1;
    } else {
      console.log('\n✅ EQUIVALENT — 0 mismatches. Safe to flip image-metrics-use-current-totals.');
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error('Equivalence check failed:', e);
  process.exit(1);
});
