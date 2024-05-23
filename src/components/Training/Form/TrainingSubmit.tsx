import {
  Accordion,
  Anchor,
  Badge,
  Button,
  Card,
  createStyles,
  Divider,
  Group,
  Input,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { showNotification } from '@mantine/notifications';
import { Currency, ModelType, TrainingStatus } from '@prisma/client';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconExclamationCircle,
  IconExclamationMark,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useRouter } from 'next/router';
import React, { useEffect, useState } from 'react';
import { z } from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { CivitaiTooltip } from '~/components/CivitaiWrapped/CivitaiTooltip';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import InputResourceSelect from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import {
  blockedCustomModels,
  goBack,
  isTrainingCustomModel,
} from '~/components/Training/Form/TrainingCommon';
import { useTrainingServiceStatus } from '~/components/Training/training.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  Form,
  InputCheckbox,
  InputNumber,
  InputSelect,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import { BaseModel, baseModelSets } from '~/server/common/constants';
import { generationResourceSchema } from '~/server/schema/generation.schema';
import {
  ModelVersionUpsertInput,
  TrainingDetailsBaseModel,
  TrainingDetailsBaseModel15,
  TrainingDetailsBaseModelXL,
  TrainingDetailsObj,
  TrainingDetailsParams,
  trainingDetailsParams,
} from '~/server/schema/model-version.schema';
import { Generation } from '~/server/services/generation/generation.types';
import { TrainingModelData } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { calcBuzzFromEta, calcEta } from '~/utils/training';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const baseModelDescriptions: {
  [key in TrainingDetailsBaseModel]: { label: string; type: string; description: string };
} = {
  sd_1_5: { label: 'Standard', type: '15', description: 'Useful for all purposes.' },
  anime: { label: 'Anime', type: '15', description: 'Results will have an anime aesthetic.' },
  semi: {
    label: 'Semi-realistic',
    type: '15',
    description: 'Results will be a blend of anime and realism.',
  },
  realistic: {
    label: 'Realistic',
    type: '15',
    description: 'Results will be extremely realistic.',
  },
  sdxl: { label: 'Standard', type: 'XL', description: 'Useful for all purposes, and uses SDXL.' },
  pony: {
    label: 'Pony',
    type: 'XL',
    description: 'Results tailored to visuals of various anthro, feral, or humanoid species.',
  },
};

// nb: keep this in line with what is set by the worker
const optimizerArgMap: { [key: string]: string } = {
  Adafactor: 'scale_parameter=False, relative_step=False, warmup_init=False',
  AdamW8Bit: 'weight_decay=0.1',
  Prodigy: 'weight_decay=0.5, decouple=True, betas=0.9,0.99, use_bias_correction=False',
};

type BaseTrainingSettingsType = {
  name: keyof TrainingDetailsParams;
  label: string;
  hint: React.ReactNode;
  disabled?: boolean;
};
type SelectTrainingSettingsType = {
  type: 'select';
  options: string[];
  default: string | ((...args: never[]) => string);
  overrides?: {
    [key in TrainingDetailsBaseModel]?: Partial<
      Omit<SelectTrainingSettingsType, 'type' | 'overrides'>
    >;
  };
};
type BoolTrainingSettingsType = {
  type: 'bool';
  default: boolean | ((...args: never[]) => boolean);
  overrides?: {
    [key in TrainingDetailsBaseModel]?: Partial<
      Omit<BoolTrainingSettingsType, 'type' | 'overrides'>
    >;
  };
};
type NumberTrainingSettingsType = {
  type: 'int' | 'number';
  min: number;
  max: number;
  step: number;
  default: number | ((...args: never[]) => number);
  overrides?: {
    [key in TrainingDetailsBaseModel]?: Partial<
      Omit<NumberTrainingSettingsType, 'type' | 'overrides'>
    >;
  };
};
type StringTrainingSettingsType = {
  type: 'string';
  default: string | ((...args: never[]) => string);
  overrides?: {
    [key in TrainingDetailsBaseModel]?: Partial<
      Omit<StringTrainingSettingsType, 'type' | 'overrides'>
    >;
  };
};

