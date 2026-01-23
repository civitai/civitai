import React from 'react';
import type {
  TrainingDetailsBaseModel,
  TrainingDetailsParams,
} from '~/server/schema/model-version.schema';
import {
  engineTypes,
  type EngineTypes,
  loraTypes,
  lrSchedulerTypes,
  optimizerTypes,
  type OptimizerTypes,
} from '~/utils/training';

// nb: keep these in line with what is set by the worker
export const optimizerArgMap: { [key in OptimizerTypes]: string } = {
  Adafactor: 'scale_parameter=False, relative_step=False, warmup_init=False',
  AdamW8Bit: 'weight_decay=0.1',
  Prodigy: 'weight_decay=0.5, decouple=True, betas=0.9,0.99, use_bias_correction=False',
};
export const optimizerArgMapFlux: { [key in OptimizerTypes]: { [key in EngineTypes]: string } } = {
  Adafactor: {
    kohya: optimizerArgMap.Adafactor,
    musubi: '(empty)',
    rapid: '(empty)',
    'flux2-dev': '(empty)',
    'flux2-dev-edit': '(empty)',
    'ai-toolkit': '(empty)',
  },
  AdamW8Bit: {
    kohya: 'weight_decay=0.01, eps=0.00000001, betas=(0.9, 0.999)',
    musubi: '(empty)',
    rapid: '(empty)',
    'flux2-dev': '(empty)',
    'flux2-dev-edit': '(empty)',
    'ai-toolkit': '(empty)',
  },
  Prodigy: {
    kohya: optimizerArgMap.Prodigy,
    musubi: '(empty)',
    rapid: '(empty)',
    'flux2-dev': '(empty)',
    'flux2-dev-edit': '(empty)',
    'ai-toolkit': '(empty)',
  },
};
export const optimizerArgMapVideo: { [key in OptimizerTypes]: string } = {
  Adafactor: '',
  AdamW8Bit: '',
  Prodigy: '',
};

type BaseTrainingSettingsType = {
  name: keyof TrainingDetailsParams;
  label: string;
  hint: React.ReactNode;
  disabled?: boolean;
};

// nb: could allow the other for either allowing custom or being strict
type TypeTrainingBaseModel = TrainingDetailsBaseModel; // TrainingDetailsBaseModelList

