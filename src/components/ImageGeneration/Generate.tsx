import {
  Center,
  Group,
  Input,
  Paper,
  Stack,
  Text,
  Accordion,
  Divider,
  Grid,
  Button,
  ScrollArea,
  createStyles,
  Card,
  Tooltip,
  ThemeIcon,
  ActionIcon,
} from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconArrowAutofitDown, IconInfoCircle, IconLock, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useImageGenerationStore } from '~/components/ImageGeneration/hooks/useImageGenerationState';
import {
  Form,
  InputNumber,
  InputSegmentedControl,
  InputSelect,
  InputSwitch,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { Sampler } from '~/server/common/constants';
import { showErrorNotification } from '~/utils/notifications';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { parsePromptMetadata } from '~/utils/image-metadata';
import { useLocalStorage } from '@mantine/hooks';
import { imageGenerationSchema } from '~/server/schema/image.schema';
import { useGenerationResourceStore } from '~/components/ImageGeneration/GenerationResources/useGenerationResourceStore';
import { GenerationResources } from '~/components/ImageGeneration/GenerationResources/GenerationResources';
import { AddGenerationResourceButton } from '~/components/ImageGeneration/GenerationResources/AddGenerationResource';
import { GenerationResourceControl } from '~/components/ImageGeneration/GenerationResources/GenerationResourceControl';
import { getDisplayName } from '~/utils/string-helpers';
import { Generation } from '~/server/services/generation/generation.types';
import generationForm, {
  generationFormSchema,
  supportedAspectRatios,
} from '~/components/ImageGeneration/utils/generationFormStorage';
import { supportedSamplers } from '~/server/schema/generation.schema';
import { useGenerationPanelControls } from '~/components/ImageGeneration/GenerationPanel';

const ADDITIONAL_RESOURCE_TYPES = [ModelType.LORA, ModelType.TextualInversion];
export function Generate({ onSuccess }: { onSuccess?: () => void }) {
  const { classes } = useStyles();
  const currentUser = useCurrentUser();

  const [showFillForm, setShowFillForm] = useState(false);
  const isMuted = currentUser?.muted ?? false;
  const [showAdvanced, setShowAdvanced] = useLocalStorage({
    key: 'generation-show-advanced',
    defaultValue: false,
  });

  // #region [Handle display of survey after 10 minutes]
  if (!localStorage.getItem('generation-first-loaded'))
    localStorage.setItem('generation-first-loaded', Date.now().toString());
  const firstLoaded = parseInt(localStorage.getItem('generation-first-loaded') ?? '0');
  const showSurvey = Date.now() - firstLoaded > 1000 * 60 * 10;
  // #endregion

  const hasUnavailable = useGenerationResourceStore((state) => state.hasUnavailable);
  const setRequests = useImageGenerationStore((state) => state.setRequests);
  const { mutate, isLoading } = trpc.generation.createRequest.useMutation({
    onSuccess: (data) => {
      setRequests([data], true);
      onSuccess?.();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to generate',
        error: new Error(error.message),
        reason: 'An unexpected error occurred. Please try again later.',
      });
    },
  });

  const getDefaultFormValues = (props: Generation.DataParams = {}) => ({
    nsfw: currentUser?.showNsfw ?? false,
    ...defaults,
    ...props,
  });

  const [defaultValues, setDefaultValues] = useState(
    getDefaultFormValues(generationForm.data.params)
  );
  const form = useForm({
    schema: generationFormSchema,
    reValidateMode: 'onSubmit',
  });

  useEffect(() => {
    form.reset({ ...defaultValues });
  }, [defaultValues]); //eslint-disable-line

  const handleReset = (props: Generation.Data) => {
    useGenerationResourceStore.getState().setResources(props.resources);
    const data = generationForm.setData(props);
    setDefaultValues(getDefaultFormValues(data.params));
  };

  useEffect(() => {
    useGenerationResourceStore.getState().setResources(generationForm.data.resources);
  }, []); // eslint-disable-line

  // #region [default generation data]
  const input = useGenerationPanelControls((state) => state.input);
  const { data } = trpc.generation.getGenerationData.useQuery({ ...input! }, { enabled: !!input });

  const randomQuery = trpc.generation.getRandomGenerationData.useQuery(undefined, {
    enabled: false,
  });

  useEffect(() => {
    if (data) handleReset(data);
  }, [data]); //eslint-disable-line
  // #endregion

  useEffect(() => {
    const subscription = form.watch((value, { name, type }) => {
      if (type !== 'change' || !name) return;
      generationForm.setParam(name, value[name]);
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleGetRandomGenParams = async () => {
    const { data: genData } = await randomQuery.refetch();
    const result = imageGenerationSchema.safeParse(genData);
    if (result.success) {
      const { sampler, ...rest } = result.data;
      form.reset({ ...rest, sampler: (sampler as Sampler) ?? 'Euler a' });
    } else console.error(result.error);
  };

  const handleParsePrompt = () => {
    const prompt = form.getValues('prompt');
    const metadata = parsePromptMetadata(prompt);
    const result = imageGenerationSchema.safeParse({
      ...defaults,
      ...metadata,
    });
    if (result.success) {
      const { sampler, ...rest } = result.data;
      form.reset({ ...rest, sampler: (sampler as Sampler) ?? 'Euler a' });
      setShowFillForm(false);
    } else {
      console.error(result.error);
      showErrorNotification({
        title: 'Unable to parse prompt',
        error: new Error('We are unable to fill out the form with the provided prompt.'),
      });
    }
  };

  if (isMuted)
    return (
      <Center h="100%" w="75%" mx="auto">
        <Stack spacing="xl" align="center">
          <ThemeIcon size="xl" radius="xl" color="yellow">
            <IconLock />
          </ThemeIcon>
          <Text align="center">You cannot create new generations because you have been muted</Text>
        </Stack>
      </Center>
    );
  return (
    <Form
      form={form}
      style={{ height: '100%' }}
      onSubmit={(values) => {
        const resources = useGenerationResourceStore.getState().getValidatedResources();
        if (!resources) return;
        const [width, height] = values.aspectRatio.split('x');
        const params = {
          ...values,
          seed: values.seed ?? -1,
          height: Number(height),
          width: Number(width),
        };
        generationForm.setData({ resources, params });
        mutate({ resources, params });
      }}
    >
      <Stack h="100%" spacing={0}>
        <ScrollArea sx={{ flex: 1, marginRight: -16, paddingRight: 16 }}>
          <Stack py="md">
            {/* Generation Resources */}
            <GenerationResourceControl type={ModelType.Checkpoint}>
              {({ errors, type }) => (
                <Input.Wrapper error={errors?.[0]}>
                  <GenerationResources type={type} />
                  <AddGenerationResourceButton
                    limit={1}
                    label="Add Model"
                    types={[ModelType.Checkpoint]}
                  />
                </Input.Wrapper>
              )}
            </GenerationResourceControl>
            {ADDITIONAL_RESOURCE_TYPES.map((type) => (
              <GenerationResourceControl key={type} type={type}>
                {({ count }) =>
                  count > 0 ? (
                    <Input.Wrapper label={getDisplayName(type)}>
                      <Stack spacing={2}>
                        <GenerationResources type={type} />
                      </Stack>
                    </Input.Wrapper>
                  ) : null
                }
              </GenerationResourceControl>
            ))}
            <AddGenerationResourceButton
              limit={9}
              label="Add Additional Resource"
              types={ADDITIONAL_RESOURCE_TYPES}
            />
            <Stack spacing={0}>
              <InputTextArea
                name="prompt"
                label={
                  <Group position="apart">
                    <Text inherit>Prompt</Text>
                    {/* <Tooltip label="Random" color="dark" withArrow>
                      <ActionIcon
                        variant="light"
                        loading={randomQuery.isFetching}
                        className={classes.generateButtonRandom}
                        onClick={handleGetRandomGenParams}
                      >
                        <IconDice5 size={20} strokeWidth={2} />
                      </ActionIcon>
                    </Tooltip> */}
                  </Group>
                }
                placeholder="Prompt"
                labelProps={{ className: classes.promptInputLabel }}
                onPaste={(event) => {
                  const text = event.clipboardData.getData('text/plain');
                  if (text) setShowFillForm(text.includes('Steps:'));
                }}
                onChange={(event) => {
                  const text = event.target.value;
                  if (text && !text.includes('Steps:')) setShowFillForm(false);
                }}
                styles={{ input: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } }}
                autosize
                withAsterisk
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
            <InputTextArea name="negativePrompt" autosize label="Negative Prompt" />
            <Stack spacing={0}>
              <Input.Label>Aspect Ratio</Input.Label>
              <InputSegmentedControl name="aspectRatio" data={aspectRatioControls} />
            </Stack>
            {/* ADVANCED */}
            <Accordion
              variant="separated"
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
              value={showAdvanced ? 'advanced' : null}
              onChange={(value) => setShowAdvanced(value === 'advanced')}
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
                    <InputNumber name="steps" label="Quality (Steps)" min={1} max={150} />
                    <InputNumber
                      name="cfgScale"
                      label="Creativity (CFG Scale)"
                      step={0.5}
                      precision={1}
                    />
                    <InputSelect
                      name="sampler"
                      label="Engine (Sampler)"
                      data={[...supportedSamplers]}
                    />
                    <Grid>
                      <Grid.Col span={6}>
                        <InputNumber //TODO - add button in label to give random seed value
                          name="seed"
                          label="Seed"
                          placeholder="Random"
                          min={-1}
                          max={999999999999999}
                          format="default"
                          hideControls
                          clearable
                        />
                      </Grid.Col>
                      <Grid.Col span={6}>
                        <InputNumber name="clipSkip" label="Clip Skip" min={0} max={10} />
                      </Grid.Col>
                    </Grid>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          </Stack>
        </ScrollArea>
        <Stack spacing="xs">
          <Stack spacing="xs">
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
                disabled={hasUnavailable}
                loading={isLoading}
                className={classes.generateButtonButton}
              >
                Generate
              </Button>
              <Tooltip label="Reset" color="dark" withArrow>
                <Button
                  onClick={() => handleReset({ resources: [], params: defaults })}
                  variant="outline"
                  className={classes.generateButtonReset}
                  px="xs"
                >
                  <IconX size={20} strokeWidth={3} />
                </Button>
              </Tooltip>
            </Group>
            {showSurvey && (
              <DismissibleAlert
                id="generation-alpha-feedback"
                title="Share your feedback!"
                content={
                  <Text>
                    Thank you for participating in our generation tech test. To help us improve the
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
          <Group spacing="xs">
            <InputSwitch
              name="nsfw"
              size="xs"
              c="dimmed"
              label={
                <Text c="dimmed" component="span" sx={{ lineHeight: 1 }}>
                  Mature content
                </Text>
              }
            />
            <Tooltip
              label="Disabling mature content will reduce, not eliminate, the probability of mature content in generated images"
              width={300}
              multiline
            >
              <ActionIcon variant="transparent" size="xs">
                <IconInfoCircle />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Stack>
      </Stack>
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

const aspectRatioControls = supportedAspectRatios.map(({ label, width, height }) => ({
  label: (
    <Stack spacing={4}>
      <Center>
        <Paper withBorder sx={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 20 }} />
      </Center>
      <Text size="xs">{label}</Text>
    </Stack>
  ),
  value: `${width}x${height}`,
}));

const cfgScales = [
  { label: 'Creative', value: '4' },
  { label: 'Balanced', value: '7' },
  { label: 'Precise', value: '10' },
];

const samplers = [
  { label: 'Fast', value: 'Euler A' },
  { label: 'Popular', value: 'DPM++ 2M Karras' },
  { label: 'Quality', value: 'DPM++ SDE Karras' },
];

const steps = [
  { label: 'Fast', value: '10' },
  { label: 'Balanced', value: '20' },
  { label: 'High', value: '30' },
];

const defaults = {
  cfgScale: 7,
  steps: 25,
  sampler: 'DPM++ 2M Karras' as Sampler,
  seed: -1,
  clipSkip: 2,
  quantity: 4,
  aspectRatio: '512x512',
  prompt: '',
  negativePrompt: '',
};
