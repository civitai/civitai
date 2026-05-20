/**
 * ControlNet Preprocessor Definitions
 *
 * Shared label/description/category metadata for every ControlNet preprocessor
 * supported by the orchestrator. Per-ecosystem support is declared as an array
 * of keys in each ecosystem subgraph; this file is the single source of truth
 * for what each key means to the user.
 */

export type ControlNetPreprocessorKey =
  | 'canny'
  | 'mlsd'
  | 'shuffle'
  | 'tile'
  | 'gray'
  | 'depthZoe'
  | 'depthAnything'
  | 'depthAnythingV2'
  | 'zoeDepthAnything'
  | 'zoeDepth'
  | 'midasDepth'
  | 'leresDepth'
  | 'metric3dDepth'
  | 'lineartRealistic'
  | 'lineartStandard'
  | 'anyline'
  | 'lineartAnime'
  | 'lineartManga'
  | 'midasNormal'
  | 'baeNormal'
  | 'dsineNormal'
  | 'metric3dNormal'
  | 'openpose'
  | 'dwpose'
  | 'scribble'
  | 'scribbleXdog'
  | 'scribblePidinet'
  | 'fakeScribble'
  | 'oneformerCoco'
  | 'oneformerAde20k'
  | 'uniformer'
  | 'softedgePidinet'
  | 'hed'
  | 'teed';

export type ControlNetCategory =
  | 'edges'
  | 'depth'
  | 'normals'
  | 'pose'
  | 'lineart'
  | 'scribble'
  | 'segmentation'
  | 'color';

export type ControlNetPreprocessorInfo = {
  label: string;
  description: string;
  category: ControlNetCategory;
  /** Surface this as the default pick within its category when available. */
  recommended?: boolean;
  /** True if the user must supply an already-processed image (no auto-preprocess recipe). */
  requiresPreprocessedImage?: boolean;
};

export type ControlNetCategoryInfo = {
  label: string;
  description: string;
};

export const controlNetCategories: Record<ControlNetCategory, ControlNetCategoryInfo> = {
  edges: {
    label: 'Edges & Structure',
    description:
      'Locks composition to the outlines and structural shapes of your reference image. Use when you want to preserve the exact layout while changing the style or subject.',
  },
  depth: {
    label: 'Depth',
    description:
      'Guides generation using a 3D depth map of your reference, preserving near/far relationships and overall scene geometry without forcing exact edges.',
  },
  normals: {
    label: 'Surface Normals',
    description:
      'Matches the direction surfaces face in your reference, preserving lighting and 3D form. Useful for product renders and any subject where surface shape matters.',
  },
  pose: {
    label: 'Pose',
    description:
      'Transfers a person’s body, hand, and face position from your reference. The model is free to change the subject, clothing, and scene while keeping the pose.',
  },
  lineart: {
    label: 'Line Art',
    description:
      'Extracts clean line work from your reference and uses it as a coloring-book-style guide. Best for stylized illustrations, anime, and manga.',
  },
  scribble: {
    label: 'Scribble',
    description:
      'Treats your reference as a loose sketch. The most forgiving option — the model fills in heavily, only following the broad strokes.',
  },
  segmentation: {
    label: 'Segmentation',
    description:
      'Divides your reference into labeled regions (sky, person, building, etc.) and asks the model to fill each region with matching content.',
  },
  color: {
    label: 'Color & Style',
    description:
      'Uses your reference to guide color palette or apply color to grayscale images, without copying its composition.',
  },
};

/**
 * Convenience map of just the category labels.
 * Kept for callers that only need the label — derived from `controlNetCategories`
 * so descriptions stay in sync.
 */
export const controlNetCategoryLabels: Record<ControlNetCategory, string> = Object.fromEntries(
  Object.entries(controlNetCategories).map(([key, { label }]) => [key, label])
) as Record<ControlNetCategory, string>;

export const controlNetPreprocessors: Record<
  ControlNetPreprocessorKey,
  ControlNetPreprocessorInfo