type SelectTrainingSettingsType = {
  type: 'select';
  options: readonly string[];
  default: string;
  overrides?: {
    [key in TypeTrainingBaseModel]?: {
      [key in EngineTypes | 'all']?: Partial<
        Pick<BaseTrainingSettingsType, 'disabled' | 'hint'> &
          Omit<SelectTrainingSettingsType, 'type' | 'overrides' | 'options'> // could allow options override
      >;
    };
  };
};
type BoolTrainingSettingsType = {
  type: 'bool';
  default: boolean;
  overrides?: {
    [key in TypeTrainingBaseModel]?: {
      [key in EngineTypes | 'all']?: Partial<
        Pick<BaseTrainingSettingsType, 'disabled' | 'hint'> &
          Omit<BoolTrainingSettingsType, 'type' | 'overrides'>
      >;
    };
  };
};
export type NumberTrainingSettingsType = {
  type: 'int' | 'number';
  min: number;
  max: number;
  step: number;
  default: number | undefined;
  overrides?: {
    [key in TypeTrainingBaseModel]?: {
      [key in EngineTypes | 'all']?: Partial<
        Pick<BaseTrainingSettingsType, 'disabled' | 'hint'> &
          Omit<NumberTrainingSettingsType, 'type' | 'overrides' | 'step'> // could allow step override
      >;
    };
  };
};
type StringTrainingSettingsType = {
  type: 'string';
  default: string;
  overrides?: {
    [key in TypeTrainingBaseModel]?: {
      [key in EngineTypes | 'all']?: Partial<
        Pick<BaseTrainingSettingsType, 'disabled' | 'hint'> &
          Omit<StringTrainingSettingsType, 'type' | 'overrides'>
      >;
    };
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
    name: 'engine',
    label: 'Engine',
    hint: "The training script used. In most cases, you'll want Kohya.",
    type: 'select',
    default: 'kohya',
    options: engineTypes,
    disabled: true,
    overrides: {
      flux_dev: { all: { disabled: false } },
      flux2_dev: { all: { disabled: true, default: 'flux2-dev' } },
      // flux2_dev_edit: { all: { disabled: true, default: 'flux2-dev-edit' } }, // Disabled for now
      chroma: { all: { disabled: false } },
      hy_720_fp8: { all: { default: 'musubi' } },
      wan_2_1_i2v_14b_720p: { all: { default: 'musubi' } },
      wan_2_1_t2v_14b: { all: { default: 'musubi' } },
      qwen_image: { all: { default: 'ai-toolkit' } },
      zimageturbo: { all: { default: 'ai-toolkit' } },
    },
  },
  {
    name: 'maxTrainEpochs',
    label: 'Epochs',
    hint: 'An epoch is one set of learning. By default, we will save a maximum of 20 epochs (evenly distributed), and they are all available for download.',
    type: 'int',
    default: 10,
    min: 3,
    max: 500,
    step: 1,
    overrides: {
      sd_1_5: { 'ai-toolkit': { max: 40 } },
      anime: { 'ai-toolkit': { max: 40 } },
      semi: { 'ai-toolkit': { max: 40 } },
      realistic: { 'ai-toolkit': { max: 40 } },
      sdxl: { all: { min: 1 }, 'ai-toolkit': { min: 1, max: 40 } },
      pony: { all: { min: 1 }, 'ai-toolkit': { min: 1, max: 40 } },
      illustrious: { all: { min: 1 }, 'ai-toolkit': { min: 1, max: 40 } },
      flux_dev: {
        kohya: { default: 5 },
        rapid: { default: 1, min: 1, max: 1 },
        'ai-toolkit': { default: 5, max: 40 },
      },
      flux2_dev: {
        all: { default: 1, min: 1, max: 1 },
      },
      // flux2_dev_edit: { all: { default: 1, min: 1, max: 1 } }, // Disabled for now
      chroma: {
        all: { default: 5 },
        'ai-toolkit': { default: 5, max: 40 },
      },
      qwen_image: {
        all: { default: 5, max: 40 },
      },
      zimageturbo: {
        all: { default: 10, max: 40 },
      },
      // sd3_medium: { all: { default: 5 } },
      // sd3_large: { all: { default: 5 } },
      hy_720_fp8: { all: { min: 1, max: 20 } },
      wan_2_1_i2v_14b_720p: { all: { min: 1, max: 20 } },
      wan_2_1_t2v_14b: { all: { min: 1, max: 20 } },
    },
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
      realistic: { all: { default: 2, max: 2 } },
      sdxl: { all: { default: 4, max: 4 } },
      pony: { all: { default: 5, max: 5 } },
      illustrious: { all: { default: 4, max: 4 } },
      flux_dev: {
        kohya: { default: 4, max: 4 },
      },
      chroma: {
        all: { default: 4, max: 4 },
      },
      qwen_image: {
        all: { default: 4, max: 4 },
      },
      zimageturbo: {
        all: { default: 4, max: 4 },
      },
      // sd3_medium: { all: { default: 4, max: 4 } },
      // sd3_large: { all: { default: 4, max: 4 } },
      hy_720_fp8: { all: { default: 2, min: 1, max: 4 } },
      wan_2_1_i2v_14b_720p: { all: { default: 2, min: 1, max: 4 } },
      wan_2_1_t2v_14b: { all: { default: 2, min: 1, max: 4 } },
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
    // overrides: {
    //   hy_720_fp8: { all: { max: 5000 } },
    //   wan_2_1_i2v_14b_720p: { all: { max: 5000 } },
    //   wan_2_1_t2v_14b: { all: { max: 5000 } },
    // },
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
      sdxl: { all: { min: 1024, max: 2048, default: 1024 } },
      pony: { all: { min: 1024, max: 2048, default: 1024 } },
      illustrious: { all: { min: 1024, max: 2048, default: 1024 } },
      hy_720_fp8: { all: { disabled: true, default: 960, min: 960, max: 960 } }, // TODO 960x544
      wan_2_1_i2v_14b_720p: { all: { disabled: true, default: 960, min: 960, max: 960 } }, // TODO 960x544
      wan_2_1_t2v_14b: { all: { disabled: true, default: 960, min: 960, max: 960 } }, // TODO 960x544
      zimageturbo: { all: { default: 1024 } },
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
    label: 'Shuffle Tags',
    hint: 'Randomly changes the order of your tags during training. The intent of shuffling is to improve learning. If you are using captions (sentences), this option has no meaning.',
    type: 'bool',
    default: false,
    overrides: {
      flux_dev: { all: { disabled: true } },
      flux2_dev: { all: { disabled: true } },
      // flux2_dev_edit: { all: { disabled: true } }, // Disabled for now
      chroma: { all: { disabled: true } },
      qwen_image: { all: { disabled: true } },
      zimageturbo: { all: { disabled: true } },
      // sd3_medium: { all: { disabled: true } },
      // sd3_large: { all: { disabled: true } },
      hy_720_fp8: { all: { disabled: true } },
      wan_2_1_i2v_14b_720p: { all: { disabled: true } },
      wan_2_1_t2v_14b: { all: { disabled: true } },
    },
  },
  {
    name: 'keepTokens',
    label: 'Keep Tokens',
    hint: (
      <>
        If your training images have tags, you can randomly shuffle them (see &quot;Shuffle
        Tags&quot; option for details). However, if you have words that you want to keep at the
        beginning, you can use this option to specify how many to keep.
        <br />
        This option does nothing if the &quot;Shuffle Tags&quot; option is off.
      </>
    ),
    type: 'int',
    default: 0,
    min: 0,
    max: 3,
    step: 1,
    overrides: {
      flux_dev: { all: { disabled: true } },
      flux2_dev: { all: { disabled: true } },
      // flux2_dev_edit: { all: { disabled: true } }, // Disabled for now
      chroma: { all: { disabled: true } },
      qwen_image: { all: { disabled: true } },
      zimageturbo: { all: { disabled: true } },
      // sd3_medium: { all: { disabled: true } },
      // sd3_large: { all: { disabled: true } },
      hy_720_fp8: { all: { disabled: true } },
      wan_2_1_i2v_14b_720p: { all: { disabled: true } },
      wan_2_1_t2v_14b: { all: { disabled: true } },
    },
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
    overrides: {
      anime: { all: { default: 2 } },
      hy_720_fp8: { all: { disabled: true, default: 0, min: 0, max: 0 } },
      wan_2_1_i2v_14b_720p: { all: { disabled: true, default: 0, min: 0, max: 0 } },
      wan_2_1_t2v_14b: { all: { disabled: true, default: 0, min: 0, max: 0 } },
    },
  },
  {
    name: 'flipAugmentation',
    label: 'Flip Augmentation',
    hint: 'If this option is turned on, the image will be horizontally flipped randomly. It can learn left and right angles, which is useful when you want to learn symmetrical people and objects.',
    type: 'bool',
    default: false,
    overrides: {
      hy_720_fp8: { all: { disabled: true } },
      wan_2_1_i2v_14b_720p: { all: { disabled: true } },
      wan_2_1_t2v_14b: { all: { disabled: true } },
    },
  },
  {
    name: 'unetLR',
    label: 'Unet LR',
    hint: 'Sets the learning rate for U-Net. This is the learning rate when performing additional learning on each attention block (and other blocks depending on the setting) in U-Net.',
    type: 'number',
    default: 5e-4,
    min: 0,
    max: 1,
    step: 1e-5,
    overrides: {
      // sd3_medium: { all: { default: 1e-5 } },
      // sd3_large: { all: { default: 1e-5 } },
      hy_720_fp8: { all: { default: 2e-4, min: 1e-4, max: 6e-4 } },
      wan_2_1_i2v_14b_720p: { all: { default: 2e-4, min: 1e-4, max: 6e-4 } },
      wan_2_1_t2v_14b: { all: { default: 2e-4, min: 1e-4, max: 6e-4 } },
    },
  },
  {
    name: 'textEncoderLR',
    label: 'Text Encoder LR',
    hint: 'Sets the learning rate for the text encoder. The effect of additional training on text encoders affects the entire U-Net.',
    type: 'number',
    default: 5e-5,
    min: 0,
    max: 1,
    step: 1e-5,
    overrides: {
      anime: { all: { default: 1e-4 } },
      flux_dev: { all: { disabled: true, default: 0, max: 0 } },
      flux2_dev: { all: { disabled: true, default: 0, max: 0 } },
      // flux2_dev_edit: { all: { disabled: true, default: 0, max: 0 } }, // Disabled for now
      chroma: { all: { disabled: true, default: 0, max: 0 } },
      qwen_image: { all: { disabled: true, default: 0, max: 0 } },
      zimageturbo: { all: { disabled: true, default: 0, max: 0 } },
      // sd3_medium: { all: { disabled: true, default: 0, max: 0 } },
      // sd3_large: { all: { disabled: true, default: 0, max: 0 } },
      hy_720_fp8: { all: { disabled: true, default: 0, max: 0 } },
      wan_2_1_i2v_14b_720p: { all: { disabled: true, default: 0, max: 0 } },
      wan_2_1_t2v_14b: { all: { disabled: true, default: 0, max: 0 } },
    },
  },
  {
    name: 'lrScheduler',
    label: 'LR Scheduler',
    hint: 'You can change the learning rate in the middle of learning. A scheduler is a setting for how to change the learning rate.',
    type: 'select',
    default: 'cosine_with_restarts',
    options: lrSchedulerTypes,
    overrides: {
      pony: { all: { default: 'cosine' } },
      hy_720_fp8: { all: { default: 'constant' } },
      wan_2_1_i2v_14b_720p: { all: { default: 'constant' } },
      wan_2_1_t2v_14b: { all: { default: 'constant' } },
    },
  },
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
    overrides: {
      hy_720_fp8: { all: { default: 1 } },
      wan_2_1_i2v_14b_720p: { all: { default: 1 } },
      wan_2_1_t2v_14b: { all: { default: 1 } },
    },
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
    overrides: {
      pony: { all: { default: 0 } },
      hy_720_fp8: { all: { disabled: true, default: 0, max: 0 } },
      wan_2_1_i2v_14b_720p: { all: { disabled: true, default: 0, max: 0 } },
      wan_2_1_t2v_14b: { all: { disabled: true, default: 0, max: 0 } },
      zimageturbo: { all: { default: 0 } },
    },
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
    overrides: {
      sdxl: { all: { max: 256 } },
      pony: { all: { max: 256 } },
      illustrious: { all: { max: 256 } },
      anime: { all: { default: 16 } },
      flux_dev: { kohya: { default: 2 } },
      chroma: { all: { default: 2 } },
      qwen_image: { all: { default: 2 } },
      zimageturbo: { all: { default: 32 } },
      // sd3_medium: { all: { default: 2 } },
      // sd3_large: { all: { default: 2 } },
    },
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
    overrides: {
      sdxl: { all: { max: 256 } },
      pony: { all: { max: 256, default: 32 } },
      illustrious: { all: { max: 256 } },
      anime: { all: { default: 8 } },
      hy_720_fp8: { all: { default: 1 } },
      wan_2_1_i2v_14b_720p: { all: { default: 1 } },
      wan_2_1_t2v_14b: { all: { default: 1 } },
      zimageturbo: { all: { default: 32 } },
    },
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
    overrides: {
      pony: { all: { default: 0.03 } },
      hy_720_fp8: { all: { disabled: true, default: 0, min: 0, max: 0 } },
      wan_2_1_i2v_14b_720p: { all: { disabled: true, default: 0, min: 0, max: 0 } },
      wan_2_1_t2v_14b: { all: { disabled: true, default: 0, min: 0, max: 0 } },
      zimageturbo: { all: { default: 0 } },
    },
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
    overrides: {
      sdxl: { all: { default: 'Adafactor' } },
      pony: { all: { default: 'Prodigy' } },
      illustrious: { all: { default: 'Adafactor' } },
    },
  },
  {
    // this is only used for display
    name: 'optimizerArgs',
    label: 'Optimizer Args',
    hint: 'Additional arguments can be passed to control the behavior of the selected optimizer. This is set automatically.',
    type: 'string',
    default: optimizerArgMap.AdamW8Bit,
    disabled: true,
    overrides: {
      sdxl: { all: { default: optimizerArgMap.Adafactor } },
      pony: { all: { default: optimizerArgMap.Prodigy } },
      illustrious: { all: { default: optimizerArgMap.Adafactor } },
      flux_dev: {
        kohya: { default: optimizerArgMapFlux.AdamW8Bit.kohya },
      },
      chroma: {
        all: { default: optimizerArgMapFlux.AdamW8Bit.kohya },
      },
      qwen_image: {
        all: { default: optimizerArgMapFlux.AdamW8Bit.kohya },
      },
      zimageturbo: {
        all: { default: optimizerArgMapFlux.AdamW8Bit.kohya },
      },
      hy_720_fp8: { all: { default: optimizerArgMapVideo.AdamW8Bit } },
      wan_2_1_i2v_14b_720p: { all: { default: optimizerArgMapVideo.AdamW8Bit } },
      wan_2_1_t2v_14b: { all: { default: optimizerArgMapVideo.AdamW8Bit } },
    },
  },
];
