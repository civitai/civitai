/**
 * Image Preprocess Graph
 *
 * Graph for control-preprocessor workflow (img2img:preprocess).
 * Standalone workflow — no ecosystem support. Mirrors the @civitai/client
 * `PreprocessImageInput` discriminated union: one `kind` value picks the
 * preprocessor, plus a free-form `kindParams` record for kind-specific options.
 *
 * The `kindParams` record is a single graph node (rather than 30+ flat
 * conditional nodes) to keep TypeScript's type-instantiation depth within
 * budget — the generation graph and its consumers (form, controllers) hit
 * TS2589 once the flat-node count goes past the limit. The handler builds
 * the strictly-typed `PreprocessImageInput` from `kind` + `kindParams`.
 *
 * Per-kind parameter metadata (label/min/max/options) is exported as
 * `preprocessKindParamSpecs` for the form to render typed controls.
 */

import { z } from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { imagesNode, sliderNode } from './common';

// =============================================================================
// Kind list (mirrors @civitai/client PreprocessImageInput.kind union)
// =============================================================================

export const preprocessKinds = [
  'animal-pose',
  'anyline',
  'bae-normal',
  'binary',
  'canny',
  'color',
  'densepose',
  'depth-anything',
  'depth-anything-v2',
  'dsine-normal',
  'dwpose',
  'fake-scribble',
  'hed',
  'leres-depth',
  'lineart-anime',
  'lineart-manga',
  'lineart-realistic',
  'lineart-standard',
  'mediapipe-face',
  'metric3d-depth',
  'metric3d-normal',
  'midas-depth',
  'midas-normal',
  'mlsd',
  'oneformer-ade20k',
  'oneformer-coco',
  'openpose',
  'pidinet',
  'scribble',
  'scribble-pidinet',
  'scribble-xdog',
  'shuffle',
  'teed',
  'tile',
  'uniformer',
  'zoe-depth',
  'zoe-depth-anything',
] as const;

export type PreprocessKind = (typeof preprocessKinds)[number];

// =============================================================================
// Enum option lists (mirrors @civitai/client enums)
// =============================================================================

const safeModeOptions = ['enable', 'disable'] as const;
const coarseModeOptions = ['disable', 'enable'] as const;
const leresBoostOptions = ['disable', 'enable'] as const;
const poseDetectorOptions = [
  'yolox_l.torchscript.pt',
  'yolox_l.onnx',
  'yolo_nas_l_fp16.onnx',
  'yolo_nas_m_fp16.onnx',
  'yolo_nas_s_fp16.onnx',
] as const;
const animalPoseEstimatorOptions = [
  'rtmpose-m_ap10k_256_bs5.torchscript.pt',
  'rtmpose-m_ap10k_256.onnx',
] as const;
const anylineMergeWithOptions = [
  'lineart_standard',
  'lineart_realistic',
  'lineart_anime',
  'manga_line',
] as const;
const densePoseModelOptions = [
  'densepose_r50_fpn_dl.torchscript',
  'densepose_r101_fpn_dl.torchscript',
] as const;
const densePoseColormapOptions = ['Viridis (MagicAnimate)', 'Parula (CivitAI)'] as const;
const depthAnythingCheckpointOptions = [
  'depth_anything_vitl14.pth',
  'depth_anything_vitb14.pth',
  'depth_anything_vits14.pth',
] as const;
const depthAnythingV2CheckpointOptions = [
  'depth_anything_v2_vitg.pth',
  'depth_anything_v2_vitl.pth',
  'depth_anything_v2_vitb.pth',
  'depth_anything_v2_vits.pth',
] as const;
const dwPoseEstimatorOptions = [
  'dw-ll_ucoco_384_bs5.torchscript.pt',
  'dw-ll_ucoco_384.onnx',
  'dw-ll_ucoco.onnx',
] as const;
const metric3dBackboneOptions = ['vit-small', 'vit-large', 'vit-giant2'] as const;
const zoeDepthEnvironmentOptions = ['indoor', 'outdoor'] as const;

// =============================================================================
// Per-kind parameter specs (for UI rendering)
// =============================================================================

export type ParamSpec =
  | { type: 'slider'; key: string; label: string; min: number; max: number; step?: number; defaultValue: number }
  | { type: 'boolean'; key: string; label: string; defaultValue: boolean }
  | { type: 'select'; key: string; label: string; options: readonly string[]; defaultValue: string };

/**
 * Map of preprocessor kind → its UI param specs.
 * The form can iterate over the active kind's specs to render typed controls
 * that write into the `kindParams` record.
 */
