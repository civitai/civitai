import { NextApiRequest, NextApiResponse } from 'next';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { queryWorkflows, submitWorkflow } from '~/server/services/orchestrator/workflows';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { env } from '~/env/server';
import { getSystemPermissions } from '~/server/services/system-cache';
import { addGenerationEngine } from '~/server/services/generation/engines';
import { dbWrite, dbRead } from '~/server/db/client';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { getResourceData } from '~/server/services/generation/generation.service';
import { Prisma } from '@prisma/client';
import { getCommentsThreadDetails2 } from '~/server/services/commentsv2.service';
import { upsertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import {
  getWorkflowDefinition,
  getWorkflowDefinitions,
  setWorkflowDefinition,
} from '~/server/services/orchestrator/comfy/comfy.utils';
import { WorkflowDefinition } from '~/server/services/orchestrator/types';
import {
  getWorkflowDefinitions,
  setWorkflowDefinition,
} from '~/server/services/orchestrator/comfy/comfy.utils';
import { WorkflowDefinition } from '~/server/services/orchestrator/types';
import { pgDbWrite } from '~/server/db/pgDb';
import { tagIdsForImagesCache } from '~/server/redis/caches';

type Row = {
  userId: number;
  cosmeticId: number;
  claimKey: string;
  data: any[];
  fixedData?: Record<string, any>;
};

const covered = [1288397, 1288372, 1288371, 1288358, 1282254, 1281249];
const notCovered = [474453, 379259];
const test = [1183765, 164821];

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerAuthSession({ req, res });
    // const modelVersions = await getResourceData({
    //   ids: [1182093],
    //   user: session?.user,
    // });
    // const modelVersions = await dbRead.$queryRaw`
    //   SELECT
    //     mv."id",
    //     mv."name",
    //     mv."trainedWords",
    //     mv."baseModel",
    //     mv."settings",
    //     mv."availability",
    //     mv."clipSkip",
    //     mv."vaeId",
    //     mv."earlyAccessEndsAt",
    //     (CASE WHEN mv."availability" = 'EarlyAccess' THEN mv."earlyAccessConfig" END) as "earlyAccessConfig",
    //     gc."covered",
    //     (
    //       SELECT to_json(obj)
    //       FROM (
    //         SELECT
    //           m."id",
    //           m."name",
    //           m."type",
    //           m."nsfw",
    //           m."poi",
    //           m."minor",
    //           m."userId"
    //         FROM "Model" m
    //         WHERE m.id = mv."modelId"
    //       ) as obj
    //     ) as model
    //   FROM "ModelVersion" mv
    //   LEFT JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id
    //   WHERE mv.id IN (${Prisma.join([1325378])})
    // `;

    // const thread = await getCommentsThreadDetails2({
    //   entityId: 10936,
    //   entityType: 'article',
    // });

    // await upsertTagsOnImageNew([
    //   {
    //     imageId: 1,
    //     tagId: 1,
    //     // source: 'User',
    //     confidence: 70,
    //     // automated: true,
    //     // disabled: false,
    //     // needsReview: false,
    //   },
    // ]);
    // for (const workflow of workflows) {
    //   setWorkflowDefinition(workflow.key, workflow);
    // }

    const imageTags = await dbWrite.tagsOnImageDetails.findMany({
      where: { imageId: { in: [66447372] }, disabled: false },
      select: {
        imageId: true,
        source: true,
        tagId: true,
      },
    });
    const dbTags = imageTags.map((x) => x.tagId);

    await tagIdsForImagesCache.bust(66447372);
    const cache = await tagIdsForImagesCache.fetch(66447372);
    const tags = Object.values(cache).flatMap((x) => x.tags);

    const fromDb = await dbWrite.tag.findMany({ where: { id: { in: dbTags } } });
    const fromCache = await dbWrite.tag.findMany({ where: { id: { in: tags } } });

    res.status(200).send({
      fromDb,
      fromCache,
    });
  } catch (e) {
    console.log(e);
    res.status(400).end();
  }
});

