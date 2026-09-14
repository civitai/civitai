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
