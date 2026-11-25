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

/**
 * Workflow metadata stamped on every Training Studio run whose `clipSkip` is what the trainer uses.
 * A run without it was submitted while the trainer raised an SDXL-family clip skip of 1 to 2, so
 * its stored 1 really trained, or should have trained, at 2.
 */
export const CLIP_SKIP_AS_SENT = { clipSkipAsSent: true } as const;

/** The Kohya ecosystems whose clip skip 1 the trainer used to raise to 2. */
const SDXL_FAMILY = new Set(['sdxl', 'pony', 'illustrious', 'noobai']);

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
 * The entries of a source run's Kohya `input` named in `keys`, for a new run that copies its
 * settings. A source without `CLIP_SKIP_AS_SENT` in its `metadata` has an SDXL-family clip skip of 1
 * copied as 2, the value it trained at; any other value, and a 1 picked on a stamped run, is kept.
 */
export function copyKohyaInput<K extends string>(
  input: Record<string, unknown>,
  keys: readonly K[],
  metadata: unknown
): Partial<Record<K, unknown>> {
  const copied: Partial<Record<string, unknown>> = pickDefinedKeys(input, keys);
  const stamped =
    (metadata as { clipSkipAsSent?: unknown } | null | undefined)?.clipSkipAsSent === true;
  const ecosystem = typeof input.model === 'string' ? input.model.split(':')[2] : undefined;
  if (!stamped && copied.clipSkip === 1 && ecosystem && SDXL_FAMILY.has(ecosystem))
    copied.clipSkip = 2;
  return copied as Partial<Record<K, unknown>>;
}

/**
 * A Kohya input that trains a source run again with its own settings and data. Pass
 * `KOHYA_REPLAY_KEYS` checked against your Kohya input type
 * (`KOHYA_REPLAY_KEYS satisfies readonly (keyof KohyaInput)[]`) and the source's workflow metadata.
 */
export function replayKohyaInput<K extends string>(
  input: Record<string, unknown>,
  keys: readonly K[],
  metadata: unknown
): Partial<Record<K, unknown>> & { engine: 'kohya' } {
  return { ...copyKohyaInput(input, keys, metadata), engine: 'kohya' };
}