export const preprocessKindParamSpecs: Record<PreprocessKind, readonly ParamSpec[]> = {
  'animal-pose': [
    { type: 'select', key: 'bboxDetector', label: 'BBox Detector', options: poseDetectorOptions, defaultValue: poseDetectorOptions[0] },
    { type: 'select', key: 'poseEstimator', label: 'Pose Estimator', options: animalPoseEstimatorOptions, defaultValue: animalPoseEstimatorOptions[0] },
  ],
  anyline: [
    { type: 'select', key: 'mergeWithLineart', label: 'Merge With', options: anylineMergeWithOptions, defaultValue: 'lineart_standard' },
    { type: 'slider', key: 'lineartLowerBound', label: 'Lineart Lower Bound', min: 0, max: 1, step: 0.01, defaultValue: 0 },
    { type: 'slider', key: 'lineartUpperBound', label: 'Lineart Upper Bound', min: 0, max: 1, step: 0.01, defaultValue: 1 },
    { type: 'slider', key: 'objectMinSize', label: 'Object Min Size', min: 0, max: 100, defaultValue: 36 },
    { type: 'slider', key: 'objectConnectivity', label: 'Object Connectivity', min: 1, max: 16, defaultValue: 8 },
  ],
  'bae-normal': [],
  binary: [{ type: 'slider', key: 'binThreshold', label: 'Threshold', min: 0, max: 255, defaultValue: 100 }],
  canny: [
    { type: 'slider', key: 'lowThreshold', label: 'Low Threshold', min: 0, max: 255, defaultValue: 100 },
    { type: 'slider', key: 'highThreshold', label: 'High Threshold', min: 0, max: 255, defaultValue: 200 },
  ],
  color: [],
  densepose: [
    { type: 'select', key: 'model', label: 'Model', options: densePoseModelOptions, defaultValue: densePoseModelOptions[0] },
    { type: 'select', key: 'colormap', label: 'Colormap', options: densePoseColormapOptions, defaultValue: 'Viridis (MagicAnimate)' },
  ],
  'depth-anything': [
    { type: 'select', key: 'checkpoint', label: 'Checkpoint', options: depthAnythingCheckpointOptions, defaultValue: depthAnythingCheckpointOptions[0] },
  ],
  'depth-anything-v2': [
    { type: 'select', key: 'checkpoint', label: 'Checkpoint', options: depthAnythingV2CheckpointOptions, defaultValue: depthAnythingV2CheckpointOptions[1] },
  ],
  'dsine-normal': [
    { type: 'slider', key: 'fov', label: 'FOV', min: 10, max: 120, defaultValue: 60 },
    { type: 'slider', key: 'iterations', label: 'Iterations', min: 1, max: 20, defaultValue: 5 },
  ],
  dwpose: [
    { type: 'boolean', key: 'detectHand', label: 'Detect Hand', defaultValue: true },
    { type: 'boolean', key: 'detectBody', label: 'Detect Body', defaultValue: true },
    { type: 'boolean', key: 'detectFace', label: 'Detect Face', defaultValue: true },
    { type: 'select', key: 'bboxDetector', label: 'BBox Detector', options: poseDetectorOptions, defaultValue: poseDetectorOptions[0] },
    { type: 'select', key: 'poseEstimator', label: 'Pose Estimator', options: dwPoseEstimatorOptions, defaultValue: dwPoseEstimatorOptions[0] },
  ],
  'fake-scribble': [{ type: 'select', key: 'safe', label: 'Safe', options: safeModeOptions, defaultValue: 'enable' }],
  hed: [{ type: 'select', key: 'safe', label: 'Safe', options: safeModeOptions, defaultValue: 'enable' }],
  'leres-depth': [
    { type: 'slider', key: 'removeNearest', label: 'Remove Nearest', min: 0, max: 100, defaultValue: 0 },
    { type: 'slider', key: 'removeBackground', label: 'Remove Background', min: 0, max: 100, defaultValue: 0 },
    { type: 'select', key: 'boost', label: 'Boost', options: leresBoostOptions, defaultValue: 'disable' },
  ],
  'lineart-anime': [],
  'lineart-manga': [],
  'lineart-realistic': [
    { type: 'select', key: 'coarse', label: 'Coarse', options: coarseModeOptions, defaultValue: 'disable' },
  ],
  'lineart-standard': [
    { type: 'slider', key: 'gaussianSigma', label: 'Gaussian Sigma', min: 0, max: 20, step: 0.1, defaultValue: 6 },
    { type: 'slider', key: 'intensityThreshold', label: 'Intensity Threshold', min: 0, max: 16, defaultValue: 8 },
  ],
  'mediapipe-face': [
    { type: 'slider', key: 'maxFaces', label: 'Max Faces', min: 1, max: 10, defaultValue: 1 },
    { type: 'slider', key: 'minConfidence', label: 'Min Confidence', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
  ],
  'metric3d-depth': [
    { type: 'select', key: 'backbone', label: 'Backbone', options: metric3dBackboneOptions, defaultValue: 'vit-large' },
    { type: 'slider', key: 'fx', label: 'fx', min: 100, max: 2000, defaultValue: 1000 },
    { type: 'slider', key: 'fy', label: 'fy', min: 100, max: 2000, defaultValue: 1000 },
  ],
  'metric3d-normal': [
    { type: 'select', key: 'backbone', label: 'Backbone', options: metric3dBackboneOptions, defaultValue: 'vit-large' },
    { type: 'slider', key: 'fx', label: 'fx', min: 100, max: 2000, defaultValue: 1000 },
    { type: 'slider', key: 'fy', label: 'fy', min: 100, max: 2000, defaultValue: 1000 },
  ],
  'midas-depth': [
    { type: 'slider', key: 'a', label: 'a', min: 0, max: 24, step: 0.1, defaultValue: 6.28 },
    { type: 'slider', key: 'backgroundThreshold', label: 'Background Threshold', min: 0, max: 1, step: 0.01, defaultValue: 0.1 },
  ],
  'midas-normal': [
    { type: 'slider', key: 'a', label: 'a', min: 0, max: 24, step: 0.1, defaultValue: 6.28 },
    { type: 'slider', key: 'backgroundThreshold', label: 'Background Threshold', min: 0, max: 1, step: 0.01, defaultValue: 0.1 },
  ],
  mlsd: [
    { type: 'slider', key: 'scoreThreshold', label: 'Score Threshold', min: 0, max: 1, step: 0.01, defaultValue: 0.1 },
    { type: 'slider', key: 'distanceThreshold', label: 'Distance Threshold', min: 0, max: 20, step: 0.1, defaultValue: 0.1 },
  ],
  'oneformer-ade20k': [],
  'oneformer-coco': [],
  openpose: [
    { type: 'boolean', key: 'detectHand', label: 'Detect Hand', defaultValue: true },
    { type: 'boolean', key: 'detectBody', label: 'Detect Body', defaultValue: true },
    { type: 'boolean', key: 'detectFace', label: 'Detect Face', defaultValue: true },
  ],
  pidinet: [{ type: 'select', key: 'safe', label: 'Safe', options: safeModeOptions, defaultValue: 'enable' }],
  scribble: [],
  'scribble-pidinet': [{ type: 'select', key: 'safe', label: 'Safe', options: safeModeOptions, defaultValue: 'enable' }],
  'scribble-xdog': [{ type: 'slider', key: 'threshold', label: 'Threshold', min: 0, max: 64, defaultValue: 32 }],
  shuffle: [{ type: 'slider', key: 'seed', label: 'Seed', min: 0, max: 2 ** 31 - 1, defaultValue: 0 }],
  teed: [{ type: 'slider', key: 'safeSteps', label: 'Safe Steps', min: 0, max: 10, defaultValue: 2 }],
  tile: [{ type: 'slider', key: 'pyrUpIterations', label: 'Pyramid Up Iterations', min: 0, max: 5, defaultValue: 3 }],
  uniformer: [],
  'zoe-depth': [],
  'zoe-depth-anything': [
    { type: 'select', key: 'environment', label: 'Environment', options: zoeDepthEnvironmentOptions, defaultValue: 'indoor' },
  ],
};

// =============================================================================
// Image Preprocess Graph
// =============================================================================

const kindParamsSchema = z.record(z.string(), z.unknown());

export const imagePreprocessGraph = new DataGraph<Record<never, never>, GenerationCtx>()
  .node('images', () => imagesNode({ min: 1, max: 1 }), [])
  .node(
    'preprocessKind',
    () => ({
      input: z.enum(preprocessKinds).optional(),
      output: z.enum(preprocessKinds),
      defaultValue: 'canny' as PreprocessKind,
      meta: { options: preprocessKinds.map((value) => ({ label: value, value })) },
    }),
    []
  )
  .node(
    'preprocessResolution',
    () => sliderNode({ min: 64, max: 2048, step: 8, defaultValue: 512 }),
    []
  )
  .node(
    'kindParams',
    (ctx) => ({
      input: kindParamsSchema.optional(),
      output: kindParamsSchema,
      defaultValue: {} as Record<string, unknown>,
      meta: {
        specs: ctx.preprocessKind ? preprocessKindParamSpecs[ctx.preprocessKind] : [],
      },
    }),
    ['preprocessKind']
  );

/** Type helper for the image preprocess graph context */
export type ImagePreprocessGraphCtx = ReturnType<typeof imagePreprocessGraph.init>;
