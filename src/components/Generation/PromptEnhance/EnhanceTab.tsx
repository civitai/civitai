import type { PromptEnhancementOutput } from '@civitai/client';
import {
  Badge,
  Button,
  Group,
  List,
  Loader,
  ScrollArea,
  Slider,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { IconSparkles, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import * as z from 'zod';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useForm } from '~/libs/form';
import { showErrorNotification } from '~/utils/notifications';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { submitPromptEnhancement, useEnhancePromptState } from './promptEnhanceHooks';

const ENHANCE_COST = 1;

const enhanceFormSchema = z.object({
  prompt: z.string().min(1),
  negativePrompt: z.string().default(''),
  instruction: z.string().default(''),
  temperature: z.number().min(0).max(1).default(0.7),
});

type EnhanceTabProps = {
  prompt: string;
  negativePrompt?: string;
  ecosystem: string;
  resources?: ResourceData[];
  onApply: (enhancedPrompt: string, enhancedNegativePrompt?: string) => void;
};

function getUsedTriggerWords(
  resources: ResourceData[] | undefined,
  prompt: string,
  negativePrompt?: string
): string[] {
  if (!resources?.length) return [];
  const allWords = resources.flatMap((r) => r.trainedWords ?? []).filter(Boolean);
  if (!allWords.length) return [];
  const text = `${prompt} ${negativePrompt ?? ''}`.toLowerCase();
  return [...new Set(allWords.filter((w) => text.includes(w.toLowerCase())))];
}

export function EnhanceTab({
  prompt,
  negativePrompt,
  ecosystem,
  resources,
  onApply,
}: EnhanceTabProps) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const [result, setResult] = useState<PromptEnhancementOutput | null>(null);
  const [preserveTriggerWords, setPreserveTriggerWords] = useState<string[]>(() =>
    getUsedTriggerWords(resources, prompt, negativePrompt)
  );

  const removeTriggerWord = (word: string) => {
    setPreserveTriggerWords((prev) => prev.filter((w) => w !== word));
  };

  const form = useForm({
    schema: enhanceFormSchema,
    defaultValues: {
      prompt,
      negativePrompt: negativePrompt ?? '',
      instruction: '',
      temperature: 0.7,
    },
  });

  const { isLoading } = useEnhancePromptState();

  const buildMutationInput = () => {
    const values = form.getValues();
    return {
      ecosystem,
      prompt: values.prompt,
      negativePrompt: values.negativePrompt || null,
      instruction: values.instruction || null,
      temperature: values.temperature ?? 0.7,
      preserveTriggerWords: preserveTriggerWords.length ? preserveTriggerWords : null,
    };
  };

  const handleEnhance = async () => {
    try {
      const data = await submitPromptEnhancement(buildMutationInput());
      if (data.output) {
        setResult(data.output);
      } else {
        showErrorNotification({
          title: 'Enhancement failed',
          error: new Error('No output returned from prompt enhancement'),
        });
      }
    } catch (error: any) {
      showErrorNotification({
        title: 'Enhancement failed',
        error: new Error(error.message),
      });
    }
  };

  const handleEnhanceAgain = async () => {
    if (!result) return;
    form.setValue('prompt', result.enhancedPrompt);
    if (result.enhancedNegativePrompt) {
      form.setValue('negativePrompt', result.enhancedNegativePrompt);
    }
    setResult(null);
    try {
      const data = await submitPromptEnhancement(buildMutationInput());
      if (data.output) {
        setResult(data.output);
      }
    } catch (error: any) {
      showErrorNotification({
        title: 'Enhancement failed',
        error: new Error(error.message),
      });
    }
  };

  const handleApply = () => {
    if (!result) return;
    onApply(result.enhancedPrompt, result.enhancedNegativePrompt ?? undefined);
    dialog.onClose();
  };

  // Register fields managed via setValue (not native inputs) so shouldUnregister doesn't clear them
  form.register('temperature');
  form.register('instruction');
  form.register('negativePrompt');

  const currentPrompt = form.watch('prompt');
  const currentNegativePrompt = form.watch('negativePrompt');
  const currentTemperature = form.watch('temperature');

  return (
    <Stack gap="md" className="flex-1 overflow-y-auto overflow-x-hidden">
      {/* Input Section */}
      {!result && !isLoading && (
        <ScrollArea className="flex-1">
          <Stack gap="md" p="md">
            <Textarea
              label="Prompt"
              {...form.register('prompt')}
              value={currentPrompt}
              onChange={(e) => form.setValue('prompt', e.currentTarget.value)}
              autosize
              minRows={3}
              maxRows={8}
            />
            {(currentNegativePrompt || negativePrompt) && (
              <Textarea
                label="Negative Prompt"
                value={currentNegativePrompt}
                onChange={(e) => form.setValue('negativePrompt', e.currentTarget.value)}
                autosize
                minRows={2}
                maxRows={4}
              />
            )}
            {preserveTriggerWords.length > 0 && (
              <div>
                <Text size="sm" fw={500} mb={4}>
                  Preserve Trigger Words
                </Text>
                <Group gap={6}>
                  {preserveTriggerWords.map((word) => (
                    <Badge
                      key={word}
                      variant="light"
                      rightSection={
                        <IconX
                          size={12}
                          className="cursor-pointer"
                          onClick={() => removeTriggerWord(word)}
                        />
                      }
                    >
                      {word}
                    </Badge>
                  ))}
                </Group>
              </div>
            )}
            <Textarea
              label="Instructions"
              description='Guide how the prompt is enhanced (e.g., "expand to 77 tokens", "keep it under 20 words")'
              value={form.watch('instruction')}
              onChange={(e) => form.setValue('instruction', e.currentTarget.value)}
              autosize
              minRows={1}
              maxRows={3}
              placeholder="Optional instructions..."
            />
            <div className="px-2">
              <Text size="sm" fw={500} mb={4}>
                Creativity ({currentTemperature?.toFixed(1)})
              </Text>
              <Slider
                value={currentTemperature}
                onChange={(val) => form.setValue('temperature', val)}
                min={0}
                max={1}
                step={0.1}
                marks={[
                  { value: 0, label: 'Precise' },
                  { value: 1, label: 'Creative' },
                ]}
                mb="md"
              />
            </div>
            <Group justify="flex-end">
              <BuzzTransactionButton
                buzzAmount={ENHANCE_COST}
                label="Enhance"
                onPerformTransaction={handleEnhance}
                disabled={!currentPrompt?.trim() || !currentUser}
                loading={isLoading}
                showPurchaseModal
                size="md"
              />
            </Group>
          </Stack>
        </ScrollArea>
      )}

      {/* Loading State */}
      {isLoading && (
        <Stack align="center" justify="center" className="flex-1" gap="md">
          <Loader size="md" />
          <Text c="dimmed" size="sm">
            Enhancing your prompt...
          </Text>
        </Stack>
      )}

      {/* Result Section */}
      {result && !isLoading && (
        <>
          <ScrollArea className="flex-1">
            <Stack gap="md" p="md">
              <div>
                <Text size="sm" fw={600} mb={4}>
                  Enhanced Prompt
                </Text>
                <Text
                  size="sm"
                  className="whitespace-pre-wrap rounded-md bg-gray-1 p-3 dark:bg-dark-6"
                >
                  {result.enhancedPrompt}
                </Text>
              </div>

              {result.enhancedNegativePrompt && (
                <div>
                  <Text size="sm" fw={600} mb={4}>
                    Enhanced Negative Prompt
                  </Text>
                  <Text
                    size="sm"
                    className="whitespace-pre-wrap rounded-md bg-gray-1 p-3 dark:bg-dark-6"
                  >
                    {result.enhancedNegativePrompt}
                  </Text>
                </div>
              )}

              {result.issues.length > 0 && (
                <div>
                  <Text size="sm" fw={600} mb={4}>
                    Issues Found
                  </Text>
                  <List size="sm" spacing={4}>
                    {result.issues.map((issue, i) => (
                      <List.Item key={i}>
                        <Group gap={6} align="center" wrap="nowrap">
                          <IssueBadge severity={issue.severity} />
                          <Text size="sm">{issue.description}</Text>
                        </Group>
                      </List.Item>
                    ))}
                  </List>
                </div>
              )}

              {result.recommendations.length > 0 && (
                <div>
                  <Text size="sm" fw={600} mb={4}>
                    Recommendations
                  </Text>
                  <List size="sm" spacing={4}>
                    {result.recommendations.map((rec, i) => (
                      <List.Item key={i}>
                        <Text size="sm">{rec}</Text>
                      </List.Item>
                    ))}
                  </List>
                </div>
              )}
            </Stack>
          </ScrollArea>

          <Group justify="flex-end" p="md" pt={0}>
            <BuzzTransactionButton
              buzzAmount={ENHANCE_COST}
              label="Enhance Again"
              onPerformTransaction={handleEnhanceAgain}
              loading={isLoading}
              showPurchaseModal
              size="md"
              variant="light"
            />
            <Button onClick={handleApply} leftSection={<IconSparkles size={16} />}>
              Apply
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}

function IssueBadge({ severity }: { severity?: string | null }) {
  const color = severity === 'error' ? 'red' : severity === 'warning' ? 'yellow' : 'blue';
  const label = severity ?? 'info';

  return (
    <Badge size="xs" color={color} variant="light">
      {label}
    </Badge>
  );
}
