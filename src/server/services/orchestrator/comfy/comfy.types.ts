export type WorkflowDefinition = {
  key: string;
  name: string;
  description?: string;
  selectable?: boolean;
  template: string;
  enabled?: boolean;
  features?: (typeof workflowDefinitionFeatures)[number][];
  inputs?: InputSchema[];
};

// TODO - these will need to be defined as an input schema first, then as a workflow input schema
type InputBase = {
  key: string;
  label: string;
  defaultValue: any;
  required: boolean;
};

type NumberInput = InputBase & {
  type: 'number';
  variant?: 'stepper' | 'slider';
  min?: number;
  max?: number;
  step?: number;
};

type TextInput = InputBase & {
  type: 'text';
  maxLength?: number;
  minLength?: number;
};

type SelectInput = InputBase & {
  type: 'select';
  options: { label: string; value: string }[];
};

type ImageInput = InputBase & {
  type: 'image';
  maxWidth?: number;
  maxHeight?: number;
  resizeToFit?: boolean;
};

export type InputSchema = NumberInput | TextInput | SelectInput | ImageInput;

// upscale could require additional config options in the future, but this could also be tied to an input schema
export const workflowDefinitionFeatures = ['draft', 'denoise', 'upscale', 'image'] as const;
export const workflowDefinitions: WorkflowDefinition[] = [
  {
    key: 'txt2img',
    name: 'Text to Image',
    features: ['draft'],
    template: '',
  },
  {
    key: 'txt2img-hires',
    name: 'Text to Image Hires',
    features: ['denoise', 'upscale'],
    template:
      '{"3":{"inputs":{"seed":{{seed}},"steps":{{steps}},"cfg":{{cfgScale}},"sampler_name":{{scheduler}},"scheduler":"normal","denoise":{{denoise}},"model":["16",0],"positive":["6",0],"negative":["7",0],"latent_image":["5",0]},"class_type":"KSampler","_meta":{"title":"KSampler"}},"5":{"inputs":{"width":{{width}},"height":{{height}},"batch_size":1},"class_type":"EmptyLatentImage","_meta":{"title":"Empty Latent Image"}},"6":{"inputs":{"text":{{prompt}},"clip":["16",1]},"class_type":"CLIPTextEncode","_meta":{"title":"CLIP Text Encode (Prompt)"}},"7":{"inputs":{"text":{{negativePrompt}},"clip":["16",1]},"class_type":"CLIPTextEncode","_meta":{"title":"CLIP Text Encode (Prompt)"}},"8":{"inputs":{"samples":["3",0],"vae":["16",2]},"class_type":"VAEDecode","_meta":{"title":"VAE Decode"}},"9":{"inputs":{"filename_prefix":"ComfyUI","images":["8",0]},"class_type":"SaveImage","_meta":{"title":"Save Image"}},"10":{"inputs":{"upscale_method":"nearest-exact","width":{{upscaleWidth}},"height":{{upscaleHeight}},"crop":"disabled","samples":["3",0]},"class_type":"LatentUpscale","_meta":{"title":"Upscale Latent"}},"11":{"inputs":{"seed":{{seed}},"steps":{{steps}},"cfg":{{cfgScale}},"sampler_name":{{scheduler}},"scheduler":"simple","denoise":{{denoise}},"model":["16",0],"positive":["6",0],"negative":["7",0],"latent_image":["10",0]},"class_type":"KSampler","_meta":{"title":"KSampler"}},"12":{"inputs":{"filename_prefix":"ComfyUI","images":["13",0]},"class_type":"SaveImage","_meta":{"title":"Save Image"}},"13":{"inputs":{"samples":["11",0],"vae":["16",2]},"class_type":"VAEDecode","_meta":{"title":"VAE Decode"}},"16":{"inputs":{"ckpt_name":"v2-1_768-ema-pruned.ckpt"},"class_type":"CheckpointLoaderSimple","_meta":{"title":"Load Checkpoint"}}}',
  },
  {
    key: 'txt2img-facefix',
    name: 'Text to Image Facefix',
    template: '',
  },
  {
    key: 'img2img-hires',
    name: 'Image to Image Facefix',
    features: ['denoise', 'upscale'],
    template: '',
  },
  {
    key: 'img2img-facefix',
    name: 'Image to Image Facefix',
    template: '',
  },
];
