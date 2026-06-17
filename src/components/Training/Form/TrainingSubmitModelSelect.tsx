import type { MantineColor } from '@mantine/core';
import {
  Anchor,
  Badge,
  Card,
  Group,
  Indicator,
  Input,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertCircle, IconExclamationCircle } from '@tabler/icons-react';
import { openConfirmModal } from '@mantine/modals';
import React from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { ResourceSelect } from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import { blockedCustomModels } from '~/components/Training/Form/TrainingCommon';
import { useTrainingServiceStatus } from '~/components/Training/training.utils';
import { trpc } from '~/utils/trpc';
import type {
  TrainingDetailsBaseModelList,
  TrainingDetailsObj,
} from '~/server/schema/model-version.schema';
import {
  trainingDetailsBaseModels15,
  // trainingDetailsBaseModels35,
  trainingDetailsBaseModelsAcestep15,
  trainingDetailsBaseModelsAcestep15Xl,
  trainingDetailsBaseModelsAnima,
  trainingDetailsBaseModelsChroma,
  trainingDetailsBaseModelsErnie,
  trainingDetailsBaseModelsFlux,
  trainingDetailsBaseModelsFlux2,
  trainingDetailsBaseModelsFlux2Klein,
  trainingDetailsBaseModelsHiDreamO1,
  trainingDetailsBaseModelsHunyuan,
  trainingDetailsBaseModelsLtx2,
  trainingDetailsBaseModelsLtx23,
  trainingDetailsBaseModelsQwen,
  trainingDetailsBaseModelsWan,
  trainingDetailsBaseModelsXL,
  trainingDetailsBaseModelsZImage,
} from '~/server/schema/model-version.schema';
import { ModelType } from '~/shared/utils/prisma/enums';
import type { TrainingRun, TrainingRunUpdate } from '~/store/training.store';
import {
  defaultBase,
  defaultBaseType,
  defaultBaseTypeVideo,
  defaultBaseVideo,
  defaultEngine,
  defaultEngineVideo,
  getDefaultTrainingParams,
  trainingStore,
} from '~/store/training.store';
import { getAirModelLink, stringifyAIR } from '~/shared/utils/air';
import {
  type AudioSampleOverride,
  AI_TOOLKIT_EPOCHS,
  aiToolkitStepDefault,
  aiToolkitSaveEveryDefault,
  getDefaultEngine,
  isSamplePromptsRequired,
  parseAudioCaption,
  type TrainingBaseModelType,
  trainingModelInfo,
} from '~/utils/training';
import { getBaseModelsByGroup } from '~/shared/constants/basemodel.constants';
import { useTrainingImageStore } from '~/store/training.store';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const ModelSelector = ({
  selectedRun,
  color,
  name,
  value,
  baseType,
  makeDefaultParams,
  isNew = false,
  isCustom = false,
  isVideo = false,
  allowedKeys,
}: {
  selectedRun: TrainingRun;
  color: MantineColor;
  name: string;
  value: string | null;
  baseType: TrainingBaseModelType;
  makeDefaultParams: (data: TrainingRunUpdate) => void;
  isNew?: boolean;
  isCustom?: boolean;
  isVideo?: boolean;
  allowedKeys?: string[];
}) => {
  const versions = Object.entries(trainingModelInfo).filter(
    ([k, v]) =>
      v.type === baseType && v.disabled !== true && (!allowedKeys || allowedKeys.includes(k))
  );
  if (!versions.length) return null;

  return (
    <Group gap="lg">
      <Indicator
        disabled={!isNew}
        inline
        color="green.8"
        label="New"
        size={16}
        styles={{ indicator: { top: '2px !important', right: '10px !important' } }}
      >
        <Badge color={color} size="lg" radius="xs" px="xs" w={115}>
          {name}
        </Badge>
      </Indicator>
      {!isCustom ? (
        <SegmentedControl
          data={versions.map(([k, v]) => {
            return {
              label: v.label,
              value: k,
            };
          })}
          // @ts-ignore: requires null to prevent auto-selecting first item
          value={value ?? null}
          onChange={(value) => {
            makeDefaultParams({
              base: value,
              baseType: baseType,
              customModel: null,
            });
          }}
          color="blue"
          size="xs"
          classNames={{ root: 'flex-wrap bg-none border-gray-4 dark:border-dark-4', label: 'px-2' }}
          transitionDuration={0}
        />
      ) : (
        <Card px="sm" py={8} radius="md" withBorder>
          <ResourceSelect
            buttonLabel="Select custom model"
            buttonProps={{
              size: 'compact-sm',
              styles: { label: { fontSize: 12 } },
            }}
            options={{
              resources: [
                {
                  type: ModelType.Checkpoint,
                  // nb: when adding here, make sure logic is added in castBase below
                  baseModels: ['SD 1.4', 'SD 1.5', 'SDXL 1.0', 'Pony', 'Illustrious'],
                },
              ],
            }}
            allowRemove={true}
            selectSource="training"
            value={selectedRun.customModel}
            onChange={(gVal) => {
              if (!gVal) {
                makeDefaultParams({
                  base: isVideo ? defaultBaseVideo : defaultBase,
                  baseType: isVideo ? defaultBaseTypeVideo : defaultBaseType,
                  customModel: null,
                });
              } else {
                const { baseModel, model, id: mvId } = gVal;

                const castBase = (
                  [
                    ...getBaseModelsByGroup('SDXL'),
                    ...getBaseModelsByGroup('SDXLDistilled'),
                    ...getBaseModelsByGroup('Pony'),
                    ...getBaseModelsByGroup('Illustrious'),
                  ] as string[]
                ).includes(baseModel)
                  ? 'sdxl'
                  : ([...getBaseModelsByGroup('Flux1')] as string[]).includes(baseModel)
                  ? 'flux'
                  : ([...getBaseModelsByGroup('Flux2')] as string[]).includes(baseModel)
                  ? 'flux2'
                  : ([...getBaseModelsByGroup('SD3')] as string[]).includes(baseModel)
                  ? 'sd35'
                  : ([...getBaseModelsByGroup('Qwen')] as string[]).includes(baseModel)
                  ? 'qwen'
                  : (
                      [
                        ...getBaseModelsByGroup('ZImageTurbo'),
                        ...getBaseModelsByGroup('ZImageBase'),
                      ] as string[]
                    ).includes(baseModel)
                  ? 'zimage'
                  : (
                      [
                        ...getBaseModelsByGroup('Flux2Klein_4B'),
                        ...getBaseModelsByGroup('Flux2Klein_4B_base'),
                        ...getBaseModelsByGroup('Flux2Klein_9B'),
                        ...getBaseModelsByGroup('Flux2Klein_9B_base'),
                      ] as string[]
                    ).includes(baseModel)
                  ? 'flux2klein'
                  : ([...getBaseModelsByGroup('Chroma')] as string[]).includes(baseModel)
                  ? 'chroma'
                  : 'sd15';

                const cLink = stringifyAIR({
                  baseModel,
                  type: model.type,
                  modelId: model.id,
                  id: mvId,
                });

                makeDefaultParams({
                  base: cLink,
                  baseType: castBase,
                  customModel: gVal,
                });
              }
            }}
          />
        </Card>
      )}
    </Group>
  );
};

