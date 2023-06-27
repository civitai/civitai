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
  ActionIcon,
} from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconBook2, IconX } from '@tabler/icons-react';
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
import { generationParamsSchema } from '~/server/schema/generation.schema';
import { Generation } from '~/server/services/generation/generation.types';
import { trpc } from '~/utils/trpc';
import { constants } from '~/server/common/constants';
import { FieldArray } from '~/libs/form/components/FieldArray';
import { imageGenerationFormStorage } from '~/components/ImageGeneration/utils';

const resourceSchema = z
  .object({
    id: z.number(),
    modelType: z.nativeEnum(ModelType),
    strength: z.number().optional(),
    trainedWords: z.string().array().optional(),
    baseModel: z.string(),
  })
  .passthrough();

type Schema = Partial<z.infer<typeof schema>>;
const schema = generationParamsSchema.extend({
  model: resourceSchema,
  aspectRatio: z.string(),
  baseModel: z.string().optional(),
  additionalResources: resourceSchema.array().default([]),
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
  const defaultValues = (imageGenerationFormStorage.get() ?? defaultDemoValues) as Schema;
  const [opened, setOpened] = useState(false);
  const [baseModel, setBaseModel] = useState(defaultValues.model.baseModel);

  const setRequests = useImageGenerationStore((state) => state.setRequests);
  const { mutate, isLoading } = trpc.generation.createRequest.useMutation({
    onSuccess: (data) => {
      setRequests([data]);
      onSuccess?.();
    },
  });

  // #region [generate from model source]
  const modelQuery = trpc.generation.getResource.useQuery(
    { id: modelVersionId ?? 0 },
    { enabled: !!modelVersionId }
  );

  useEffect(() => {
    if (!modelQuery.data) return;
    form.reset({ model: modelQuery.data });
  }, [modelQuery.data]); // eslint-disable-line
  // #endregion

  // #region [generate from image source]
  const imageQuery = trpc.generation.getImageGenerationData.useQuery(
    { id: imageId ?? 0 },
    { enabled: !!imageId }
  );

  useEffect(() => {
    if (!imageQuery.data) return;
    form.reset(imageQuery.data);
  }, [imageQuery.data]); // eslint-disable-line
  // #endregion

  const form = useForm({
    schema,
    defaultValues: { ...defaults, ...defaultValues } as any,
  });

  const handleResourceChange = (resource: Generation.Client.Resource) => {
    const baseModel = form.getValues('baseModel');
    if (!baseModel) form.setValue('baseModel', resource.baseModel);
  };

  return (
    <ScrollArea.Autosize maxHeight={mobile ? 'calc(90vh - 87px)' : 'calc(100vh - 87px)'}>
      <Form
        form={form}
        onSubmit={(values) => {
          imageGenerationFormStorage.set(values);
          form.reset(values);
          const [width, height] = values.aspectRatio.split('x');
          mutate({
            height: Number(height),
            width: Number(width),
            resources: [values.model, ...values.additionalResources].map((resource) => ({
              modelVersionId: resource.id,
              type: resource.modelType,
              strength: resource.strength,
              triggerWord:
                resource.modelType === ModelType.TextualInversion
                  ? resource.trainedWords?.[0]
                  : undefined,
            })),
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
        <Stack>
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
                <Button onClick={() => setOpened(true)} variant="outline" size="xs" fullWidth>
                  Add Additional Resource
                </Button>
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
          {/* <Input.Wrapper
            labelProps={{ sx: { width: '100%' } }}
            label={
              <Group position="apart">
                Prompt
                <Text variant="link">
                <Group align="center" spacing={4}>
                  <span>From Collection</span> <IconBook2 size={16} />
                </Group>
              </Text>
              </Group>
            }
          >
            <MentionExample value={prompt} />
          </Input.Wrapper> */}
          <InputTextArea name="prompt" autosize label="Prompt" required />
          <InputTextArea name="negativePrompt" autosize label="Negative Prompt" />
          <Stack spacing={0}>
            <Input.Label>Aspect Ratio</Input.Label>
            <InputSegmentedControl name="aspectRatio" data={aspectRatioControls} />
          </Stack>

          {/* ADVANCED */}
          <Accordion variant="separated">
            <Accordion.Item value="advanced">
              <Accordion.Control>
                <Divider label="Advanced" labelPosition="left" labelProps={{ size: 'md' }} />
              </Accordion.Control>
              <Accordion.Panel>
                <Stack>
                  <InputNumber name="steps" label="Quality (Steps)" />
                  <InputNumber
                    name="cfgScale"
                    label="Creativity (CFG Scale)"
                    step={0.5}
                    precision={1}
                  />
                  <InputSelect
                    name="sampler"
                    label="Engine (Sampler)"
                    data={[...constants.samplers]}
                  />
                  {/* <Stack spacing={0}>
                  <Input.Label>Creativity (CFG Scale)</Input.Label>
                  <SegmentedControl data={cfgScales} />
                </Stack>
                <Stack spacing={0}>
                  <Input.Label>Engine (Sampler)</Input.Label>
                  <SegmentedControl data={samplers} />
                </Stack>
                <Stack spacing={0}>
                  <Input.Label>Quality (Steps)</Input.Label>
                  <SegmentedControl data={steps} />
                </Stack> */}
                  <Grid>
                    <Grid.Col span={6}>
                      <InputNumber
                        name="seed"
                        label="Seed"
                        placeholder="Random"
                        min={0}
                        format="default"
                        hideControls
                        rightSection={
                          <ActionIcon
                            color="gray"
                            radius="xl"
                            size="xs"
                            variant="filled"
                            mr={3}
                            onClick={() => form.setValue('seed', undefined)}
                          >
                            <IconX size={12} />
                          </ActionIcon>
                        }
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

          <InputNumber name="quantity" label="Quantity" min={0} max={10} />
          <Group>
            <Button onClick={() => form.reset()} variant="default">
              Reset
            </Button>
            <Button type="submit" loading={isLoading}>
              Go
            </Button>
          </Group>
          {/* TODO.Quantity,Go */}
        </Stack>
      </Form>
    </ScrollArea.Autosize>
  );
}

const aspectRatioDetails = [
  { label: 'Square', width: 512, height: 512 },
  { label: 'Landscape', width: 768, height: 512 },
  { label: 'Portrait', width: 576, height: 768 },
];
const aspectRatioControls = aspectRatioDetails.map(({ label, width, height }) => ({
  label: (
    <Stack spacing={4} py="xs">
      <Center>
        <Paper withBorder sx={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 30 }} />
      </Center>
      {label}
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
  sampler: 'Euler a',
  seed: undefined,
  clipSkip: 1,
  quantity: 1,
  aspectRatio: '512x512',
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
