// Builds a Kohya training input from a source run's input, as the orchestrator API returns it.
// This package does not depend on the orchestration client, so each consumer checks these key lists
// against its own Kohya input type with `satisfies`.

/**
 * The Kohya input fields a new run copies from a source run: only fields a submit sends, never the
 * read-only values the orchestrator echoes back (`defaultSteps`, `storageBuzzPerEpoch`, …), which
 * it rejects on re-submit. Epochs and steps are left out: a continuation sets its own.
 */
export const KOHYA_CONTINUE_KEYS = [
  'model',
  'numRepeats',
  'trainBatchSize',
  'resolution',
  'enableBucket',
  'shuffleCaption',
  'keepTokens',
  'clipSkip',
  'flipAugmentation',
  'unetLR',
  'textEncoderLR',
  'trainTextEncoder',
  'lrScheduler',
  'lrSchedulerNumCycles',
  'minSnrGamma',
  'networkDim',
  'networkAlpha',
  'noiseOffset',
  'optimizerType',
  'seed',
  'fp8Base',
  'blocksToSwap',
  'vParameterization',
  'zeroTerminalSnr',
  'trainingData',
  'samples',
  'clipLModel',
  'textEncoderModel',
  'vaeModel',
] as const;

/** A replay trains the source again with the same settings, so it also keeps its epochs and steps. */
export const KOHYA_REPLAY_KEYS = [...KOHYA_CONTINUE_KEYS, 'maxTrainEpochs', 'steps'] as const;

/** The entries of `input` named in `keys` that are not undefined. */
export function pickDefinedKeys<K extends string>(
  input: Record<string, unknown>,
  keys: readonly K[]
): Partial<Record<K, unknown>> {
  return Object.fromEntries(
    keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])
  ) as Partial<Record<K, unknown>>;
}

/**
 * A Kohya input that trains a source run again with its own settings and data. Pass
 * `KOHYA_REPLAY_KEYS` checked against your Kohya input type
 * (`KOHYA_REPLAY_KEYS satisfies readonly (keyof KohyaInput)[]`).
 */
export function replayKohyaInput<K extends string>(
  input: Record<string, unknown>,
  keys: readonly K[]
): Partial<Record<K, unknown>> & { engine: 'kohya' } {
  return { ...pickDefinedKeys(input, keys), engine: 'kohya' };
}
