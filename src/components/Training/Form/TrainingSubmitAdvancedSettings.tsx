import {
  Accordion,
  Badge,
  Card,
  Checkbox,
  Code,
  Group,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import { IconAlertTriangle } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { CivitaiTooltip } from '~/components/CivitaiWrapped/CivitaiTooltip';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { getPrecision, isTrainingCustomModel } from '~/components/Training/Form/TrainingCommon';
import {
  optimizerArgMap,
  optimizerArgMapFlux,
  trainingSettings,
} from '~/components/Training/Form/TrainingParams';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { SelectWrapper } from '~/libs/form/components/SelectWrapper';
import { TextInputWrapper } from '~/libs/form/components/TextInputWrapper';
import { TrainingDetailsParams } from '~/server/schema/model-version.schema';
import { TrainingRun, TrainingRunUpdate, trainingStore } from '~/store/training.store';
import { isValidRapid, rapidEta } from '~/utils/training';

export const AdvancedSettings = ({
  selectedRun,
  modelId,
  maxSteps,
  numImages,
}: {
  selectedRun: TrainingRun;
  modelId: number;
  maxSteps: number;
  numImages: number | undefined;
}) => {
  const { updateRun } = trainingStore;
  const theme = useMantineTheme();
  const previous = usePrevious(selectedRun);
  const [openedSections, setOpenedSections] = useState<string[]>([]);

  const doUpdate = (data: TrainingRunUpdate) => {
    updateRun(modelId, selectedRun.id, data);
  };

  useEffect(() => {
    if (previous?.id !== selectedRun.id) return;
    const defaultParams = trainingSettings.reduce(
      (a, v) => ({
        ...a,
        [v.name]:
          v.overrides?.[selectedRun.base]?.all?.default ??
          v.overrides?.[selectedRun.base]?.[selectedRun.params.engine]?.default ??
          v.default,
      }),
      {} as TrainingDetailsParams
    );

    defaultParams.engine = selectedRun.params.engine;
    defaultParams.numRepeats = Math.max(1, Math.min(5000, Math.ceil(200 / (numImages || 1))));

    if (selectedRun.params.engine === 'kohya') {
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
    if (engine === 'x-flux') return;

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
              updateRun(modelId, selectedRun.id, {
                params: { engine: event.currentTarget.checked ? 'rapid' : 'kohya' }, // TODO ideally this would revert to the previous engine, but we only have 1 now
              })
            }
          />
          {Date.now() < new Date('2024-09-27').getTime() && (
            <Badge color="green" variant="filled" size="sm">
              NEW
            </Badge>
          )}
        </Group>
      )}

      {isValidRapid(selectedRun.baseType, selectedRun.params.engine) ? (
        <Card withBorder mt={8} p="sm">
          <Card.Section inheritPadding withBorder py="sm">
            <Text>Advanced settings are disabled with &quot;Rapid Training&quot;</Text>
          </Card.Section>
        </Card>
      ) : (
        <>
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
                borderColor:
                  theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
                boxShadow: theme.shadows.sm,
              },
              control: {
                padding: theme.spacing.sm,
              },
            })}
          >
            {selectedRun.params.engine === 'x-flux' ? (
              <AlertWithIcon icon={<IconAlertTriangle />} color="yellow" iconColor="yellow" mb="md">
                <Text>
                  Heads up: you&apos;re using <Code color="green">x-flux</Code>!
                  <br />
                  We currently do not provide sample images for LoRAs trained this way.
                  <br />
                  We are also working on expanding the list of supported training parameters.
                </Text>
              </AlertWithIcon>
            ) : (
              <Accordion.Item value="custom-prompts">
                <Accordion.Control>
                  <Stack spacing={4}>
                    Sample Image Prompts
                    {openedSections.includes('custom-prompts') && (
                      <Text size="xs" color="dimmed">
                        Set your own prompts for any of the 3 sample images we generate for each
                        epoch.
                      </Text>
                    )}
                  </Stack>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack p="sm">
                    <TextInputWrapper
                      label="Image #1"
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
                      label="Image #2"
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
                      label="Image #3"
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
            )}
            <Accordion.Item value="training-settings">
              <Accordion.Control>
                <Stack spacing={4}>
                  <Group spacing="sm">
                    <Text>Training Parameters</Text>
                    {isTrainingCustomModel(selectedRun.base) && (
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

                    const baseOverride = ts.overrides?.[selectedRun.base];
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
                        ts.overrides?.[selectedRun.base]?.all ??
                        ts.overrides?.[selectedRun.base]?.[selectedRun.params.engine];

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
                      // TODO if we fix the bitsandbytes issue, we can disable this
                      if (ts.name === 'optimizerType' && selectedRun.baseType === 'sdxl') {
                        options = options.filter((o) => o !== 'AdamW8Bit');
                      }
                      if (
                        ts.name === 'lrScheduler' &&
                        selectedRun.params.optimizerType === 'Prodigy'
                      ) {
                        options = options.filter((o) => o !== 'cosine_with_restarts');
                      }
                      // TODO re-enable x-flux
                      if (ts.name === 'engine') {
                        options = options.filter((o) => o !== 'x-flux');
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
                                  <IconAlertTriangle color="orange" size={16} />
                                )}
                            </Group>
                            {/*TODO re-enable when x-flux is back*/}
                            {/*{ts.name === 'engine' && selectedRun.baseType === 'flux' && (*/}
                            {/*  <Badge color="green">NEW</Badge>*/}
                            {/*)}*/}
                          </Group>
                        </CivitaiTooltip>
                      ) : (
                        ts.label
                      ),
                      value: inp,
                      visible: !(ts.name === 'engine' && selectedRun.baseType !== 'flux'),
                    };
                  })}
                />
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </>
      )}
    </>
  );
};