> = {
  // --- Edges & Structure ---
  canny: {
    label: 'Canny',
    description:
      'Traces hard edges. Best for preserving precise outlines, logos, and architectural lines.',
    category: 'edges',
    recommended: true,
  },
  mlsd: {
    label: 'MLSD (Straight Lines)',
    description:
      'Detects only straight lines. Great for interiors, buildings, and room layouts.',
    category: 'edges',
  },
  hed: {
    label: 'HED',
    description:
      'Soft edge detection that captures outlines and gentle gradients. More forgiving than Canny.',
    category: 'edges',
  },
  teed: {
    label: 'TEED',
    description: 'Newer soft-edge detector with finer detail and less noise than HED.',
    category: 'edges',
  },
  softedgePidinet: {
    label: 'Soft Edge (Pidinet)',
    description:
      'Smooth, painterly edge map. Use when you want loose adherence to the original shapes.',
    category: 'edges',
  },
  tile: {
    label: 'Tile',
    description:
      'Preserves the source while letting the model add detail and variation. Good for refining or restyling without changing layout.',
    category: 'edges',
  },

  // --- Depth ---
  depthAnythingV2: {
    label: 'Depth Anything V2',
    description:
      'Most accurate depth map. Captures near/far relationships so the model matches your image’s 3D layout.',
    category: 'depth',
    recommended: true,
  },
  depthAnything: {
    label: 'Depth Anything',
    description:
      'Previous generation of Depth Anything. Use only if V2 isn’t available for your base model.',
    category: 'depth',
  },
  zoeDepthAnything: {
    label: 'Zoe + Depth Anything',
    description:
      'Hybrid depth estimator combining Zoe’s metric depth with Depth Anything’s detail.',
    category: 'depth',
  },
  zoeDepth: {
    label: 'Zoe Depth',
    description:
      'Metric depth estimator. Good when relative distances matter (portraits, interiors).',
    category: 'depth',
  },
  depthZoe: {
    label: 'Depth (Zoe)',
    description: 'Classic Zoe depth output. Reliable across most scenes.',
    category: 'depth',
  },
  midasDepth: {
    label: 'Midas Depth',
    description: 'Classic depth estimator. Reliable fallback when newer options aren’t available.',
    category: 'depth',
  },
  leresDepth: {
    label: 'LeReS Depth',
    description: 'Depth model tuned for full scenes with distant backgrounds.',
    category: 'depth',
  },
  metric3dDepth: {
    label: 'Metric3D Depth',
    description: 'True-scale depth. Useful for technical or architectural work.',
    category: 'depth',
  },

  // --- Surface Normals ---
  baeNormal: {
    label: 'BAE Normal',
    description: 'Detects which way surfaces face, preserving lighting and 3D form.',
    category: 'normals',
    recommended: true,
  },
  dsineNormal: {
    label: 'DSINE Normal',
    description: 'Newer normal estimator with cleaner results on smooth surfaces.',
    category: 'normals',
  },
  midasNormal: {
    label: 'Midas Normal',
    description: 'Classic surface-normal estimator.',
    category: 'normals',
  },
  metric3dNormal: {
    label: 'Metric3D Normal',
    description: 'High-accuracy normals. Pairs well with Metric3D Depth.',
    category: 'normals',
  },

  // --- Pose ---
  dwpose: {
    label: 'DWPose',
    description:
      'Detects body, hand, and face keypoints. Best choice for matching a person’s pose.',
    category: 'pose',
    recommended: true,
  },
  openpose: {
    label: 'OpenPose',
    description: 'Older pose detector. Still solid; use if DWPose gives odd results.',
    category: 'pose',
  },

  // --- Line Art ---
  anyline: {
    label: 'Anyline',
    description:
      'High-quality line extractor that works across styles. A safe default for line art.',
    category: 'lineart',
    recommended: true,
  },
  lineartRealistic: {
    label: 'Lineart (Realistic)',
    description: 'Clean line extraction tuned for photos and realistic art.',
    category: 'lineart',
  },
  lineartStandard: {
    label: 'Lineart (Standard)',
    description: 'General-purpose line extraction.',
    category: 'lineart',
  },
  lineartAnime: {
    label: 'Lineart (Anime)',
    description: 'Optimized for anime and illustration styles.',
    category: 'lineart',
  },
  lineartManga: {
    label: 'Lineart (Manga)',
    description: 'Tuned for black-and-white manga panels.',
    category: 'lineart',
  },

  // --- Scribble ---
  scribble: {
    label: 'Scribble',
    description:
      'Turns rough sketches into detailed images. The most forgiving option — the model fills in heavily.',
    category: 'scribble',
    recommended: true,
  },
  scribbleXdog: {
    label: 'Scribble (XDoG)',
    description: 'Cleaner, more controlled scribble extraction from existing images.',
    category: 'scribble',
  },
  scribblePidinet: {
    label: 'Scribble (Pidinet)',
    description: 'Scribble derived from soft edges. Smoother result.',
    category: 'scribble',
  },
  fakeScribble: {
    label: 'Fake Scribble',
    description:
      'Generates a scribble-style guide from a finished image. Use when you have a photo but want loose stylistic adherence.',
    category: 'scribble',
  },

  // --- Segmentation ---
  oneformerCoco: {
    label: 'OneFormer (COCO)',
    description:
      'Labels regions by common object categories (person, car, dog, etc.). Best for scenes with recognizable objects.',
    category: 'segmentation',
    recommended: true,
  },
  oneformerAde20k: {
    label: 'OneFormer (ADE20K)',
    description:
      'Labels by scene categories (sky, wall, building, floor). Best for landscapes and interiors.',
    category: 'segmentation',
  },
  uniformer: {
    label: 'Uniformer',
    description: 'Older segmentation model. Use as a fallback.',
    category: 'segmentation',
  },

  // --- Color & Style ---
  gray: {
    label: 'Gray (Recolor)',
    description:
      'Recolor a grayscale image. You must supply an already-grayscale source — there is no auto-preprocess for this.',
    category: 'color',
    requiresPreprocessedImage: true,
  },
  shuffle: {
    label: 'Shuffle',
    description:
      'Transfers the color palette and style of a reference image without copying its composition.',
    category: 'color',
  },
};

