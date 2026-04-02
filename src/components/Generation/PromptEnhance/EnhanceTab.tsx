import { EnhancementDetails } from './EnhancementDetails';
import {
  Alert,
  Button,
  Group,
  Loader,
  ScrollArea,
  Slider,
  Stack,
  TagsInput,
  Text,
  Textarea,
} from '@mantine/core';
import { IconCheck, IconSparkles } from '@tabler/icons-react';
import { useState } from 'react';
import * as z from 'zod';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useForm } from '~/libs/form';
import {
  GenerationFooter,
  useHasGenerationSlots,
} from '~/components/generation_v2/GenerationLayout';
import { getRootEcosystem } from '~/shared/constants/basemodel.constants';
import { showErrorNotification } from '~/utils/notifications';
import { submitPromptEnhancement, useGetPromptEnhancementHistory } from './promptEnhanceHooks';

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
  instruction?: string;
  ecosystem: string;
  triggerWords?: string[];
  onApply: (enhancedPrompt: string, enhancedNegativePrompt?: string) => void;
  onBack?: () => void;
};

function getUsedTriggerWords(
  triggerWords: string[] | undefined,
  prompt: string,
  negativePrompt?: string
): string[] {
  if (!triggerWords?.length) return [];
  const text = `${prompt} ${negativePrompt ?? ''}`.toLowerCase();
  return [...new Set(triggerWords.filter((w) => text.includes(w.toLowerCase())))];
}

