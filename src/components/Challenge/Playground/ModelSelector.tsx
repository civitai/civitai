import { Select, TextInput, Stack } from '@mantine/core';
import { usePlaygroundStore } from './playground.store';

const MODEL_OPTIONS = [
  { value: 'x-ai/grok-4.1-fast', label: 'Grok (x-ai/grok-4.1-fast)' },
  { value: 'moonshotai/kimi-k2.5', label: 'Kimi (moonshotai/kimi-k2.5)' },
  { value: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet (anthropic/claude-sonnet-4)' },
  { value: 'openai/gpt-4o', label: 'GPT-4o (openai/gpt-4o)' },
  { value: '__other__', label: 'Other...' },
];

export function ModelSelector() {
  const aiModel = usePlaygroundStore((s) => s.aiModel);
  const customModelId = usePlaygroundStore((s) => s.customModelId);
  const setAiModel = usePlaygroundStore((s) => s.setAiModel);
  const setCustomModelId = usePlaygroundStore((s) => s.setCustomModelId);

  const isOther = !MODEL_OPTIONS.some((o) => o.value === aiModel && o.value !== '__other__');
  const selectValue = isOther ? '__other__' : aiModel;

  return (
    <Stack gap="xs">
      <Select
        label="AI Model"
        data={MODEL_OPTIONS}
        value={selectValue}
        onChange={(val) => {
          if (val === '__other__') {
            setAiModel(customModelId || '');
          } else if (val) {
            setAiModel(val);
          }
        }}
      />
      {isOther && (
        <TextInput
          placeholder="e.g. google/gemini-2.5-pro"
          value={customModelId}
          onChange={(e) => {
            const val = e.currentTarget.value;
            setCustomModelId(val);
            setAiModel(val);
          }}
        />
      )}
    </Stack>
  );
}
