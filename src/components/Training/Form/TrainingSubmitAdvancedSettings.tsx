import { Accordion, Checkbox, Group, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import React, { useState } from 'react';
import { CivitaiTooltip } from '~/components/CivitaiWrapped/CivitaiTooltip';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { getPrecision, isTrainingCustomModel } from '~/components/Training/Form/TrainingCommon';
import { trainingSettings } from '~/components/Training/Form/TrainingParams';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { SelectWrapper } from '~/libs/form/components/SelectWrapper';
import { TextInputWrapper } from '~/libs/form/components/TextInputWrapper';
import { TrainingRun, trainingStore } from '~/store/training.store';

export const AdvancedSettings = ({
  selectedRun,
  modelId,
  maxSteps,
}: {
  selectedRun: TrainingRun;
  modelId: number;
  maxSteps: number;
}) => {
  const { updateRun } = trainingStore;
  const [openedSections, setOpenedSections] = useState<string[]>([]);

  return (
    <>
      <Title mt="md" order={5}>
        Advanced Settings
      </Title>

      <Accordion
        variant="separated"
        multiple
        mt="md"
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
              Sample Image Prompts
              {openedSections.includes('custom-prompts') && (
                <Text size="xs" color="dimmed">
                  Set your own prompts for any of the 3 sample images we generate for each epoch.
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
                onChange={(event) =>
                  updateRun(modelId, selectedRun.id, {
                    samplePrompts: [
                      event.currentTarget.value,
                      selectedRun.samplePrompts[1],
                      selectedRun.samplePrompts[2],
                    ],
                  })
                }
              />
              <TextInputWrapper
                label="Image #2"
                placeholder="Automatically set"
                value={selectedRun.samplePrompts[1]}
                onChange={(event) =>
                  updateRun(modelId, selectedRun.id, {
                    samplePrompts: [
                      selectedRun.samplePrompts[0],
                      event.currentTarget.value,
                      selectedRun.samplePrompts[2],
                    ],
                  })
                }
              />
              <TextInputWrapper
                label="Image #3"
                placeholder="Automatically set"
                value={selectedRun.samplePrompts[2]}
                onChange={(event) =>
                  updateRun(modelId, selectedRun.id, {
                    samplePrompts: [
                      selectedRun.samplePrompts[0],
                      selectedRun.samplePrompts[1],
                      event.currentTarget.value,
                    ],
                  })
                }
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
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
                          theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                        }`,
                      },
                      arrow: {
                        borderRight: `1px solid ${
                          theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                        }`,
                        borderBottom: `1px solid ${
                          theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
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
                  Default settings are based on your chosen model. Altering these settings may cause
                  undesirable results.
                </Text>
              )}
            </Stack>
          </Accordion.Control>
          <Accordion.Panel>
            <DescriptionTable
              labelWidth="200px"
              items={trainingSettings.map((ts) => {
                let inp: React.ReactNode;
                const disabledOverride = ts.overrides?.[selectedRun.base]?.disabled;
                const disabled = disabledOverride ?? ts.disabled === true;

                if (ts.type === 'int' || ts.type === 'number') {
                  const override = ts.overrides?.[selectedRun.base];
                  inp = (
                    <NumberInputWrapper
                      min={override?.min ?? ts.min}
                      max={override?.max ?? ts.max}
                      precision={
                        ts.type === 'number' ? getPrecision(ts.step ?? ts.default) || 4 : undefined
                      }
                      step={ts.step}
                      sx={{ flexGrow: 1 }}
                      disabled={disabled}
                      format="default"
                      value={selectedRun.params[ts.name] as number}
                      onChange={(value) =>
                        updateRun(modelId, selectedRun.id, {
                          params: { [ts.name]: value },
                        })
                      }
                    />
                  );
                } else if (ts.type === 'select') {
                  let options = ts.options as string[];
                  // TODO if we fix the bitsandbytes issue, we can disable this
                  if (ts.name === 'optimizerType' && selectedRun.baseType === 'sdxl') {
                    options = options.filter((o) => o !== 'AdamW8Bit');
                  }
                  if (ts.name === 'lrScheduler' && selectedRun.params.optimizerType === 'Prodigy') {
                    options = options.filter((o) => o !== 'cosine_with_restarts');
                  }

                  inp = (
                    <SelectWrapper
                      data={options}
                      disabled={disabled}
                      value={selectedRun.params[ts.name] as string}
                      onChange={(value) =>
                        updateRun(modelId, selectedRun.id, {
                          params: { [ts.name]: value },
                        })
                      }
                    />
                  );
                } else if (ts.type === 'bool') {
                  inp = (
                    <Checkbox
                      py={8}
                      disabled={disabled}
                      checked={selectedRun.params[ts.name] as boolean}
                      onChange={(event) =>
                        updateRun(modelId, selectedRun.id, {
                          params: {
                            [ts.name]: event.currentTarget.checked,
                          },
                        })
                      }
                    />
                  );
                } else if (ts.type === 'string') {
                  inp = (
                    <TextInputWrapper
                      disabled={disabled}
                      clearable={!disabled}
                      value={selectedRun.params[ts.name] as string}
                      onChange={(event) =>
                        updateRun(modelId, selectedRun.id, {
                          params: {
                            [ts.name]: event.currentTarget.value,
                          },
                        })
                      }
                    />
                  );
                }

                return {
                  label: ts.hint ? (
                    <CivitaiTooltip
                      position="top"
                      variant="roundedOpaque"
                      withArrow
                      multiline
                      label={ts.hint}
                    >
                      <Group spacing={6}>
                        <Text inline style={{ cursor: 'help' }}>
                          {ts.label}
                        </Text>
                        {ts.name === 'targetSteps' && selectedRun.params.targetSteps > maxSteps && (
                          <IconAlertTriangle color="orange" size={16} />
                        )}
                      </Group>
                    </CivitaiTooltip>
                  ) : (
                    ts.label
                  ),
                  value: inp,
                };
              })}
            />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </>
  );
};