export function EnhanceTab({
  prompt,
  negativePrompt,
  instruction,
  ecosystem,
  triggerWords,
  onApply,
  onBack,
}: EnhanceTabProps) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const hasSlots = useHasGenerationSlots();
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingWorkflowId, setPendingWorkflowId] = useState<string | null>(null);
  const [promptWarning, setPromptWarning] = useState<string | null>(null);
  const [preserveTriggerWords, setPreserveTriggerWords] = useState<string[]>(() =>
    getUsedTriggerWords(triggerWords, prompt, negativePrompt)
  );

  const form = useForm({
    schema: enhanceFormSchema,
    defaultValues: {
      prompt,
      negativePrompt: negativePrompt ?? '',
      instruction: instruction ?? '',
      temperature: 0.7,
    },
  });

  // Get history data — the signal handler is registered inside this hook
  const { data: records } = useGetPromptEnhancementHistory();

  // Find the result for the pending workflow from the history cache
  const result = pendingWorkflowId
    ? records.find((r) => r.workflowId === pendingWorkflowId) ?? null
    : null;

  const resultStatus = result?.status.toLowerCase();
  const isLoading =
    submitting || (pendingWorkflowId !== null && (!result || resultStatus !== 'succeeded'));

  const buildMutationInput = () => {
    const values = form.getValues();
    let orchestratorEcosystem = ecosystem;
    try {
      orchestratorEcosystem = getRootEcosystem(ecosystem).name;
    } catch {}
    return {
      ecosystem: orchestratorEcosystem,
      prompt: values.prompt,
      negativePrompt: values.negativePrompt || null,
      instruction: values.instruction || null,
      temperature: values.temperature ?? 0.7,
      preserveTriggerWords: preserveTriggerWords.length ? preserveTriggerWords : null,
    };
  };

  const handleEnhance = async () => {
    setSubmitting(true);
    try {
      const workflowId = await submitPromptEnhancement(buildMutationInput());
      setPendingWorkflowId(workflowId);
      setEditing(false);
    } catch (error: any) {
      const isFlagged = error.message?.startsWith('Your prompt was flagged');
      if (isFlagged) {
        setPromptWarning(error.message);
      } else {
        showErrorNotification({
          title: 'Enhancement failed',
          error: new Error(error.message),
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleEnhanceAgain = async () => {
    if (!result) return;
    form.setValue('prompt', result.enhancedPrompt ?? '');
    form.setValue('negativePrompt', result.enhancedNegativePrompt ?? '');
    setSubmitting(true);
    try {
      const workflowId = await submitPromptEnhancement(buildMutationInput());
      setPendingWorkflowId(workflowId);
      setEditing(false);
    } catch (error: any) {
      const isFlagged = error.message?.startsWith('Your prompt was flagged');
      if (isFlagged) {
        setPromptWarning(error.message);
      } else {
        showErrorNotification({
          title: 'Enhancement failed',
          error: new Error(error.message),
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = () => {
    if (!result) return;
    form.setValue('prompt', result.enhancedPrompt ?? '');
    form.setValue('negativePrompt', result.enhancedNegativePrompt ?? '');
    setEditing(true);
  };

  const handleBackToResult = () => {
    setEditing(false);
  };

  const handleApply = () => {
    if (!result) return;
    onApply(result.enhancedPrompt ?? '', result.enhancedNegativePrompt);
    dialog.onClose();
  };

  const handleApplyEdited = () => {
    const values = form.getValues();
    onApply(values.prompt, values.negativePrompt || undefined);
    dialog.onClose();
  };

  // Register fields managed via setValue
  form.register('temperature');
  form.register('instruction');
  form.register('negativePrompt');

  const currentPrompt = form.watch('prompt');
  const currentNegativePrompt = form.watch('negativePrompt');
  const currentTemperature = form.watch('temperature');

  const isWaitingForWorkflow =
    pendingWorkflowId !== null && (!result || resultStatus !== 'succeeded');
  const hasSucceededResult = result && resultStatus === 'succeeded';
  const showInputForm = (!isWaitingForWorkflow && !hasSucceededResult) || editing;
  const showResult = hasSucceededResult && !editing;
  const showInputFooter = showInputForm || (isLoading && !editing);

  // Footer buttons for each state
  const inputFormFooter = showInputFooter ? (
    <div className="flex gap-2">
      {editing ? (
        <Button variant="default" size="md" onClick={handleBackToResult}>
          Back to Result
        </Button>
      ) : (
        onBack && (
          <Button variant="default" size="md" onClick={onBack}>
            Back
          </Button>
        )
      )}
      <BuzzTransactionButton
        buzzAmount={ENHANCE_COST}
        label="Enhance"
        onPerformTransaction={handleEnhance}
        disabled={!currentPrompt?.trim() || !currentUser}
        loading={isLoading}
        showPurchaseModal
        size="md"
        className="flex-1"
      />
      {editing && (
        <Button size="md" onClick={handleApplyEdited} leftSection={<IconSparkles size={16} />}>
          Apply
        </Button>
      )}
    </div>
  ) : null;

  const resultFooter = showResult ? (
    <div className="flex gap-2">
      <Button variant="default" size="md" onClick={handleEdit}>
        Edit
      </Button>
      <BuzzTransactionButton
        buzzAmount={ENHANCE_COST}
        label="Enhance Again"
        onPerformTransaction={handleEnhanceAgain}
        loading={isLoading}
        showPurchaseModal
        size="md"
        variant="light"
        className="flex-1"
      />
      <Button size="md" onClick={handleApply} leftSection={<IconSparkles size={16} />}>
        Apply
      </Button>
    </div>
  ) : null;

  const warningAlert = promptWarning ? (
    <Alert color="red" title="Prohibited Prompt">
      <Text className="whitespace-pre-wrap">{promptWarning}</Text>
      <Button
        color="red"
        variant="light"
        onClick={() => setPromptWarning(null)}
        style={{ marginTop: 10 }}
        leftSection={<IconCheck />}
        fullWidth
      >
        I Understand
      </Button>
      {currentUser?.username && (
        <Text size="xs" c="dimmed" mt={4}>
          Is this a mistake?{' '}
          <Text
            component="a"
            td="underline"
            href={`https://forms.clickup.com/8459928/f/825mr-9671/KRFFR2BFKJCROV3B8Q?Civitai Username=${currentUser.username}`}
            target="_blank"
          >
            Submit your prompt for review
          </Text>{' '}
          so we can refine our system.
        </Text>
      )}
    </Alert>
  ) : null;

  const footerContent = warningAlert || inputFormFooter || resultFooter;

  return (
    <>
      <Stack gap="md" className="flex-1 overflow-y-auto overflow-x-hidden">
        {/* Input Form */}
        {showInputForm && (
          <ScrollArea className="flex-1" scrollbars="y">
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
              <Textarea
                label="Negative Prompt"
                {...form.register('negativePrompt')}
                value={currentNegativePrompt}
                onChange={(e) => form.setValue('negativePrompt', e.currentTarget.value)}
                autosize
                minRows={2}
                maxRows={4}
              />
              <Textarea
                label="Instructions"
                description='Guide how the prompt is enhanced (e.g., "expand to 77 tokens")'
                {...form.register('instruction')}
                value={form.watch('instruction')}
                onChange={(e) => form.setValue('instruction', e.currentTarget.value)}
                autosize
                minRows={2}
                maxRows={4}
                placeholder="Optional instructions..."
              />
              <TagsInput
                label="Preserve Trigger Words"
                description="These words will be preserved during enhancement"
                placeholder="Add a trigger word..."
                value={preserveTriggerWords}
                onChange={setPreserveTriggerWords}
              />
              <div className="px-2">
                <Text size="sm" fw={500} mb={4}>
                  Creativity ({currentTemperature?.toFixed(1)})
                </Text>
                <Slider
                  {...form.register('temperature')}
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
              {/* Inline footer for legacy dialog path */}
              {!hasSlots && inputFormFooter}
            </Stack>
          </ScrollArea>
        )}

        {/* Loading State */}
        {isLoading && !editing && (
          <Stack align="center" justify="center" className="flex-1" gap="md">
            <Loader size="md" />
            <Text c="dimmed" size="sm">
              Enhancing your prompt...
            </Text>
          </Stack>
        )}

        {/* Result Section */}
        {showResult && (
          <ScrollArea className="flex-1" scrollbars="y">
            <Stack gap="md" p="md">
              <EnhancementDetails record={result} />
            </Stack>
          </ScrollArea>
        )}

        {/* Inline result footer for legacy dialog path */}
        {!hasSlots && resultFooter && (
          <Group justify="flex-end" p="md" pt={0}>
            {resultFooter}
          </Group>
        )}
      </Stack>
      {footerContent && <GenerationFooter>{footerContent}</GenerationFooter>}
    </>
  );
}
