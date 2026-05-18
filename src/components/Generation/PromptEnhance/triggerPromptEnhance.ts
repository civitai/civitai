import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import type { SnippetReferenceValue } from '~/shared/data-graph/schemas/snippet-schema';
import { usePromptEnhanceStore } from './promptEnhanceStore';

const PromptEnhanceDrawer = dynamic(
  () => import('~/components/Generation/PromptEnhance/PromptEnhanceDrawer')
);

export type PromptEnhanceProps = {
  prompt: string;
  negativePrompt?: string;
  ecosystem: string;
  resources?: ResourceData[];
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
  });
  setWorkflow('prompt:enhance');
}

/**
 * Trigger prompt enhancement via a dialog drawer.
 * Used by the legacy generation form (non-graph).
 */
export function triggerPromptEnhanceDialog(props: PromptEnhanceProps) {
  dialogStore.trigger({
    id: 'prompt-enhance-drawer',
    component: PromptEnhanceDrawer,
    props,
  });
}
