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
import { IconAlertTriangle, IconChevronDown, IconConfetti } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import { CivitaiTooltip } from '~/components/CivitaiWrapped/CivitaiTooltip';
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
import {
  defaultTrainingState,
  defaultTrainingStateVideo,
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
  isAiToolkitSupported,
  isAiToolkitMandatory,
  isSamplePromptsRequired,
  getDefaultEngine,
  rapidEta,
  trainingBaseModelTypesVideo,
} from '~/utils/training';
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
    (state) =>
      state[modelId] ?? {
        ...(mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState),
      }
  );
  const previous = usePrevious(selectedRun);
  const [openedSections, setOpenedSections] = useState<string[]>([]);

  const doUpdate = (data: TrainingRunUpdate) => {
    updateRun(modelId, mediaType, selectedRun.id, data);
  };

  const runBase = selectedRun.base;
  const isVideo = (trainingBaseModelTypesVideo as unknown as string[]).includes(
    selectedRun.baseType
  );

  useEffect(() => {
    if (previous?.id !== selectedRun.id) return;
    const defaultParams = getDefaultTrainingParams(runBase, selectedRun.params.engine);

    defaultParams.engine = selectedRun.params.engine;
    defaultParams.numRepeats = Math.max(1, Math.min(5000, Math.ceil(200 / (numImages || 1))));

    if (selectedRun.params.engine !== 'rapid') {
      defaultParams.targetSteps = Math.ceil(
        ((numImages || 1) * defaultParams.numRepeats * defaultParams.maxTrainEpochs) /
          defaultParams.trainBatchSize
      );
    }

    doUpdate({ params: defaultParams });
  }, [selectedRun.params.engine]);

  // Use functions to set proper starting values based on metadata
  useEffect(() => {
    if (selectedRun.params.numRepeats === undefined) {
      const numRepeats = Math.max(1, Math.min(5000, Math.ceil(200 / (numImages || 1))));
      doUpdate({ params: { numRepeats } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun.id, numImages]);

  // Set targetSteps automatically on value changes
  useEffect(() => {
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

    if (
      newOptimizerArgs !== selectedRun.params.optimizerArgs ||
      newScheduler !== selectedRun.params.lrScheduler
    ) {
      doUpdate({ params: { optimizerArgs: newOptimizerArgs, lrScheduler: newScheduler } });
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

  // Pre-fill sample prompts with random captions when AI Toolkit is selected
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

    // Select 3 random captions (or fewer if not enough available)
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

    // Fill remaining slots with empty strings if needed
    while (randomCaptions.length < numPromptsNeeded) {
      randomCaptions.push('');
    }

    doUpdate({ samplePrompts: randomCaptions });

    showInfoNotification({
      title: 'Sample prompts pre-filled',
      message:
        'Sample prompts have been pre-filled with random captions from your uploaded images.',
      autoClose: 8000,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun.params.engine, selectedRun.id]);

  return (
    <>
      {/* Flux1 can toggle Rapid Training on/off */}
      {selectedRun.baseType === 'flux' && (
        <Group mt="md">
          <Switch
            label={
              <Group gap={4} wrap="nowrap">
                <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
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
                params: { engine: event.currentTarget.checked ? 'rapid' : 'kohya' }, // TODO ideally this would revert to the previous engine, but we only have 1 now
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
      {/* AI Toolkit is public for SD1.5 and SDXL, mod-only for other supported models */}
      {features.aiToolkitTraining && isAiToolkitSupported(selectedRun.baseType) && (
        <Group mt="md">
          {!isAiToolkitMandatory(selectedRun.baseType) && (
            // Show toggle for optional AI Toolkit
            <Switch
              label={
                <Group gap={4} wrap="nowrap">
                  <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
                    <Text>
                      Train using the AI Toolkit engine, offering improved quality and flexibility.
                      {selectedRun.baseType === 'flux' && selectedRun.params.engine === 'rapid' && (
                        <> Note: Rapid Training is currently enabled and must be disabled first.</>
                      )}
                    </Text>
                  </InfoPopover>
                  <Text>AI Toolkit Training</Text>
                  <Badge color="blue" size="xs">
                    Beta
                  </Badge>
                </Group>
              }
              labelPosition="left"
              checked={selectedRun.params.engine === 'ai-toolkit'}
              disabled={selectedRun.params.engine === 'rapid'}
              onChange={(event) => {
                const newEngine = event.currentTarget.checked
                  ? 'ai-toolkit'
                  : getDefaultEngine(selectedRun.baseType, selectedRun.base);

                updateRun(modelId, mediaType, selectedRun.id, {
                  params: { ...selectedRun.params, engine: newEngine },
                });
              }}
            />
          )}
        </Group>
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
                {isSamplePromptsRequired(selectedRun.baseType, selectedRun.params.engine) && (
                  <Badge color="red" size="sm">
                    Required
                  </Badge>
                )}
              </Group>
              {openedSections.includes('custom-prompts') && (
                <Text size="xs" c="dimmed">
                  {isSamplePromptsRequired(selectedRun.baseType, selectedRun.params.engine)
                    ? `This model requires sample prompts. These are pre-filled from your image captions.`
                    : `Set your own prompts for any of the ${isVideo ? '2' : '3'} sample ${
                        isVideo ? 'videos' : 'images'
                      } we generate for each epoch.`}
                </Text>
              )}
            </Stack>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack p="sm">
              <TextInputWrapper
                label={`${isVideo ? 'Video' : 'Image'} #1`}
                placeholder={
                  isSamplePromptsRequired(selectedRun.baseType, selectedRun.params.engine)
                    ? 'Required - pre-filled from captions'
                    : 'Automatically set'
                }
                value={selectedRun.samplePrompts[0]}
                required={isSamplePromptsRequired(selectedRun.baseType, selectedRun.params.engine)}
                error={
                  isSamplePromptsRequired(selectedRun.baseType, selectedRun.params.engine) &&
                  !selectedRun.samplePrompts[0]?.trim()
                    ? 'Required'
                    : undefined
                }
                onChange={(event) => {
                  doUpdate({
                    samplePrompts: [
                      event.currentTarget.value,
                      selectedRun.samplePrompts[1],
                      selectedRun.samplePrompts[2],
                    ],
                  });
                }}
              />
              <TextInputWrapper
                label={`${isVideo ? 'Video' : 'Image'} #2`}
                placeholder={
                  isSamplePromptsRequired(selectedRun.baseType, selectedRun.params.engine)
                    ? 'Required - pre-filled from captions'
                    : 'Automatically set'
                }
                value={selectedRun.samplePrompts[1]}
                required={isSamplePromptsRequired(selectedRun.baseType, selectedRun.params.engine)}
                error={
                  isSamplePromptsRequired(selectedRun.baseType, selectedRun.params.engine) &&
                  !selectedRun.samplePrompts[1]?.trim()
                    ? 'Required'
                    : undefined
                }
                onChange={(event) => {
                  doUpdate({
                    samplePrompts: [
                      selectedRun.samplePrompts[0],
                      event.currentTarget.value,
                      selectedRun.samplePrompts[2],
                    ],
                  });
                }}
              />
              {!isVideo && (
                <TextInputWrapper
                  label={`${isVideo ? 'Video' : 'Image'} #3`}
                  placeholder={
                    isSamplePromptsRequired(selectedRun.baseType, selectedRun.params.engine)
                      ? 'Required - pre-filled from captions'
                      : 'Automatically set'
                  }
                  value={selectedRun.samplePrompts[2]}
                  required={isSamplePromptsRequired(
                    selectedRun.baseType,
                    selectedRun.params.engine
                  )}
                  error={
                    isSamplePromptsRequired(selectedRun.baseType, selectedRun.params.engine) &&
                    !selectedRun.samplePrompts[2]?.trim()
                      ? 'Required'
                      : undefined
                  }
                  onChange={(event) => {
                    doUpdate({
                      samplePrompts: [
                        selectedRun.samplePrompts[0],
                        selectedRun.samplePrompts[1],
                        event.currentTarget.value,
                      ],
                    });
                  }}
                />
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
                    <Tooltip
                      label="Custom models will likely require parameter adjustments. Please carefully check these before submitting."
                      maw={300}
                      classNames={{
                        tooltip: 'border-gray-3 dark:border-dark-4',
                        arrow:
                          'border-r-gray-3 border-b-gray-3 dark:border-r-dark-4 dark:border-b-dark-4',
                      }}
                      multiline
                      withArrow
                    >
                      <IconAlertTriangle color="orange" size={16} />
                    </Tooltip>
                  )}
                </Group>
                {openedSections.includes('training-settings') && (
                  <Text size="xs" c="dimmed">
                    Hover over each setting for more information.
                    <br />
                    Default settings are based on your chosen model. Altering these settings may
                    cause undesirable results.
                  </Text>
                )}
              </Stack>
            </Accordion.Control>
            <Accordion.Panel>
              <DescriptionTable
                labelWidth="200px"
                items={trainingSettings.map((ts) => {
                  let inp: React.ReactNode;

                  const baseOverride = ts.overrides?.[runBase];
                  const override = baseOverride?.all ?? baseOverride?.[selectedRun.params.engine];

                  const disabledOverride = override?.disabled;
                  const hint = override?.hint ?? ts.hint;
                  const disabled =
                    selectedRun.params.engine === 'rapid'
                      ? true
                      : disabledOverride ?? ts.disabled === true;

                  if (ts.type === 'int' || ts.type === 'number') {
                    // repeating for dumb ts
                    const tOverride =
                      ts.overrides?.[runBase]?.all ??
                      ts.overrides?.[runBase]?.[selectedRun.params.engine];

                    inp = (
                      <NumberInputWrapper
                        min={tOverride?.min ?? ts.min}
                        max={tOverride?.max ?? ts.max}
                        decimalScale={
                          ts.type === 'number'
                            ? getPrecision(ts.step ?? ts.default) || 4
                            : undefined
                        }
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
                    if (
                      ts.name === 'lrScheduler' &&
                      selectedRun.params.optimizerType === 'Prodigy'
                    ) {
                      options = options.filter((o) => o !== 'cosine_with_restarts');
                    }

                    if (ts.name === 'optimizerType' && isVideo) {
                      options = options.filter((o) => o !== 'Prodigy');
                    }

                    if (ts.name === 'engine') {
                      if (isVideo) {
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

                  return {
                    label: hint ? (
                      <CivitaiTooltip
                        position="top"
                        variant="roundedOpaque"
                        withArrow
                        multiline
                        label={hint}
                      >
                        <Group>
                          <Group gap={6}>
                            <Text inline style={{ cursor: 'help' }}>
                              {ts.label}
                            </Text>
                            {ts.name === 'targetSteps' &&
                              selectedRun.params.targetSteps > maxSteps && (
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
                          </Group>
                          {/* use this for new parameters */}
                          {/*{ts.name === 'engine' && selectedRun.baseType === 'flux' && (*/}
                          {/*  <Badge color="green">NEW</Badge>*/}
                          {/*)}*/}
                        </Group>
                      </CivitaiTooltip>
                    ) : (
                      ts.label
                    ),
                    value: inp,
                    visible: !(
                      ts.name === 'engine' ||
                      ((ts.name === 'numRepeats' || ts.name === 'trainBatchSize') &&
                        selectedRun.params.engine === 'ai-toolkit')
                    ),
                  };
                })}
              />
            </Accordion.Panel>
          </Accordion.Item>
        )}
      </Accordion>
    </>
  );
};
