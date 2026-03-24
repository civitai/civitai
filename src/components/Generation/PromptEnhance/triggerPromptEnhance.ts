import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

const PromptEnhanceDrawer = dynamic(
  () => import('~/components/Generation/PromptEnhance/PromptEnhanceDrawer')
);

import type { ResourceData } from '~/shared/data-graph/generation/common';

export type PromptEnhanceProps = {
  prompt: string;
  negativePrompt?: string;
  ecosystem: string;
  resources?: ResourceData[];
  onApply: (enhancedPrompt: string, enhancedNegativePrompt?: string) => void;
};

export function triggerPromptEnhance(props: PromptEnhanceProps) {
  dialogStore.trigger({
    id: 'prompt-enhance-drawer',
    component: PromptEnhanceDrawer,
    props,
  });
}
