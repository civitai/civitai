import { Accordion, Button, Group, Input, Stack, Title } from '@mantine/core';
import { TrainingStatus } from '@prisma/client';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { z } from 'zod';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { goBack } from '~/components/Resource/Forms/Training/TrainingCommon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  Form,
  InputCheckbox,
  InputNumber,
  InputSegmentedControl,
  InputSelect,
  InputText,
  useForm,
} from '~/libs/form';
import {
  TrainingDetailsBaseModel,
  trainingDetailsBaseModels,
  TrainingDetailsObj,
  trainingDetailsParams,
} from '~/server/schema/model-version.schema';
import { ModelById } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

// const useStyles = createStyles((theme) => ({
//   reviewData: {
//     '& > div': {
//       alignItems: 'center',
//       gap: theme.spacing.md,
//     },
//   },
// }));

const baseModelDescriptions: {
  [key in TrainingDetailsBaseModel]: { label: string; description: string };
} = {
  sd_1_5: { label: 'SD 1.5', description: 'Useful for all purposes.' },
  sdxl: { label: 'SDXL', description: 'Useful for all purposes.' },
  anime: { label: 'Anime', description: 'Results will have an anime aesthetic' },
  semi: { label: 'Semi-realistic', description: 'Results will be a blend of anime and realism' },
  realistic: { label: 'Realistic', description: 'Results will be extremely realistic.' },
};

type TrainingSettingsType<T extends string> = {
  name: string;
  label: string;
  type: string;
  default: string | number | boolean | ((...args: never[]) => string | number);
  options?: string[];
  min?: number;
  max?: number;
  disabled?: boolean;
  overrides?: {
    [override in T]: {
      default?: string | number | boolean | ((...args: never[]) => string | number);
      min?: number;
      max?: number;
    };
  };
};

const trainingSettings: TrainingSettingsType<string>[] = [
  { name: 'epochs', label: 'Epochs', type: 'int', default: 10, min: 3, max: 16 },
  {
    name: 'num_repeats',
    label: 'Num Repeats',
    type: 'int',
    default: (n: number) => Math.max(1, Math.min(16, Math.ceil(200 / n))),
    min: 1,
    max: 16,
  },
  { name: 'resolution', label: 'Resolution', type: 'int', default: 512, min: 512, max: 1024 },
  { name: 'lora_type', label: 'LoRA Type', type: 'select', default: 'lora', options: ['lora'] }, // LoCon Lycoris", "LoHa Lycoris
  { name: 'enable_bucket', label: 'Enable Bucket', type: 'bool', default: true },
  { name: 'keep_tokens', label: 'Keep Tokens', type: 'int', default: 1, min: 0, max: 1 },
  { name: 'train_batch_size', label: 'Train Batch Size', type: 'int', default: 2, min: 1, max: 4 },
  { name: 'unet_lr', label: 'Unet LR', type: 'number', default: 0.0005, min: 0, max: 1 },
  {
    name: 'text_encoder_lr',
    label: 'Text Encoder LR',
    type: 'number',
    default: 0.0001,
    min: 0,
    max: 1,
  },
  {
    name: 'lr_scheduler',
    label: 'LR Scheduler',
    type: 'select',
    default: 'cosine_with_restarts',
    options: [
      'constant',
      'cosine',
      'cosine_with_restarts',
      'constant_with_warmup',
      'linear',
      'polynomial',
    ],
  },
  {
    name: 'lr_scheduler_number',
    label: 'LR Scheduler Number',
    type: 'int',
    default: 3,
    min: 1,
    max: 4,
  },
  { name: 'min_snr_gamma', label: 'Min SNR Gamma', type: 'int', default: 5, min: 0, max: 20 },
  {
    name: 'network_dim',
    label: 'Network Dim',
    type: 'int',
    default: 32,
    min: 1,
    max: 128,
    overrides: { sdxl: { max: 256 } },
  },
  {
    name: 'network_alpha',
    label: 'Network Alpha',
    type: 'int',
    default: 16,
    min: 1,
    max: 128,
    overrides: { sdxl: { max: 256 } },
  },
  {
    name: 'optimizer',
    label: 'Optimizer',
    type: 'select',
    default: 'AdamW8Bit',
    options: ['AdamW8Bit'],
  }, // other options...
  { name: 'optimizer_args', label: 'Optimizer Args', type: 'string', default: 'weight_decay=0.1' },
  { name: 'shuffle_tags', label: 'Shuffle Tags', type: 'bool', default: true },
  {
    name: 'steps',
    label: 'Steps',
    type: 'int',
    default: (n: number, r: number, e: number, b: number) => Math.ceil((n * r * e) / b),
    disabled: true,
  },
];

