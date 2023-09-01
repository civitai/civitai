import { Accordion, Button, Group, Input, Stack, Text, Title } from '@mantine/core';
import { TrainingStatus } from '@prisma/client';
import { useRouter } from 'next/router';
import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { CivitaiTooltip } from '~/components/CivitaiWrapped/CivitaiTooltip';
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
import { BaseModel } from '~/server/common/constants';
import {
  TrainingDetailsBaseModel,
  trainingDetailsBaseModels,
  TrainingDetailsObj,
  TrainingDetailsParams,
  trainingDetailsParams,
} from '~/server/schema/model-version.schema';
import { TrainingModelData } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const baseModelDescriptions: {
  [key in TrainingDetailsBaseModel]: { label: string; description: string };
} = {
  sd_1_5: { label: 'Standard (SD 1.5)', description: 'Useful for all purposes.' },
  anime: { label: 'Anime (SD 1.5)', description: 'Results will have an anime aesthetic.' },
  semi: {
    label: 'Semi-realistic (SD 1.5)',
    description: 'Results will be a blend of anime and realism.',
  },
  realistic: { label: 'Realistic (SD 1.5)', description: 'Results will be extremely realistic.' },
  sdxl: { label: 'Standard (SDXL)', description: 'Useful for all purposes, and uses SDXL.' },
};

type TrainingSettingsType = {
  name: keyof TrainingDetailsParams;
  label: string;
  type: string;
  // TODO [bw] review - this makes this completely unpredictable and kind of hard to work with, perhaps a discrimated type instead?
  default: string | number | boolean | ((...args: never[]) => number);
  hint?: React.ReactNode;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  overrides?: {
    [override in TrainingDetailsBaseModel]?: {
      default?: string | number | boolean | ((...args: never[]) => number);
      min?: number;
      max?: number;
    };
  };
};

const getPrecision = (n: any) => {
  if (!isFinite(n)) return 0;
  const e = 1;
  let p = 0;
  while (Math.round(n * e) / e !== n) {
    n *= 10;
    p++;
  }
  return p;
};

