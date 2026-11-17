/**
 * The one statement of the custom-training-base-model weights rule: a pasted base model must ship
 * SafeTensor weights. The main app reads the format off its ModelFile metadata (`'SafeTensor'`);
 * the training studio reads the orchestrator's resolved FileFormat (`'safeTensor'`) — the same fact
 * in two spellings, so the comparison is case-insensitive. `no-divergent-safetensor-rule` keeps
 * both consumers importing from here instead of restating the literal.
 */
export function isSafeTensorFormat(format: string | null | undefined): boolean {
  return typeof format === 'string' && format.toLowerCase() === 'safetensor';
}

export const NON_SAFETENSOR_CUSTOM_MODEL_MESSAGE =
  'Custom model does not have a SafeTensor file. Please choose another model.';

/**
 * Custom base checkpoints refused for training in both trainers, whatever the ops `blockedModels`
 * list in `training:status` holds. Keyed by Civitai model id so every version of the model is caught.
 * - 53761: blocked before this list existed (was the main app's `blockedCustomModels`).
 * - 2855007 Anima-2.9B: a layer-expanded Anima, not the architecture the Anima trainer targets.
 */
const BLOCKED_CUSTOM_MODEL_IDS = new Set([53761, 2855007]);

export function isBlockedCustomModelId(modelId: number): boolean {
  return BLOCKED_CUSTOM_MODEL_IDS.has(modelId);
}

/** Matches the model id in an AIR (`urn:air:…:civitai:<model>@<version>` or `civitai:<model>@<version>`). */
export function isBlockedCustomModel(air: string): boolean {
  const modelId = /(?:^|:)civitai:(\d+)(?:@|$)/.exec(air.trim())?.[1];
  return modelId !== undefined && isBlockedCustomModelId(Number(modelId));
}

export const BLOCKED_CUSTOM_MODEL_MESSAGE =
  'This custom model is blocked from training. Pick another.';
