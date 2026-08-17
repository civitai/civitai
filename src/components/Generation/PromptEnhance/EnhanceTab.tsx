import { EnhancementDetails } from './EnhancementDetails';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Loader,
  ScrollArea,
  Slider,
  Stack,
  TagsInput,
  Text,
  Textarea,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconCheck, IconSparkles } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import * as z from 'zod';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useForm } from '~/libs/form';
import {
  GenerationFooter,
  useHasGenerationSlots,
} from '~/components/generation_v2/GenerationLayout';
import { getGenerationEcosystemsForMediaType } from '~/shared/constants/basemodel.constants';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import type { SnippetReferenceValue } from '~/shared/data-graph/schemas/snippet-schema';
import { showErrorNotification } from '~/utils/notifications';
import { submitPromptEnhancement, useGetPromptEnhancementHistory } from './promptEnhanceHooks';
import type { PromptEnhanceImage } from './promptEnhanceStore';

const ENHANCE_COST = 1;
const TEMPERATURE_STORAGE_KEY = 'prompt-enhance-temperature';
const SEGMENT_PROMPT_STORAGE_KEY = 'prompt-enhance-segment-prompt';
const SINGLE_TAKE_STORAGE_KEY = 'prompt-enhance-single-take';
const DEFAULT_TEMPERATURE = 0.7;

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
  /**
   * `snippets.targets` snapshot. Passed straight to the enhancement mutation
   * so `buildInstruction` can union the `#category` references with any
   * `preserveSnippets` overrides and emit a preservation directive.
   */
  snippetTargets?: Record<string, SnippetReferenceValue[]>;
  /**
   * Images already attached to the generation form. Offered as opt-out visual
   * context for the rewrite — checked ones go to the enhancement step's
   * `images` input, where a vision-capable model reads them.
   */
  images?: PromptEnhanceImage[];
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
  snippetTargets,
  images,
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
  // Indexes rather than urls: the same image can be attached to more than one
  // slot, and those entries have to check independently.
  const [selectedImageIndexes, setSelectedImageIndexes] = useState<number[]>(() =>
    (images ?? []).map((_, i) => i)
  );
  const [segmentPrompt, setSegmentPrompt] = useLocalStorage({
    key: SEGMENT_PROMPT_STORAGE_KEY,
    defaultValue: false,
    getInitialValueInEffect: false,
  });
  const [singleTake, setSingleTake] = useLocalStorage({
    key: SINGLE_TAKE_STORAGE_KEY,
    defaultValue: true,
    getInitialValueInEffect: false,
  });
  const isVideoEcosystem = useMemo(
    () =>
      getGenerationEcosystemsForMediaType('video').some(
        (key) => key.toLowerCase() === ecosystem.toLowerCase()
      ),
    [ecosystem]
  );
  const [storedTemperature, setStoredTemperature] = useLocalStorage({
    key: TEMPERATURE_STORAGE_KEY,
    defaultValue: DEFAULT_TEMPERATURE,
    getInitialValueInEffect: false,
  });

  const form = useForm({
    schema: enhanceFormSchema,
    defaultValues: {
      prompt,
      negativePrompt: negativePrompt ?? '',
      instruction: instruction ?? '',
      temperature: storedTemperature,
    },
  });

  // Get history data — the signal handler is registered inside this hook
  const { data: records } = useGetPromptEnhancementHistory();

  // Find the result for the pending workflow from the history cache
  const result = pendingWorkflowId
    ? records.find((r) => r.workflowId === pendingWorkflowId) ?? null
    : null;

  const resultStatus = result?.status.toLowerCase();
  const isTerminalFailure =
    resultStatus === 'failed' || resultStatus === 'canceled' || resultStatus === 'expired';
  const isLoading =
    submitting ||
    (pendingWorkflowId !== null &&
      (!result || (resultStatus !== 'succeeded' && !isTerminalFailure)));

  useEffect(() => {
    if (pendingWorkflowId && result && isTerminalFailure) {
      showErrorNotification({
        title: 'Enhancement failed',
        error: new Error('The prompt enhancement could not be completed. Please try again.'),
      });
      setPendingWorkflowId(null);
    }
  }, [pendingWorkflowId, result, isTerminalFailure]);

  const toggleImage = (index: number) =>
    setSelectedImageIndexes((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );

  const buildMutationInput = () => {
    const values = form.getValues();
    const selectedImages = (images ?? [])
      .filter((_, i) => selectedImageIndexes.includes(i))
      .map((image) => image.url);
    return {
      ecosystem,
      prompt: values.prompt,
      negativePrompt: values.negativePrompt || null,
      instruction: values.instruction || null,
      temperature: values.temperature ?? 0.7,
      preserveTriggerWords: preserveTriggerWords.length ? preserveTriggerWords : null,
      // Forward the form's `snippets.targets` snapshot. `buildInstruction`
      // flattens this to `#category` tokens and asks the LLM to preserve
      // them through the rewrite. Null when the source form didn't have a
      // snippets node (non-snippet-enabled ecosystems).
      snippetTargets: snippetTargets ?? null,
      segmentPrompt,
      // Shot structure only means something for video; sending it for image
      // ecosystems would put a stray directive in front of the analyzer, and
      // every unused line costs instruction budget.
      singleTake: isVideoEcosystem ? singleTake : null,
      images: selectedImages.length ? selectedImages : null,
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
    pendingWorkflowId !== null && (!result || (resultStatus !== 'succeeded' && !isTerminalFailure));
  const hasSucceededResult = result && resultStatus === 'succeeded';
  const showInputForm = (!isWaitingForWorkflow && !hasSucceededResult) || editing;
  const showResult = hasSucceededResult && !editing && !isLoading;
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
        accountTypes={buzzSpendTypes}
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
        accountTypes={buzzSpendTypes}
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
              {!!images?.length && (
                <div>
                  <Text size="sm" fw={500}>
                    Reference Images
                  </Text>
                  <Text size="xs" c="dimmed" mb={6}>
                    Checked images are sent along as visual context for the rewrite. Uncheck any you
                    want the enhancer to ignore.
                  </Text>
                  <div className="flex flex-wrap gap-2">
                    {images.map((image, index) => {
                      const checked = selectedImageIndexes.includes(index);
                      return (
                        <div
                          key={`${image.url}-${index}`}
                          className={clsx(
                            'relative size-20 cursor-pointer overflow-hidden rounded border-2',
                            checked ? 'border-blue-5' : 'border-transparent opacity-40'
                          )}
                          onClick={() => toggleImage(index)}
                        >
                          <img
                            src={image.url}
                            alt={`Reference image ${index + 1}`}
                            className="size-full object-cover"
                          />
                          <Checkbox
                            checked={checked}
                            onChange={() => toggleImage(index)}
                            onClick={(e) => e.stopPropagation()}
                            size="xs"
                            className="absolute left-1 top-1"
                            aria-label={`Use reference image ${index + 1}`}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <TagsInput
                label="Preserve Trigger Words"
                description="These words will be preserved during enhancement"
                placeholder="Add a trigger word..."
                value={preserveTriggerWords}
                onChange={setPreserveTriggerWords}
              />
              <Checkbox
                label="Reorganize into thematic segments"
                description="Regroup the prompt by subject, setting, style, and lighting. Enhanced prompts are already multi-line, and your own formatting is kept, so leave this off unless you want it restructured."
                checked={segmentPrompt}
                onChange={(e) => setSegmentPrompt(e.currentTarget.checked)}
              />
              {isVideoEcosystem && (
                <Checkbox
                  label="Single continuous take"
                  description="Keep the action in one unbroken shot instead of cutting between shots"
                  checked={singleTake}
                  onChange={(e) => setSingleTake(e.currentTarget.checked)}
                />
              )}
              <div className="px-2">
                <Text size="sm" fw={500} mb={4}>
                  Creativity ({currentTemperature?.toFixed(1)})
                </Text>
                <Slider
                  {...form.register('temperature')}
                  value={currentTemperature}
                  onChange={(val) => {
                    form.setValue('temperature', val);
                    setStoredTemperature(val);
                  }}
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