const trainingSettings: TrainingSettingsType[] = [
  {
    name: 'maxTrainEpochs',
    label: 'Epochs',
    hint: 'An epoch is one set of learning. By default, we save every epoch, and they are all available for download.',
    type: 'int',
    default: 10,
    min: 3,
    max: 16,
    overrides: { sdxl: { min: 1, default: 10 } },
  },
  {
    name: 'numRepeats',
    label: 'Num Repeats',
    hint: 'Num Repeats defines how many times each individual image gets put into VRAM. As opposed to batch size, which is how many images you shove into your VRAM at once.',
    type: 'int',
    default: (n: number) => Math.max(1, Math.min(1000, Math.ceil(200 / n))),
    min: 1,
    max: 1000,
  },
  {
    name: 'trainBatchSize',
    label: 'Train Batch Size',
    hint: 'Batch size is the number of images that will be placed into VRAM at once. A batch size of 2 will train two images at a time, simultaneously. To avoid OOM errors, please limit batch counts to the following by resolution: 512 -> 9, 768 -> 6, 1024 -> 4',
    type: 'int',
    // TODO [bw] this should have a default/max driven by the resolution they've selected (e.g. 512 -> 9, 768 -> 6, 1024 -> 4 basically cap lower than 4700)
    default: 6,
    min: 4,
    max: 9,
    overrides: { sdxl: { max: 4, min: 2, default: 4 } },
  },
  {
    name: 'targetSteps',
    label: 'Steps',
    hint: (
      <>
        The total number of steps for training. Computed automatically with (epochs * # of images *
        repeats / batch size).
        <br />
        The maximum allowed is 10,000 steps.
      </>
    ),
    type: 'int',
    default: (n: number, r: number, e: number, b: number) => Math.ceil((n * r * e) / b),
    min: 1,
    // max: 10000,
    disabled: true,
  },
  {
    name: 'resolution',
    label: 'Resolution',
    hint: 'Specify the maximum resolution of training images in the order of "width, height". If the training images exceed the resolution specified here, they will be scaled down to this resolution.',
    type: 'int',
    default: 512,
    min: 512,
    step: 64,
    max: 1024,
    overrides: { sdxl: { min: 1024, default: 1024 } },
  },
  {
    name: 'loraType',
    label: 'LoRA Type',
    hint: 'Specifies the type of LoRA learning. Only standard LoRA is currently supported.',
    type: 'select',
    default: 'lora',
    options: ['lora'],
  }, // LoCon Lycoris", "LoHa Lycoris // TODO enum
  {
    name: 'enableBucket',
    label: 'Enable Bucket',
    hint: 'Sorts images into buckets by size for the purposes of training. If your training images are all the same size, you can turn this option off, but leaving it on has no effect.',
    type: 'bool',
    default: true,
  },
  {
    name: 'shuffleCaption',
    label: 'Shuffle Caption',
    hint: 'Shuffling tags randomly changes the order of your caption tags during training. The intent of shuffling is to improve learning. If you have written captions as sentences, this option has no meaning.',
    type: 'bool',
    default: false,
  },
  {
    name: 'keepTokens',
    label: 'Keep Tokens',
    hint: (
      <>
        If your training images have captions, you can randomly shuffle the comma-separated words in
        the captions (see Shuffle caption option for details). However, if you have words that you
        want to keep at the beginning, you can use this option to specify &quot;Keep the first 0
        words at the beginning&quot;.
        <br />
        This option does nothing if the shuffle caption option is off.
      </>
    ),
    type: 'int',
    default: 0,
    min: 0,
    max: 1,
  },
  {
    name: 'unetLR',
    label: 'Unet LR',
    hint: 'Sets the learning rate for U-Net. This is the learning rate when performing additional learning on each attention block (and other blocks depending on the setting) in U-Net.',
    type: 'number',
    default: 0.0005,
    step: 0.0001,
    min: 0,
    max: 1,
  },
  {
    name: 'textEncoderLR',
    label: 'Text Encoder LR',
    hint: 'Sets the learning rate for the text encoder. The effect of additional training on text encoders affects the entire U-Net.',
    type: 'number',
    default: 0.00005,
    step: 0.00001,
    min: 0,
    max: 1,
  },
  {
    name: 'lrScheduler',
    label: 'LR Scheduler',
    hint: 'You can change the learning rate in the middle of learning. A scheduler is a setting for how to change the learning rate.',
    type: 'select',
    default: 'cosine_with_restarts',
    options: [
      // TODO enum
      'constant',
      'cosine',
      'cosine_with_restarts',
      'constant_with_warmup',
      'linear',
    ],
  },
  // TODO add warmup if constant_with_warmup
  {
    // TODO [bw] actually conditional on lrScheduler, cosine_with_restarts/polynomial
    name: 'lrSchedulerNumCycles',
    label: 'LR Scheduler Cycles',
    hint: 'This option specifies how many cycles the scheduler runs during training. It is only used when "cosine_with_restarts" or "polynomial" is used as the scheduler.',
    type: 'int',
    default: 3,
    min: 1,
    max: 4,
  },
  {
    name: 'minSnrGamma',
    label: 'Min SNR Gamma',
    hint: 'In LoRA learning, learning is performed by putting noise of various strengths on the training image (details about this are omitted), but depending on the difference in strength of the noise on which it is placed, learning will be stable by moving closer to or farther from the learning target. not, and the Min SNR gamma was introduced to compensate for that. Especially when learning images with little noise on them, it may deviate greatly from the target, so try to suppress this jump.',
    type: 'int',
    default: 5, // TODO maybe float
    min: 0,
    max: 20,
  },
  {
    name: 'networkDim',
    label: 'Network Dim',
    hint: 'The larger the Dim setting, the more learning information can be stored, but the possibility of learning unnecessary information other than the learning target increases. A larger Dim also increases LoRA file size.',
    type: 'int',
    default: 32,
    min: 1,
    max: 128,
    overrides: { sdxl: { max: 256 } },
  },
  {
    name: 'networkAlpha',
    label: 'Network Alpha',
    hint: (
      <>
        The smaller the Network alpha value, the larger the stored LoRA neural net weights. For
        example, with an Alpha of 16 and a Dim of 32, the strength of the weight used is 16/32 =
        0.5, meaning that the learning rate is only half as powerful as the Learning Rate setting.
        <br />
        If Alpha and Dim are the same number, the strength used will be 1 and will have no effect on
        the learning rate.
      </>
    ),
    type: 'int',
    default: 16,
    min: 1,
    max: 128,
    overrides: { sdxl: { max: 256 } },
  },
  {
    name: 'optimizerType',
    label: 'Optimizer',
    hint: 'The optimizer is a setting for "how to update the neural net weights during training". Various methods have been proposed for smart learning, but the most commonly used in LoRA learning is "AdamW (32-bit)" or "AdamW8bit".',
    type: 'select',
    default: 'AdamW8Bit',
    options: ['AdamW8Bit'], // TODO enum
  },
  {
    name: 'optimizerArgs',
    label: 'Optimizer Args',
    hint: 'Additional arguments can be passed to control the behavior of the selected optimizer. Place them here as a string, comma separated.',
    type: 'string',
    default: 'weight_decay=0.1',
    disabled: true,
  },
];

