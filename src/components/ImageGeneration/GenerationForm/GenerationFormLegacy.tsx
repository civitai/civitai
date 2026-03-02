/**
 * GenerationFormLegacy
 *
 * Wrapper that provides the legacy generation form experience with image/video toggle.
 * Uses the legacy form format with persistence to localStorage,
 * while submitting via the new generation-graph routes.
 *
 * Data flow:
 * 1. generation-graph.store.setData() triggers data update
 * 2. GenerationFormProvider listens and formats data to legacy form format
 * 3. Form persists to localStorage (generation-form-2)
 * 4. On submit, form data is converted to graph format
 * 5. Submission via trpc.orchestrator.generateFromGraph
 */

// Re-export the combined GenerationForm as default
export {
  GenerationForm as GenerationFormLegacy,
  GenerationForm as default,
} from './GenerationForm';

// Re-export components for direct use
export { GenerationFormProvider, useGenerationForm } from './GenerationFormProvider';
export {
  TextToImageWhatIfProvider,
  useTextToImageWhatIfContext,
} from './TextToImageWhatIfProvider';
export { GenerationFormContent } from './GenerationForm2';
