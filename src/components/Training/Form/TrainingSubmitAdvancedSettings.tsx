import {
  Accordion,
  Badge,
  Box,
  Card,
  Checkbox,
  Group,
  Stack,
  Switch,
  Text,
  Textarea,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import { IconAlertTriangle, IconCheck, IconChevronDown, IconConfetti } from '@tabler/icons-react';
import React, { useEffect, useRef, useState } from 'react';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { getPrecision } from '~/components/Training/Form/TrainingCommon';
import {
  optimizerArgMap,
  optimizerArgMapFlux,
  optimizerArgMapVideo,
  trainingSettings,
} from '~/components/Training/Form/TrainingParams';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { SelectWrapper } from '~/libs/form/components/SelectWrapper';
import { TextInputWrapper } from '~/libs/form/components/TextInputWrapper';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { audioSampleOverrideSchema } from '~/server/schema/model-version.schema';
import {
  getDefaultTrainingStateFor,
  getDefaultTrainingParams,
  type TrainingRun,
  type TrainingRunUpdate,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';
import { showInfoNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import {
  discountInfo,
  isValidRapid,
  isAiToolkitEnabled,
  isAiToolkitMandatory,
  isAudioTrainingBaseType,
  isKohyaEnabled,
  isSamplePromptsRequired,
  getDefaultEngine,
  rapidEta,
  trainingBaseModelTypesVideo,
  AI_TOOLKIT_EPOCHS,
  AI_TOOLKIT_SAVE_EVERY,
  aiToolkitStepDefault,
  aiToolkitSaveEveryDefault,
  aiToolkitBatchMax,
} from '~/utils/training';
import type { AudioSampleOverride } from '~/utils/training';
import { buildSamplePromptsFromCaptions } from '~/components/Training/Form/trainingSamplePrompts';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export const AdvancedSettings = ({
  selectedRun,
  modelId,
  mediaType,
  maxSteps,
  numImages,
}: {
  selectedRun: TrainingRun;
  modelId: number;
  mediaType: TrainingDetailsObj['mediaType'];
  maxSteps: number;
  numImages: number | undefined;
}) => {
  const { updateRun } = trainingStore;
  const features = useFeatureFlags();
  const { triggerWord, imageList } = useTrainingImageStore(
    (state) => state[modelId] ?? { ...getDefaultTrainingStateFor(mediaType) }
  );
  const previous = usePrevious(selectedRun);
  const [openedSections, setOpenedSections] = useState<string[]>([]);
  // Advanced training parameters stay locked until the user accepts that editing them
  // forfeits the refund on a poor result. Reset per run so each run is acknowledged on its
  // own (see the effect below).
  const [acknowledgedAdvanced, setAcknowledgedAdvanced] = useState(false);
  // Track runs that have already had the flag-driven default applied,
  // so switching back to a run the user manually changed won't re-override.
  const appliedDefaultEngineRuns = useRef(new Set<number>());

  useEffect(() => {
    setAcknowledgedAdvanced(false);
  }, [selectedRun.id]);

  const doUpdate = (data: TrainingRunUpdate) => {
    updateRun(modelId, mediaType, selectedRun.id, data);
  };

  const runBase = selectedRun.base;
  const isVideo = (trainingBaseModelTypesVideo as unknown as string[]).includes(
    selectedRun.baseType
  );
  const isAudio = isAudioTrainingBaseType(selectedRun.baseType);
  // Sample prompts are text descriptions across all media types — naming is the
  // only thing that varies. Audio gets the same 3-slot layout as image for now;
  // when the orchestrator switches to a different prompt format we can swap the
  // promptLabelNoun out without rewriting the loop.
  const promptLabelNoun = isAudio ? 'Sample' : isVideo ? 'Video' : 'Image';
  const numSamplePrompts = isVideo ? 2 : 3;

  useEffect(() => {
    if (previous?.id !== selectedRun.id) return;
    const defaultParams = getDefaultTrainingParams(runBase, selectedRun.params.engine);

    defaultParams.engine = selectedRun.params.engine;

    if (features.trainingStepsPricing && selectedRun.params.engine === 'ai-toolkit') {
      // Steps-based pricing: steps is set directly (not derived from repeats), batchSize
      // defaults to 1. "Save every" is the secondary knob (step interval); the saved-
      // checkpoint count (maxTrainEpochs, sent as `epochs`) is derived from it.
      defaultParams.trainBatchSize = 1;
      // Default steps to 10× dataset size, never below the ecosystem's minimum.
      defaultParams.targetSteps = Math.max(
        10 * (numImages || 1),
        aiToolkitStepDefault(selectedRun.baseType)
      );
      defaultParams.saveEvery = aiToolkitSaveEveryDefault(defaultParams.targetSteps);
      defaultParams.maxTrainEpochs = AI_TOOLKIT_EPOCHS.default;
    } else {
      const repeatsTarget = selectedRun.baseType === 'sd15' ? 400 : 200;
      defaultParams.numRepeats = Math.max(
        1,
        Math.min(5000, Math.ceil(repeatsTarget / (numImages || 1)))
      );

      if (selectedRun.params.engine !== 'rapid') {
        defaultParams.targetSteps = Math.ceil(
          ((numImages || 1) * defaultParams.numRepeats * defaultParams.maxTrainEpochs) /
            defaultParams.trainBatchSize
        );
      }
    }

    doUpdate({ params: defaultParams });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun.params.engine, features.trainingStepsPricing]);

  // Use functions to set proper starting values based on metadata.
  // numRepeats is deprecated for AI Toolkit under steps-based pricing, so skip seeding it.
  useEffect(() => {
    if (features.trainingStepsPricing && selectedRun.params.engine === 'ai-toolkit') return;
    if (selectedRun.params.numRepeats === undefined) {
      const repeatsTarget = selectedRun.baseType === 'sd15' ? 400 : 200;
      const numRepeats = Math.max(1, Math.min(5000, Math.ceil(repeatsTarget / (numImages || 1))));
      doUpdate({ params: { numRepeats } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun.id, numImages]);

  // Set targetSteps automatically on value changes.
  // Under steps-based pricing, AI Toolkit steps is set directly by the user (and drives
  // pricing), so it is NOT derived from epochs/repeats/batch.
  useEffect(() => {
    if (features.trainingStepsPricing && selectedRun.params.engine === 'ai-toolkit') return;
    const { maxTrainEpochs, numRepeats, trainBatchSize } = selectedRun.params;

    const newSteps = Math.ceil(
      ((numImages || 1) * (numRepeats ?? 200) * maxTrainEpochs) / trainBatchSize
    );

    // if (newSteps > maxSteps) {
    //   showErrorNotification({
    //     error: new Error(
    //       `Steps are beyond the maximum (${numberWithCommas(maxSteps)}. Please lower Epochs or Num Repeats, or increase Train Batch Size.`
    //     ),
    //     title: 'Too many steps',
    //   });
    // }

    if (selectedRun.params.targetSteps !== newSteps) {
      doUpdate({ params: { targetSteps: newSteps } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedRun.params.maxTrainEpochs,
    selectedRun.params.numRepeats,
    selectedRun.params.trainBatchSize,
    numImages,
  ]);

  // Steps-based pricing (AI Toolkit): the user sets the checkpoint COUNT directly
  // (maxTrainEpochs, sent as `epochs`). "Save every" (the step interval) is NOT sent to the
  // orchestrator for AI Toolkit, but we keep it consistent so the stored value matches the
  // chosen step/checkpoint combo: saveEvery = clamp(round(steps / checkpoints), min, max).
  // Recomputes when either steps or the checkpoint count changes.
  useEffect(() => {
    if (!features.trainingStepsPricing || selectedRun.params.engine !== 'ai-toolkit') return;
    const { targetSteps, maxTrainEpochs } = selectedRun.params;
    if (!maxTrainEpochs || maxTrainEpochs < 1) return;
    const saveEvery = Math.min(
      AI_TOOLKIT_SAVE_EVERY.max,
      Math.max(AI_TOOLKIT_SAVE_EVERY.min, Math.round(targetSteps / maxTrainEpochs))
    );
    if (selectedRun.params.saveEvery !== saveEvery) {
      doUpdate({ params: { saveEvery } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedRun.params.engine,
    selectedRun.params.targetSteps,
    selectedRun.params.maxTrainEpochs,
    features.trainingStepsPricing,
  ]);

  // Adjust optimizer and related settings
  useEffect(() => {
    let newOptimizerArgs: string;
    if (selectedRun.baseType === 'flux' || selectedRun.baseType === 'flux2') {
      newOptimizerArgs =
        optimizerArgMapFlux[selectedRun.params.optimizerType][selectedRun.params.engine];
    } else if (isVideo) {
      newOptimizerArgs = optimizerArgMapVideo[selectedRun.params.optimizerType] ?? '';
    } else {
      newOptimizerArgs = optimizerArgMap[selectedRun.params.optimizerType] ?? '';
    }

    const newScheduler =
      selectedRun.params.optimizerType === 'Prodigy' &&
      selectedRun.params.lrScheduler === 'cosine_with_restarts'
        ? 'cosine'
        : selectedRun.params.lrScheduler;

    const updatedParams: Record<string, unknown> = {};

    if (newOptimizerArgs !== selectedRun.params.optimizerArgs) {
      updatedParams.optimizerArgs = newOptimizerArgs;
    }
    if (newScheduler !== selectedRun.params.lrScheduler) {
      updatedParams.lrScheduler = newScheduler;
    }

    // Check if textEncoderLR is disabled for this base model (non-SD1/SDXL models)
    const textEncoderSetting = trainingSettings.find((ts) => ts.name === 'textEncoderLR');
    const textEncoderOverride =
      textEncoderSetting?.overrides?.[runBase]?.all ??
      textEncoderSetting?.overrides?.[runBase]?.[selectedRun.params.engine];
    const isTextEncoderDisabled = textEncoderOverride?.disabled === true;

    // Prodigy optimizer requires LR values set to 1
    if (selectedRun.params.optimizerType === 'Prodigy') {
      if (selectedRun.params.unetLR !== 1) {
        updatedParams.unetLR = 1;
      }
      // Only set textEncoderLR for models that support text encoder training
      if (!isTextEncoderDisabled && selectedRun.params.textEncoderLR !== 1) {
        updatedParams.textEncoderLR = 1;
      }
    } else {
      // For non-Prodigy optimizers, LR=1 is dangerously high and produces noise.
      // Reset to defaults if LR values are at Prodigy levels (e.g. after switching away).
      const defaults = getDefaultTrainingParams(runBase, selectedRun.params.engine);
      if (selectedRun.params.unetLR >= 0.1) {
        updatedParams.unetLR = defaults.unetLR;
      }
      if (selectedRun.params.textEncoderLR >= 0.1) {
        updatedParams.textEncoderLR = defaults.textEncoderLR;
      }
    }

    // Ensure textEncoderLR is 0 for models that don't support text encoder training
    if (isTextEncoderDisabled && selectedRun.params.textEncoderLR !== 0) {
      updatedParams.textEncoderLR = 0;
    }

    if (Object.keys(updatedParams).length > 0) {
      doUpdate({ params: updatedParams });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun.params.optimizerType]);

  // Adjust defaults for keepTokens
  useEffect(() => {
    if (
      triggerWord.length > 0 &&
      selectedRun.params.shuffleCaption &&
      selectedRun.params.keepTokens === 0
    ) {
      showInfoNotification({
        title: 'Keep Tokens parameter changed',
        message:
          'Using "shuffleCaption" with a trigger word usually requires a keepToken value >1.',
        autoClose: 10000,
      });
      doUpdate({ params: { keepTokens: 1 } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun.params.shuffleCaption]);

  // Pre-fill sample prompts with random captions when AI Toolkit is selected.
  // For audio, captions are XML-tagged (CAPTION/LYRICS/DURATION/LANGUAGE); we
  // strip the tags for the visible prompt and seed `samplesOverrides` from the
  // remaining fields so the user gets sensible defaults to tweak.
  useEffect(() => {
    if (selectedRun.params.engine !== 'ai-toolkit') return;

    // Check if sample prompts are already filled
    const allEmpty = selectedRun.samplePrompts.every((prompt) => !prompt || prompt.trim() === '');
    if (!allEmpty) return;

    // Get captions from uploaded images
    const captionsWithContent = imageList
      .filter((img) => img.label && img.label.trim().length > 0)
      .map((img) => img.label.trim());

    if (captionsWithContent.length === 0) return;

    // Pick + shape prompts via the shared helper so this in-memory prefill and the
    // on-demand zip fetch on Step 3 (TrainingSubmit) stay in sync.
    const { prompts, overrides } = buildSamplePromptsFromCaptions(captionsWithContent, mediaType);

    doUpdate({
      samplePrompts: prompts,
      ...(mediaType === 'audio' && { samplesOverrides: overrides }),
    });

    showInfoNotification({
      title: 'Sample prompts pre-filled',
      message: 'Sample prompts have been pre-filled with random labels from your uploaded images.',
      autoClose: 8000,
    });
    // imageList is included so the prefill re-fires if the user picks an
    // AI Toolkit model before their labels have been generated/loaded. The
    // `allEmpty` guard above prevents overwriting user-edited prompts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun.params.engine, selectedRun.id, imageList]);

  // Apply feature-flag-driven default engine once per run.
  // The store's defaultRun always uses 'kohya' because it can't access feature flags,
  // so we correct it here when:
  // 1. aiToolkitDefaultSd is enabled for sd15/sdxl
  // 2. kohyaTraining is disabled (Kohya engine unavailable)
  // Only applies once per run ID — if the user toggles engines and switches
  // between multi-train runs, their choice is preserved.
  useEffect(() => {
    if (selectedRun.params.engine !== 'kohya') return;
    if (appliedDefaultEngineRuns.current.has(selectedRun.id)) return;

    const shouldOverride =
      !isKohyaEnabled(features) ||
      (features.aiToolkitDefaultSd &&
        (selectedRun.baseType === 'sd15' || selectedRun.baseType === 'sdxl'));

    if (!shouldOverride) return;

    appliedDefaultEngineRuns.current.add(selectedRun.id);

    const newEngine = getDefaultEngine(selectedRun.baseType, selectedRun.base, features);
    const defaultParams = getDefaultTrainingParams(runBase, newEngine);
    defaultParams.engine = newEngine as typeof selectedRun.params.engine;
    const repeatsTarget = selectedRun.baseType === 'sd15' ? 400 : 200;
    defaultParams.numRepeats = Math.max(
      1,
      Math.min(5000, Math.ceil(repeatsTarget / (numImages || 1)))
    );
    defaultParams.targetSteps = Math.ceil(
      ((numImages || 1) * defaultParams.numRepeats * defaultParams.maxTrainEpochs) /
        defaultParams.trainBatchSize
    );

    doUpdate({ params: defaultParams });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun.id, features.aiToolkitDefaultSd, features.kohyaTraining]);

  const engineLabel =
    selectedRun.params.engine === 'ai-toolkit'
      ? 'AI Toolkit'
      : selectedRun.params.engine === 'rapid'
      ? 'Rapid'
      : selectedRun.params.engine === 'kohya'
      ? 'Kohya'
      : selectedRun.params.engine;

  // Steps-based pricing UI only applies to AI Toolkit when the flag is on.
  const isAiToolkit = features.trainingStepsPricing && selectedRun.params.engine === 'ai-toolkit';

  // A continuation run resumes from a prior epoch (continueFrom is the source AIR). When
  // continuing, the engine is locked and Steps is fixed — hide those controls.
  const isContinuation = !!selectedRun.params.continueFrom;

  // For AI Toolkit, lead with the two length knobs in priority order — Steps (primary)
  // then Checkpoints (maxTrainEpochs, secondary) — instead of their default array position.
  const orderedTrainingSettings = isAiToolkit
    ? [...trainingSettings].sort((a, b) => {
        const rank = (name: string) =>
          name === 'targetSteps' ? 0 : name === 'maxTrainEpochs' ? 1 : 2;
        return rank(a.name) - rank(b.name);
      })
    : trainingSettings;

  // Count non-empty prompts among the active sample slots, for the section completion badge.
  const samplePromptsRequired = isSamplePromptsRequired(
    selectedRun.baseType,
    selectedRun.params.engine
  );
  const filledSamplePrompts = Array.from({ length: numSamplePrompts }).filter(
    (_, idx) => (selectedRun.samplePrompts[idx] ?? '').trim().length > 0
  ).length;
  const samplePromptsComplete = samplePromptsRequired
    ? filledSamplePrompts >= numSamplePrompts
    : filledSamplePrompts > 0;

  // Builds a single Training Parameters row. Factored out so the same row rendering can be
  // reused both in the always-visible Steps/Checkpoints block (AI Toolkit) and inside the
  // collapsible "Advanced settings" accordion.
  const buildRow = (ts: (typeof trainingSettings)[number]) => {
    let inp: React.ReactNode;

    const baseOverride = ts.overrides?.[runBase];
    const override = baseOverride?.all ?? baseOverride?.[selectedRun.params.engine];

    const disabledOverride = override?.disabled;
    const hint = override?.hint ?? ts.hint;
    const disabled =
      selectedRun.params.engine === 'rapid'
        ? true
        : // Steps and Checkpoints are user-set knobs for AI Toolkit steps pricing.
        isAiToolkit && (ts.name === 'targetSteps' || ts.name === 'maxTrainEpochs')
        ? false
        : // Everything else is an advanced param, locked until the refund acknowledgment.
        !acknowledgedAdvanced
        ? true
        : disabledOverride ?? ts.disabled === true;

    if (ts.type === 'int' || ts.type === 'number') {
      // repeating for dumb ts
      const tOverride =
        ts.overrides?.[runBase]?.all ?? ts.overrides?.[runBase]?.[selectedRun.params.engine];

      // AI Toolkit steps-based pricing bounds: epochs = saved checkpoints (1–20),
      // batchSize capped per ecosystem.
      let inpMin = tOverride?.min ?? ts.min;
      let inpMax = tOverride?.max ?? ts.max;
      if (isAiToolkit && ts.name === 'maxTrainEpochs') {
        inpMin = AI_TOOLKIT_EPOCHS.min;
        inpMax = AI_TOOLKIT_EPOCHS.max;
      }
      if (isAiToolkit && ts.name === 'trainBatchSize') {
        inpMin = 1;
        inpMax = aiToolkitBatchMax(selectedRun.baseType);
      }

      inp = (
        <NumberInputWrapper
          min={inpMin}
          max={inpMax}
          decimalScale={ts.type === 'number' ? getPrecision(ts.step ?? ts.default) || 4 : undefined}
          step={ts.step}
          className="grow"
          disabled={disabled}
          format="default"
          value={selectedRun.params[ts.name] as number}
          onChange={(value) => {
            doUpdate({ params: { [ts.name]: value } });
          }}
        />
      );
    } else if (ts.type === 'select') {
      let options = ts.options as string[];

      // Options overrides (eventually move this to normal override)
      if (ts.name === 'lrScheduler' && selectedRun.params.optimizerType === 'Prodigy') {
        options = options.filter((o) => o !== 'cosine_with_restarts');
      }

      if (ts.name === 'optimizerType' && (isVideo || isAudio)) {
        options = options.filter((o) => o !== 'Prodigy');
      }

      if (ts.name === 'optimizerType' && selectedRun.params.engine !== 'ai-toolkit') {
        options = options.filter((o) => o !== 'Automagic');
      }

      if (ts.name === 'engine') {
        if (isAudio) {
          // Audio only supports AI Toolkit
          options = options.filter((o) => o === 'ai-toolkit');
        } else if (isVideo) {
          options = options.filter((o) => o !== 'kohya' && o !== 'rapid');
        } else {
          options = options.filter((o) => o !== 'musubi');
        }
      }

      inp = (
        <SelectWrapper
          data={options}
          disabled={disabled}
          value={selectedRun.params[ts.name] as string}
          onChange={(value) => {
            doUpdate({ params: { [ts.name]: value } });
          }}
        />
      );
    } else if (ts.type === 'bool') {
      inp = (
        <Checkbox
          py={8}
          disabled={disabled}
          checked={selectedRun.params[ts.name] as boolean}
          onChange={(event) => {
            doUpdate({ params: { [ts.name]: event.currentTarget.checked } });
          }}
        />
      );
    } else if (ts.type === 'string') {
      inp = (
        <TextInputWrapper
          disabled={disabled}
          clearable={!disabled}
          value={selectedRun.params[ts.name] as string}
          onChange={(event) => {
            doUpdate({ params: { [ts.name]: event.currentTarget.value } });
          }}
        />
      );
    }

    // Rows with their own dedicated info bubble skip the inline hint bubble to avoid a
    // double popup (the dedicated bubble carries the full explanation).
    const hasInfoBubble =
      isAiToolkit && (ts.name === 'targetSteps' || ts.name === 'maxTrainEpochs');

    // Display "Checkpoints" for the maxTrainEpochs row under AI Toolkit steps pricing
    // (display-only; the param key stays maxTrainEpochs).
    const displayLabel = isAiToolkit && ts.name === 'maxTrainEpochs' ? 'Checkpoints' : ts.label;

    // "Each image will be seen ~X times" subtext for the Steps row (AI Toolkit).
    const imagesSeen =
      isAiToolkit && ts.name === 'targetSteps' && numImages
        ? Math.round(
            (selectedRun.params.targetSteps * (selectedRun.params.trainBatchSize || 1)) /
              (numImages || 1)
          )
        : undefined;

    // The Steps help bubble travels with the "seen ~X times" subtext when that subtext is
    // shown, so the icon and subtext share a line (instead of the icon floating on the label
    // row while the subtext sits below it).
    const stepsInfoPopover =
      isAiToolkit && ts.name === 'targetSteps' ? (
        <InfoPopover size="xs" iconProps={{ size: 16 }}>
          <Stack gap={4}>
            <Text size="sm" fw={600}>
              Steps
            </Text>
            <Text size="sm">
              The total number of training steps — the main thing that drives how long training
              takes and what it costs. More steps means the LoRA learns your dataset more strongly;
              too many can{' '}
              <Text span fw={600}>
                overtrain
              </Text>{' '}
              it and introduce artifacts.
            </Text>
            <Text size="sm" c="dimmed">
              This is the primary dial — start here, then use{' '}
              <Text span fw={600}>
                Checkpoints
              </Text>{' '}
              to choose how many candidates you get along the way.
            </Text>
          </Stack>
        </InfoPopover>
      ) : null;

    const labelInner = (
      <Stack gap={2}>
        <Group gap={6} wrap="nowrap">
          <Text inline>{displayLabel}</Text>
          {/* Inline click info bubble for rows carrying a hint (no dedicated bubble). */}
          {hint && !hasInfoBubble && (
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              {hint}
            </InfoPopover>
          )}
          {/* Steps info bubble sits next to the label; the subtext renders below. */}
          {stepsInfoPopover}
          {ts.name === 'targetSteps' && selectedRun.params.targetSteps > maxSteps && (
            <Tooltip
              label={`Max steps too high. Limit: ${numberWithCommas(maxSteps)}`}
              position="bottom"
            >
              <IconAlertTriangle color="orange" size={16} />
            </Tooltip>
          )}
          {ts.name === 'trainBatchSize' &&
            ['flux', 'sd35'].includes(selectedRun.baseType) &&
            selectedRun.params.engine === 'kohya' &&
            selectedRun.params.trainBatchSize > 2 &&
            selectedRun.params.resolution > 512 && (
              <Tooltip
                label={`Batch size too high for resolution (max of 2 for >512)`}
                position="bottom"
              >
                <IconAlertTriangle color="orange" size={16} />
              </Tooltip>
            )}
          {isAiToolkit && ts.name === 'maxTrainEpochs' && (
            <InfoPopover size="xs" iconProps={{ size: 16 }}>
              <Stack gap={4}>
                <Text size="sm" fw={600}>
                  Checkpoints
                </Text>
                <Text size="sm">
                  The number of checkpoints saved during training. Each is a downloadable{' '}
                  <Text span fw={600}>
                    epoch
                  </Text>{' '}
                  you can preview and pick from after training. Default 10.
                </Text>
                <Text size="sm" c="dimmed">
                  More checkpoints gives you more candidates, with a much smaller effect on cost
                  than Steps.
                </Text>
              </Stack>
            </InfoPopover>
          )}
        </Group>
        {imagesSeen !== undefined && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            Each image seen ~{imagesSeen}×
          </Text>
        )}
      </Stack>
    );

    return {
      label: labelInner,
      value: inp,
      visible: !(
        ts.name === 'engine' ||
        (ts.name === 'optimizerArgs' && selectedRun.params.engine === 'ai-toolkit') ||
        // "Save every" is no longer surfaced for AI Toolkit steps pricing (the user sets the
        // checkpoint count directly); keep it hidden everywhere it isn't relevant.
        ts.name === 'saveEvery' ||
        // Steps pricing (AI Toolkit): user sets Checkpoints (maxTrainEpochs) directly, numRepeats
        // is deprecated, batchSize is configurable.
        // Legacy AI Toolkit keeps the old layout (batchSize hidden, numRepeats shown).
        (selectedRun.params.engine === 'ai-toolkit' &&
          (features.trainingStepsPricing ? ts.name === 'numRepeats' : ts.name === 'trainBatchSize'))
      ),
    };
  };

  return (
    <>
      {/* Active engine indicator (hidden when continuing — engine is locked) */}
      {!isContinuation && (
        <Group mt="md" gap="xs">
          <Text size="sm" fw={500}>
            Engine:
          </Text>
          <Badge
            size="sm"
            color={selectedRun.params.engine === 'ai-toolkit' ? 'blue' : 'gray'}
            variant="light"
          >
            {engineLabel}
          </Badge>
        </Group>
      )}

      {/* Flux1 can toggle Rapid Training on/off */}
      {!isContinuation && selectedRun.baseType === 'flux' && (
        <Group mt="md">
          <Switch
            label={
              <Group gap={4} wrap="nowrap">
                <InfoPopover size="xs" iconProps={{ size: 16 }}>
                  <Text>
                    Your LoRA will be trained in {<b>{rapidEta} minutes</b>} or less so you can get
                    right into generating as fast as possible.
                    {selectedRun.params.engine === 'ai-toolkit' && (
                      <> Note: AI Toolkit is currently enabled and must be disabled first.</>
                    )}
                  </Text>
                </InfoPopover>
                <Text>Rapid Training</Text>
              </Group>
            }
            labelPosition="left"
            checked={selectedRun.params.engine === 'rapid'}
            disabled={selectedRun.params.engine === 'ai-toolkit'}
            onChange={(event) =>
              updateRun(modelId, mediaType, selectedRun.id, {
                params: {
                  engine: event.currentTarget.checked
                    ? 'rapid'
                    : getDefaultEngine(selectedRun.baseType, selectedRun.base, features),
                },
              })
            }
          />
          {discountInfo.amt !== 0 && (
            <Badge
              color="pink"
              size="sm"
              pl={0}
              style={{ overflow: 'visible' }}
              leftSection={
                <ThemeIcon variant="filled" size={18} color="pink" radius="xl" ml={-8}>
                  <IconConfetti size={12} />
                </ThemeIcon>
              }
            >
              Sale
            </Badge>
          )}
        </Group>
      )}

      {/* AI Toolkit Training Toggle or Required Badge */}
      {/* Per-model AI Toolkit availability controlled via Flipt boolean flags */}
      {!isContinuation && isAiToolkitEnabled(selectedRun.baseType, features) && (
        <Group mt="md">
          {!isAiToolkitMandatory(selectedRun.baseType) && (
            // Show toggle for optional AI Toolkit
            <Switch
              label={
                <Group gap={4} wrap="nowrap">
                  <InfoPopover size="xs" iconProps={{ size: 16 }}>
                    <Text>
                      Train using the AI Toolkit engine, offering improved quality and flexibility.
                      {selectedRun.baseType === 'flux' && selectedRun.params.engine === 'rapid' && (
                        <> Note: Rapid Training is currently enabled and must be disabled first.</>
                      )}
                    </Text>
                  </InfoPopover>
                  <Text>AI Toolkit Training</Text>
                </Group>
              }
              labelPosition="left"
              checked={selectedRun.params.engine === 'ai-toolkit'}
              disabled={
                selectedRun.params.engine === 'rapid' ||
                // Can't toggle off AI Toolkit when Kohya is unavailable (no fallback engine)
                (!isKohyaEnabled(features) && selectedRun.params.engine === 'ai-toolkit')
              }
              onChange={(event) => {
                const newEngine = event.currentTarget.checked
                  ? 'ai-toolkit'
                  : getDefaultEngine(selectedRun.baseType, selectedRun.base, features, {
                      ignoreDefaultPreference: true,
                    });

                updateRun(modelId, mediaType, selectedRun.id, {
                  params: { ...selectedRun.params, engine: newEngine },
                });
              }}
            />
          )}
        </Group>
      )}

      {/* Always-visible Steps & Checkpoints for AI Toolkit steps pricing. Rendered with the
          same separated-accordion card as "Training Parameters" below for visual consistency,
          but expanded by default so the core knobs stay visible. Steps stays editable when
          continuing from a prior epoch so the user can train more/fewer additional steps. */}
      {isAiToolkit && (
        <Accordion
          variant="separated"
          defaultValue="training"
          mt="md"
          classNames={{
            content: 'p-0',
            item: 'overflow-hidden shadow-sm border-gray-3 dark:border-dark-4',
            control: 'py-4 pl-4 pr-2',
          }}
        >
          <Accordion.Item value="training">
            <Accordion.Control>
              <Text>Training Settings</Text>
            </Accordion.Control>
            <Accordion.Panel>
              {/* withBorder=false avoids doubling the table border against the accordion item;
                  border-t adds back just the divider between the header and the first row. */}
              <DescriptionTable
                withBorder={false}
                paperProps={{
                  style: { borderTop: '1px solid var(--mantine-color-default-border)' },
                }}
                labelWidth="200px"
                items={orderedTrainingSettings
                  .filter((ts) => ts.name === 'maxTrainEpochs' || ts.name === 'targetSteps')
                  .map(buildRow)}
              />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}

      <Title mt="md" order={5}>
        Advanced Settings
      </Title>

      <Accordion
        variant="separated"
        multiple
        mt="xs"
        onChange={setOpenedSections}
        classNames={{
          content: 'p-0',
          item: 'overflow-hidden shadow-sm border-gray-3 dark:border-dark-4',
          control: 'py-4 pl-4 pr-2',
        }}
      >
        <Accordion.Item value="custom-prompts">
          <Accordion.Control>
            <Stack gap={4}>
              <Group gap="sm">
                <Text>Sample Media Prompts</Text>
                {samplePromptsComplete ? (
                  <Badge color="green" size="sm" leftSection={<IconCheck size={12} />}>
                    {filledSamplePrompts}/{numSamplePrompts} ready
                  </Badge>
                ) : samplePromptsRequired ? (
                  <Badge color="red" size="sm">
                    Required · {filledSamplePrompts}/{numSamplePrompts} ready
                  </Badge>
                ) : (
                  filledSamplePrompts > 0 && (
                    <Badge color="gray" size="sm">
                      {filledSamplePrompts}/{numSamplePrompts} ready
                    </Badge>
                  )
                )}
              </Group>
              {openedSections.includes('custom-prompts') && (
                <Text size="xs" c="dimmed">
                  {isSamplePromptsRequired(selectedRun.baseType, selectedRun.params.engine)
                    ? `This model requires sample prompts. These are pre-filled from your captions.`
                    : `Set your own prompts for any of the ${numSamplePrompts} sample ${
                        isAudio ? 'clips' : isVideo ? 'videos' : 'images'
                      } we generate for each epoch.`}
                </Text>
              )}
            </Stack>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack p="sm">
              {Array.from({ length: numSamplePrompts }).map((_, idx) => {
                const required = isSamplePromptsRequired(
                  selectedRun.baseType,
                  selectedRun.params.engine
                );
                const current = selectedRun.samplePrompts[idx] ?? '';
                const override = selectedRun.samplesOverrides?.[idx] ?? {};
                const setPromptAt = (value: string) => {
                  const next = [...selectedRun.samplePrompts];
                  next[idx] = value;
                  doUpdate({ samplePrompts: next });
                };
                const setOverrideAt = (patch: Partial<AudioSampleOverride>) => {
                  const next: AudioSampleOverride[] = Array.from(
                    { length: numSamplePrompts },
                    (_v, i) => ({ ...(selectedRun.samplesOverrides?.[i] ?? {}) })
                  );
                  next[idx] = { ...next[idx], ...patch };
                  // Drop undefined / empty-string keys so we send a tight object.
                  for (const k of Object.keys(next[idx]) as (keyof AudioSampleOverride)[]) {
                    const v = next[idx][k];
                    if (v === undefined || v === '' || v === null) delete next[idx][k];
                  }
                  doUpdate({ samplesOverrides: next });
                };
                // Derive per-field errors from the same zod schema the server uses,
                // so out-of-range values surface inline instead of as a vague popup
                // after submit.
                const overrideIssues: Partial<Record<keyof AudioSampleOverride, string>> = isAudio
                  ? (() => {
                      const parsed = audioSampleOverrideSchema.safeParse(override);
                      if (parsed.success) return {};
                      const map: Partial<Record<keyof AudioSampleOverride, string>> = {};
                      for (const issue of parsed.error.issues) {
                        const key = issue.path[0] as keyof AudioSampleOverride | undefined;
                        if (key && !map[key]) map[key] = issue.message;
                      }
                      return map;
                    })()
                  : {};
                return (
                  <Stack key={idx} gap="xs">
                    <Textarea
                      label={`${promptLabelNoun} #${idx + 1}`}
                      placeholder={
                        required ? 'Required - pre-filled from captions' : 'Automatically set'
                      }
                      value={current}
                      required={required}
                      error={required && !current.trim() ? 'Required' : undefined}
                      autosize
                      minRows={1}
                      maxRows={6}
                      onChange={(event) => setPromptAt(event.currentTarget.value)}
                    />
                    {isAudio && (
                      <Card withBorder p="sm" radius="sm">
                        <Stack gap="xs">
                          <Text size="xs" c="dimmed">
                            Optional overrides for this sample. Leave blank to use the model
                            defaults.
                          </Text>
                          <Textarea
                            label="Lyrics"
                            autosize
                            minRows={2}
                            maxRows={6}
                            placeholder="[Verse]&#10;...&#10;[Chorus]&#10;..."
                            value={override.lyrics ?? ''}
                            error={overrideIssues.lyrics}
                            onChange={(e) => setOverrideAt({ lyrics: e.currentTarget.value })}
                          />
                          <Group grow wrap="wrap" align="flex-start">
                            <NumberInputWrapper
                              label="Duration (s)"
                              min={1}
                              max={360}
                              value={override.duration ?? ''}
                              error={overrideIssues.duration}
                              onChange={(v) =>
                                setOverrideAt({ duration: typeof v === 'number' ? v : undefined })
                              }
                            />
                            <NumberInputWrapper
                              label="BPM"
                              min={20}
                              max={300}
                              value={override.bpm ?? ''}
                              error={overrideIssues.bpm}
                              onChange={(v) =>
                                setOverrideAt({ bpm: typeof v === 'number' ? v : undefined })
                              }
                            />
                            <TextInputWrapper
                              label="Time signature"
                              placeholder="4"
                              value={override.timeSignature ?? ''}
                              error={overrideIssues.timeSignature}
                              onChange={(e) =>
                                setOverrideAt({ timeSignature: e.currentTarget.value })
                              }
                            />
                          </Group>
                          <Group grow wrap="wrap" align="flex-start">
                            <TextInputWrapper
                              label="Language"
                              placeholder="en"
                              value={override.language ?? ''}
                              error={overrideIssues.language}
                              onChange={(e) => setOverrideAt({ language: e.currentTarget.value })}
                            />
                            <TextInputWrapper
                              label="Key"
                              placeholder="A minor"
                              value={override.key ?? ''}
                              error={overrideIssues.key}
                              onChange={(e) => setOverrideAt({ key: e.currentTarget.value })}
                            />
                          </Group>
                          <Group grow wrap="wrap" align="flex-start">
                            <NumberInputWrapper
                              label="Instrumental weight"
                              min={0}
                              max={1}
                              step={0.1}
                              decimalScale={2}
                              value={override.instrumentalWeight ?? ''}
                              error={overrideIssues.instrumentalWeight}
                              onChange={(v) =>
                                setOverrideAt({
                                  instrumentalWeight: typeof v === 'number' ? v : undefined,
                                })
                              }
                            />
                            <NumberInputWrapper
                              label="Vocal weight"
                              min={0}
                              max={1}
                              step={0.1}
                              decimalScale={2}
                              value={override.vocalWeight ?? ''}
                              error={overrideIssues.vocalWeight}
                              onChange={(v) =>
                                setOverrideAt({
                                  vocalWeight: typeof v === 'number' ? v : undefined,
                                })
                              }
                            />
                          </Group>
                          <Group grow wrap="wrap" align="flex-start">
                            <NumberInputWrapper
                              label="Steps"
                              min={1}
                              max={200}
                              value={override.steps ?? ''}
                              error={overrideIssues.steps}
                              onChange={(v) =>
                                setOverrideAt({ steps: typeof v === 'number' ? v : undefined })
                              }
                            />
                            <NumberInputWrapper
                              label="CFG"
                              min={0}
                              max={20}
                              step={0.5}
                              decimalScale={2}
                              value={override.cfg ?? ''}
                              error={overrideIssues.cfg}
                              onChange={(v) =>
                                setOverrideAt({ cfg: typeof v === 'number' ? v : undefined })
                              }
                            />
                          </Group>
                        </Stack>
                      </Card>
                    )}
                  </Stack>
                );
              })}
              {/* Sample generation settings (AI Toolkit + steps pricing). Blank = defaults. */}
              {/* Nested "Advanced" dropdown, hidden by default. */}
              {features.trainingStepsPricing && selectedRun.params.engine === 'ai-toolkit' && (
                <Accordion
                  variant="separated"
                  classNames={{
                    content: 'p-0',
                    item: 'overflow-hidden border-gray-3 dark:border-dark-4',
                    control: 'py-3 px-3',
                  }}
                >
                  <Accordion.Item value="sample-advanced">
                    <Accordion.Control>
                      <Text size="sm">Advanced sample settings</Text>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <Card withBorder p="sm" radius="sm">
                        <Stack gap="xs">
                          <Text size="xs" c="dimmed">
                            Sample generation settings for the preview outputs. Leave blank to use
                            the model defaults.
                          </Text>
                          <Group grow wrap="wrap" align="flex-start">
                            <NumberInputWrapper
                              label="Sample CFG Scale"
                              min={0}
                              max={20}
                              step={0.5}
                              decimalScale={2}
                              value={selectedRun.params.sampleCfgScale ?? ''}
                              onChange={(v) =>
                                doUpdate({
                                  params: {
                                    sampleCfgScale: typeof v === 'number' ? v : undefined,
                                  },
                                })
                              }
                            />
                            <NumberInputWrapper
                              label="Sample LoRA Strength"
                              min={0}
                              max={2}
                              step={0.1}
                              decimalScale={2}
                              value={selectedRun.params.sampleStrength ?? ''}
                              onChange={(v) =>
                                doUpdate({
                                  params: {
                                    sampleStrength: typeof v === 'number' ? v : undefined,
                                  },
                                })
                              }
                            />
                          </Group>
                        </Stack>
                      </Card>
                    </Accordion.Panel>
                  </Accordion.Item>
                </Accordion>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
        {selectedRun.baseType === 'chroma' && (
          <Accordion.Item value="negative-prompt">
            <Accordion.Control>
              <Stack gap={4}>
                <Group gap="sm">
                  <Text>Negative Prompt</Text>
                  <Badge color="red" size="sm">
                    Required
                  </Badge>
                </Group>
                {openedSections.includes('negative-prompt') && (
                  <Text size="xs" c="dimmed">
                    The negative prompt helps define what should NOT appear in generated samples
                    during training.
                  </Text>
                )}
              </Stack>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack p="sm">
                <Textarea
                  label="Negative Prompt"
                  placeholder="Enter negative prompt (required for Chroma training)"
                  value={selectedRun.negativePrompt || ''}
                  onChange={(event) => {
                    doUpdate({
                      negativePrompt: event.currentTarget.value,
                    });
                  }}
                  error={
                    !selectedRun.negativePrompt?.trim()
                      ? 'Negative prompt is required for Chroma training'
                      : undefined
                  }
                  minRows={3}
                  autosize
                />
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        )}
        {isValidRapid(selectedRun.baseType, selectedRun.params.engine) ? (
          <Card withBorder mt="md" p="sm">
            <Card.Section inheritPadding withBorder py="sm">
              <Group justify="space-between">
                <Text className="text-gray-5 dark:text-gray-6">
                  Training Parameters{' '}
                  <Text component="span" size="xs" fs="italic">
                    (disabled with &quot;Rapid Training&quot;{' '}
                    {features.flux2Training ? 'or Flux.2' : ''})
                  </Text>
                </Text>
                <Box mr={4}>
                  <IconChevronDown className="text-gray-5 dark:text-gray-6" size={16} />
                </Box>
              </Group>
            </Card.Section>
          </Card>
        ) : (
          <Accordion.Item value="training-settings">
            <Accordion.Control>
              <Stack gap={4}>
                <Group gap="sm">
                  <Text>Training Parameters</Text>
                  {!!selectedRun.customModel && (
                    <InfoPopover
                      size="xs"
                      customIcon={IconAlertTriangle}
                      iconProps={{ size: 16, color: 'orange' }}
                    >
                      <Text>
                        Custom models will likely require parameter adjustments. Please carefully
                        check these before submitting.
                      </Text>
                    </InfoPopover>
                  )}
                </Group>
                {openedSections.includes('training-settings') && (
                  <Text size="xs" c="dimmed">
                    Click the info icon next to each setting for more information.
                    <br />
                    Default settings are based on your chosen model. Altering these settings may
                    cause undesirable results.
                  </Text>
                )}
              </Stack>
            </Accordion.Control>
            <Accordion.Panel>
              {/* The refund-acknowledgment card is inset (its own margin); the params table is
                  flush and borderless so it matches the Training Settings card above (no L/R
                  padding, no double border against the accordion item). */}
              <Card withBorder p="sm" radius="sm" m="sm">
                <Group gap="sm" align="flex-start" wrap="nowrap">
                  <ThemeIcon color="yellow" variant="light" radius="xl" size="md">
                    <IconAlertTriangle size={18} />
                  </ThemeIcon>
                  <Stack gap={6}>
                    <Text size="sm" fw={600}>
                      Editing advanced parameters forfeits your refund
                    </Text>
                    <Text size="xs" c="dimmed">
                      These defaults are tuned for your selected model. If you change them and the
                      result is poor, the training is non-refundable. Steps and Checkpoints above
                      are not affected.
                    </Text>
                    <Checkbox
                      checked={acknowledgedAdvanced}
                      onChange={(event) => setAcknowledgedAdvanced(event.currentTarget.checked)}
                      label="I understand and want to edit the advanced parameters"
                    />
                  </Stack>
                </Group>
              </Card>
              <DescriptionTable
                withBorder={false}
                paperProps={{
                  style: { borderTop: '1px solid var(--mantine-color-default-border)' },
                }}
                labelWidth="200px"
                items={orderedTrainingSettings
                  // Steps & Checkpoints render in the always-visible block above for AI Toolkit.
                  .filter(
                    (ts) =>
                      !(isAiToolkit && (ts.name === 'targetSteps' || ts.name === 'maxTrainEpochs'))
                  )
                  .map(buildRow)}
              />
            </Accordion.Panel>
          </Accordion.Item>
        )}
      </Accordion>
    </>
  );
};