export const TrainingFormSubmit = ({ model }: { model: NonNullable<TrainingModelData> }) => {
  const thisModelVersion = model.modelVersions[0];
  const thisTrainingDetails = thisModelVersion.trainingDetails as TrainingDetailsObj | undefined;
  const thisFile = thisModelVersion.files[0];
  const thisMetadata = thisFile?.metadata as FileMetadata | null;

  const [formBaseModel, setDisplayBaseModel] = useState<TrainingDetailsBaseModel | undefined>(
    thisTrainingDetails?.baseModel ?? undefined
  );
  const router = useRouter();
  const [awaitInvalidate, setAwaitInvalidate] = useState<boolean>(false);
  const queryUtils = trpc.useContext();
  const currentUser = useCurrentUser();

  const thisStep = 3;

  const schema = trainingDetailsParams.extend({
    baseModel: z.enum(trainingDetailsBaseModels, {
      errorMap: () => ({ message: 'A base model must be chosen.' }),
    }),
  });

  // @ts-ignore ignoring because the reducer will use default functions in the next step in place of actual values
  const defaultValues: Omit<z.infer<typeof schema>, 'baseModel'> & {
    baseModel: TrainingDetailsBaseModel | undefined;
  } = {
    baseModel: thisTrainingDetails?.baseModel ?? undefined,
    ...(thisTrainingDetails?.params
      ? thisTrainingDetails.params
      : trainingSettings.reduce((a, v) => ({ ...a, [v.name]: v.default }), {})),
  };

  if (!thisTrainingDetails?.params) {
    const numRepeatsFnc = defaultValues.numRepeats as unknown as (n: number) => number;
    const targetStepsFnc = defaultValues.targetSteps as unknown as (
      n: number,
      r: number,
      e: number,
      b: number
    ) => number;

    defaultValues.numRepeats = numRepeatsFnc(thisMetadata?.numImages || 1);
    defaultValues.targetSteps = targetStepsFnc(
      thisMetadata?.numImages || 1,
      defaultValues.numRepeats,
      defaultValues.maxTrainEpochs,
      defaultValues.trainBatchSize
    );
  }

  const form = useForm({
    schema,
    mode: 'onChange',
    defaultValues,
    shouldUnregister: false,
  });

  const watchFields = form.watch(['maxTrainEpochs', 'numRepeats', 'trainBatchSize']);

  // apply default overrides for base model upon selection
  useEffect(() => {
    if (!formBaseModel) return;
    trainingSettings.forEach((s) => {
      let val = s.default;
      const overrideObj = s.overrides?.[formBaseModel];
      if (overrideObj && overrideObj.default !== undefined) {
        // TODO [bw] should check here for function type
        //  could also check if it is in dirty state and leave it alone
        val = overrideObj.default;
      }
      if (typeof val !== 'function') form.setValue(s.name, val);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formBaseModel]);

  // nb: if there are more default calculations, need to put them here
  useEffect(() => {
    const maxTrainEpochs = form.getValues('maxTrainEpochs');
    const numRepeats = form.getValues('numRepeats');
    const trainBatchSize = form.getValues('trainBatchSize');

    const newSteps = Math.ceil(
      ((thisMetadata?.numImages || 1) * numRepeats * maxTrainEpochs) / trainBatchSize
    );

    // if (newSteps > 10000) {
    //   showErrorNotification({
    //     error: new Error(
    //       'Steps are beyond the maximum (10,000). Please lower Epochs or Num Repeats, or increase Train Batch Size.'
    //     ),
    //     title: 'Too many steps',
    //   });
    // }

    form.setValue('targetSteps', newSteps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchFields]);

  const { isDirty, errors } = form.formState;

  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation({
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to saved model version',
      });
    },
  });

  const doTraining = trpc.training.createRequest.useMutation({
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to submit for training',
        error: new Error(error.message),
        reason: error.message ?? 'An unexpected error occurred. Please try again later.',
      });
    },
  });

  const handleSubmit = ({ ...rest }: z.infer<typeof schema>) => {
    const userTrainingDashboardURL = `/user/${currentUser?.username}/models?section=training`;
    if (isDirty) {
      if (!thisFile) {
        showErrorNotification({
          error: new Error('Missing file data, please reupload your images.'),
        });
        return;
      }

      if (form.getValues('targetSteps') > 10000) {
        showErrorNotification({
          error: new Error(
            'Steps are beyond the maximum (10,000). Please lower Epochs or Num Repeats, or increase Train Batch Size.'
          ),
          title: 'Too many steps',
        });
        return;
      }

      setAwaitInvalidate(true);

      const { baseModel, ...paramData } = rest;

      const baseModelConvert: BaseModel =
        baseModel === 'sd_1_5' ? 'SD 1.5' : baseModel === 'sdxl' ? 'SDXL 1.0' : 'Other';

      const versionMutateData = {
        // these 4 appear to be required for upsert, but aren't actually being updated.
        // only ID should technically be necessary
        id: thisModelVersion.id,
        name: thisModelVersion.name,
        modelId: model.id,
        baseModel: baseModelConvert,
        epochs: paramData.maxTrainEpochs,
        steps: paramData.targetSteps,
        trainingStatus: TrainingStatus.Submitted,
        trainingDetails: {
          ...((thisModelVersion.trainingDetails as TrainingDetailsObj) || {}),
          baseModel: baseModel,
          params: paramData,
        },
      };

      upsertVersionMutation.mutate(versionMutateData, {
        async onSuccess(response, request) {
          queryUtils.training.getModelBasic.setData({ id: model.id }, (old) => {
            if (!old) return old;

            const versionToUpdate = old.modelVersions.find((mv) => mv.id === thisModelVersion.id);
            if (!versionToUpdate) return old;

            versionToUpdate.trainingStatus = request.trainingStatus!;
            versionToUpdate.trainingDetails = request.trainingDetails!;

            return {
              ...old,
              modelVersions: [
                versionToUpdate,
                ...old.modelVersions.filter((mv) => mv.id !== thisModelVersion.id),
              ],
            };
          });
          // TODO [bw] don't invalidate, just update
          await queryUtils.model.getMyTrainingModels.invalidate();

          doTraining.mutate(
            {
              model: baseModel,
              trainingData: thisFile.url,
              params: {
                ...paramData,
                modelFileId: thisFile.id,
                loraName: model.name,
              },
            },
            {
              onSuccess: async () => {
                setAwaitInvalidate(false);
                showSuccessNotification({
                  title: 'Successfully submitted for training!',
                  message: 'You will be notified when training is complete.',
                });
                await router.replace(userTrainingDashboardURL);
              },
              onError: () => {
                // TODO [bw] set status back to pending
                setAwaitInvalidate(false);
              },
            }
          );
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
                    value: thisMetadata?.numImages || 0,
                  },
                  {
                    label: 'Captions',
                    value: thisMetadata?.numCaptions || 0,
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
                flexWrap: 'wrap',
              },
            })}
            fullWidth
          />
        </Input.Wrapper>
        {formBaseModel && (baseModelDescriptions[formBaseModel]?.description || '')}

        {formBaseModel && (
          <Accordion
            variant="separated"
            // multiple
            // defaultValue={['training-settings']}
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
              <Accordion.Control>Advanced Training Settings</Accordion.Control>
              <Accordion.Panel>
                <DescriptionTable
                  labelWidth="200px"
                  items={trainingSettings.map((ts) => {
                    let inp: React.ReactNode;
                    const override = ts.overrides?.[formBaseModel];

                    if (['int', 'number'].includes(ts.type)) {
                      inp = (
                        <InputNumber
                          name={ts.name}
                          min={override?.min ?? ts.min}
                          max={override?.max ?? ts.max}
                          precision={
                            ts.type === 'number' ? getPrecision(ts.default) || 4 : undefined
                          }
                          step={ts.step}
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
                      inp = <InputCheckbox py={8} name={ts.name} disabled={ts.disabled === true} />;
                    } else if (ts.type === 'string') {
                      inp = <InputText name={ts.name} disabled={ts.disabled === true} />;
                    }

                    return {
                      label: ts.hint ? (
                        <CivitaiTooltip
                          position="top"
                          // transition="slide-up"
                          variant="roundedOpaque"
                          withArrow
                          multiline
                          label={ts.hint}
                        >
                          <Text inline style={{ cursor: 'help' }}>
                            {ts.label}
                          </Text>
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
        )}
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
