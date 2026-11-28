import { Select } from '@mantine/core';
import { usePlaygroundStore } from './playground.store';

// Mod-only playground — list every model wired into AI_MODELS for testing.
// Vision-capable models work for all flows; text-only models will fail on
// generateArticle / generateReview (they send image_url).
const MODEL_OPTIONS = [
  { value: 'civitai/qwen3.8', label: 'Qwen 3.8 — pipeline default (Civitai orchestrator)' },
  { value: 'openai/gpt-6-luna', label: 'GPT-6 Luna — pipeline fallback (openai/gpt-6-luna)' },
  { value: 'xiaomi/mimo-v2.6-flash', label: 'MiMo v2.6 Flash (xiaomi/mimo-v2.6-flash)' },
  { value: 'x-ai/grok-4.3', label: 'Grok 4.3 (x-ai/grok-4.3)' },
  { value: 'openai/gpt-4o', label: 'GPT-4o (openai/gpt-4o)' },
  {
    value: 'anthropic/claude-sonnet-5.5',
    label: 'Claude Sonnet 5.5 (anthropic/claude-sonnet-5.5)',
  },
  { value: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5 (anthropic/claude-haiku-5.5)' },
  { value: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5 — text only (moonshotai/kimi-k2.5)' },
  { value: 'stepfun/step-3.7-flash', label: 'StepFun 3.7 Flash (stepfun/step-3.7-flash)' },
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