export const ModelSelect = ({
  selectedRun,
  modelId,
  mediaType,
  numImages,
}: {
  selectedRun: TrainingRun;
  modelId: number;
  mediaType: TrainingDetailsObj['mediaType'];
  numImages: number | undefined;
}) => {
  const status = useTrainingServiceStatus();
  const features = useFeatureFlags();

  // Fetch moderator-editable announcement
  const { data: announcement } = trpc.training.getAnnouncement.useQuery();

  const { updateRun } = trainingStore;
  const blockedModels = status.blockedModels ?? [blockedCustomModels];

  // Detect whether the user has tweaked the advanced training params away from the
  // defaults for the current base. Auto-derived length knobs (steps/checkpoints/repeats/
  // batch) and the engine field are excluded since those are recomputed per base and
  // would otherwise always read as "dirty".
  const isParamsDirty = (() => {
    if (!selectedRun.base) return false;
    const cur = selectedRun.params as Record<string, unknown>;
    const def = getDefaultTrainingParams(selectedRun.base, selectedRun.params.engine) as Record<
      string,
      unknown
    >;
    const skip = new Set([
      'engine',
      'targetSteps',
      'saveEvery',
      'maxTrainEpochs',
      'numRepeats',
      'trainBatchSize',
      'continueFrom',
      'optimizerArgs',
    ]);
    return Object.keys(def).some((k) => !skip.has(k) && cur[k] !== def[k]);
  })();

  // - Apply default params with overrides and calculations upon base model selection
  const applyDefaultParams = (data: TrainingRunUpdate) => {
    // Determine the appropriate engine based on the base type and model
    const engineToUse =
      data.params?.engine ??
      (data.baseType
        ? getDefaultEngine(data.baseType, data.base ?? undefined, features)
        : defaultEngine);

    const defaultParams = getDefaultTrainingParams(data.base!, engineToUse);

    // Ensure the engine param reflects the computed default (getDefaultTrainingParams
    // uses the static trainingSettings default of 'kohya' for the engine field itself)
    defaultParams.engine = engineToUse;

    if (features.trainingStepsPricing && engineToUse === 'ai-toolkit') {
      // Steps-based pricing: steps is the primary length knob (prefilled per ecosystem),
      // batchSize defaults to 1. "Save every" (step interval) seeds to ~10 checkpoints;
      // maxTrainEpochs (sent as `epochs`) is derived from it in AdvancedSettings.
      defaultParams.trainBatchSize = 1;
      defaultParams.targetSteps = aiToolkitStepDefault(
        (data.baseType ?? selectedRun.baseType) as TrainingBaseModelType
      );
      defaultParams.saveEvery = aiToolkitSaveEveryDefault(defaultParams.targetSteps);
      defaultParams.maxTrainEpochs = AI_TOOLKIT_EPOCHS.default;
    } else {
      defaultParams.numRepeats = Math.max(1, Math.min(5000, Math.ceil(200 / (numImages || 1))));

      defaultParams.targetSteps = Math.ceil(
        ((numImages || 1) * defaultParams.numRepeats * defaultParams.maxTrainEpochs) /
          defaultParams.trainBatchSize
      );
    }

    // Pre-fill sample prompts if required (AI Toolkit mandatory models or Flux2)
    const samplePrompts = data.samplePrompts || selectedRun.samplePrompts || ['', '', ''];
    if (data.baseType && isSamplePromptsRequired(data.baseType)) {
      // Get captions from uploaded images
      const imageList = useTrainingImageStore.getState()[modelId]?.imageList || [];
      const captionsWithContent = imageList
        .filter((img) => img.label && img.label.trim().length > 0)
        .map((img) => img.label.trim());

      if (captionsWithContent.length > 0) {
        // Select random captions for sample prompts. Video uses 2 slots; image
        // and audio use 3.
        const numPromptsNeeded = mediaType === 'video' ? 2 : 3;
        const randomCaptions: string[] = [];
        const usedIndices = new Set<number>();

        while (
          randomCaptions.length < numPromptsNeeded &&
          randomCaptions.length < captionsWithContent.length
        ) {
          const randomIndex = Math.floor(Math.random() * captionsWithContent.length);
          if (!usedIndices.has(randomIndex)) {
            usedIndices.add(randomIndex);
            randomCaptions.push(captionsWithContent[randomIndex]);
          }
        }

        // Audio captions arrive XML-tagged (CAPTION/LYRICS/DURATION/LANGUAGE)
        // from the audioCaptioning step. Strip the tags for the visible prompt
        // and seed `samplesOverrides` from the parsed fields so this prefill
        // path stays consistent with the advanced-settings prefill effect.
        if (mediaType === 'audio') {
          const finalPrompts: string[] = [];
          const finalOverrides: AudioSampleOverride[] = [];
          for (let i = 0; i < numPromptsNeeded; i++) {
            const raw = randomCaptions[i] ?? '';
            if (raw) {
              const parsed = parseAudioCaption(raw);
              finalPrompts.push(parsed.caption ?? raw);
              finalOverrides.push({
                ...(parsed.lyrics && { lyrics: parsed.lyrics }),
                ...(parsed.duration && { duration: parsed.duration }),
                ...(parsed.language && { language: parsed.language }),
              });
            } else {
              finalPrompts.push('');
              finalOverrides.push({});
            }
          }
          data.samplePrompts = finalPrompts;
          data.samplesOverrides = finalOverrides;
        } else {
          // Fill remaining slots with empty strings if needed
          while (randomCaptions.length < numPromptsNeeded) {
            randomCaptions.push('');
          }

          data.samplePrompts = randomCaptions;
        }
      }
    }

    updateRun(modelId, mediaType, selectedRun.id, {
      params: { ...defaultParams },
      ...data,
      samplePrompts: data.samplePrompts || samplePrompts,
    });
  };

  // Selecting a different base model resets training params to that model's defaults.
  // If the user has dirtied the params, confirm before discarding their changes.
  const makeDefaultParams = (data: TrainingRunUpdate) => {
    const isChangingBase = !!data.base && data.base !== selectedRun.base;
    if (isChangingBase && isParamsDirty) {
      openConfirmModal({
        title: 'Change base model?',
        children: (
          <Text size="sm">
            Changing the base model will reset your training parameters to the defaults for the new
            model. Your current parameter changes will be lost.
          </Text>
        ),
        labels: { confirm: 'Change base model', cancel: 'Keep current model' },
        confirmProps: { color: 'red' },
        onConfirm: () => applyDefaultParams(data),
      });
      return;
    }
    applyDefaultParams(data);
  };

  const formBaseModel = selectedRun.base;
  const isCustomModel = !!selectedRun.customModel;

  const baseModel15 =
    !!formBaseModel &&
    (trainingDetailsBaseModels15 as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelXL =
    !!formBaseModel &&
    (trainingDetailsBaseModelsXL as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  // const baseModel35 =
  //   !!formBaseModel &&
  //   (trainingDetailsBaseModels35 as ReadonlyArray<string>).includes(formBaseModel)
  //     ? formBaseModel
  //     : null;
  const baseModelFlux =
    !!formBaseModel &&
    (trainingDetailsBaseModelsFlux as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelHunyuan =
    !!formBaseModel &&
    (trainingDetailsBaseModelsHunyuan as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelWan =
    !!formBaseModel &&
    (trainingDetailsBaseModelsWan as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelFlux2 =
    !!formBaseModel &&
    (trainingDetailsBaseModelsFlux2 as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelChroma =
    !!formBaseModel &&
    (trainingDetailsBaseModelsChroma as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelQwen =
    !!formBaseModel &&
    (trainingDetailsBaseModelsQwen as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelZImage =
    !!formBaseModel &&
    (trainingDetailsBaseModelsZImage as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelFlux2Klein =
    !!formBaseModel &&
    (trainingDetailsBaseModelsFlux2Klein as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelLtx2 =
    !!formBaseModel &&
    (trainingDetailsBaseModelsLtx2 as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelLtx23 =
    !!formBaseModel &&
    (trainingDetailsBaseModelsLtx23 as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelErnie =
    !!formBaseModel &&
    (trainingDetailsBaseModelsErnie as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelHiDreamO1 =
    !!formBaseModel &&
    (trainingDetailsBaseModelsHiDreamO1 as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelAnima =
    !!formBaseModel &&
    (trainingDetailsBaseModelsAnima as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelAcestep15 =
    !!formBaseModel &&
    (trainingDetailsBaseModelsAcestep15 as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;
  const baseModelAcestep15Xl =
    !!formBaseModel &&
    (trainingDetailsBaseModelsAcestep15Xl as ReadonlyArray<string>).includes(formBaseModel)
      ? formBaseModel
      : null;

  return (
    <>
      <Stack gap={0}>
        <Title mt="md" order={5}>
          Base Model for Training{' '}
          <Text span c="red">
            *
          </Text>
        </Title>
        <Text c="dimmed" size="sm">
          Not sure which one to choose? Read our{' '}
          <Anchor
            href="https://education.civitai.com/using-civitai-the-on-site-lora-trainer"
            target="_blank"
            rel="nofollow noreferrer"
          >
            On-Site LoRA Trainer Guide
          </Anchor>{' '}
          for more info.
        </Text>
      </Stack>
      <Input.Wrapper>
        <Card withBorder mt={8} p="sm">
          <Card.Section inheritPadding withBorder py="sm">
            <Stack gap="xs">
              {announcement?.message && (
                <AlertWithIcon
                  icon={<IconExclamationCircle size={16} />}
                  iconColor={announcement.color || 'yellow'}
                  color={announcement.color || 'yellow'}
                  size="sm"
                >
                  <CustomMarkdown>{announcement.message}</CustomMarkdown>
                </AlertWithIcon>
              )}
              {mediaType === 'image' && (
                <>
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="violet"
                    name="SD 1.5"
                    value={baseModel15}
                    baseType="sd15"
                    makeDefaultParams={makeDefaultParams}
                  />
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="grape"
                    name="SDXL"
                    value={baseModelXL}
                    baseType="sdxl"
                    makeDefaultParams={makeDefaultParams}
                  />
                  {/*<ModelSelector
                    selectedRun={selectedRun}
                    color="pink"
                    name="SD 3.5"
                    value={baseModel35}
                    baseType="sd35"
                    makeDefaultParams={makeDefaultParams}
                    isNew={new Date() < new Date('2024-11-10')}
                  />*/}
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="red"
                    name="Flux.1"
                    value={baseModelFlux}
                    baseType="flux"
                    makeDefaultParams={makeDefaultParams}
                    isNew={new Date() < new Date('2024-09-01')}
                  />
                  {features.flux2Training && (
                    <ModelSelector
                      selectedRun={selectedRun}
                      color="orange"
                      name="Flux.2"
                      value={baseModelFlux2}
                      baseType="flux2"
                      makeDefaultParams={makeDefaultParams}
                    />
                  )}
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="teal"
                    name="Chroma"
                    value={baseModelChroma}
                    baseType="chroma"
                    makeDefaultParams={makeDefaultParams}
                    isNew={new Date() < new Date('2025-10-01')}
                  />
                  {features.qwenTraining && (
                    <ModelSelector
                      selectedRun={selectedRun}
                      color="orange"
                      name="Qwen"
                      value={baseModelQwen}
                      baseType="qwen"
                      makeDefaultParams={makeDefaultParams}
                    />
                  )}
                  {(features.zimageturboTraining || features.zimagebaseTraining) && (
                    <ModelSelector
                      selectedRun={selectedRun}
                      color="yellow"
                      name="Z Image"
                      value={baseModelZImage}
                      baseType="zimage"
                      makeDefaultParams={makeDefaultParams}
                      allowedKeys={[
                        ...(features.zimageturboTraining ? ['zimageturbo'] : []),
                        ...(features.zimagebaseTraining ? ['zimagebase'] : []),
                      ]}
                    />
                  )}
                  {features.fluxTwoKleinTraining && (
                    <ModelSelector
                      selectedRun={selectedRun}
                      color="pink"
                      name="Flux.2 Klein"
                      value={baseModelFlux2Klein}
                      baseType="flux2klein"
                      makeDefaultParams={makeDefaultParams}
                    />
                  )}
                  {features.ernieTraining && (
                    <ModelSelector
                      selectedRun={selectedRun}
                      color="blue"
                      name="Ernie"
                      value={baseModelErnie}
                      baseType="ernie"
                      makeDefaultParams={makeDefaultParams}
                    />
                  )}
                  {features.hidreamO1Training && (
                    <ModelSelector
                      selectedRun={selectedRun}
                      color="indigo"
                      name="HiDream O1"
                      value={baseModelHiDreamO1}
                      baseType="hidream-o1"
                      makeDefaultParams={makeDefaultParams}
                      isNew={new Date() < new Date('2026-06-15')}
                    />
                  )}
                  {features.animaTraining && (
                    <ModelSelector
                      selectedRun={selectedRun}
                      color="pink"
                      name="Anima"
                      value={baseModelAnima}
                      baseType="anima"
                      makeDefaultParams={makeDefaultParams}
                      isNew={new Date() < new Date('2026-06-25')}
                    />
                  )}
                </>
              )}
              {mediaType === 'audio' && (
                <>
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="violet"
                    name="ACE-Step 1.5"
                    value={baseModelAcestep15}
                    baseType="acestep15"
                    makeDefaultParams={makeDefaultParams}
                    isNew
                  />
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="grape"
                    name="ACE-Step 1.5 XL"
                    value={baseModelAcestep15Xl}
                    baseType="acestep15xl"
                    makeDefaultParams={makeDefaultParams}
                    isNew
                  />
                </>
              )}
              {mediaType === 'video' && (
                <>
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="teal"
                    name="Hunyuan"
                    value={baseModelHunyuan}
                    baseType="hunyuan"
                    makeDefaultParams={makeDefaultParams}
                    isVideo
                    isNew={new Date() < new Date('2025-04-30')}
                  />
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="green"
                    name="Wan"
                    value={baseModelWan}
                    baseType="wan"
                    makeDefaultParams={makeDefaultParams}
                    isVideo
                    isNew={new Date() < new Date('2025-04-30')}
                    allowedKeys={[
                      'wan_2_1_t2v_14b',
                      'wan_2_1_i2v_14b_720p',
                      ...(features.wan22Training ? ['wan_2_2_t2v_a14b'] : []),
                    ]}
                  />
                  {features.ltx2Training && (
                    <ModelSelector
                      selectedRun={selectedRun}
                      color="lime"
                      name="LTX2"
                      value={baseModelLtx2}
                      baseType="ltx2"
                      makeDefaultParams={makeDefaultParams}
                      isVideo
                      isNew
                    />
                  )}
                  {features.ltx23Training && (
                    <ModelSelector
                      selectedRun={selectedRun}
                      color="lime"
                      name="LTX 2.3"
                      value={baseModelLtx23}
                      baseType="ltx23"
                      makeDefaultParams={makeDefaultParams}
                      isVideo
                      isNew
                    />
                  )}
                </>
              )}
              {mediaType === 'image' && (
                <>
                  <ModelSelector
                    selectedRun={selectedRun}
                    color="cyan"
                    name="Custom"
                    value=""
                    baseType="sdxl" // unused
                    makeDefaultParams={makeDefaultParams}
                    isCustom
                  />
                </>
              )}
            </Stack>
          </Card.Section>
          {formBaseModel && (
            <Card.Section inheritPadding py="sm">
              <Stack>
                <Text size="sm">
                  {isCustomModel
                    ? 'Custom model selected.'
                    : trainingModelInfo[formBaseModel as TrainingDetailsBaseModelList]
                        ?.description ?? 'No description.'}
                </Text>
                {!isCustomModel &&
                  trainingModelInfo[formBaseModel as TrainingDetailsBaseModelList]?.air && (
                    <Anchor
                      href={getAirModelLink(
                        trainingModelInfo[formBaseModel as TrainingDetailsBaseModelList].air!
                      )}
                      target="_blank"
                      rel="noreferrer"
                      size="sm"
                    >
                      View base model on Civitai
                    </Anchor>
                  )}
                {blockedModels.includes(formBaseModel) ? (
                  <AlertWithIcon
                    icon={<IconExclamationCircle />}
                    iconColor="default"
                    p="sm"
                    color="red"
                  >
                    <Text>
                      This model is not currently available for LoRA training - please select a
                      different model.
                    </Text>
                  </AlertWithIcon>
                ) : isCustomModel ? (
                  <AlertWithIcon icon={<IconAlertCircle />} iconColor="default" p="xs">
                    Note: custom models may see a higher failure rate than normal, and cost more
                    Buzz.
                  </AlertWithIcon>
                ) : selectedRun.baseType === 'hunyuan' ||
                  selectedRun.baseType === 'wan' ||
                  selectedRun.baseType === 'ltx2' ||
                  selectedRun.baseType === 'ltx23' ||
                  selectedRun.baseType === 'hidream-o1' ||
                  selectedRun.baseType === 'anima' ||
                  selectedRun.baseType === 'acestep15' ||
                  selectedRun.baseType === 'acestep15xl' ? (
                  <AlertWithIcon icon={<IconAlertCircle />} iconColor="default" p="xs">
                    Note: This is an experimental build. Pricing, default settings, and results are
                    subject to change.
                  </AlertWithIcon>
                ) : undefined}
              </Stack>
            </Card.Section>
          )}
        </Card>
      </Input.Wrapper>
    </>
  );
};
