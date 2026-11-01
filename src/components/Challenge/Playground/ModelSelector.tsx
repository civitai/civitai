import { Select } from '@mantine/core';
import { usePlaygroundStore } from './playground.store';

// Mod-only playground — list every model wired into AI_MODELS for testing.
// Vision-capable models work for all flows; text-only models will fail on
// generateArticle / generateReview (they send image_url).
const MODEL_OPTIONS = [
  { value: 'civitai/qwen3.8', label: 'Qwen 3.8 — pipeline default (Civitai orchestrator)' },
  { value: 'openai/gpt-6-luna', label: 'GPT-6 Luna — pipeline fallback (openai/gpt-6-luna)' },
  { value: 'xiaomi/mimo-v2.5', label: 'MiMo v2.5 (xiaomi/mimo-v2.5)' },
  { value: 'x-ai/grok-4.3', label: 'Grok 4.3 (x-ai/grok-4.3)' },
  { value: 'openai/gpt-4o', label: 'GPT-4o (openai/gpt-4o)' },
  { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4 (anthropic/claude-sonnet-4)' },
  { value: 'anthropic/claude-3-5-haiku', label: 'Claude 3.5 Haiku (anthropic/claude-3-5-haiku)' },
  { value: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5 — text only (moonshotai/kimi-k2.5)' },
  {
    value: 'stepfun/step-3.5-flash',
    label: 'StepFun 3.5 Flash — text only (stepfun/step-3.5-flash)',
  },
];

export function ModelSelector() {
  const aiModel = usePlaygroundStore((s) => s.aiModel);
  const setAiModel = usePlaygroundStore((s) => s.setAiModel);

  return (
    <Select
      label="AI Model"
      data={MODEL_OPTIONS}
      value={aiModel}
      onChange={(val) => {
        if (val) setAiModel(val);
      }}
    />
  );
}
