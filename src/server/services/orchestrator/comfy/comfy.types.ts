export type WorkflowDefinitionType = 'txt2img' | 'img2img';

export type WorkflowDefinition = {
  key: 'txt2img' | `${WorkflowDefinitionType}-${string}`;
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
    name: 'Text to image',
    features: ['draft'],
    template:
      '{"3": { "inputs": { "seed": {{seed}}, "steps": {{steps}}, "cfg": {{cfgScale}}, "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": 1.0, "model": [ "4", 0 ], "positive": [ "6", 0 ], "negative": [ "7", 0 ], "latent_image": [ "5", 0 ]}, "class_type": "KSampler" }, "4": { "inputs": { "ckpt_name": "placeholder.safetensors" }, "class_type": "CheckpointLoaderSimple" }, "5": { "inputs": { "width": {{width}}, "height": {{height}}, "batch_size": 1 }, "class_type": "EmptyLatentImage" }, "6": { "inputs": { "parser": "A1111", "mean_normalization": true, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 6.0, "width": {{width}}, "height": {{height}}, "crop_w": 0, "crop_h": 0, "target_width": {{width}}, "target_height": {{height}}, "text_g": "", "text_l": "", "text": "{{prompt}}", "clip": [ "10", 0 ]}, "class_type": "smZ CLIPTextEncode" }, "7": { "inputs": { "parser": "A1111", "mean_normalization": true, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 2.5, "width": {{width}}, "height": {{height}}, "crop_w": 0, "crop_h": 0, "target_width": {{width}}, "target_height": {{height}}, "text_g": "", "text_l": "", "text": "{{negativePrompt}}", "clip": [ "10", 0 ]}, "class_type": "smZ CLIPTextEncode" }, "8": { "inputs": { "samples": [ "3", 0 ], "vae": [ "4", 2 ]}, "class_type": "VAEDecode" }, "9": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "8", 0 ]}, "class_type": "SaveImage" }, "10": { "inputs": { "stop_at_clip_layer": 0, "clip": [ "4", 1 ]}, "class_type": "CLIPSetLastLayer" }}',
  },
  {
    key: 'txt2img-hires',
    name: 'Hi-res fix',
    features: ['denoise', 'upscale'],
    template:
      '{"3":{"inputs":{"seed":{{seed}},"steps":{{steps}},"cfg":{{cfgScale}},"sampler_name":"{{sampler}}","scheduler":"{{scheduler}}","denoise":{{denoise}},"model":["16",0],"positive":["6",0],"negative":["7",0],"latent_image":["5",0]},"class_type":"KSampler","_meta":{"title":"KSampler"}},"5":{"inputs":{"width":{{width}},"height":{{height}},"batch_size":1},"class_type":"EmptyLatentImage","_meta":{"title":"Empty Latent Image"}},"6":{"inputs":{"text":"{{prompt}}","clip":["16",1]},"class_type":"CLIPTextEncode","_meta":{"title":"CLIP Text Encode (Prompt)"}},"7":{"inputs":{"text":"{{negativePrompt}}","clip":["16",1]},"class_type":"CLIPTextEncode","_meta":{"title":"CLIP Text Encode (Prompt)"}},"8":{"inputs":{"samples":["3",0],"vae":["16",2]},"class_type":"VAEDecode","_meta":{"title":"VAE Decode"}},"9":{"inputs":{"filename_prefix":"ComfyUI","images":["8",0]},"class_type":"SaveImage","_meta":{"title":"Save Image"}},"10":{"inputs":{"upscale_method":"nearest-exact","width":{{upscaleWidth}},"height":{{upscaleHeight}},"crop":"disabled","samples":["3",0]},"class_type":"LatentUpscale","_meta":{"title":"Upscale Latent"}},"11":{"inputs":{"seed":{{seed}},"steps":{{steps}},"cfg":{{cfgScale}},"sampler_name":"{{sampler}}","scheduler":"simple","denoise":{{denoise}},"model":["16",0],"positive":["6",0],"negative":["7",0],"latent_image":["10",0]},"class_type":"KSampler","_meta":{"title":"KSampler"}},"12":{"inputs":{"filename_prefix":"ComfyUI","images":["13",0]},"class_type":"SaveImage","_meta":{"title":"Save Image"}},"13":{"inputs":{"samples":["11",0],"vae":["16",2]},"class_type":"VAEDecode","_meta":{"title":"VAE Decode"}},"16":{"inputs":{"ckpt_name":"placeholder.safetensors"},"class_type":"CheckpointLoaderSimple","_meta":{"title":"Load Checkpoint"}}}',
  },
  {
    key: 'txt2img-facefix',
    name: 'Face fix',
    features: ['denoise'],
    template:
      '{"5": { "inputs": { "text": "{{prompt}}", "clip": [ "54", 1 ]}, "class_type": "CLIPTextEncode", "_meta": { "title": "Positive" }}, "6": { "inputs": { "text": "{{negativePrompt}}", "clip": [ "54", 1 ]}, "class_type": "CLIPTextEncode", "_meta": { "title": "Negative" }}, "7": { "inputs": { "images": [ "51", 0 ]}, "class_type": "PreviewImage", "_meta": { "title": "Enhanced" }}, "16": { "inputs": { "model_name": "urn:air:other:other:civitai-r2:civitai-worker-assets@sam_vit_b_01ec64.pth", "device_mode": "AUTO" }, "class_type": "SAMLoader", "_meta": { "title": "SAMLoader (Impact)" }}, "17": { "inputs": { "mask": [ "51", 3 ]}, "class_type": "MaskToImage", "_meta": { "title": "Convert Mask to Image" }}, "18": { "inputs": { "images": [ "17", 0 ]}, "class_type": "PreviewImage", "_meta": { "title": "Mask" }}, "28": { "inputs": { "seed": {{seed}}, "steps": {{steps}}, "cfg": {{cfgScale}}, "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": {{denoise}}, "model": [ "54", 0 ], "positive": [ "5", 0 ], "negative": [ "6", 0 ], "latent_image": [ "29", 0 ]}, "class_type": "KSampler", "_meta": { "title": "KSampler" }}, "29": { "inputs": { "width": {{width}}, "height": {{height}}, "batch_size": 1 }, "class_type": "EmptyLatentImage", "_meta": { "title": "Empty Latent Image" }}, "30": { "inputs": { "samples": [ "28", 0 ], "vae": [ "54", 2 ]}, "class_type": "VAEDecode", "_meta": { "title": "VAE Decode" }}, "33": { "inputs": { "images": [ "30", 0 ]}, "class_type": "PreviewImage", "_meta": { "title": "Preview Image" }}, "43": { "inputs": { "images": [ "51", 1 ]}, "class_type": "PreviewImage", "_meta": { "title": "Cropped (refined)" }}, "51": { "inputs": { "guide_size": 360, "guide_size_for": "bbox", "max_size": 768, "seed": 0, "steps": {{steps}}, "cfg": {{cfgScale}}, "sampler_name": "euler", "scheduler": "{{scheduler}}", "denoise": 0.5, "feather": 5, "noise_mask": "enabled", "force_inpaint": "disabled", "bbox_threshold": 0.5, "bbox_dilation": 15, "bbox_crop_factor": 3, "sam_detection_hint": "center-1", "sam_dilation": 0, "sam_threshold": 0.93, "sam_bbox_expansion": 0, "sam_mask_hint_threshold": 0.7, "sam_mask_hint_use_negative": "False", "drop_size": 10, "wildcard": "", "cycle": 1, "inpaint_model": false, "noise_mask_feather": 20, "image": [ "30", 0 ], "model": [ "54", 0 ], "clip": [ "54", 1 ], "vae": [ "54", 2 ], "positive": [ "5", 0 ], "negative": [ "6", 0 ], "bbox_detector": [ "53", 0 ], "sam_model_opt": [ "16", 0 ]}, "class_type": "FaceDetailer", "_meta": { "title": "FaceDetailer" }}, "52": { "inputs": { "images": [ "51", 2 ]}, "class_type": "PreviewImage", "_meta": { "title": "Preview Image" }}, "53": { "inputs": { "model_name": "urn:air:other:other:civitai-r2:civitai-worker-assets@face_yolov8m.pt" }, "class_type": "UltralyticsDetectorProvider", "_meta": { "title": "UltralyticsDetectorProvider" }}, "54": { "inputs": { "ckpt_name": "placeholder.safetensors" }, "class_type": "CheckpointLoaderSimple", "_meta": { "title": "Load Checkpoint" }} }',
  },
  {
    key: 'img2img-hires',
    name: 'Hi-res fix',
    features: ['denoise', 'upscale', 'image'],
    template:
      '{"6": { "inputs": { "text": "{{prompt}}", "clip": [ "16", 1 ]}, "class_type": "CLIPTextEncode", "_meta": { "title": "CLIP Text Encode (Prompt)" }}, "7": { "inputs": { "text": "{{negativePrompt}}", "clip": [ "16", 1 ]}, "class_type": "CLIPTextEncode", "_meta": { "title": "CLIP Text Encode (Prompt)" }}, "10": { "inputs": { "upscale_method": "nearest-exact", "width": {{upscaleWidth}}, "height": {{upscaleHeight}}, "crop": "disabled", "samples": [ "18", 0 ]}, "class_type": "LatentUpscale", "_meta": { "title": "Upscale Latent" }}, "11": { "inputs": { "seed": {{seed}}, "steps": {{steps}}, "cfg": {{cfgScale}}, "sampler_name": "{{sampler}}", "scheduler": "simple", "denoise": {{denoise}}, "model": [ "16", 0 ], "positive": [ "6", 0 ], "negative": [ "7", 0 ], "latent_image": [ "10", 0 ]}, "class_type": "KSampler", "_meta": { "title": "KSampler" }}, "12": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "13", 0 ]}, "class_type": "SaveImage", "_meta": { "title": "Save Image" }}, "13": { "inputs": { "samples": [ "11", 0 ], "vae": [ "16", 2 ]}, "class_type": "VAEDecode", "_meta": { "title": "VAE Decode" }}, "16": { "inputs": { "ckpt_name": "placeholder.safetensors" }, "class_type": "CheckpointLoaderSimple", "_meta": { "title": "Load Checkpoint" }}, "17": { "inputs": { "image_path": "{{image}}", "RGBA": "false", "filename_text_extension": "true" }, "class_type": "LoadImage", "_meta": { "title": "Image Load" }}, "18": { "inputs": { "pixels": [ "17", 0 ]}, "class_type": "VAEEncode", "_meta": { "title": "VAE Encode" }}}',
  },
  {
    key: 'img2img-facefix',
    name: 'Face fix',
    features: ['denoise', 'image'],
    template:
      '{"5": { "inputs": { "text": "prompt", "clip": [ "54", 1 ]}, "class_type": "CLIPTextEncode", "_meta": { "title": "Positive" ]}, "6": { "inputs": { "text": "negativePrompt", "clip": [ "54", 1 ]}, "class_type": "CLIPTextEncode", "_meta": { "title": "Negative" ]}, "7": { "inputs": { "images": [ "51", 0 ]}, "class_type": "PreviewImage", "_meta": { "title": "Enhanced" ]}, "16": { "inputs": { "model_name": "urn:air:other:other:civitai-r2:civitai-worker-assets@sam_vit_b_01ec64.pth", "device_mode": "AUTO" }, "class_type": "SAMLoader", "_meta": { "title": "SAMLoader (Impact)" ]}, "17": { "inputs": { "mask": [ "51", 3 ]}, "class_type": "MaskToImage", "_meta": { "title": "Convert Mask to Image" ]}, "18": { "inputs": { "images": [ "17", 0 ]}, "class_type": "PreviewImage", "_meta": { "title": "Mask" ]}, "28": { "inputs": { "seed": {{seed}}, "steps": {{steps}}, "cfg": {{cfgScale}}, "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": 0.15, "model": [ "54", 0 ], "positive": [ "5", 0 ], "negative": [ "6", 0 ], "latent_image": [ "57", 0 ]}, "class_type": "KSampler", "_meta": { "title": "KSampler" ]}, "30": { "inputs": { "samples": [ "28", 0 ], "vae": [ "54", 2 ]}, "class_type": "VAEDecode", "_meta": { "title": "VAE Decode" ]}, "33": { "inputs": { "images": [ "30", 0 ]}, "class_type": "PreviewImage", "_meta": { "title": "Preview Image" ]}, "43": { "inputs": { "images": [ "51", 1 ]}, "class_type": "PreviewImage", "_meta": { "title": "Cropped (refined)" ]}, "51": { "inputs": { "guide_size": 360, "guide_size_for": "bbox", "max_size": 768, "seed": 0, "steps": {{steps}}, "cfg": {{cfgScale}}, "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": 0.5, "feather": 5, "noise_mask": "enabled", "force_inpaint": "disabled", "bbox_threshold": 0.5, "bbox_dilation": 15, "bbox_crop_factor": 3, "sam_detection_hint": "center-1", "sam_dilation": 0, "sam_threshold": 0.93, "sam_bbox_expansion": 0, "sam_mask_hint_threshold": 0.7, "sam_mask_hint_use_negative": "False", "drop_size": 10, "wildcard": "", "cycle": 1, "inpaint_model": false, "noise_mask_feather": 20, "image": [ "30", 0 ], "model": [ "54", 0 ], "clip": [ "54", 1 ], "vae": [ "54", 2 ], "positive": [ "5", 0 ], "negative": [ "6", 0 ], "bbox_detector": [ "53", 0 ], "sam_model_opt": [ "16", 0 ]}, "class_type": "FaceDetailer", "_meta": { "title": "FaceDetailer" ]}, "52": { "inputs": { "images": [ "51", 2 ]}, "class_type": "PreviewImage", "_meta": { "title": "Preview Image" ]}, "53": { "inputs": { "model_name": "urn:air:other:other:civitai-r2:civitai-worker-assets@face_yolov8m.pt" }, "class_type": "UltralyticsDetectorProvider", "_meta": { "title": "UltralyticsDetectorProvider" ]}, "54": { "inputs": { "ckpt_name": "placeholder.safetensors" }, "class_type": "CheckpointLoaderSimple", "_meta": { "title": "Load Checkpoint" ]}, "56": { "inputs": { "image": "{{image}}", "upload": "image" }, "class_type": "LoadImage", "_meta": { "title": "Load Image" ]}, "57": { "inputs": { "pixels": [ "56", 0 ], "vae": [ "54", 2 ]}, "class_type": "VAEEncode", "_meta": { "title": "VAE Encode" ]]}',
  },
  {
    key: 'img2img-upscale',
    name: 'Upscale',
    features: ['denoise', 'image'],
    template:
      '{"12": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "24", 0 ]}, "class_type": "SaveImage", "_meta": { "title": "Save Image" }}, "22": { "inputs": { "upscale_model": [ "23", 0 ], "image": [ "26", 0 ]}, "class_type": "ImageUpscaleWithModel", "_meta": { "title": "Upscale Image (using Model)" }}, "23": { "inputs": { "model_name": "urn:air:multi:upscaler:civitai:147817@164898" }, "class_type": "UpscaleModelLoader", "_meta": { "title": "Load Upscale Model" }}, "24": { "inputs": { "upscale_method": "bilinear", "width": {{upscaleWidth}}, "height": {{upscaleHeight}}, "crop": "disabled", "image": [ "22", 0 ]}, "class_type": "ImageScale", "_meta": { "title": "Upscale Image" }}, "26": { "inputs": { "image": "{{image}}", "upload": "image" }, "class_type": "LoadImage", "_meta": { "title": "Load Image" }}}',
  },
];
