import * as z from 'zod';

import {
  BUILD_FAILED_STEPS,
  type BuildFailedStep,
  type BuildFailureClassSignal,
} from '~/shared/constants/app-block-build.constants';

/**
 * The OPTIONAL structured signals a build callback may carry, and the ONE place a failure
 * class is derived from them. Pure: no DB, no env, so both callbacks and their tests load
 * it directly.
 *
 * Every field is additive and optional. A pipeline that predates them sends none, and the
 * callback then behaves exactly as it did before they existed.
 */

/** Tekton's aggregate status for the whole run. */
export const PIPELINE_STATUSES = ['Succeeded', 'Failed', 'Completed', 'None'] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

/**
 * One validator per field, so an invalid field is dropped on its own and never takes a
 * valid sibling down with it.
 *
 * `failedReason` is a Tekton reason word (`TaskRunTimeout`, `Failed`, ...): letters only.
 * `runId` is the pipeline run's name; it is stored for the stale-run guard and never
 * rendered. Bounded at 253 (the Kubernetes object-name limit), not 63: a run name embeds
 * the slug, so a label-length bound would silently drop it for long slugs and switch the
 * guard off for those apps.
 */
const FIELD_SCHEMAS = {
  failedStep: z.enum(BUILD_FAILED_STEPS),
  pipelineStatus: z.enum(PIPELINE_STATUSES),
  failedReason: z.string().regex(/^[A-Za-z]{1,64}$/),
  runId: z.string().regex(/^[a-z0-9-]{1,253}$/),
} as const;

export type BuildSignalField = keyof typeof FIELD_SCHEMAS;

export type BuildSignals = {
  failedStep?: BuildFailedStep;
  pipelineStatus?: PipelineStatus;
  failedReason?: string;
  runId?: string;
};

/**
 * Read the optional signals off a parsed callback body.
 *
 * 🔴 NEVER REJECTS. A field that is present and invalid is DROPPED and its name returned
 * in `dropped` for the caller to log; the callback itself goes ahead. Its job (moving the
 * version out of `building`) matters more than any one new field, and the signature has
 * already proven who sent the body. `undefined` means absent and is not reported; any
 * other value that fails its schema, `null` included, is.
 */
export function parseBuildSignals(body: Record<string, unknown>): {
  signals: BuildSignals;
  dropped: BuildSignalField[];
} {
  const signals: Record<string, unknown> = {};
  const dropped: BuildSignalField[] = [];
  for (const field of Object.keys(FIELD_SCHEMAS) as BuildSignalField[]) {
    const raw = body[field];
    if (raw === undefined) continue;
    const parsed = FIELD_SCHEMAS[field].safeParse(raw);
    if (parsed.success) signals[field] = parsed.data;
    else dropped.push(field);
  }
  return { signals: signals as BuildSignals, dropped };
}

/** A pipeline run name, or `undefined` when the value is not a valid run id. */
export function parseRunId(value: unknown): string | undefined {
  const parsed = FIELD_SCHEMAS.runId.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The Tekton reason a task carries when it ran past its timeout. */
const TASK_TIMEOUT_REASON = 'TaskRunTimeout';

/** The Tekton reason a task carries when it ran and its own steps failed. */
const TASK_FAILED_REASON = 'Failed';

/**
 * Whose problem a failure is, from WHICH STEP failed. No log text is read.
 *
 * | step     | condition                   | class       |
 * |----------|-----------------------------|-------------|
 * | clone    | any                         | `platform`  |
 * | validate | reason `Failed`             | `author`    |
 * | validate | anything else, or no reason | `unknown`   |
 * | build    | reason `TaskRunTimeout`     | `transient` |
 * | build    | anything else               | `unknown`   |
 * | scan     | any                         | `unknown`   |
 * | push     | any                         | `transient` |
 * | apply    | (the civitai-side deploy)   | `platform`  |
 * | none     | a failed run naming no step | `unknown`   |
 *
 * - clone: the repo it fetches is written by the platform at approve time, so a failure
 *   there is ours.
 * - validate: the step re-checks the app's own manifest, so its failure is the author's —
 *   but ONLY with positive evidence that it ran and failed (reason `Failed`). A run stopped
 *   before validate executed (cancelled, timed out upstream) still reports `validate` as
 *   the first step that did not succeed, with no reason; that must not blame the author.
 *   This is the only `author` row, and every author-class row must require that evidence.
 * - build: a timeout is transient. Any other build failure stays `unknown`: a
 *   registry or network blip lands there too, and blaming the author for one would send
 *   them chasing a bug they don't have. (The author UI may still attribute a build
 *   failure to the author on TEXT evidence — a pre-check `ERROR:` first line — which is
 *   applied in `describeBuildFailure`, not here.)
 * - scan: `unknown` FOR NOW. Whether a finding is in a platform-provided OS package or
 *   in the app's own dependencies is not in the callback yet, so neither side can be
 *   named. Split this row when that signal arrives.
 * - push: the publish step has already retried by the time it reports failure.
 * - apply: the image built; the deploy the civitai side runs did not finish.
 */
export function deriveFailureClass(
  step: BuildFailedStep | 'apply',
  failedReason?: string | null
): BuildFailureClassSignal {
  switch (step) {
    case 'clone':
      return 'platform';
    case 'validate':
      return failedReason === TASK_FAILED_REASON ? 'author' : 'unknown';
    case 'build':
      return failedReason === TASK_TIMEOUT_REASON ? 'transient' : 'unknown';
    case 'scan':
      return 'unknown';
    case 'push':
      return 'transient';
    case 'apply':
      return 'platform';
    case 'none':
      return 'unknown';
  }
}
