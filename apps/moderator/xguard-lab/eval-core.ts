/**
 * Run a label's policy against the ground truth humans have confirmed, and record what it got
 * wrong. This is the piece that closes the loop: review builds ground truth, this measures a
 * policy against it, and the per-row results say which prompts to look at next.
 *
 * Owns its own `pg` connection from a connection string rather than taking a client, so the CLI
 * and the SvelteKit route can both call it without agreeing on a database library.
 *
 * Ids are cast to text in SQL rather than left to pg's type parser. `@civitai/db` calls
 * `setTypeParser(INT8, parseFloat)` on pg's PROCESS-GLOBAL registry, so a bigint comes back as a
 * number once that module has loaded and as a string when it has not - meaning this file would
 * return different types from the SvelteKit route than from the CLI. Casting makes it string in
 * both, which is what the types here claim.
 */
import pg from 'pg';
import { scan, type LabelPolicy } from './xguard-client';

export type EvalOptions = {
  connectionString: string;
  label: string;
  /** Omit to measure whatever the live registry currently has. That is the baseline. */
  policyVersion?: number;
  /** Restrict to one sampling batch. Omit for every sample with ground truth. */
  batch?: string;
  thresholdOverride?: number;
  concurrency?: number;
  limit?: number;
  note?: string;
  onProgress?: (done: number, total: number) => void;
};

export type EvalSummary = {
  runId: string;
  label: string;
  policyLabel: string;
  threshold: number;
  total: number;
  scored: number;
  errors: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  // Null, not zero, when undefined. With no positives in the ground truth, precision has no
  // value - reporting 0.000 reads as "it got everything wrong" when it means "nothing to measure".
  precision: number | null;
  recall: number | null;
  f1: number | null;
};

type GroundTruthRow = {
  sample_id: string;
  positive_prompt: string;
  negative_prompt: string | null;
  expected: boolean;
  reviewers: string;
};

/**
 * Majority vote across reviewers. A tie is dropped rather than broken arbitrarily - a prompt two
 * moderators genuinely disagree on is not ground truth, and quietly picking a side would put an
 * unearned number in the evaluation.
 */
const GROUND_TRUTH_SQL = `
  SELECT h.sample_id::text AS sample_id,
         s.positive_prompt,
         s.negative_prompt,
         count(*) FILTER (WHERE h.verdict) > count(*) FILTER (WHERE NOT h.verdict) AS expected,
         count(*) AS reviewers
    FROM human_judgement h
    JOIN sample s ON s.id = h.sample_id
   WHERE h.label = $1
     AND h.excluded_reason IS NULL
     AND ($2::text IS NULL OR s.batch = $2)
   GROUP BY h.sample_id, s.positive_prompt, s.negative_prompt
  HAVING count(*) FILTER (WHERE h.verdict) <> count(*) FILTER (WHERE NOT h.verdict)
   ORDER BY h.sample_id
`;