const workflows: WorkflowDefinition[] = [
  {
    type: 'img2img',
    key: 'img2img-background-removal',
    name: 'Background Removal',
    features: ['image'],
    selectable: false,
    memberOnly: true,
    template:
      '{"1":{"inputs":{"model":"urn:air:other:birefnet:huggingface:ZhengPeng7/BiRefNet@main/model.safetensors","device":"AUTO","use_weight":false,"dtype":"float32"},"class_type":"LoadRembgByBiRefNetModel","_meta":{"title":"LoadRembgByBiRefNetModel"}},"4":{"inputs":{"image":"{{image}}","upload":"image"},"class_type":"LoadImage","_meta":{"title":"Load Image"}},"5":{"inputs":{"width": {{width}},"height": {{height}},"upscale_method":"nearest","mask_threshold":0,"model":["1",0],"images":["4",0]},"class_type":"GetMaskByBiRefNet","_meta":{"title":"GetMaskByBiRefNet"}},"6":{"inputs":{"model":["1",0],"images":["4",0]},"class_type":"RembgByBiRefNet","_meta":{"title":"RembgByBiRefNet"}},"9":{"inputs":{"width": {{width}},"height": {{height}},"upscale_method":"bilinear","blur_size":91,"blur_size_two":7,"fill_color":false,"color":0,"mask_threshold":0,"model":["1",0],"images":["4",0]},"class_type":"RembgByBiRefNetAdvanced","_meta":{"title":"RembgByBiRefNetAdvanced"}},"10":{"inputs":{"blur_size":91,"blur_size_two":7,"fill_color":false,"color":0,"images":["4",0],"masks":["16",0]},"class_type":"BlurFusionForegroundEstimation","_meta":{"title":"BlurFusionForegroundEstimation"}},"16":{"inputs":{"width": {{width}},"height": {{height}},"upscale_method":"bilinear","mask_threshold":0,"model":["1",0],"images":["4",0]},"class_type":"GetMaskByBiRefNet","_meta":{"title":"GetMaskByBiRefNet"}},"17":{"inputs":{"width": {{width}},"height": {{height}},"upscale_method":"bilinear","mask_threshold":0,"model":["1",0],"images":["4",0]},"class_type":"GetMaskByBiRefNet","_meta":{"title":"GetMaskByBiRefNet"}},"18":{"inputs":{"images":["10",0]},"class_type":"SaveImage","_meta":{"title":"SaveImage"}}}',
  },
  {
    type: 'img2img',
    key: 'img2img-facefix',
    name: 'Face fix',
    description: 'Find and regenerate faces in the image',
    features: ['denoise', 'image'],
    template:
      '{ "5": { "inputs": { "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "mean_normalization": false, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "parser": "A1111", "text_g": "", "text_l": "", "text": "{{prompt}}", "clip": [ "54", 1 ] }, "class_type": "smZ CLIPTextEncode", "_meta": { "title": "Positive" } }, "6": { "inputs": { "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "mean_normalization": false, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "parser": "A1111", "text_g": "", "text_l": "", "text": "{{negativePrompt}}", "clip": [ "54", 1 ] }, "class_type": "smZ CLIPTextEncode", "_meta": { "title": "Negative" } }, "16": { "inputs": { "model_name": "urn:air:other:other:civitai-r2:civitai-worker-assets@sam_vit_b_01ec64.pth", "device_mode": "AUTO" }, "class_type": "SAMLoader", "_meta": { "title": "SAMLoader (Impact)" } }, "51": { "inputs": { "guide_size": 360, "guide_size_for": "bbox", "max_size": 768, "seed": {{seed}}, "steps": {{steps}}, "cfg": {{cfgScale}}, "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": {{denoise}}, "feather": 5, "noise_mask": "enabled", "force_inpaint": "disabled", "bbox_threshold": 0.5, "bbox_dilation": 15, "bbox_crop_factor": 3, "sam_detection_hint": "center-1", "sam_dilation": 0, "sam_threshold": 0.93, "sam_bbox_expansion": 0, "sam_mask_hint_threshold": 0.7000000000000001, "sam_mask_hint_use_negative": "False", "drop_size": 10, "wildcard": "", "cycle": 1, "inpaint_model": false, "noise_mask_feather": 20, "image": [ "56", 0 ], "model": [ "54", 0 ], "clip": [ "54", 1 ], "vae": [ "54", 2 ], "positive": [ "5", 0 ], "negative": [ "6", 0 ], "bbox_detector": [ "53", 0 ], "sam_model_opt": [ "16", 0 ] }, "class_type": "FaceDetailer", "_meta": { "title": "FaceDetailer" } }, "53": { "inputs": { "model_name": "urn:air:other:other:civitai-r2:civitai-worker-assets@face_yolov8m.pt" }, "class_type": "UltralyticsDetectorProvider", "_meta": { "title": "UltralyticsDetectorProvider" } }, "54": { "inputs": { "ckpt_name": "placeholder.safetensors" }, "class_type": "CheckpointLoaderSimple", "_meta": { "title": "Load Checkpoint" } }, "56": { "inputs": { "image": "{{image}}", "upload": "image" }, "class_type": "LoadImage", "_meta": { "title": "Load Image" } }, "58": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "51", 0 ] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } } }',
  },
  {
    type: 'img2img',
    key: 'img2img-hires',
    name: 'Hi-res fix',
    description: 'Upscale and regenerate the image',
    features: ['denoise', 'upscale', 'image'],
    template:
      '{"6":{"inputs":{"text":"{{prompt}}","parser":"comfy","mean_normalization":true,"multi_conditioning":true,"use_old_emphasis_implementation":false,"with_SDXL":false,"ascore":2.5,"width":0,"height":0,"crop_w":0,"crop_h":0,"target_width":0,"target_height":0,"text_g":"","text_l":"","smZ_steps":1,"clip":["101",1]},"class_type":"smZ CLIPTextEncode","_meta":{"title":"Positive"}},"7":{"inputs":{"text":"{{negativePrompt}}","parser":"comfy","mean_normalization":true,"multi_conditioning":true,"use_old_emphasis_implementation":false,"with_SDXL":false,"ascore":2.5,"width":0,"height":0,"crop_w":0,"crop_h":0,"target_width":0,"target_height":0,"text_g":"","text_l":"","smZ_steps":1,"clip":["101",1]},"class_type":"smZ CLIPTextEncode","_meta":{"title":"Negative"}},"11":{"inputs":{"seed":"{{{seed}}}","steps":"{{{steps}}}","cfg":"{{{cfgScale}}}","sampler_name":"{{sampler}}","scheduler":"{{scheduler}}","denoise":"{{{denoise}}}","model":["101",0],"positive":["6",0],"negative":["7",0],"latent_image":["21",0]},"class_type":"KSampler","_meta":{"title":"KSampler"}},"12":{"inputs":{"filename_prefix":"ComfyUI","images":["13",0]},"class_type":"SaveImage","_meta":{"title":"Save Image"}},"13":{"inputs":{"samples":["11",0],"vae":["101",2]},"class_type":"VAEDecode","_meta":{"title":"VAE Decode"}},"17":{"inputs":{"image":"{{image}}","upload":"image"},"class_type":"LoadImage","_meta":{"title":"Image Load"}},"19":{"inputs":{"upscale_model":["20",0],"image":["17",0]},"class_type":"ImageUpscaleWithModel","_meta":{"title":"Upscale Image (using Model)"}},"20":{"inputs":{"model_name":"urn:air:other:upscaler:civitai:147759@164821"},"class_type":"UpscaleModelLoader","_meta":{"title":"Load Upscale Model"}},"21":{"inputs":{"pixels":["23",0],"vae":["101",2]},"class_type":"VAEEncode","_meta":{"title":"VAE Encode"}},"23":{"inputs":{"upscale_method":"nearest-exact","width":"{{{upscaleWidth}}}","height":"{{{upscaleHeight}}}","crop":"disabled","image":["19",0]},"class_type":"ImageScale","_meta":{"title":"Upscale Image"}},"101":{"inputs":{"ckpt_name":"placeholder.safetensors"},"class_type":"CheckpointLoaderSimple","_meta":{"title":"Load Checkpoint"}}}',
  },
  {
    type: 'img2img',
    key: 'img2img-upscale',
    name: 'Upscale',
    features: ['upscale', 'image'],
    selectable: false,
    remix: 'txt2img',
    template:
      '{"12": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "24", 0 ]}, "class_type": "SaveImage", "_meta": { "title": "Save Image" }}, "22": { "inputs": { "upscale_model": [ "23", 0 ], "image": [ "26", 0 ]}, "class_type": "ImageUpscaleWithModel", "_meta": { "title": "Upscale Image (using Model)" }}, "23": { "inputs": { "model_name": "urn:air:other:upscaler:civitai:147759@164821" }, "class_type": "UpscaleModelLoader", "_meta": { "title": "Load Upscale Model" }}, "24": { "inputs": { "upscale_method": "bilinear", "width": {{upscaleWidth}}, "height": {{upscaleHeight}}, "crop": "disabled", "image": [ "22", 0 ]}, "class_type": "ImageScale", "_meta": { "title": "Upscale Image" }}, "26": { "inputs": { "image": "{{image}}", "upload": "image" }, "class_type": "LoadImage", "_meta": { "title": "Load Image" }}}',
  },
  {
    type: 'img2img',
    key: 'img2img',
    name: 'Variations (img2img)',
    description: 'Generate a similar image',
    features: ['denoise', 'image'],
    template:
      '{ "6": { "inputs": { "text": "{{prompt}}", "parser": "A1111", "mean_normalization": false, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "text_g": "", "text_l": "", "smZ_steps": 1, "clip": [ "101", 1 ] }, "class_type": "smZ CLIPTextEncode", "_meta": { "title": "Positive" } }, "7": { "inputs": { "text": "{{negativePrompt}}", "parser": "A1111", "mean_normalization": false, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "text_g": "", "text_l": "", "smZ_steps": 1, "clip": [ "101", 1 ] }, "class_type": "smZ CLIPTextEncode", "_meta": { "title": "Negative" } }, "11": { "inputs": { "seed": "{{{seed}}}", "steps": "{{{steps}}}", "cfg": "{{{cfgScale}}}", "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": "{{{denoise}}}", "model": [ "101", 0 ], "positive": [ "6", 0 ], "negative": [ "7", 0 ], "latent_image": [ "18", 0 ] }, "class_type": "KSampler", "_meta": { "title": "KSampler" } }, "12": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "13", 0 ] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } }, "13": { "inputs": { "samples": [ "11", 0 ], "vae": [ "101", 2 ] }, "class_type": "VAEDecode", "_meta": { "title": "VAE Decode" } }, "17": { "inputs": { "image": "{{image}}", "upload": "image" }, "class_type": "LoadImage", "_meta": { "title": "Image Load" } }, "18": { "inputs": { "pixels": [ "17", 0 ], "vae": [ "101", 2 ] }, "class_type": "VAEEncode", "_meta": { "title": "VAE Encode" } }, "101": { "inputs": { "ckpt_name": "placeholder.safetensors" }, "class_type": "CheckpointLoaderSimple", "_meta": { "title": "Load Checkpoint" } } }',
  },
  {
    type: 'txt2img',
    key: 'txt2img',
    name: '',
    features: ['draft'],
    template:
      '{"3": { "inputs": { "seed": {{seed}}, "steps": {{steps}}, "cfg": {{cfgScale}}, "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": 1.0, "model": [ "4", 0 ], "positive": [ "6", 0 ], "negative": [ "7", 0 ], "latent_image": [ "5", 0 ]}, "class_type": "KSampler" }, "4": { "inputs": { "ckpt_name": "placeholder.safetensors" }, "class_type": "CheckpointLoaderSimple" }, "5": { "inputs": { "width": {{width}}, "height": {{height}}, "batch_size": 1 }, "class_type": "EmptyLatentImage" }, "6": { "inputs": { "parser": "A1111", "mean_normalization": false, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 6.0, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "text_g": "", "text_l": "", "text": "{{prompt}}", "clip": [ "10", 0 ]}, "class_type": "smZ CLIPTextEncode" }, "7": { "inputs": { "parser": "A1111", "mean_normalization": false, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "text_g": "", "text_l": "", "text": "{{negativePrompt}}", "clip": [ "10", 0 ]}, "class_type": "smZ CLIPTextEncode" }, "8": { "inputs": { "samples": [ "3", 0 ], "vae": [ "4", 2 ]}, "class_type": "VAEDecode" }, "9": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "8", 0 ]}, "class_type": "SaveImage" }, "10": { "inputs": { "stop_at_clip_layer": 0, "clip": [ "4", 1 ]}, "class_type": "CLIPSetLastLayer" }}',
  },
  {
    type: 'txt2img',
    key: 'txt2img-facefix',
    name: 'Face fix',
    description: 'Generate an image then find and regenerate faces',
    features: ['denoise'],
    template:
      '{ "5": { "inputs": { "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "mean_normalization": false, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "parser": "A1111", "text_g": "", "text_l": "", "text": "{{prompt}}", "clip": [ "54", 1 ] }, "class_type": "smZ CLIPTextEncode", "_meta": { "title": "CLIP Text Encode (Prompt)" } }, "6": { "inputs": { "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "mean_normalization": false, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "parser": "A1111", "text_g": "", "text_l": "", "text": "{{negativePrompt}}", "clip": [ "54", 1 ] }, "class_type": "smZ CLIPTextEncode", "_meta": { "title": "CLIP Text Encode (Prompt)" } }, "16": { "inputs": { "model_name": "urn:air:other:other:civitai-r2:civitai-worker-assets@sam_vit_b_01ec64.pth", "device_mode": "AUTO" }, "class_type": "SAMLoader", "_meta": { "title": "SAMLoader (Impact)" } }, "28": { "inputs": { "seed": {{seed}}, "steps": {{steps}}, "cfg": {{cfgScale}}, "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": 1, "model": [ "54", 0 ], "positive": [ "5", 0 ], "negative": [ "6", 0 ], "latent_image": [ "29", 0 ] }, "class_type": "KSampler", "_meta": { "title": "KSampler" } }, "29": { "inputs": { "width": {{width}}, "height": {{height}}, "batch_size": 1 }, "class_type": "EmptyLatentImage", "_meta": { "title": "Empty Latent Image" } }, "30": { "inputs": { "samples": [ "28", 0 ], "vae": [ "54", 2 ] }, "class_type": "VAEDecode", "_meta": { "title": "VAE Decode" } }, "51": { "inputs": { "guide_size": 360, "guide_size_for": "bbox", "max_size": 768, "seed": {{seed}}, "steps": {{steps}}, "cfg": {{cfgScale}}, "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": {{denoise}}, "feather": 5, "noise_mask": "enabled", "force_inpaint": "disabled", "bbox_threshold": 0.5, "bbox_dilation": 15, "bbox_crop_factor": 3, "sam_detection_hint": "center-1", "sam_dilation": 0, "sam_threshold": 0.93, "sam_bbox_expansion": 0, "sam_mask_hint_threshold": 0.7000000000000001, "sam_mask_hint_use_negative": "False", "drop_size": 10, "wildcard": "", "cycle": 1, "inpaint_model": false, "noise_mask_feather": 20, "image": [ "30", 0 ], "model": [ "54", 0 ], "clip": [ "54", 1 ], "vae": [ "54", 2 ], "positive": [ "5", 0 ], "negative": [ "6", 0 ], "bbox_detector": [ "53", 0 ], "sam_model_opt": [ "16", 0 ] }, "class_type": "FaceDetailer", "_meta": { "title": "FaceDetailer" } }, "53": { "inputs": { "model_name": "urn:air:other:other:civitai-r2:civitai-worker-assets@face_yolov8m.pt" }, "class_type": "UltralyticsDetectorProvider", "_meta": { "title": "UltralyticsDetectorProvider" } }, "54": { "inputs": { "ckpt_name": "placeholder.safetensors" }, "class_type": "CheckpointLoaderSimple", "_meta": { "title": "Load Checkpoint" } }, "55": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "51", 0 ] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } }, "56": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "30", 0 ] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } } }',
  },
  {
    type: 'txt2img',
    key: 'txt2img-hires-facefix',
    name: 'Hi-res face fix',
    description: 'Generate an image then upscale it, regenerate, find and regenerate faces',
    features: ['denoise', 'upscale'],
    template:
      '{ "3": { "inputs": { "seed": "{{{seed}}}", "steps": "{{{steps}}}", "cfg": "{{{cfgScale}}}", "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": 1, "model": [ "101", 0 ], "positive": [ "6", 0 ], "negative": [ "7", 0 ], "latent_image": [ "5", 0 ] }, "class_type": "KSampler", "_meta": { "title": "KSampler" } }, "5": { "inputs": { "width": "{{{width}}}", "height": "{{{height}}}", "batch_size": 1 }, "class_type": "EmptyLatentImage", "_meta": { "title": "Empty Latent Image" } }, "6": { "inputs": { "text": "{{prompt}}", "parser": "A1111", "mean_normalization": false, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "text_g": "", "text_l": "", "smZ_steps": 1, "clip": [ "101", 1 ] }, "class_type": "smZ CLIPTextEncode", "_meta": { "title": "CLIP Text Encode++" } }, "7": { "inputs": { "text": "{{negativePrompt}}", "parser": "A1111", "mean_normalization": false, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "text_g": "", "text_l": "", "smZ_steps": 1, "clip": [ "101", 1 ] }, "class_type": "smZ CLIPTextEncode", "_meta": { "title": "CLIP Text Encode++" } }, "8": { "inputs": { "samples": [ "3", 0 ], "vae": [ "101", 2 ] }, "class_type": "VAEDecode", "_meta": { "title": "VAE Decode" } }, "9": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "8", 0 ] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } }, "11": { "inputs": { "seed": "{{{seed}}}", "steps": "{{{steps}}}", "cfg": "{{{cfgScale}}}", "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": "{{{denoise}}}", "model": [ "101", 0 ], "positive": [ "6", 0 ], "negative": [ "7", 0 ], "latent_image": [ "24", 0 ] }, "class_type": "KSampler", "_meta": { "title": "KSampler" } }, "12": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "13", 0 ] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } }, "13": { "inputs": { "samples": [ "11", 0 ], "vae": [ "101", 2 ] }, "class_type": "VAEDecode", "_meta": { "title": "VAE Decode" } }, "14": { "inputs": { "guide_size": 384, "guide_size_for": true, "max_size": 1024, "seed": "{{{seed}}}", "steps": "{{{steps}}}", "cfg": "{{{cfgScale}}}", "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": 0.4, "feather": 5, "noise_mask": true, "force_inpaint": true, "bbox_threshold": 0.5, "bbox_dilation": 10, "bbox_crop_factor": 3, "sam_detection_hint": "center-1", "sam_dilation": 0, "sam_threshold": 0.93, "sam_bbox_expansion": 0, "sam_mask_hint_threshold": 0.7000000000000001, "sam_mask_hint_use_negative": "False", "drop_size": 10, "wildcard": "", "cycle": 1, "inpaint_model": false, "noise_mask_feather": 20, "image": [ "13", 0 ], "model": [ "101", 0 ], "clip": [ "101", 1 ], "vae": [ "101", 2 ], "positive": [ "15", 0 ], "negative": [ "16", 0 ], "bbox_detector": [ "18", 0 ], "sam_model_opt": [ "17", 0 ] }, "class_type": "FaceDetailer", "_meta": { "title": "FaceDetailer" } }, "15": { "inputs": { "text": "a face", "clip": [ "101", 1 ] }, "class_type": "CLIPTextEncode", "_meta": { "title": "CLIP Text Encode (Prompt)" } }, "16": { "inputs": { "text": "worst quality, low quality, normal quality, lowres, normal quality, monochrome, grayscale", "clip": [ "101", 1 ] }, "class_type": "CLIPTextEncode", "_meta": { "title": "CLIP Text Encode (Prompt)" } }, "17": { "inputs": { "model_name": "urn:air:other:other:civitai-r2:civitai-worker-assets@sam_vit_b_01ec64.pth", "device_mode": "AUTO" }, "class_type": "SAMLoader", "_meta": { "title": "SAMLoader (Impact)" } }, "18": { "inputs": { "model_name": "urn:air:other:other:civitai-r2:civitai-worker-assets@face_yolov8m.pt" }, "class_type": "UltralyticsDetectorProvider", "_meta": { "title": "UltralyticsDetectorProvider" } }, "19": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "14", 0 ] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } }, "20": { "inputs": { "images": [ "14", 2 ] }, "class_type": "PreviewImage", "_meta": { "title": "Preview Image" } }, "21": { "inputs": { "model_name": "urn:air:other:upscaler:civitai:147759@164821" }, "class_type": "UpscaleModelLoader", "_meta": { "title": "Load Upscale Model" } }, "22": { "inputs": { "upscale_model": [ "21", 0 ], "image": [ "8", 0 ] }, "class_type": "ImageUpscaleWithModel", "_meta": { "title": "Upscale Image (using Model)" } }, "23": { "inputs": { "upscale_method": "nearest-exact", "width": "{{{upscaleWidth}}}", "height": "{{{upscaleHeight}}}", "crop": "disabled", "image": [ "22", 0 ] }, "class_type": "ImageScale", "_meta": { "title": "Upscale Image" } }, "24": { "inputs": { "pixels": [ "23", 0 ], "vae": [ "101", 2 ] }, "class_type": "VAEEncode", "_meta": { "title": "VAE Encode" } }, "101": { "inputs": { "ckpt_name": "placeholder.safetensors" }, "class_type": "CheckpointLoaderSimple", "_meta": { "title": "Load Checkpoint" } } }',
    status: 'disabled',
  },
  {
    type: 'txt2img',
    key: 'txt2img-hires',
    name: 'Hi-res fix',
    description: 'Generate an image then upscale it and regenerate it',
    features: ['denoise', 'upscale'],
    template:
      '{"6":{"inputs":{"text":"{{prompt}}","parser":"comfy","mean_normalization":true,"multi_conditioning":true,"use_old_emphasis_implementation":false,"with_SDXL":false,"ascore":2.5,"width":0,"height":0,"crop_w":0,"crop_h":0,"target_width":0,"target_height":0,"text_g":"","text_l":"","smZ_steps":1,"clip":["101",1]},"class_type":"smZ CLIPTextEncode","_meta":{"title":"Positive"}},"7":{"inputs":{"text":"{{negativePrompt}}","parser":"comfy","mean_normalization":true,"multi_conditioning":true,"use_old_emphasis_implementation":false,"with_SDXL":false,"ascore":2.5,"width":0,"height":0,"crop_w":0,"crop_h":0,"target_width":0,"target_height":0,"text_g":"","text_l":"","smZ_steps":1,"clip":["101",1]},"class_type":"smZ CLIPTextEncode","_meta":{"title":"Negative"}},"11":{"inputs":{"seed":"{{{seed}}}","steps":"{{{steps}}}","cfg":"{{{cfgScale}}}","sampler_name":"{{sampler}}","scheduler":"{{scheduler}}","denoise":1,"model":["101",0],"positive":["6",0],"negative":["7",0],"latent_image":["26",0]},"class_type":"KSampler","_meta":{"title":"KSampler"}},"12":{"inputs":{"filename_prefix":"ComfyUI","images":["25",0]},"class_type":"SaveImage","_meta":{"title":"Save Image"}},"19":{"inputs":{"upscale_model":["20",0],"image":["27",0]},"class_type":"ImageUpscaleWithModel","_meta":{"title":"Upscale Image (using Model)"}},"20":{"inputs":{"model_name":"urn:air:other:upscaler:civitai:147759@164821"},"class_type":"UpscaleModelLoader","_meta":{"title":"Load Upscale Model"}},"21":{"inputs":{"pixels":["23",0],"vae":["101",2]},"class_type":"VAEEncode","_meta":{"title":"VAE Encode"}},"23":{"inputs":{"upscale_method":"nearest-exact","width":"{{{upscaleWidth}}}","height":"{{{upscaleHeight}}}","crop":"disabled","image":["19",0]},"class_type":"ImageScale","_meta":{"title":"Upscale Image"}},"24":{"inputs":{"seed":"{{{seed}}}","steps":"{{{steps}}}","cfg":"{{{cfgScale}}}","sampler_name":"{{sampler}}","scheduler":"{{scheduler}}","denoise":"{{{denoise}}}","model":["101",0],"positive":["6",0],"negative":["7",0],"latent_image":["21",0]},"class_type":"KSampler","_meta":{"title":"KSampler"}},"25":{"inputs":{"samples":["24",0],"vae":["101",2]},"class_type":"VAEDecode","_meta":{"title":"VAE Decode"}},"26":{"inputs":{"width":"{{{width}}}","height":"{{{height}}}","batch_size":1},"class_type":"EmptyLatentImage","_meta":{"title":"Empty Latent Image"}},"27":{"inputs":{"samples":["11",0],"vae":["101",2]},"class_type":"VAEDecode","_meta":{"title":"VAE Decode"}},"28":{"inputs":{"filename_prefix":"ComfyUI","images":["27",0]},"class_type":"SaveImage","_meta":{"title":"Save Image"}},"101":{"inputs":{"ckpt_name":"placeholder.safetensors"},"class_type":"CheckpointLoaderSimple","_meta":{"title":"Load Checkpoint"}}}',
  },
];
