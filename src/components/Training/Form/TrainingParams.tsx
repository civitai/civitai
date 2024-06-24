import React from 'react';
import {
  loraTypes,
  lrSchedulerTypes,
  optimizerTypes,
  TrainingDetailsBaseModel,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';

// nb: keep this in line with what is set by the worker
export const optimizerArgMap: { [key: string]: string } = {
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
  options: readonly string[];
  default: string;
  overrides?: {
    [key in TrainingDetailsBaseModel]?: Partial<
      Omit<SelectTrainingSettingsType, 'type' | 'overrides'>
    >;
  };
};
type BoolTrainingSettingsType = {
  type: 'bool';
  default: boolean;
  overrides?: {
    [key in TrainingDetailsBaseModel]?: Partial<
      Omit<BoolTrainingSettingsType, 'type' | 'overrides'>
    >;
  };
};
export type NumberTrainingSettingsType = {
  type: 'int' | 'number';
  min: number;
  max: number;
  step: number;
  default: number | undefined;
  overrides?: {
    [key in TrainingDetailsBaseModel]?: Partial<
      Omit<NumberTrainingSettingsType, 'type' | 'overrides'>
    >;
  };
};
type StringTrainingSettingsType = {
  type: 'string';
  default: string;
  overrides?: {
    [key in TrainingDetailsBaseModel]?: Partial<
      Omit<StringTrainingSettingsType, 'type' | 'overrides'>
    >;
  };
};

export type TrainingSettingsType = BaseTrainingSettingsType &
  (
    | SelectTrainingSettingsType
    | BoolTrainingSettingsType
    | NumberTrainingSettingsType
    | StringTrainingSettingsType
  );

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
    default: undefined,
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
    default: undefined,
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
    options: loraTypes,
    disabled: true,
  },
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
    options: lrSchedulerTypes,
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
    options: optimizerTypes,
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
