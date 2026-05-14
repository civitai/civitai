import { Select } from '@mantine/core';
import { usePlaygroundStore } from './playground.store';

// Mod-only playground — list every model wired into AI_MODELS for testing.
// Vision-capable models work for all flows; text-only models will fail on
// generateArticle / generateReview (they send image_url).
const MODEL_OPTIONS = [
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini (openai/gpt-4o-mini)' },
  { value: 'openai/gpt-5-nano', label: 'GPT-5 Nano (openai/gpt-5-nano)' },
  { value: 'openai/gpt-4o', label: 'GPT-4o (openai/gpt-4o)' },
  { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4 (anthropic/claude-sonnet-4)' },
  { value: 'anthropic/claude-3-5-haiku', label: 'Claude 3.5 Haiku (anthropic/claude-3-5-haiku)' },
  { value: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5 — text only (moonshotai/kimi-k2.5)' },
  {
    value: 'stepfun/step-3.5-flash',
    label: 'StepFun 3.5 Flash — text only (stepfun/step-3.5-flash)',
  },
  {
    value: 'urn:air:qwen3:repository:huggingface:Civitai/Qwen3.6-35B-A3B-Abliterated-AWQ@main.tar',
    label: 'Qwen 35B (Civitai orchestrator)',
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
