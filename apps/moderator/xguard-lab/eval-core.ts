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
import { scan, type LabelPolicy, type OrchestratorConfig, type XGuardMode } from './xguard-client';

export type EvalOptions = {
  connectionString: string;
  label: string;
  /** Omit to measure whatever the live registry currently has. That is the baseline. */
  policyVersion?: number;
  /** Restrict to one sampling batch. Omit for every sample with ground truth. */
  batch?: string;
  /**
   * Which scanner to measure against. Must match how the content is scanned in production, or the
   * run reports a number for a registry the content never passes through — model listings are
   * `text`, generation prompts are `prompt`.
   */
  mode?: XGuardMode;
  thresholdOverride?: number;
  concurrency?: number;
  limit?: number;
  note?: string;
  /** Supply when the caller reads env some other way than `process.env` (the SvelteKit routes do). */
  orchestrator?: Partial<OrchestratorConfig>;
  onProgress?: (done: number, total: number) => void;
  /**
   * Fires once the `eval_run` row exists, before any scanning. Lets an HTTP caller return the id and let
   * the run finish in the background instead of holding a request open for minutes of inference.
   */
  onRunCreated?: (runId: string) => void;
};

export type EvalSummary = {
  runId: string;
  label: string;
  /** Scanner this run actually measured against, after resolution. Never assume it. */
  mode: XGuardMode;
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
  source: string;
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
         s.source,
         count(*) FILTER (WHERE h.verdict) > count(*) FILTER (WHERE NOT h.verdict) AS expected,
         count(*) AS reviewers
    FROM human_judgement h
    JOIN sample s ON s.id = h.sample_id
   WHERE h.label = $1
     AND h.excluded_reason IS NULL
     AND ($2::text IS NULL OR s.batch = $2)
   GROUP BY h.sample_id, s.positive_prompt, s.negative_prompt, s.source
  HAVING count(*) FILTER (WHERE h.verdict) <> count(*) FILTER (WHERE NOT h.verdict)
   ORDER BY h.sample_id
`;

/**
 * Which scanner a sample belongs to, by where it came from.
 *
 * Derived rather than defaulted, because a default is silent and wrong half the time: an operator
 * clicking Evaluate has no reason to know that `prompt` and `text` are different registries, and a
 * run measured against the wrong one still returns a confident-looking number.
 *
 * An unknown source throws instead of falling back. A new sampler is one line here; a silent
 * fallback is a number nobody can trust.
 */
const MODE_BY_SOURCE: Record<string, XGuardMode> = {
  xguardPromptResults: 'prompt',
  // Every entity that flows through EntityModeration is scanned in text mode. The sampler writes
  // `source` as the entity type lowercased, so a new one is a line here, not a code change.
  model: 'text',
  article: 'text',
  challenge: 'text',
  wildcardsetcategory: 'text',
};

function resolveMode(sources: string[], override?: XGuardMode): XGuardMode {
  if (override) return override;
  const distinct = [...new Set(sources)];
  const modes = new Set(
    distinct.map((s) => {
      const mode = MODE_BY_SOURCE[s];
      if (!mode)
        throw new Error(
          `sample source "${s}" has no scanner mapping — add it to MODE_BY_SOURCE in eval-core.ts, or pass an explicit mode`
        );
      return mode;
    })
  );
  // Two scanners averaged into one precision number is not a measurement of either.
  if (modes.size > 1)
    throw new Error(
      `this ground truth mixes scanner modes (${[...modes].join(', ')}) — evaluate one batch at a time, or pass an explicit mode`
    );
  return [...modes][0];
}

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
      //
      // The threshold is REQUIRED here rather than defaulted. A baseline exists to say what
      // production does today, and production's threshold lives in the orchestrator registry, not
      // in this file — a default silently measures a different operating point and records it as
      // "live". That has happened, and the resulting number was believed for a day.
      if (opts.thresholdOverride === undefined)
        throw new Error(
          `a live baseline needs an explicit threshold — read the label's real one with ` +
            `\`xguard-manager get <prompt|text>\` and pass it, so the number describes production`
        );
      policy = { label: opts.label, policy: '', threshold: opts.thresholdOverride };
      policyLabel = 'live';
    }

    const { rows: truth } = await client.query<GroundTruthRow>(GROUND_TRUTH_SQL, [
      opts.label,
      opts.batch ?? null,
    ]);
    const rows = opts.limit ? truth.slice(0, opts.limit) : truth;
    if (rows.length === 0) {
      throw new Error(
        `no confirmed ground truth for "${opts.label}"${
          opts.batch ? ` in batch ${opts.batch}` : ''
        }. Review some samples first.`
      );
    }

    // Resolved from the samples themselves, before anything is scanned. `eval_run` has no column
    // for it, so it is prefixed onto the note — a run whose mode you cannot recover is a number you
    // cannot compare against any other run.
    const mode = resolveMode(
      rows.map((r) => r.source),
      opts.mode
    );

    const { rows: runRows } = await client.query<{ id: string }>(
      `INSERT INTO eval_run (label, policy_id, policy_label, threshold, batch, total, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
      [
        opts.label,
        policyId,
        policyLabel,
        policy.threshold,
        opts.batch ?? null,
        rows.length,
        `[${mode}] ${opts.note ?? ''}`.trim(),
      ]
    );
    const runId = runRows[0].id;
    opts.onRunCreated?.(runId);

    try {
      return await score(client, runId, rows, policy, policyId, policyLabel, mode, opts);
    } catch (err) {
      // A run left on `status = 'running'` is indistinguishable from one still working, so a caller polling
      // for completion would wait forever on a run that died. Record the death.
      await client
        .query(
          `UPDATE eval_run
              SET status = 'error', finished_at = now(),
                  note = concat_ws(' | ', note, $2)
            WHERE id = $1`,
          [runId, (err as Error).message.slice(0, 500)]
        )
        .catch(() => {});
      throw err;
    }
  } finally {
    await client.end();
  }
}

async function score(
  client: pg.Client,
  runId: string,
  rows: GroundTruthRow[],
  policy: LabelPolicy,
  policyId: string | null,
  policyLabel: string,
  mode: XGuardMode,
  opts: EvalOptions
): Promise<EvalSummary> {
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
            mode,
            orchestrator: opts.orchestrator,
          });
          const hit = results.find((r) => r.label?.toLowerCase() === opts.label.toLowerCase());
          if (!hit) {
            // With no policy override the orchestrator only knows labels in its live registry, so
            // a candidate label that has never shipped comes back empty. Say that, rather than
            // reporting an empty result list.
            throw new Error(
              policyId === null
                ? `"${opts.label}" is not in the live XGuard registry, so there is no baseline to measure. Import a policy and pass --policy-version.`
                : `label missing from output (got ${
                    results.map((r) => r.label).join(', ') || 'nothing'
                  })`
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
    mode,
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
}
