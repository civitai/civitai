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
import { IconBook2, IconDice5, IconLock, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import {
  InputResourceSelect,
  ResourceSelectModal,
} from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import MentionExample from '~/components/ImageGeneration/SlateEditor/SlateEditor';
import { useImageGenerationStore } from '~/components/ImageGeneration/hooks/useImageGenerationState';
import { useIsMobile } from '~/hooks/useIsMobile';
import {
  Form,
  InputNumber,
  InputSegmentedControl,
  InputSelect,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { additionalResourceLimit, generationParamsSchema } from '~/server/schema/generation.schema';
import { Generation } from '~/server/services/generation/generation.types';
import { trpc } from '~/utils/trpc';
import { constants, Sampler } from '~/server/common/constants';
import { FieldArray } from '~/libs/form/components/FieldArray';
import { imageGenerationFormStorage } from '~/components/ImageGeneration/utils';
import { showErrorNotification } from '~/utils/notifications';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { parsePromptMetadata } from '~/utils/image-metadata';

const supportedSamplers = constants.samplers.filter((sampler) =>
  ['Euler a', 'Euler', 'Heun', 'LMS', 'DDIM', 'DPM++ 2M Karras', 'DPM2', 'DPM2 a'].includes(sampler)
);

const resourceSchema = z
  .object({
    id: z.number(),
    modelType: z.nativeEnum(ModelType),
    strength: z.number().optional(),
    trainedWords: z.string().array().optional(),
    baseModel: z.string().optional(),
  })
  .passthrough();

type Schema = Partial<z.infer<typeof schema>>;
const schema = generationParamsSchema.extend({
  model: resourceSchema
    .nullable()
    .refine((data) => !!data, { message: 'Please select a model to generate from' }),
  aspectRatio: z.string(),
  baseModel: z.string().optional(),
  additionalResources: resourceSchema.array().max(additionalResourceLimit).default([]),
});

export function Generate({
  onSuccess,
  modelVersionId,
  imageId,
}: {
  onSuccess?: () => void;
  modelVersionId?: number;
  imageId?: number;
}) {
  const mobile = useIsMobile({ breakpoint: 'md' });
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  const defaultValues = (imageGenerationFormStorage.get() ?? defaultDemoValues) as Schema;
  const [opened, setOpened] = useState(false);
  const [baseModel, setBaseModel] = useState(
    defaultValues.model?.baseModel ?? defaultValues.additionalResources?.[0]?.baseModel
  );
  const [showParsePrompt, setShowParsePrompt] = useState(false);
  const isMuted = currentUser?.muted ?? false;

  // Handle display of survey after 10 minutes
  if (!localStorage.getItem('generation-first-loaded'))
    localStorage.setItem('generation-first-loaded', Date.now().toString());
  const firstLoaded = parseInt(localStorage.getItem('generation-first-loaded') ?? '0');
  const showSurvey = Date.now() - firstLoaded > 1000 * 60 * 10;

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

  // #region [generate from model source]
  const modelQuery = trpc.generation.getResource.useQuery(
    { id: modelVersionId ?? 0 },
    { enabled: !!modelVersionId }
  );

  useEffect(() => {
    if (!modelQuery.data) return;
    const resource = modelQuery.data;
    if (resource.modelType === ModelType.Checkpoint) form.reset({ model: resource });
    else form.reset({ additionalResources: [resource] });
  }, [modelQuery.data]); // eslint-disable-line
  // #endregion

  // #region [generate from image source]
  const imageQuery = trpc.generation.getImageGenerationData.useQuery(
    { id: imageId ?? 0 },
    { enabled: !!imageId }
  );

  const randomQuery = trpc.generation.getRandomGenerationData.useQuery(undefined, {
    enabled: false,
  });

  useEffect(() => {
    if (!imageQuery.data) return;
    form.reset(imageQuery.data);
  }, [imageQuery.data]); // eslint-disable-line
  // #endregion

  const form = useForm({
    schema,
    defaultValues: { ...defaults, ...defaultValues } as any,
    reValidateMode: 'onSubmit',
  });

  const handleResourceChange = (resource: Generation.Resource) => {
    const baseModel = form.getValues('baseModel');
    if (!baseModel) form.setValue('baseModel', resource.baseModel);
  };

  const handleGetRandomGenParams = async () => {
    const { data: genData } = await randomQuery.refetch();
    if (genData) form.reset(genData);
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
        imageGenerationFormStorage.set(values);
        form.reset(values);
        const [width, height] = values.aspectRatio.split('x');
        mutate({
          height: Number(height),
          width: Number(width),
          resources: [...(values.model ? [values.model] : []), ...values.additionalResources].map(
            (resource) => ({
              modelVersionId: resource.id,
              type: resource.modelType,
              strength: resource.strength,
              triggerWord:
                resource.modelType === ModelType.TextualInversion
                  ? resource.trainedWords?.[0]
                  : undefined,
            })
          ),
          prompt: values.prompt,
          negativePrompt: values.negativePrompt,
          cfgScale: values.cfgScale,
          sampler: values.sampler,
          steps: values.steps,
          seed: values.seed,
          clipSkip: values.clipSkip,
          quantity: values.quantity,
        });
      }}
    >
      <Stack h="100%" spacing={0}>
        <ScrollArea sx={{ flex: 1, marginRight: -16, paddingRight: 16 }}>
          <Stack py="md">
            <InputResourceSelect
              label="Model"
              name="model"
              withAsterisk
              types={[ModelType.Checkpoint]}
              onChange={(value) => {
                if (value) setBaseModel(value.baseModel);
              }}
            />
            <FieldArray
              control={form.control}
              name="additionalResources"
              keyName={'uid' as any} // TODO.type fix
              render={({ fields, append, remove, update }) => (
                <Stack spacing="xs">
                  {fields.map((item, index) => (
                    <InputResourceSelect
                      key={item.id}
                      name={`additionalResources.${index}`}
                      types={[ModelType.LORA, ModelType.TextualInversion]}
                      onRemove={() => remove(index)}
                      onChange={(value) => {
                        if (value) update(index, value);
                      }}
                    />
                  ))}
                  {fields.length < additionalResourceLimit && (
                    <Button onClick={() => setOpened(true)} variant="outline" size="xs" fullWidth>
                      Add Additional Resource
                    </Button>
                  )}
                  <ResourceSelectModal
                    opened={opened}
                    onClose={() => setOpened(false)}
                    title="Select Additional Resource"
                    types={[ModelType.LORA, ModelType.TextualInversion]}
                    onSelect={(value) => append(value)}
                    notIds={[...fields.map((item) => item.id)]}
                    baseModel={baseModel}
                  />
                </Stack>
              )}
            />
            <InputTextArea
              name="prompt"
              label={
                <>
                  <Text inherit>Prompt</Text>
                  {/* {showParsePrompt && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        const prompt = form.getValues('prompt');
                        const metadata = parsePromptMetadata(prompt);
                        form.reset(metadata);
                        setShowParsePrompt(false);
                      }}
                      sx={{ order: 3, ml: 4 }}
                      compact
                    >
                      Fill form
                    </Button>
                  )}
                  <Tooltip label="Random" color="dark" withArrow>
                    <ActionIcon
                      variant="light"
                      loading={randomQuery.isFetching}
                      className={classes.generateButtonRandom}
                      onClick={handleGetRandomGenParams}
                    >
                      <IconDice5 size={20} strokeWidth={2} />
                    </ActionIcon>
                  </Tooltip> */}
                </>
              }
              labelProps={{ className: classes.promptInputLabel }}
              onPaste={(event) => {
                const text = event.clipboardData.getData('text/plain');
                if (text && text.includes('Steps:')) setShowParsePrompt(true);
              }}
              autosize
              withAsterisk
            />
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
                        <InputNumber
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
                onClick={() => {
                  form.reset(defaults);
                  imageGenerationFormStorage.set(defaults);
                }}
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
  },
  promptInputLabel: {
    display: 'inline-flex',
    gap: 4,
    marginBottom: 5,
  },
}));

