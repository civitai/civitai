import type { ResourceData } from '~/shared/generation/values';
import type { SnippetReferenceValue } from '~/shared/generation/schemas/snippet-schema';
import { usePromptEnhanceStore, type PromptEnhanceImage } from './promptEnhanceStore';

export type PromptEnhanceProps = {
  prompt: string;
  negativePrompt?: string;
  ecosystem: string;
  resources?: ResourceData[];
  images?: PromptEnhanceImage[];
  onApply: (enhancedPrompt: string, enhancedNegativePrompt?: string) => void;
};

/**
 * Trigger prompt enhancement by capturing form state and switching to the
 * prompt:enhance workflow. Extracts trigger words from resources at trigger time.
 * Used by the new generation form (graph-based).
 */
export function triggerPromptEnhance(
  data: {
    prompt: string;
    negativePrompt?: string;
    ecosystem: string;
    resources?: ResourceData[];
    /**
     * `snippets.targets` map at trigger time. The form reads this off the
     * graph snapshot and forwards it untouched so the enhancement
     * mutation can preserve every `#category` reference through the LLM.
     */
    snippetTargets?: Record<string, SnippetReferenceValue[]>;
    /**
     * The form's attached images at trigger time. Offered in the enhance form
     * as opt-out visual context for the rewrite.
     */
    images?: PromptEnhanceImage[];
  },
  setWorkflow: (workflow: string) => void
) {
  const triggerWords = [
    ...new Set((data.resources ?? []).flatMap((r) => r.trainedWords ?? []).filter(Boolean)),
  ];

  usePromptEnhanceStore.getState().setData({
    prompt: data.prompt,
    negativePrompt: data.negativePrompt,
    ecosystem: data.ecosystem,
    triggerWords,
    snippetTargets: data.snippetTargets,
    images: data.images,
  });
  setWorkflow('prompt:enhance');
}
