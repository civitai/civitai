import {
  Card,
  Group,
  NumberInputProps,
  SliderProps,
  Stack,
  Text,
  Button,
  CardProps,
  Center,
  Paper,
  Input,
  Accordion,
  Divider,
  createStyles,
  Tooltip,
  ScrollArea,
} from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconX } from '@tabler/icons-react';
import { uniq } from 'lodash-es';
import { UseFormReturn, DeepPartial } from 'react-hook-form';
import { BaseModelProvider } from '~/components/ImageGeneration/GenerationForm/BaseModelProvider';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import InputResourceSelect from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import InputResourceSelectMultiple from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import { PersistantAccordion } from '~/components/PersistantAccordion/PersistantAccordion';
import {
  Form,
  InputNumber,
  InputNumberSlider,
  InputSegmentedControl,
  InputSelect,
  InputSwitch,
  InputTextArea,
} from '~/libs/form';
import { generation } from '~/server/common/constants';
import { GenerateFormModel } from '~/server/schema/generation.schema';
import { getDisplayName } from '~/utils/string-helpers';

export function GenerateForm({
  form,
  onSubmit,
  isLoading,
}: {
  form: UseFormReturn<GenerateFormModel>;
  onSubmit: (data: GenerateFormModel) => void;
  isLoading?: boolean;
}) {
  const { classes } = useStyles();

  return (
    <Form form={form} onSubmit={onSubmit} style={{ height: '100%' }}>
      <BaseModelProvider form={form} getBaseModels={getBaseModels}>
        <Stack h="100%">
          <ScrollArea sx={{ flex: 1, marginRight: -16, paddingRight: 16 }}>
            <Stack py="md">
              <Card {...sharedCardProps}>
                <Stack>
                  <InputResourceSelect
                    name="model"
                    type={ModelType.Checkpoint}
                    label="Model"
                    buttonLabel="Add Model"
                    withAsterisk
                  />
                  <InputResourceSelectMultiple
                    name="resources"
                    limit={9}
                    groups={[
                      {
                        type: ModelType.LORA,
                        label: getDisplayName(ModelType.LORA),
                      },
                      {
                        type: ModelType.TextualInversion,
                        label: getDisplayName(ModelType.TextualInversion),
                      },
                    ]}
                    buttonLabel="Add additional resource"
                  />
                  <InputTextArea name="prompt" label="Prompt" withAsterisk autosize />
                  <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
                  <InputSwitch name="nsfw" label="Mature content" labelPosition="left" />
                </Stack>
              </Card>
              <Card {...sharedCardProps}>
                <Stack>
                  <Stack spacing={0}>
                    <Input.Label>Aspect Ratio</Input.Label>
                    <InputSegmentedControl name="aspectRatio" data={aspectRatioControls} />
                  </Stack>
                  <PersistantAccordion
                    storeKey="generation-form-advanced"
                    variant="filled"
                    styles={(theme) => ({
                      content: {
                        padding: 0,
                      },
                      item: {
                        overflow: 'hidden',
                        border: 'none',
                        background: 'transparent',
                      },
                      control: {
                        padding: 0,
                        paddingBottom: theme.spacing.xs,
                      },
                    })}
                  >
                    <Accordion.Item value="advanced">
                      <Accordion.Control>
                        <Divider
                          label="Advanced"
                          labelPosition="left"
                          labelProps={{ size: 'sm', weight: 500 }}
                        />
                      </Accordion.Control>
                      <Accordion.Panel>
                        <Stack>
                          <InputSelect name="sampler" label="Sampler" data={generation.samplers} />
                          <Group position="apart">
                            <InputNumberSlider
                              name="steps"
                              label="Steps"
                              min={1}
                              max={150}
                              sliderProps={sharedSliderProps}
                              numberProps={sharedNumberProps}
                            />
                            <InputNumberSlider
                              name="cfgScale"
                              label="CFG Scale"
                              min={1}
                              max={30}
                              step={0.5}
                              precision={1}
                              sliderProps={sharedSliderProps}
                              numberProps={sharedNumberProps}
                            />
                          </Group>
                          <InputSeed name="seed" label="Seed" min={1} max={generation.maxSeed} />
                          <InputNumberSlider
                            name="clipSkip"
                            label="Clip Skip"
                            min={0}
                            max={10}
                            sliderProps={{
                              ...sharedSliderProps,
                              marks: clipSkipMarks,
                            }}
                            numberProps={sharedNumberProps}
                          />
                          <InputResourceSelect
                            name="vae"
                            type={ModelType.VAE}
                            label={getDisplayName(ModelType.VAE)}
                            buttonLabel="Add VAE"
                          />
                        </Stack>
                      </Accordion.Panel>
                    </Accordion.Item>
                  </PersistantAccordion>
                </Stack>
              </Card>
              {/* <Card {...sharedCardProps}>
          <Stack>
            <Text>TODO.hires</Text>
          </Stack>
        </Card> */}
            </Stack>
          </ScrollArea>
          <Group spacing={0} className={classes.generateButtonContainer} noWrap>
            <Card withBorder className={classes.generateButtonQuantity} p={0}>
              <Stack spacing={0}>
                <Text
                  size="xs"
                  color="dimmed"
                  weight={500}
                  ta="center"
                  className={classes.generateButtonQuantityText}
                >
                  Quantity
                </Text>
                <InputNumber
                  name="quantity"
                  min={1}
                  max={10}
                  className={classes.generateButtonQuantityInput}
                />
              </Stack>
            </Card>
            <Button
              type="submit"
              size="lg"
              loading={isLoading}
              className={classes.generateButtonButton}
            >
              Generate
            </Button>
            <Tooltip label="Reset" color="dark" withArrow>
              <Button
                onClick={() => form.reset()}
                variant="outline"
                className={classes.generateButtonReset}
                px="xs"
              >
                <IconX size={20} strokeWidth={3} />
              </Button>
            </Tooltip>
          </Group>
        </Stack>
      </BaseModelProvider>
    </Form>
  );
}