type TrainingSettingsType = BaseTrainingSettingsType &
  (
    | SelectTrainingSettingsType
    | BoolTrainingSettingsType
    | NumberTrainingSettingsType
    | StringTrainingSettingsType
  );

/**
 * Computes the number of decimal points in a given input using magic math
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

const minsToHours = (n: number) => {
  if (!n) return 'Unknown';

  const hours = Math.floor(n / 60);
  const minutes = Math.floor(n % 60);

  const h = hours > 0 ? `${hours} hour${hours === 1 ? '' : 's'}, ` : '';
  const m = `${minutes} min${minutes === 1 ? '' : 's'}`;

  return `${h}${m}`;
};

export const trainingSettings: TrainingSettingsType[] = [
  {
    name: 'maxTrainEpochs',
    label: 'Epochs',
    hint: 'An epoch is one set of learning. By default, we will save a maximum of 20 epochs (evenly distributed), and they are all available for download.',
    type: 'int',
    default: 10,
    min: 3,
    max: 500,
    step: 1,
    overrides: { sdxl: { min: 1 }, pony: { min: 1 } },
  },
  {
    name: 'numRepeats',
    label: 'Num Repeats',
    hint: 'Num Repeats defines how many times each individual image gets put into VRAM. As opposed to batch size, which is how many images are placed into VRAM at once.',
    type: 'int',
    default: (n: number) => Math.max(1, Math.min(5000, Math.ceil(200 / n))),
    min: 1,
    max: 5000,
    step: 1,
  },
  {
    name: 'trainBatchSize',
    label: 'Train Batch Size',
    hint: 'Batch size is the number of images that will be placed into VRAM at once. A batch size of 2 will train two images at a time, simultaneously.',
    type: 'int',
    // TODO [bw] this should have a default/max driven by the resolution they've selected (e.g. 512 -> 9, 768 -> 6, 1024 -> 4 basically cap lower than 4700)
    default: 6,
    min: 1,
    max: 9,
    step: 1,
    overrides: {
      realistic: { default: 2, min: 1, max: 2 },
      sdxl: { max: 4, min: 1, default: 4 },
      pony: { max: 5, min: 1, default: 5 },
    },
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
    max: 10000,
    step: 1,
    disabled: true,
  },
  {
    name: 'resolution',
    label: 'Resolution',
    hint: 'Specify the maximum resolution of training images. If the training images exceed the resolution specified here, they will be scaled down to this resolution.',
    type: 'int',
    default: 512,
    min: 512,
    max: 1024,
    step: 64,
    overrides: {
      sdxl: { min: 1024, max: 2048, default: 1024 },
      pony: { min: 1024, max: 2048, default: 1024 },
    },
  },
  {
    name: 'loraType',
    label: 'LoRA Type',
    hint: 'Specifies the type of LoRA learning. Only standard LoRA is currently supported.',
    type: 'select',
    default: 'lora',
    options: ['lora'],
    disabled: true,
  }, // LoCon Lycoris", "LoHa Lycoris // TODO enum
  // TODO are we using buckets?
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
    max: 3,
    step: 1,
  },
  {
    name: 'clipSkip',
    label: 'Clip Skip',
    hint: 'Determines which layer\'s vector output will be used. There are 12 layers, and setting the skip will select "xth from the end" of the total layers. For anime, we use 2. For everything else, 1.',
    type: 'int',
    default: 1,
    min: 1,
    max: 4,
    step: 1,
    overrides: { anime: { default: 2 } },
  },
  {
    name: 'flipAugmentation',
    label: 'Flip Augmentation',
    hint: 'If this option is turned on, the image will be horizontally flipped randomly. It can learn left and right angles, which is useful when you want to learn symmetrical people and objects.',
    type: 'bool',
    default: false,
  },
  {
    name: 'unetLR',
    label: 'Unet LR',
    hint: 'Sets the learning rate for U-Net. This is the learning rate when performing additional learning on each attention block (and other blocks depending on the setting) in U-Net.',
    type: 'number',
    default: 0.0005,
    min: 0,
    max: 1,
    step: 0.00001,
  },
  {
    name: 'textEncoderLR',
    label: 'Text Encoder LR',
    hint: 'Sets the learning rate for the text encoder. The effect of additional training on text encoders affects the entire U-Net.',
    type: 'number',
    default: 0.00005,
    min: 0,
    max: 1,
    step: 0.00001,
    overrides: { anime: { default: 0.0001 } },
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
    overrides: { pony: { default: 'cosine' } },
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
    step: 1,
  },
  {
    name: 'minSnrGamma',
    label: 'Min SNR Gamma',
    hint: (
      <>
        Learning is performed by putting noise of various strengths on the training image, but
        depending on the difference in strength of the noise on which it is placed, learning will be
        stable by moving closer to or farther from the learning target.
        <br />
        Min SNR gamma was introduced to compensate for that. When learning images have little noise,
        it may deviate greatly from the target, so try to suppress this jump.
      </>
    ),
    type: 'int',
    default: 5, // TODO maybe float
    min: 0,
    max: 20,
    step: 1,
    overrides: { pony: { default: 0 } },
  },
  {
    name: 'networkDim',
    label: 'Network Dim',
    hint: 'The larger the Dim setting, the more learning information can be stored, but the possibility of learning unnecessary information other than the learning target increases. A larger Dim also increases LoRA file size.',
    type: 'int',
    default: 32,
    min: 1,
    max: 128,
    step: 1,
    overrides: { sdxl: { max: 256 }, pony: { max: 256 }, anime: { default: 16 } },
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
    step: 1,
    overrides: { sdxl: { max: 256 }, pony: { max: 256, default: 32 }, anime: { default: 8 } },
  },
  {
    name: 'noiseOffset',
    label: 'Noise Offset',
    hint: 'Adds noise to training images. 0 adds no noise at all. A value of 1 adds strong noise.',
    type: 'number',
    default: 0.1,
    min: 0,
    max: 1,
    step: 0.01,
    overrides: { pony: { default: 0.03 } },
  },
  {
    name: 'optimizerType',
    label: 'Optimizer',
    hint: (
      <>
        The optimizer determines how to update the neural net weights during training. Various
        methods have been proposed for smart learning, but the most commonly used in LoRA learning
        is &quot;AdamW8bit&quot;, or &quot;Adafactor&quot; for SDXL.
        <br />
        We will automatically generate the proper optimizer args depending on your choice.
      </>
    ),
    type: 'select',
    default: 'AdamW8Bit',
    options: ['AdamW8Bit', 'Adafactor', 'Prodigy'], // TODO enum
    overrides: { sdxl: { default: 'Adafactor' }, pony: { default: 'Prodigy' } },
  },
  {
    // this is only used for display
    name: 'optimizerArgs',
    label: 'Optimizer Args',
    hint: 'Additional arguments can be passed to control the behavior of the selected optimizer. This is set automatically.',
    type: 'string',
    default: optimizerArgMap.AdamW8Bit,
    disabled: true,
  },
];

const useStyles = createStyles((theme) => ({
  segControl: {
    root: {
      border: `1px solid ${
        theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
      }`,
      background: 'none',
      flexWrap: 'wrap',
    },
    label: {
      paddingLeft: theme.spacing.sm,
      paddingRight: theme.spacing.sm,
    },
  },
}));

export const TrainingFormSubmit = ({ model }: { model: NonNullable<TrainingModelData> }) => {
  const thisModelVersion = model.modelVersions[0];
  const thisTrainingDetails = thisModelVersion.trainingDetails as TrainingDetailsObj | undefined;
  const thisFile = thisModelVersion.files[0];
  const thisMetadata = thisFile?.metadata as FileMetadata | null;

  const [openedSections, setOpenedSections] = useState<string[]>([]);
  const [formBaseModel, setFormBaseModel] = useState<TrainingDetailsBaseModel | null>('sdxl');
  const [formBaseModelType, setFormBaseModelType] = useState<'sd15' | 'sdxl'>('sdxl');
  const [baseModel15, setBaseModel15] = useState<TrainingDetailsBaseModel15 | null>(null);
  const [baseModelXL, setBaseModelXL] = useState<TrainingDetailsBaseModelXL | null>('sdxl');
  const [etaMins, setEtaMins] = useState<number | undefined>(undefined);
  // const [debouncedEtaMins] = useDebouncedValue(etaMins, 2000);
  const [buzzCost, setBuzzCost] = useState<number | undefined>(undefined);
  const [awaitInvalidate, setAwaitInvalidate] = useState<boolean>(false);
  const status = useTrainingServiceStatus();
  const blockedModels = status.blockedModels ?? [blockedCustomModels];

  const { classes } = useStyles();
  const theme = useMantineTheme();
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const { balance } = useBuzz();
  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to train this model. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to complete the training process.`,
    performTransactionOnPurchase: false,
    purchaseSuccessMessage: (purchasedBalance) => (
      <Stack>
        <Text>Thank you for your purchase!</Text>
        <Text>
          We have added <CurrencyBadge currency={Currency.BUZZ} unitAmount={purchasedBalance} /> to
          your account. You can now continue the training process.
        </Text>
      </Stack>
    ),
  });

  const thisStep = 3;

  const schema = trainingDetailsParams.extend({
    customModelSelect: generationResourceSchema.optional(),
    samplePrompt1: z.string(),
    samplePrompt2: z.string(),
    samplePrompt3: z.string(),
    staging: z.boolean().optional(),
    highPriority: z.boolean().optional(),
  });

  // @ts-ignore ignoring because the reducer will use default functions in the next step in place of actual values
  const defaultValues: z.infer<typeof schema> = {
    samplePrompt1: thisTrainingDetails?.samplePrompts?.[0] ?? '',
    samplePrompt2: thisTrainingDetails?.samplePrompts?.[1] ?? '',
    samplePrompt3: thisTrainingDetails?.samplePrompts?.[2] ?? '',
    staging: false,
    highPriority: false,
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
  const watchFieldsBuzz = form.watch(['targetSteps', 'highPriority']);
  const watchFieldOptimizer = form.watch('optimizerType');

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
    const [maxTrainEpochs, numRepeats, trainBatchSize] = watchFields;

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

    if (form.getValues('targetSteps') !== newSteps) {
      form.setValue('targetSteps', newSteps);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchFields]);

  useEffect(() => {
    const [targetSteps, highPriority] = watchFieldsBuzz;
    const eta = calcEta({
      cost: status.cost,
      baseModel: formBaseModelType,
      targetSteps,
    });
    const isCustom = isTrainingCustomModel(formBaseModel);
    const price = calcBuzzFromEta({
      cost: status.cost,
      eta,
      isCustom,
      isPriority: highPriority ?? false,
    });
    setEtaMins(eta);
    setBuzzCost(price);
  }, [watchFieldsBuzz, formBaseModel, formBaseModelType, status.cost]);

  useEffect(() => {
    const newArgs = optimizerArgMap[watchFieldOptimizer] ?? '';
    form.setValue('optimizerArgs', newArgs);

    if (
      watchFieldOptimizer === 'Prodigy' &&
      form.getValues('lrScheduler') === 'cosine_with_restarts'
    ) {
      form.setValue('lrScheduler', 'cosine');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchFieldOptimizer]);

  const { data: dryRunData, isFetching: dryRunLoading } =
    trpc.training.createRequestDryRun.useQuery(
      {
        baseModel: formBaseModel,
        isPriority: watchFieldsBuzz[1],
        // cost: debouncedEtaMins,
      },
      {
        refetchInterval: 1000 * 60,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        staleTime: 1000 * 60,
        enabled: !!formBaseModel,
      }
    );

  // TODO [bw] this should be a new route for modelVersion.update instead
  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation({
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to save model version',
        autoClose: false,
      });
    },
  });

  const doTraining = trpc.training.createRequest.useMutation({
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to submit for training',
        error: new Error(error.message),
        reason: error.message ?? 'An unexpected error occurred. Please try again later.',
        autoClose: false,
      });
    },
  });

  const userTrainingDashboardURL = `/user/${currentUser?.username}/models?section=training`;

  const handleSubmit = ({ ...rest }: z.infer<typeof schema>) => {
    if (!formBaseModel) {
      showErrorNotification({
        error: new Error('A base model must be chosen.'),
        autoClose: false,
      });
      return;
    }

    if (blockedModels.includes(formBaseModel)) {
      showErrorNotification({
        error: new Error('This model has been blocked from training - please try another one.'),
        autoClose: false,
      });
      return;
    }

    // TODO [bw] we should probably disallow people to get to the training wizard at all when it's not pending
    if (thisModelVersion.trainingStatus !== TrainingStatus.Pending) {
      showNotification({
        message: 'Model was already submitted for training.',
      });
      router.replace(userTrainingDashboardURL).then();
      return;
    }

    if (!thisFile) {
      showErrorNotification({
        error: new Error('Missing file data, please reupload your images.'),
        autoClose: false,
      });
      return;
    }

    if (form.getValues('targetSteps') > 10000) {
      showErrorNotification({
        error: new Error(
          'Steps are beyond the maximum (10,000). Please lower Epochs or Num Repeats, or increase Train Batch Size.'
        ),
        title: 'Too many steps',
        autoClose: false,
      });
      return;
    }

    const performTransaction = () => {
      return openConfirmModal({
        title: 'Confirm Buzz Transaction',
        children: (
          <Stack pt="md">
            <Group>
              <Text span inline>
                The cost for this training run is:{' '}
              </Text>
              <Group spacing={2}>
                <CurrencyIcon currency={Currency.BUZZ} size={12} />
                <Text span inline>
                  {(buzzCost ?? 0).toLocaleString()}
                </Text>
              </Group>
            </Group>
            <Group>
              <Text span inline>
                Your remaining balance will be:{' '}
              </Text>
              <Group spacing={2}>
                <CurrencyIcon currency={Currency.BUZZ} size={12} />
                <Text span inline>
                  {(balance - (buzzCost ?? 0)).toLocaleString()}
                </Text>
              </Group>
            </Group>
            <Text mt="md">Proceed?</Text>
          </Stack>
        ),
        labels: { cancel: 'Cancel', confirm: 'Confirm' },
        centered: true,
        onConfirm: () => {
          handleConfirm(rest);
        },
      });
    };

    conditionalPerformTransaction(buzzCost ?? 0, performTransaction);
  };

  const handleConfirm = (data: z.infer<typeof schema>) => {
    if (!formBaseModel) {
      showErrorNotification({
        error: new Error('A base model must be chosen.'),
        autoClose: false,
      });
      return;
    }

    setAwaitInvalidate(true);

    const {
      samplePrompt1,
      samplePrompt2,
      samplePrompt3,
      staging,
      highPriority,
      customModelSelect, //unsent
      optimizerArgs, //unsent
      ...paramData
    } = data;

    const baseModelConvert: BaseModel =
      formBaseModel === 'sd_1_5'
        ? 'SD 1.5'
        : formBaseModel === 'sdxl'
        ? 'SDXL 1.0'
        : formBaseModel === 'pony'
        ? 'Pony'
        : 'Other';

    // these top vars appear to be required for upsert, but aren't actually being updated.
    // only ID should technically be necessary
    const basicVersionData = {
      id: thisModelVersion.id,
      name: thisModelVersion.name,
      modelId: model.id,
      trainedWords: [],
    };

    const versionMutateData: ModelVersionUpsertInput = {
      ...basicVersionData,
      baseModel: baseModelConvert,
      epochs: paramData.maxTrainEpochs,
      steps: paramData.targetSteps,
      clipSkip: paramData.clipSkip,
      trainingStatus: TrainingStatus.Submitted,
      trainingDetails: {
        ...((thisModelVersion.trainingDetails as TrainingDetailsObj) || {}),
        baseModel: formBaseModel,
        baseModelType: formBaseModelType,
        samplePrompts: [samplePrompt1, samplePrompt2, samplePrompt3],
        params: paramData,
        staging,
        highPriority,
      },
    };

    upsertVersionMutation.mutate(versionMutateData, {
      async onSuccess(_, request) {
        queryUtils.training.getModelBasic.setData({ id: model.id }, (old) => {
          if (!old) return old;

          const versionToUpdate = old.modelVersions.find((mv) => mv.id === thisModelVersion.id);
          if (!versionToUpdate) return old;

          versionToUpdate.baseModel = request.baseModel!;
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
          { modelVersionId: thisModelVersion.id },
          {
            onSuccess: async () => {
              showSuccessNotification({
                title: 'Successfully submitted for training!',
                message: 'You will be emailed when training is complete.',
              });
              router.replace(userTrainingDashboardURL).then(() => setAwaitInvalidate(false));
            },
            onError: () => {
              // set the status back to pending
              upsertVersionMutation.mutate(
                {
                  ...basicVersionData,
                  baseModel: baseModelConvert,
                  trainingStatus: TrainingStatus.Pending,
                },
                {
                  async onSuccess(_, request) {
                    queryUtils.training.getModelBasic.setData({ id: model.id }, (old) => {
                      if (!old) return old;

                      const versionToUpdate = old.modelVersions.find(
                        (mv) => mv.id === thisModelVersion.id
                      );
                      if (!versionToUpdate) return old;

                      versionToUpdate.trainingStatus = request.trainingStatus!;

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
                  },
                  onSettled() {
                    setAwaitInvalidate(false);
                  },
                }
              );
            },
          }
        );
      },
      onError: () => {
        setAwaitInvalidate(false);
      },
    });
  };

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack>
        {!status.available && (
          <AlertWithIcon
            icon={<IconExclamationMark size={18} />}
            iconColor="red"
            color="red"
            size="sm"
          >
            {status.message ?? 'Training is currently disabled.'}
          </AlertWithIcon>
        )}
        <Accordion
          variant="separated"
          defaultValue={'model-details'}
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

        <Stack spacing={0}>
          <Title mt="md" order={5}>
            Base Model for Training
          </Title>
          <Text color="dimmed" size="sm">
            Not sure which one to choose? Read our{' '}
            <Anchor
              href="https://education.civitai.com/using-civitai-the-on-site-lora-trainer"
              target="_blank"
              rel="nofollow noreferrer"
            >
              On-Site LoRA Trainer Guide
            </Anchor>{' '}
            for more info.
          </Text>
        </Stack>
        <Input.Wrapper label="Select a base model to train your model on" withAsterisk>
          <Card withBorder mt={8} p="sm">
            <Card.Section inheritPadding withBorder py="sm">
              <Stack spacing="xs">
                <Group>
                  <Badge color="violet" size="lg" radius="xs" w={85}>
                    SD 1.5
                  </Badge>
                  <SegmentedControl
                    data={Object.entries(baseModelDescriptions)
                      // eslint-disable-next-line @typescript-eslint/no-unused-vars
                      .filter(([_k, v]) => v.type === '15')
                      .map(([k, v]) => {
                        return {
                          label: v.label,
                          value: k,
                        };
                      })}
                    // nb: this type is not accurate, but null is the only way to clear out SegmentedControl
                    value={baseModel15 as TrainingDetailsBaseModel15}
                    onChange={(value) => {
                      setBaseModel15(value as TrainingDetailsBaseModel15);
                      setBaseModelXL(null);
                      form.setValue('customModelSelect', undefined);
                      setFormBaseModelType('sd15');
                      setFormBaseModel(value as TrainingDetailsBaseModel);
                    }}
                    color="blue"
                    size="xs"
                    className={classes.segControl}
                    transitionDuration={0}
                  />
                </Group>

                <Group>
                  <Badge color="grape" size="lg" radius="xs" w={85}>
                    SDXL
                  </Badge>
                  <SegmentedControl
                    data={Object.entries(baseModelDescriptions)
                      // eslint-disable-next-line @typescript-eslint/no-unused-vars
                      .filter(([_k, v]) => v.type === 'XL')
                      .map(([k, v]) => {
                        return {
                          label: v.label,
                          value: k,
                        };
                      })}
                    value={baseModelXL as TrainingDetailsBaseModelXL}
                    onChange={(value) => {
                      setBaseModel15(null);
                      setBaseModelXL(value as TrainingDetailsBaseModelXL);
                      form.setValue('customModelSelect', undefined);
                      setFormBaseModelType('sdxl');
                      setFormBaseModel(value as TrainingDetailsBaseModel);
                    }}
                    color="blue"
                    size="xs"
                    className={classes.segControl}
                    transitionDuration={0}
                  />
                </Group>

                <Group>
                  <Badge color="cyan" size="lg" radius="xs" w={85}>
                    Custom
                  </Badge>
                  <Card px="sm" py={8} radius="md" withBorder>
                    <InputResourceSelect
                      name="customModelSelect"
                      buttonLabel="Select custom model"
                      buttonProps={{
                        size: 'md',
                        compact: true,
                        styles: { label: { fontSize: 12 } },
                      }}
                      options={{
                        resources: [
                          {
                            type: ModelType.Checkpoint,
                          },
                        ],
                      }}
                      allowRemove={true}
                      isTraining={true}
                      onChange={(val) => {
                        const gVal = val as Generation.Resource;
                        const mId = gVal?.modelId;
                        const mvId = gVal?.id;
                        const mBase = gVal?.baseModel as BaseModel | undefined;
                        const castBase =
                          !!mBase &&
                          [
                            ...baseModelSets.SDXL,
                            ...baseModelSets.SDXLDistilled,
                            ...baseModelSets.Pony,
                          ].includes(mBase)
                            ? 'sdxl'
                            : 'sd15';
                        const cLink =
                          isDefined(mId) && isDefined(mvId) ? `civitai:${mId}@${mvId}` : null;
                        setBaseModel15(null);
                        setBaseModelXL(null);
                        setFormBaseModelType(castBase);
                        setFormBaseModel(cLink);
                      }}
                    />
                  </Card>
                </Group>
              </Stack>
            </Card.Section>
            {formBaseModel && (
              <Card.Section inheritPadding py="sm">
                <Stack>
                  <Text size="sm">
                    {isTrainingCustomModel(formBaseModel)
                      ? 'Custom model selected.'
                      : baseModelDescriptions[formBaseModel]?.description ?? 'No description.'}
                  </Text>
                  {blockedModels.includes(formBaseModel) ? (
                    <AlertWithIcon
                      icon={<IconExclamationCircle />}
                      iconColor="default"
                      p="sm"
                      color="red"
                    >
                      <Text>
                        This model currently does not work properly with kohya.
                        <br />
                        We are working on a fix for this - in the meantime, please try a different
                        model.
                      </Text>
                    </AlertWithIcon>
                  ) : isTrainingCustomModel(formBaseModel) ? (
                    <AlertWithIcon icon={<IconAlertCircle />} iconColor="default" p="xs">
                      Note: custom models may see a higher failure rate than normal, and cost more
                      Buzz.
                    </AlertWithIcon>
                  ) : undefined}
                </Stack>
              </Card.Section>
            )}
          </Card>
        </Input.Wrapper>

        {formBaseModel && (
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
                  borderColor:
                    theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
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
                        Set your own prompts for any of the 3 sample images we generate for each
                        epoch.
                      </Text>
                    )}
                  </Stack>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack p="sm">
                    <InputText
                      name="samplePrompt1"
                      label="Image #1"
                      placeholder="Automatically set"
                    />
                    <InputText
                      name="samplePrompt2"
                      label="Image #2"
                      placeholder="Automatically set"
                    />
                    <InputText
                      name="samplePrompt3"
                      label="Image #3"
                      placeholder="Automatically set"
                    />
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
              <Accordion.Item value="training-settings">
                <Accordion.Control>
                  <Stack spacing={4}>
                    <Group spacing="sm">
                      <Text>Training Parameters</Text>
                      {isTrainingCustomModel(formBaseModel) && (
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

                      if (ts.type === 'int' || ts.type === 'number') {
                        const override = ts.overrides?.[formBaseModel];

                        inp = (
                          <InputNumber
                            name={ts.name}
                            min={override?.min ?? ts.min}
                            max={override?.max ?? ts.max}
                            precision={
                              ts.type === 'number'
                                ? getPrecision(ts.step ?? ts.default) || 4
                                : undefined
                            }
                            step={ts.step}
                            sx={{ flexGrow: 1 }}
                            disabled={ts.disabled === true}
                            format="default"
                          />
                        );
                      } else if (ts.type === 'select') {
                        let options = ts.options;
                        // TODO if we fix the bitsandbytes issue, we can disable this
                        if (
                          ts.name === 'optimizerType' &&
                          (formBaseModel === 'sdxl' || formBaseModel === 'pony')
                        ) {
                          options = options.filter((o) => o !== 'AdamW8Bit');
                        }
                        if (ts.name === 'lrScheduler' && watchFieldOptimizer === 'Prodigy') {
                          options = options.filter((o) => o !== 'cosine_with_restarts');
                        }

                        inp = (
                          <InputSelect
                            name={ts.name}
                            data={options}
                            disabled={ts.disabled === true}
                          />
                        );
                      } else if (ts.type === 'bool') {
                        inp = (
                          <InputCheckbox py={8} name={ts.name} disabled={ts.disabled === true} />
                        );
                      } else if (ts.type === 'string') {
                        inp = (
                          <InputText
                            name={ts.name}
                            disabled={ts.disabled === true}
                            clearable={ts.disabled !== true}
                          />
                        );
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
            <Group mt="lg">
              <InputSwitch
                name="highPriority"
                label={
                  <Group spacing={4} noWrap>
                    <InfoPopover size="xs" iconProps={{ size: 16 }}>
                      Jump to the front of the training queue and ensure that your training run is
                      uninterrupted.
                    </InfoPopover>
                    <Text>High Priority</Text>
                  </Group>
                }
                labelPosition="left"
              />
              {currentUser?.isModerator && (
                <InputSwitch name="staging" label="Test Mode" labelPosition="left" />
              )}
            </Group>
            <Paper
              shadow="xs"
              radius="sm"
              mt="md"
              w="fit-content"
              px="md"
              py="xs"
              style={{
                backgroundColor:
                  theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
                alignSelf: 'flex-end',
              }}
            >
              {/* TODO: some tooltip -> link explaining */}
              <Group spacing="sm">
                <Badge>Est. Wait Time</Badge>
                {dryRunLoading ? (
                  <Loader size="sm" />
                ) : (
                  <Text>
                    {/*{!!dryRunData ? formatDate(dryRunData, 'MMM D, YYYY hh:mm:ss A') : 'Unknown'}*/}
                    {!!dryRunData ? dayjs(dryRunData).add(10, 's').fromNow(true) : 'Unknown'}
                  </Text>
                )}
                <Divider orientation="vertical" />
                <Badge>ETA</Badge>
                {dryRunLoading ? (
                  <Loader size="sm" />
                ) : (
                  <Text>
                    {!isDefined(etaMins)
                      ? 'Unknown'
                      : minsToHours(
                          (!!dryRunData
                            ? (new Date().getTime() - new Date(dryRunData).getTime()) / 60000
                            : 10) + etaMins
                        )}
                  </Text>
                )}
              </Group>
            </Paper>
          </>
        )}
      </Stack>
      <Group mt="xl" position="right">
        <Button variant="default" onClick={() => goBack(model.id, thisStep)}>
          Back
        </Button>
        <BuzzTransactionButton
          type="submit"
          loading={awaitInvalidate}
          disabled={blockedModels.includes(formBaseModel ?? '') || !status.available}
          label="Submit"
          buzzAmount={buzzCost ?? 0}
        />
      </Group>
    </Form>
  );
};