export const TrainingFormSubmit = ({ model }: { model: ModelById }) => {
  const [formBaseModel, setDisplayBaseModel] = useState<TrainingDetailsBaseModel | undefined>();
  const router = useRouter();
  const [awaitInvalidate, setAwaitInvalidate] = useState<boolean>(false);
  const queryUtils = trpc.useContext();
  const currentUser = useCurrentUser();

  const thisStep = 3;

  const thisModelVersion = model.modelVersions[0];
  const thisTrainingDetails = thisModelVersion.trainingDetails as TrainingDetailsObj | undefined;

  const schema = trainingDetailsParams.extend({
    baseModel: z.enum(trainingDetailsBaseModels, {
      errorMap: () => ({ message: 'A base model must be chosen.' }),
    }),
  });

  const defaultValues: z.infer<typeof schema> = {
    baseModel: thisTrainingDetails?.baseModel ?? undefined,
    ...(thisTrainingDetails?.params
      ? thisTrainingDetails.params
      : trainingSettings.reduce((a, v) => ({ ...a, [v.name]: v.default }), {})),
  };

  if (!thisTrainingDetails?.params) {
    defaultValues.num_repeats = defaultValues.num_repeats(
      thisModelVersion.files.find((f) => f.type === 'Training Data')?.metadata['numImages'] || 1
    );
    defaultValues.steps = defaultValues.steps(
      thisModelVersion.files.find((f) => f.type === 'Training Data')?.metadata['numImages'] || 1,
      defaultValues.num_repeats,
      defaultValues.epochs,
      defaultValues.train_batch_size
    );
  }

  console.log(defaultValues);
  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues,
    shouldUnregister: false,
  });

  // TODO [bw]
  // useEffect(() => {
  //   // change the defaults? but what if already modified?
  // }, [formBaseModel])

  const { isDirty, errors } = form.formState;

  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation({
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to saved model version',
      });
    },
  });

  const handleSubmit = ({ ...rest }: z.infer<typeof schema>) => {
    console.log('dirty', isDirty);
    console.log(rest);
    const userTrainingDashboardURL = `/user/${currentUser?.username}/models?section=training`;
    if (isDirty) {
      console.log('running model mutation');
      setAwaitInvalidate(true);

      const { baseModel, ...paramData } = rest;

      const versionMutateData = {
        // these 4 appear to be required for upsert, but aren't actually being updated.
        // only ID should technically be necessary
        id: thisModelVersion.id,
        name: thisModelVersion.name,
        modelId: model.id,
        baseModel: thisModelVersion.baseModel,
        trainingStatus: TrainingStatus.Submitted,
        trainingDetails: {
          ...((thisModelVersion.trainingDetails as TrainingDetailsObj) || {}),
          baseModel: baseModel,
          params: paramData,
        },
      };

      upsertVersionMutation.mutate(versionMutateData, {
        onSuccess: async () => {
          // TODO [bw] ideally, we would simply update the proper values rather than invalidate to skip the loading step
          await queryUtils.modelVersion.getById.invalidate({ id: thisModelVersion.id });
          await queryUtils.model.getById.invalidate({ id: model.id });
          setAwaitInvalidate(false);
          showSuccessNotification({
            title: 'Successfully submitted for training!',
            message: 'You will be notified when training is complete.',
            autoClose: 3000,
          });
          await router.replace(userTrainingDashboardURL);
        },
        onError: (error) => {
          setAwaitInvalidate(false);
          showErrorNotification({
            error: new Error(error.message),
            title: 'Failed to submit.',
          });
        },
      });
    } else {
      // TODO [bw] this won't do anything since there are no changes, change verbiage?
      router.replace(userTrainingDashboardURL);
    }
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack>
        <Accordion
          variant="separated"
          multiple
          defaultValue={['model-details']}
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
          <Accordion.Item value="model-details">
            <Accordion.Control>
              {/*<Group position="apart">*/}
              Model Details
            </Accordion.Control>
            <Accordion.Panel>
              <DescriptionTable
                // title="Model Info"
                labelWidth="150px"
                items={[
                  { label: 'Name', value: model.name },
                  { label: 'Type', value: thisTrainingDetails?.type },
                  {
                    label: 'Images',
                    value:
                      thisModelVersion.files.find((f) => f.type === 'Training Data')?.metadata[
                        'numImages'
                      ] || 0,
                  },
                  {
                    label: 'Captions',
                    value:
                      thisModelVersion.files.find((f) => f.type === 'Training Data')?.metadata[
                        'numCaptions'
                      ] || 0,
                  },
                ]}
              />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
        {/* TODO [bw] sample images here */}

        <Title mt="md" order={5}>
          Base Model for Training
        </Title>
        <Input.Wrapper
          label="Select a base model to train your model on"
          withAsterisk
          error={errors.baseModel?.message}
        >
          <InputSegmentedControl
            name="baseModel"
            data={Object.entries(baseModelDescriptions).map(([k, v]) => {
              return {
                label: v.label,
                value: k,
              };
            })}
            onChange={(value) => setDisplayBaseModel(value as TrainingDetailsBaseModel)}
            color="blue"
            size="xs"
            styles={(theme) => ({
              root: {
                border: `1px solid ${
                  theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
                }`,
                background: 'none',
                marginTop: theme.spacing.xs * 0.5, // 5px
              },
            })}
            fullWidth
          />
        </Input.Wrapper>
        {formBaseModel && (baseModelDescriptions[formBaseModel]?.description || '')}

        {/*<Title mt="md" order={5}>*/}
        {/*  <Group align="center">*/}
        {/*    <Text inline>Advanced Training Settings</Text>*/}
        {/*    <Badge*/}
        {/*      component="button"*/}
        {/*      // color="gray"*/}
        {/*      size="md"*/}
        {/*      onClick={() => setSettingsCollapsed(!settingsCollapsed)}*/}
        {/*      sx={{ cursor: 'pointer' }}*/}
        {/*    >*/}
        {/*      {settingsCollapsed ? (*/}
        {/*        <IconPlus style={{ verticalAlign: 'sub' }} size={16} />*/}
        {/*      ) : (*/}
        {/*        <IconMinus style={{ verticalAlign: 'sub' }} size={16} />*/}
        {/*      )}*/}
        {/*    </Badge>*/}
        {/*  </Group>*/}
        {/*</Title>*/}
        {/*<Collapse in={!settingsCollapsed}>*/}

        <Accordion
          variant="separated"
          multiple
          defaultValue={['training-settings']}
          mt="md"
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
          <Accordion.Item value="training-settings">
            <Accordion.Control>
              {/*<Group position="apart">*/}
              Advanced Training Settings
            </Accordion.Control>
            <Accordion.Panel>
              <DescriptionTable
                labelWidth="200px"
                items={trainingSettings.map((ts) => {
                  let inp: React.ReactNode;
                  // console.log(ts.name);
                  if (['int', 'number'].includes(ts.type)) {
                    inp = (
                      <InputNumber
                        name={ts.name}
                        // label={ts.label}
                        // placeholder="Training Epochs"
                        // defaultValue={ts.default as number}
                        min={ts.min}
                        max={ts.max}
                        precision={ts.type === 'number' ? 4 : undefined}
                        step={ts.type === 'int' ? 1 : 0.0001}
                        sx={{ flexGrow: 1 }}
                        disabled={ts.disabled === true}
                        format="default"
                      />
                    );
                  } else if (ts.type === 'select') {
                    inp = (
                      <InputSelect
                        name={ts.name}
                        data={ts.options as string[]}
                        disabled={ts.disabled === true}
                      />
                    );
                  } else if (ts.type === 'bool') {
                    inp = <InputCheckbox name={ts.name} disabled={ts.disabled === true} />;
                  } else if (ts.type === 'string') {
                    inp = <InputText name={ts.name} disabled={ts.disabled === true} />;
                  }
                  return {
                    label: ts.label,
                    value: inp,
                  };
                })}
              />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Stack>
      <Group mt="xl" position="right">
        <Button variant="default" onClick={() => goBack(model.id, thisStep)}>
          Back
        </Button>
        <Button type="submit" loading={awaitInvalidate}>
          Submit
        </Button>
      </Group>
    </Form>
  );
};