const useStyles = createStyles((theme) => ({
  generationContainer: {},
  generateButtonContainer: {
    width: '100%',
    justifyContent: 'stretch',
    alignItems: 'stretch',
  },
  generateButtonQuantity: {
    width: 100,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
  },
  generateButtonQuantityText: {
    paddingRight: 25,
  },
  generateButtonQuantityInput: {
    marginTop: -20,
    input: {
      background: 'transparent',
      border: 'none',
      borderTopRightRadius: 0,
      borderBottomRightRadius: 0,
      borderTopLeftRadius: 0,
      textAlign: 'center',
      paddingRight: 25 + 12,
      paddingTop: 18,
      paddingBottom: 6,
      lineHeight: 1,
      fontWeight: 500,
      height: 'auto',
    },
  },
  generateButtonButton: {
    flex: 1,
    borderRadius: 0,
    height: 'auto',
  },

  generateButtonReset: {
    borderBottomLeftRadius: 0,
    borderTopLeftRadius: 0,
    height: 'auto',
  },

  generateButtonRandom: {
    borderRadius: 0,
    height: 'auto',
    order: 3,
  },
  promptInputLabel: {
    display: 'inline-flex',
    gap: 4,
    marginBottom: 5,
    alignItems: 'center',
  },
}));

const sharedCardProps: Omit<CardProps, 'children'> = {
  withBorder: true,
};

const sharedSliderProps: SliderProps = {
  size: 'sm',
};

const sharedNumberProps: NumberInputProps = {
  size: 'sm',
};

const getBaseModels = (data: DeepPartial<GenerateFormModel>) => {
  const baseModels: string[] = [];
  if (data.model?.baseModel) baseModels.push(data.model.baseModel);
  if (data.resources) {
    for (const resource of data.resources) {
      if (resource?.baseModel) baseModels.push(resource.baseModel);
    }
  }
  // if (data.vae) baseModels.push(data.vae.baseModel);

  return uniq(baseModels);
};

const aspectRatioControls = generation.aspectRatios.map(({ label, width, height }) => ({
  label: (
    <Stack spacing={2}>
      <Center>
        <Paper withBorder sx={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 20 }} />
      </Center>
      <Stack spacing={0}>
        <Text size="xs">{label}</Text>
        <Text size={10} color="dimmed">{`${width}x${height}`}</Text>
      </Stack>
    </Stack>
  ),
  value: `${width}x${height}`,
}));

const clipSkipMarks = Array(10)
  .fill(0)
  .map((_, index) => ({ value: index + 1 }));
