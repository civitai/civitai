import type { PromptEnhancementOutput } from '@civitai/client';
import {
  Badge,
  Button,
  Group,
  List,
  Loader,
  Modal,
  ScrollArea,
  Slider,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const ENHANCE_COST = 1;

type PromptEnhanceModalProps = {
  prompt: string;
  negativePrompt?: string;
  ecosystem: string;
  onApply: (enhancedPrompt: string, enhancedNegativePrompt?: string) => void;
};

export function PromptEnhanceModal({
  prompt: initialPrompt,
  negativePrompt: initialNegativePrompt,
  ecosystem,
  onApply,
}: PromptEnhanceModalProps) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();

  const [prompt, setPrompt] = useState(initialPrompt);
  const [negativePrompt, setNegativePrompt] = useState(initialNegativePrompt ?? '');
  const [instruction, setInstruction] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [result, setResult] = useState<PromptEnhancementOutput | null>(null);

  const enhanceMutation = trpc.orchestrator.enhancePrompt.useMutation({
    onSuccess: (data) => {
      if (data.output) {
        setResult(data.output);
      } else {
        showErrorNotification({
          title: 'Enhancement failed',
          error: new Error('No output returned from prompt enhancement'),
        });
      }
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Enhancement failed',
        error: new Error(error.message),
      });
    },
  });

  const getMutationInput = (p: string, np: string) => ({
    ecosystem,
    prompt: p,
    negativePrompt: np || null,
    instruction: instruction || null,
    temperature,
  });

  const handleEnhance = () => {
    enhanceMutation.mutate(getMutationInput(prompt, negativePrompt));
  };

  const handleEnhanceAgain = () => {
    if (!result) return;
    const newPrompt = result.enhancedPrompt;
    const newNegative = result.enhancedNegativePrompt ?? negativePrompt;
    setPrompt(newPrompt);
    if (result.enhancedNegativePrompt) {
      setNegativePrompt(result.enhancedNegativePrompt);
    }
    setResult(null);
    enhanceMutation.mutate(getMutationInput(newPrompt, newNegative));
  };

  const handleApply = () => {
    if (!result) return;
    onApply(result.enhancedPrompt, result.enhancedNegativePrompt ?? undefined);
    dialog.onClose();
  };

  return (
    <Modal {...dialog} title="Enhance Prompt" size="lg" centered>
      <Stack gap="md">
        {/* Input Section */}
        {!result && !enhanceMutation.isLoading && (
          <>
            <Textarea
              label="Prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              autosize
              minRows={3}
              maxRows={8}
            />
            {(negativePrompt || initialNegativePrompt) && (
              <Textarea
                label="Negative Prompt"
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.currentTarget.value)}
                autosize
                minRows={2}
                maxRows={4}
              />
            )}
            <Textarea
              label="Instructions"
              description="Guide how the prompt is enhanced (e.g., &quot;expand to 77 tokens&quot;, &quot;keep it under 20 words&quot;)"
              value={instruction}
              onChange={(e) => setInstruction(e.currentTarget.value)}
              autosize
              minRows={1}
              maxRows={3}
              placeholder="Optional instructions..."
            />
            <div>
              <Text size="sm" fw={500} mb={4}>
                Creativity ({temperature.toFixed(1)})
              </Text>
              <Slider
                value={temperature}
                onChange={setTemperature}
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
              <Button variant="default" onClick={dialog.onClose}>
                Cancel
              </Button>
              <BuzzTransactionButton
                buzzAmount={ENHANCE_COST}
                label="Enhance"
                onPerformTransaction={handleEnhance}
                disabled={!prompt.trim() || !currentUser}
                loading={enhanceMutation.isLoading}
                showPurchaseModal
                size="md"
              />
            </Group>
          </>
        )}

        {/* Loading State */}
        {enhanceMutation.isLoading && (
          <Stack align="center" py="xl" gap="md">
            <Loader size="md" />
            <Text c="dimmed" size="sm">
              Enhancing your prompt...
            </Text>
          </Stack>
        )}

        {/* Result Section */}
        {result && !enhanceMutation.isLoading && (
          <>
            <ScrollArea.Autosize mah={400}>
              <Stack gap="md">
                {/* Enhanced Prompt */}
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

                {/* Enhanced Negative Prompt */}
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

                {/* Issues */}
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

                {/* Recommendations */}
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
            </ScrollArea.Autosize>

            <Group justify="flex-end">
              <Button variant="default" onClick={dialog.onClose}>
                Cancel
              </Button>
              <BuzzTransactionButton
                buzzAmount={ENHANCE_COST}
                label="Enhance Again"
                onPerformTransaction={handleEnhanceAgain}
                loading={enhanceMutation.isLoading}
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
    </Modal>
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
