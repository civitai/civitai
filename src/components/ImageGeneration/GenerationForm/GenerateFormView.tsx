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
  ScrollArea,
} from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconArrowAutofitDown } from '@tabler/icons-react';
import { uniq } from 'lodash-es';
import { useState } from 'react';
import { UseFormReturn, DeepPartial } from 'react-hook-form';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { BaseModelProvider } from '~/components/ImageGeneration/GenerationForm/BaseModelProvider';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import InputResourceSelect from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import InputResourceSelectMultiple from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import { PersistentAccordion } from '~/components/PersistentAccordion/PersistantAccordion';
import {
  InputNumber,
  InputNumberSlider,
  InputSegmentedControl,
  InputSelect,
  InputSwitch,
  InputTextArea,
  PersistentForm,
} from '~/libs/form';
import {
  BaseModelSetType,
  BaseModel,
  baseModelSets,
  generation,
  getGenerationConfig,
} from '~/server/common/constants';
import { GenerateFormModel, generationFormShapeSchema } from '~/server/schema/generation.schema';
import { imageGenerationSchema } from '~/server/schema/image.schema';
import { generationStore } from '~/store/generation.store';
import { parsePromptMetadata } from '~/utils/metadata';
import { showErrorNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';

export function GenerateFormView({
  form,
  onSubmit,
}: {
  form: UseFormReturn<GenerateFormModel>;
  onSubmit: (data: GenerateFormModel) => void;
}) {
  const { classes } = useStyles();
  const { formState } = form;
  const { isSubmitting } = formState;

  // #region [Handle display of survey after 10 minutes]
  if (!localStorage.getItem('generation-first-loaded'))
    localStorage.setItem('generation-first-loaded', Date.now().toString());
  const firstLoaded = parseInt(localStorage.getItem('generation-first-loaded') ?? '0');
  const showSurvey = Date.now() - firstLoaded > 1000 * 60 * 10;
  // #endregion

  // #region [Handle parse prompt]
  const [showFillForm, setShowFillForm] = useState(false);
  const handleParsePrompt = async () => {
    const prompt = form.getValues('prompt');
    const metadata = await parsePromptMetadata(prompt);
    const result = imageGenerationSchema.safeParse(metadata);
    if (result.success) {
      generationStore.setParams(result.data);
      setShowFillForm(false);
    } else {
      console.error(result.error);
      showErrorNotification({
        title: 'Unable to parse prompt',
        error: new Error('We are unable to fill out the form with the provided prompt.'),
      });
    }
  };
  // #endregion

  return (
    <PersistentForm
      form={form}
      onSubmit={onSubmit}
      style={{ height: '100%' }}
      name="generation-form"
      storage={typeof window !== 'undefined' ? window.localStorage : undefined}
      schema={generationFormShapeSchema.deepPartial()}
    >
      <BaseModelProvider getBaseModels={getBaseModels}>
        {({ baseModel }) => {
          const isSDXL = baseModel === 'SDXL';
          return (
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
                        groups={getGenerationConfig(baseModel).additionalResourceTypes.map(
                          (type) => ({ type, label: getDisplayName(type) })
                        )}
                        // groups={[
                        //   {
                        //     type: ModelType.LORA,
                        //     label: getDisplayName(ModelType.LORA),
                        //   },
                        //   {
                        //     type: ModelType.TextualInversion,
                        //     label: getDisplayName(ModelType.TextualInversion),
                        //   },
                        //   ...getGenerationConfig(baseModel).additionalResourceTypes.map(type => ({type, label: getDisplayName(type)}))
                        // ]}
                        buttonLabel="Add additional resource"
                      />
                      <Stack spacing={0}>
                        <InputTextArea
                          name="prompt"
                          label="Prompt"
                          withAsterisk
                          autosize
                          styles={
                            showFillForm
                              ? { input: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } }
                              : undefined
                          }
                          onPaste={(event) => {
                            const text = event.clipboardData.getData('text/plain');
                            if (text) setShowFillForm(text.includes('Steps:'));
                          }}
                        />
                        {showFillForm && (
                          <Button
                            variant="light"
                            onClick={handleParsePrompt}
                            leftIcon={<IconArrowAutofitDown size={16} />}
                            sx={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}
                            fullWidth
                          >
                            Apply Parameters
                          </Button>
                        )}
                      </Stack>

                      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
                      <InputSwitch name="nsfw" label="Mature content" labelPosition="left" />
                    </Stack>
                  </Card>
                  <Card {...sharedCardProps}>
                    <Stack>
                      <Stack spacing={0}>
                        <Input.Label>Aspect Ratio</Input.Label>
                        <InputSegmentedControl
                          name="aspectRatio"
                          data={getAspectRatioControls(baseModel)}
                        />
                      </Stack>
                      <PersistentAccordion
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
                              <InputSelect
                                name="sampler"
                                label="Sampler"
                                data={generation.samplers}
                              />
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
                                  max={isSDXL ? 10 : 30}
                                  step={0.5}
                                  precision={1}
                                  sliderProps={sharedSliderProps}
                                  numberProps={sharedNumberProps}
                                />
                              </Group>
                              <InputSeed
                                name="seed"
                                label="Seed"
                                min={1}
                                max={generation.maxSeed}
                              />
                              {!isSDXL && (
                                <InputNumberSlider
                                  name="clipSkip"
                                  label="Clip Skip"
                                  min={1}
                                  max={10}
                                  sliderProps={{
                                    ...sharedSliderProps,
                                    marks: clipSkipMarks,
                                  }}
                                  numberProps={sharedNumberProps}
                                />
                              )}
                              {!isSDXL && (
                                <InputResourceSelect
                                  name="vae"
                                  type={ModelType.VAE}
                                  label={getDisplayName(ModelType.VAE)}
                                  buttonLabel="Add VAE"
                                />
                              )}
                            </Stack>
                          </Accordion.Panel>
                        </Accordion.Item>
                      </PersistentAccordion>
                    </Stack>
                  </Card>
                  {/* <Card {...sharedCardProps}>
          <Stack>
            <Text>TODO.hires</Text>
          </Stack>
        </Card> */}
                </Stack>
              </ScrollArea>
              <Group spacing="xs" className={classes.generateButtonContainer} noWrap>
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
                  loading={isSubmitting}
                  className={classes.generateButtonButton}
                >
                  Generate
                </Button>
                {/* <Tooltip label="Reset" color="dark" withArrow> */}
                <Button
                  onClick={() => form.reset()}
                  variant="outline"
                  className={classes.generateButtonReset}
                  px="xs"
                >
                  {/* <IconX size={20} strokeWidth={3} /> */}
                  Clear All
                </Button>
                {/* </Tooltip> */}
              </Group>
              {showSurvey && (
                <DismissibleAlert
                  id="generation-alpha-feedback"
                  title="Share your feedback!"
                  content={
                    <Text>
                      Thank you for participating in our generation beta. To help us improve the
                      service and prioritize feature development, please take a moment to fill out{' '}
                      <Text
                        component="a"
                        td="underline"
                        href="https://forms.clickup.com/8459928/f/825mr-6111/V0OXEDK2MIO5YKFZV4"
                        variant="link"
                        target="_blank"
                      >
                        our survey
                      </Text>
                      .
                    </Text>
                  }
                />
              )}
            </Stack>
          );
        }}
      </BaseModelProvider>
    </PersistentForm>
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
    // borderTopRightRadius: 0,
    // borderBottomRightRadius: 0,
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
    // borderRadius: 0,
    height: 'auto',
  },

  generateButtonReset: {
    // borderBottomLeftRadius: 0,
    // borderTopLeftRadius: 0,
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

const baseModelSetsEntries = Object.entries(baseModelSets);
const getBaseModels = (data: DeepPartial<GenerateFormModel>) => {
  const baseModels: string[] = [];
  let baseModel: BaseModelSetType | undefined;
  const defaultResource = data.model ?? data.resources?.[0] ?? data.vae;
  const checkpointBaseModel = defaultResource?.baseModel;
  if (checkpointBaseModel) {
    baseModels.push(checkpointBaseModel);
    baseModel = baseModelSetsEntries.find(([, v]) =>
      v.includes(checkpointBaseModel as BaseModel)
    )?.[0] as BaseModelSetType;
  }
  if (data.resources) {
    for (const resource of data.resources) {
      if (resource?.baseModel) baseModels.push(resource.baseModel);
    }
  }

  return { baseModel, baseModels: uniq(baseModels) };
};

const getAspectRatioControls = (baseModel?: string) => {
  const aspectRatios = getGenerationConfig(baseModel).aspectRatios;
  return aspectRatios.map(({ label, width, height }) => ({
    label: (
      <Stack spacing={2}>
        <Center>
          <Paper
            withBorder
            sx={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 20 }}
          />
        </Center>
        <Stack spacing={0}>
          <Text size="xs">{label}</Text>
          <Text size={10} color="dimmed">{`${width}x${height}`}</Text>
        </Stack>
      </Stack>
    ),
    value: `${width}x${height}`,
  }));
};

const clipSkipMarks = Array(10)
  .fill(0)
  .map((_, index) => ({ value: index + 1 }));
