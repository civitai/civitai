/**
 * Generation Config
 *
 * Unified configuration system for generation workflow node settings.
 *
 * Usage:
 * ```typescript
 * import { workflowConfigs, getImagesConfig } from '~/shared/data-graph/generation/config';
 *
 * // Get merged images config for a workflow + ecosystem
 * const imagesConfig = getImagesConfig(workflowConfigs, 'img2img:edit', 'Qwen');
 * // Returns: { max: 1 } (Qwen override applied)
 *
 * // Get full node config
 * const nodeConfig = getNodeConfig(workflowConfigs, 'img2img', 'SDXL', modelVersionId);
 * // Returns merged config with version overrides applied
 * ```
 */

// Export configs and lookups
export {
  workflowConfigs,
  workflowConfigsArray,
  workflowConfigByKey,
  workflowOptions,
  workflowOptionById,
} from './workflows';

// Export workflow helpers
export {
  isWorkflowAvailable,
  getWorkflowsForEcosystem,
  getWorkflowsWithCompatibility,
  getAllWorkflowsGrouped,
  getDefaultEcosystemForWorkflow,
  getEcosystemsForWorkflow,
  getInputTypeForWorkflow,
  getOutputTypeForWorkflow,
} from './workflows';

// Export node config lookup functions
export { getNodeConfig, getImagesConfig } from './registry';

// Export types
export type {
  WorkflowConfig,
  WorkflowConfigs,
  WorkflowCategory,
  NodeConfigs,
  ImagesNodeConfig,
  ImageSlotConfig,
} from './types';

export type { WorkflowOption } from './workflows';