const aspectRatioDetails = [
  { label: 'Square', width: 512, height: 512 },
  { label: 'Landscape', width: 768, height: 512 },
  { label: 'Portrait', width: 512, height: 768 },
];
const aspectRatioControls = aspectRatioDetails.map(({ label, width, height }) => ({
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
  sampler: 'Euler a' as Sampler,
  seed: undefined,
  clipSkip: 1,
  quantity: 1,
  aspectRatio: '512x512',
  prompt: '',
  negativePrompt: '',
  additionalResources: [],
};

// #region [developement]
const defaultDemoValues = {
  // prompt:
  //   'close up photo of a rabbit, forest, haze, halation, bloom, dramatic atmosphere, centred, rule of thirds, 200mm 1.4f macro shot',
  // negativePrompt:
  //   '(semi-realistic, cgi, 3d, render, sketch, cartoon, drawing, anime:1.4), text, close up, cropped, out of frame, worst quality, low quality, jpeg artifacts, ugly, duplicate, morbid, mutilated, extra fingers, mutated hands, poorly drawn hands, poorly drawn face, mutation, deformed, blurry, dehydrated, bad anatomy, bad proportions, extra limbs, cloned face, disfigured, gross proportions, malformed limbs, missing arms, missing legs, extra arms, extra legs, fused fingers, too many fingers, long neck',
  // cfgScale: 7,
  // steps: 25,
  // sampler: 'Euler a',
  // aspectRatio: '768x512',
  // quantity: 2,
  // clipSkip: 1,
  model: {
    id: 29460,
    name: 'V2.0',
    trainedWords: ['analog style', 'modelshoot style', 'nsfw', 'nudity'],
    modelId: 4201,
    modelName: 'Realistic Vision V2.0',
    modelType: ModelType.Checkpoint,
    baseModel: 'SD 1.5',
  },
};
// #endregion