export const controlNetPreprocessorKeys = Object.keys(
  controlNetPreprocessors
) as ControlNetPreprocessorKey[];

// =============================================================================
// Per-Ecosystem Support
// =============================================================================

/**
 * Preprocessor support by orchestrator ecosystem key.
 * Source of truth: the ControlNet sample doc in ClickUp 868jn34n5.
 *
 * Sub-ecosystems share their parent's list (e.g. Illustrious / NoobAI / Pony
 * all use the SDXL list; FluxKrea uses Flux1's; ZImageBase uses ZImageTurbo's).
 * The mapping happens in each ecosystem subgraph — these arrays just declare
 * what the orchestrator supports per base family.
 */
export const sd1ControlNetPreprocessors: ControlNetPreprocessorKey[] = [
  'canny',
  'mlsd',
  'shuffle',
  'tile',
  'depthZoe',
  'depthAnything',
  'depthAnythingV2',
  'zoeDepthAnything',
  'zoeDepth',
  'midasDepth',
  'leresDepth',
  'metric3dDepth',
  'lineartRealistic',
  'lineartStandard',
  'anyline',
  'lineartAnime',
  'lineartManga',
  'midasNormal',
  'baeNormal',
  'dsineNormal',
  'metric3dNormal',
  'openpose',
  'dwpose',
  'scribble',
  'scribbleXdog',
  'scribblePidinet',
  'fakeScribble',
  'oneformerCoco',
  'oneformerAde20k',
  'uniformer',
  'softedgePidinet',
  'hed',
  'teed',
];

export const sdxlControlNetPreprocessors: ControlNetPreprocessorKey[] = [
  'canny',
  'mlsd',
  'hed',
  'softedgePidinet',
  'teed',
  'depthZoe',
  'depthAnything',
  'depthAnythingV2',
  'zoeDepthAnything',
  'zoeDepth',
  'midasDepth',
  'leresDepth',
  'metric3dDepth',
  'lineartRealistic',
  'lineartStandard',
  'anyline',
  'lineartAnime',
  'lineartManga',
  'midasNormal',
  'baeNormal',
  'dsineNormal',
  'metric3dNormal',
  'openpose',
  'dwpose',
  'scribble',
  'scribbleXdog',
  'scribblePidinet',
  'fakeScribble',
  'oneformerCoco',
  'oneformerAde20k',
  'uniformer',
];

export const fluxControlNetPreprocessors: ControlNetPreprocessorKey[] = [
  'canny',
  'gray',
  'depthZoe',
  'depthAnything',
  'depthAnythingV2',
  'zoeDepthAnything',
  'zoeDepth',
  'midasDepth',
  'leresDepth',
  'metric3dDepth',
  'openpose',
  'dwpose',
  'softedgePidinet',
  'hed',
  'teed',
];

export const zImageControlNetPreprocessors: ControlNetPreprocessorKey[] = [
  'canny',
  'mlsd',
  'hed',
  'depthZoe',
  'depthAnything',
  'depthAnythingV2',
  'zoeDepthAnything',
  'zoeDepth',
  'midasDepth',
  'leresDepth',
  'metric3dDepth',
  'openpose',
  'dwpose',
];
