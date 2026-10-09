/**
 * Structured build-outcome signals for App Block builds: which pipeline step failed, and
 * whose problem that makes it.
 *
 * Lives in `shared/` because the server stores these values (the build callbacks write
 * them to `app_block_build_attempts`) and the client renders them (`describeBuildFailure`
 * and the moderator deploy chip). Both sides read the same closed lists, so a value one
 * side does not know is treated as absent on the other rather than rendered raw.
 */

/**
 * The build pipeline's steps in run order, plus `none` for a run where no step failed.
 * Sent by the pipeline as the callback's optional `failedStep` field.
 */
export const BUILD_FAILED_STEPS = ['clone', 'validate', 'build', 'scan', 'push', 'none'] as const;
export type BuildFailedStep = (typeof BUILD_FAILED_STEPS)[number];

/** The pipeline steps that can fail. `none` is the "nothing failed" marker. */
export type BuildPipelineStep = Exclude<BuildFailedStep, 'none'>;

/**
 * Whose problem a failed build is, derived on the server by `deriveFailureClass`.
 *
 * - `author`: the app's own code or manifest. The only class that tells an author to
 *   submit a new version.
 * - `platform`: something Civitai provides. The app is fine.
 * - `transient`: a temporary problem (a timeout, a failed publish after retries).
 * - `unknown`: no deterministic signal says either way. Shown neutrally, never as the
 *   author's fault.
 */
export const BUILD_FAILURE_CLASSES = ['author', 'platform', 'transient', 'unknown'] as const;
export type BuildFailureClassSignal = (typeof BUILD_FAILURE_CLASSES)[number];

/** Product words for each step, as authors and moderators read them. */
export const BUILD_STEP_LABELS: Record<BuildPipelineStep, string> = {
  clone: 'fetching the source',
  validate: 'manifest check',
  build: 'build',
  scan: 'security scan',
  push: 'publishing the image',
};

export function isBuildPipelineStep(value: unknown): value is BuildPipelineStep {
  return (
    typeof value === 'string' &&
    value !== 'none' &&
    BUILD_FAILED_STEPS.includes(value as BuildFailedStep)
  );
}

export function isBuildFailureClassSignal(value: unknown): value is BuildFailureClassSignal {
  return (
    typeof value === 'string' && BUILD_FAILURE_CLASSES.includes(value as BuildFailureClassSignal)
  );
}

/**
 * The stored signals for a version's latest build attempt, as the readers receive them.
 * Both are `null` when the attempt predates the signals or the attempt table is absent.
 */
export type BuildAttemptSignals = {
  failedStep: string | null;
  failureClass: string | null;
};