export async function runEvaluation(opts: EvalOptions): Promise<EvalSummary> {
  const client = new pg.Client({ connectionString: opts.connectionString });
  await client.connect();

  try {
    // Resolve the policy under test.
    let policy: LabelPolicy;
    let policyId: string | null = null;
    let policyLabel: string;

    if (opts.policyVersion !== undefined) {
      const { rows } = await client.query<{
        id: string;
        policy: string;
        threshold: number;
        action: string;
      }>(
        `SELECT id::text, policy, threshold, action FROM label_policy WHERE label = $1 AND version = $2`,
        [opts.label, opts.policyVersion]
      );
      if (rows.length === 0) {
        throw new Error(`no policy version ${opts.policyVersion} for label "${opts.label}"`);
      }
      policyId = rows[0].id;
      policy = {
        label: opts.label,
        policy: rows[0].policy,
        threshold: opts.thresholdOverride ?? rows[0].threshold,
        action: rows[0].action,
      };
      policyLabel = `v${opts.policyVersion}`;
    } else {
      // Empty policy = don't send an override = measure the live registry.
      policy = { label: opts.label, policy: '', threshold: opts.thresholdOverride ?? 0.4 };
      policyLabel = 'live';
    }

    const { rows: truth } = await client.query<GroundTruthRow>(GROUND_TRUTH_SQL, [
      opts.label,
      opts.batch ?? null,
    ]);
    const rows = opts.limit ? truth.slice(0, opts.limit) : truth;
    if (rows.length === 0) {
      throw new Error(
        `no confirmed ground truth for "${opts.label}"${opts.batch ? ` in batch ${opts.batch}` : ''}. Review some samples first.`
      );
    }

    const { rows: runRows } = await client.query<{ id: string }>(
      `INSERT INTO eval_run (label, policy_id, policy_label, threshold, batch, total, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
      [opts.label, policyId, policyLabel, policy.threshold, opts.batch ?? null, rows.length, opts.note ?? null]
    );
    const runId = runRows[0].id;

    let next = 0;
    let done = 0;
    let errors = 0;
    const concurrency = Math.min(opts.concurrency ?? 6, rows.length);

    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          const i = next++;
          if (i >= rows.length) return;
          const row = rows[i];

          let score: number | null = null;
          let reason: string | null = null;
          let error: string | null = null;
          try {
            const results = await scan({
              input: { positivePrompt: row.positive_prompt, negativePrompt: row.negative_prompt },
              policies: [policy],
            });
            const hit = results.find((r) => r.label?.toLowerCase() === opts.label.toLowerCase());
            if (!hit) {
              // With no policy override the orchestrator only knows labels in its live registry, so
              // a candidate label that has never shipped comes back empty. Say that, rather than
              // reporting an empty result list.
              throw new Error(
                policyId === null
                  ? `"${opts.label}" is not in the live XGuard registry, so there is no baseline to measure. Import a policy and pass --policy-version.`
                  : `label missing from output (got ${results.map((r) => r.label).join(', ') || 'nothing'})`
              );
            }
            score = typeof hit.score === 'number' ? hit.score : null;
            reason = hit.modelReason || null;
          } catch (err) {
            error = (err as Error).message;
            errors++;
          }

          const predicted = score === null ? null : score >= policy.threshold;
          const bucket =
            predicted === null
              ? 'error'
              : predicted && row.expected
                ? 'TP'
                : predicted && !row.expected
                  ? 'FP'
                  : !predicted && !row.expected
                    ? 'TN'
                    : 'FN';

          await client.query(
            `INSERT INTO eval_result (run_id, sample_id, score, predicted, expected, bucket, reason, error)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (run_id, sample_id) DO NOTHING`,
            [runId, row.sample_id, score, predicted, row.expected, bucket, reason, error]
          );

          done++;
          opts.onProgress?.(done, rows.length);
        }
      })
    );

    const { rows: tally } = await client.query<{ bucket: string; n: string }>(
      `SELECT bucket, count(*) AS n FROM eval_result WHERE run_id = $1 GROUP BY bucket`,
      [runId]
    );
    const count = (b: string) => Number(tally.find((t) => t.bucket === b)?.n ?? 0);
    const tp = count('TP');
    const fp = count('FP');
    const tn = count('TN');
    const fn = count('FN');
    const precision = tp + fp === 0 ? null : tp / (tp + fp);
    const recall = tp + fn === 0 ? null : tp / (tp + fn);
    const f1 =
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall);

    await client.query(
      `UPDATE eval_run
          SET status = 'complete', scored = $2, errors = $3, tp = $4, fp = $5, tn = $6, fn = $7,
              precision = $8, recall = $9, f1 = $10, finished_at = now()
        WHERE id = $1`,
      [runId, tp + fp + tn + fn, errors, tp, fp, tn, fn, precision, recall, f1]
    );

    return {
      runId,
      label: opts.label,
      policyLabel,
      threshold: policy.threshold,
      total: rows.length,
      scored: tp + fp + tn + fn,
      errors,
      tp,
      fp,
      tn,
      fn,
      precision,
      recall,
      f1,
    };
  } finally {
    await client.end();
  }
}
