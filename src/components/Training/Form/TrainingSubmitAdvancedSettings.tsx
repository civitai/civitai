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
  ThemeIcon,
  Title,
  Tooltip,
  useMantineTheme,
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
  rapidEta,
  trainingBaseModelTypesVideo,
} from '~/utils/training';

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
  const { triggerWord } = useTrainingImageStore(
    (state) =>
      state[modelId] ?? {
        ...(mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState),
      }
  );
  const theme = useMantineTheme();
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
    const { maxTrainEpochs, numRepeats, trainBatchSize, engine } = selectedRun.params;

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
    if (selectedRun.baseType === 'flux') {
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

  return (
    <>
      {selectedRun.baseType === 'flux' && (
        <Group mt="md">
          <Switch
            label={
              <Group spacing={4} noWrap>
                <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
                  <Text>
                    Your LoRA will be trained in {<b>{rapidEta} minutes</b>} or less so you can get
                    right into generating as fast as possible.
                  </Text>
                </InfoPopover>
                <Text>Rapid Training</Text>
              </Group>
            }
            labelPosition="left"
            checked={selectedRun.params.engine === 'rapid'}
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
              sx={{ overflow: 'visible' }}
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

      <Title mt="md" order={5}>
        Advanced Settings
      </Title>

      <Accordion
        variant="separated"
        multiple
        mt="xs"
        onChange={setOpenedSections}
        styles={(theme) => ({
          content: { padding: 0 },
          item: {
            overflow: 'hidden',
            borderColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
            boxShadow: theme.shadows.sm,
          },
          control: {
            padding: theme.spacing.sm,
          },
        })}
      >
        <Accordion.Item value="custom-prompts">
          <Accordion.Control>
            <Stack spacing={4}>
              <Text>Sample Media Prompts</Text>
              {openedSections.includes('custom-prompts') && (
                <Text size="xs" color="dimmed">
                  Set your own prompts for any of the 3 sample {isVideo ? 'videos' : 'images'} we
                  generate for each epoch.
                </Text>
              )}
            </Stack>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack p="sm">
              <TextInputWrapper
                label={`${isVideo ? 'Video' : 'Image'} #1`}
                placeholder="Automatically set"
                value={selectedRun.samplePrompts[0]}
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
                placeholder="Automatically set"
                value={selectedRun.samplePrompts[1]}
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
              <TextInputWrapper
                label={`${isVideo ? 'Video' : 'Image'} #3`}
                placeholder="Automatically set"
                value={selectedRun.samplePrompts[2]}
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
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
        {isValidRapid(selectedRun.baseType, selectedRun.params.engine) ? (
          <Card withBorder mt="md" p="sm">
            <Card.Section inheritPadding withBorder py="sm">
              <Group position="apart">
                <Text
                  color={theme.colorScheme === 'dark' ? theme.colors.gray[6] : theme.colors.gray[5]}
                >
                  Training Parameters{' '}
                  <Text component="span" size="xs" fs="italic">
                    (disabled with &quot;Rapid Training&quot;)
                  </Text>
                </Text>
                <Box mr={4}>
                  <IconChevronDown
                    color={
                      theme.colorScheme === 'dark' ? theme.colors.gray[6] : theme.colors.gray[5]
                    }
                    size={16}
                  />
                </Box>
              </Group>
            </Card.Section>
          </Card>
        ) : (
          <Accordion.Item value="training-settings">
            <Accordion.Control>
              <Stack spacing={4}>
                <Group spacing="sm">
                  <Text>Training Parameters</Text>
                  {!!selectedRun.customModel && (
                    <Tooltip
                      label="Custom models will likely require parameter adjustments. Please carefully check these before submitting."
                      maw={300}
                      multiline
                      withArrow
                      styles={(theme) => ({
                        tooltip: {
                          border: `1px solid ${
                            theme.colorScheme === 'dark'
                              ? theme.colors.dark[4]
                              : theme.colors.gray[3]
                          }`,
                        },
                        arrow: {
                          borderRight: `1px solid ${
                            theme.colorScheme === 'dark'
                              ? theme.colors.dark[4]
                              : theme.colors.gray[3]
                          }`,
                          borderBottom: `1px solid ${
                            theme.colorScheme === 'dark'
                              ? theme.colors.dark[4]
                              : theme.colors.gray[3]
                          }`,
                        },
                      })}
                    >
                      <IconAlertTriangle color="orange" size={16} />
                    </Tooltip>
                  )}
                </Group>
                {openedSections.includes('training-settings') && (
                  <Text size="xs" color="dimmed">
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
                        precision={
                          ts.type === 'number'
                            ? getPrecision(ts.step ?? ts.default) || 4
                            : undefined
                        }
                        step={ts.step}
                        sx={{ flexGrow: 1 }}
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
                          <Group spacing={6}>
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
                    visible: !(ts.name === 'engine' && selectedRun.baseType !== 'flux' && !isVideo),
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
