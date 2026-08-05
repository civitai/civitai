// Moved to @civitai/shared so the creator-studio spoke reads the same values as the main app.
// Re-exported from the original path so existing imports keep working.
export {
  ModelVersionFlag,
  modelVersionFlagLabels,
  getModelVersionFlagLabels,
  isGenerationDisabled,
  type ModelVersionFlagValue,
} from '@civitai/shared';
