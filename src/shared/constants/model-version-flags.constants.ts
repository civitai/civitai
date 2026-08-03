// Moved to @civitai/shared so the creator-studio spoke — which writes `licensingFee`, and therefore
// owns the DisablePayout bit too — reads the same values as the main app. Re-exported from the
// original path so existing imports keep working.
export {
  ModelVersionFlag,
  modelVersionFlagLabels,
  getModelVersionFlagLabels,
  isGenerationDisabled,
  type ModelVersionFlagValue,
} from '@civitai/shared';
