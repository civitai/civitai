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
    description: 'Detects only straight lines. Great for interiors, buildings, and room layouts.',
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
// Preprocessor kind mapping (UI key → orchestrator kind)
// =============================================================================

/**
 * Maps a ControlNet preprocessor key (camelCase, drives the ControlNet model
 * selection) to the corresponding `PreprocessImageInput.kind` value
 * (kebab-case, drives the orchestrator's preprocess step).
 *
 * Returns `null` for keys that have no auto-preprocess recipe (e.g. `gray`) —
 * those keys are flagged `requiresPreprocessedImage: true` and the UI forces
 * their entries to `mode: 'preprocessed'`.
 *
 * Single source of truth — `controlnets.helper.ts` imports this for the
 * server-side step build, and the UI uses it to resolve example images.
 */
export const controlNetToPreprocessKind: Record<ControlNetPreprocessorKey, string | null> = {
  canny: 'canny',
  mlsd: 'mlsd',
  shuffle: 'shuffle',
  tile: 'tile',
  gray: null,
  depthZoe: 'zoe-depth',
  depthAnything: 'depth-anything',
  depthAnythingV2: 'depth-anything-v2',
  zoeDepthAnything: 'zoe-depth-anything',
  zoeDepth: 'zoe-depth',
  midasDepth: 'midas-depth',
  leresDepth: 'leres-depth',
  metric3dDepth: 'metric3d-depth',
  lineartRealistic: 'lineart-realistic',
  lineartStandard: 'lineart-standard',
  anyline: 'anyline',
  lineartAnime: 'lineart-anime',
  lineartManga: 'lineart-manga',
  midasNormal: 'midas-normal',
  baeNormal: 'bae-normal',
  dsineNormal: 'dsine-normal',
  metric3dNormal: 'metric3d-normal',
  openpose: 'openpose',
  dwpose: 'dwpose',
  scribble: 'scribble',
  scribbleXdog: 'scribble-xdog',
  scribblePidinet: 'scribble-pidinet',
  fakeScribble: 'fake-scribble',
  oneformerCoco: 'oneformer-coco',
  oneformerAde20k: 'oneformer-ade20k',
  uniformer: 'uniformer',
  softedgePidinet: 'pidinet',
  hed: 'hed',
  teed: 'teed',
};

// =============================================================================
// Example before/after images
// =============================================================================

/**
 * Reference images that every preprocessor was run against. Outputs live next
 * to them in `public/images/controlnets/` named `<base>-<kind>.png` (generated
 * via the /api/admin/test harness). Served from `/images/controlnets/...`.
 */
export const controlNetExampleInputs = [
  { base: 'test-image-1', label: 'Nature', src: '/images/controlnets/test-image-1.jpg' },
  { base: 'test-image-2', label: 'Portrait', src: '/images/controlnets/test-image-2.webp' },
] as const;

export type ControlNetExample = {
  /** Short label for the source image (e.g. "Portrait"). */
  label: string;
  /** Original reference image URL. */
  input: string;
  /** Preprocessed output image URL. */
  output: string;
};

/**
 * The single reference image that best demonstrates each preprocess kind, chosen
 * by reviewing the actual outputs:
 *  - `test-image-2` (Portrait): pose / face / depth / surface-normal kinds — a
 *    person shows body & facial structure and clean depth/normal gradients.
 *  - `test-image-1` (Nature, a detailed macro shot): edge / line / scribble /
 *    color / segmentation kinds — fine detail and varied regions read clearly.
 *
 * Kinds absent from this map fall back to showing both reference images.
 */
const preprocessKindPreferredInput: Record<string, 'test-image-1' | 'test-image-2'> = {
  // Nature — edges, lines, scribbles, color, tile, segmentation (rich detail)
  'animal-pose': 'test-image-1',
  anyline: 'test-image-1',
  binary: 'test-image-2',
  canny: 'test-image-1',
  color: 'test-image-1',
  'fake-scribble': 'test-image-1',
  hed: 'test-image-1',
  'lineart-standard': 'test-image-1',
  pidinet: 'test-image-1',
  'scribble-pidinet': 'test-image-1',
  'scribble-xdog': 'test-image-1',
  shuffle: 'test-image-1',
  teed: 'test-image-1',
  tile: 'test-image-1',
  uniformer: 'test-image-1',
  'oneformer-ade20k': 'test-image-1',
  // Portrait — pose, face, depth, surface normals, character line art
  'bae-normal': 'test-image-2',
  'dsine-normal': 'test-image-2',
  'metric3d-normal': 'test-image-2',
  'midas-normal': 'test-image-2',
  'depth-anything': 'test-image-2',
  'depth-anything-v2': 'test-image-2',
  'leres-depth': 'test-image-2',
  'metric3d-depth': 'test-image-2',
  'midas-depth': 'test-image-2',
  'zoe-depth': 'test-image-2',
  'zoe-depth-anything': 'test-image-2',
  densepose: 'test-image-2',
  dwpose: 'test-image-2',
  openpose: 'test-image-2',
  'mediapipe-face': 'test-image-2',
  scribble: 'test-image-2',
  'lineart-anime': 'test-image-2',
  'lineart-manga': 'test-image-2',
  'lineart-realistic': 'test-image-2',
  mlsd: 'test-image-2',
  'oneformer-coco': 'test-image-2',
};

/**
 * Preprocess kinds that have no generated example image yet — they currently
 * fail on the orchestrator, so no sample was produced. Listed explicitly so we
 * never render an `<img>` that 404s. Remove a kind here once its sample exists.
 *
 * A missing example is a strong signal that the orchestrator isn't configured
 * for that preprocessor (the workflow fails) — surfaced to moderators via
 * `getPreprocessKindsMissingExamples()` as a reminder that a fix is needed.
 */
const preprocessKindsWithoutExamples = new Set<string>([
  'depth-anything',
  'midas-depth',
  'midas-normal',
  'oneformer-ade20k',
  'oneformer-coco',
  'zoe-depth',
  'zoe-depth-anything',
]);

/**
 * Preprocess kinds with no valid example output — i.e. preprocessors that
 * currently appear to be failing on the orchestrator. Returned with their
 * display labels for the moderator-only "needs a fix" notice. Sorted by label.
 */
export function getPreprocessKindsMissingExamples(): Array<{ kind: string; label: string }> {
  return [...preprocessKindsWithoutExamples]
    .map((kind) => ({ kind, label: getPreprocessKindInfo(kind)?.label ?? kind }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Resolve the before/after example image(s) for an orchestrator preprocess kind
 * (kebab-case, e.g. `canny`, `depth-anything`). Returns the single best-fitting
 * reference for the kind (see `preprocessKindPreferredInput`), or both when the
 * kind has no preference. Returns `[]` for kinds with no generated sample. Used
 * by both the standalone Control Preprocessor workflow and (via the key mapping)
 * the ControlNets input.
 */
export function getPreprocessKindExamples(kind: string | null | undefined): ControlNetExample[] {
  if (!kind || preprocessKindsWithoutExamples.has(kind)) return [];
  const preferred = preprocessKindPreferredInput[kind];
  const inputs = preferred
    ? controlNetExampleInputs.filter((input) => input.base === preferred)
    : controlNetExampleInputs;
  return inputs.map((input) => ({
    label: input.label,
    input: input.src,
    output: `/images/controlnets/${input.base}-${kind}.png`,
  }));
}

/**
 * Label + description for preprocess kinds that have no ControlNet preprocessor
 * entry (so they aren't covered by `controlNetPreprocessors`). These only appear
 * in the standalone Control Preprocessor workflow.
 */
const extraPreprocessKindInfo: Record<string, { label: string; description: string }> = {
  'animal-pose': {
    label: 'Animal Pose',
    description: 'Detects an animal’s body keypoints (skeleton) to guide the pose of animals.',
  },
  binary: {
    label: 'Binary',
    description: 'Converts the image to a stark black-and-white mask using a brightness threshold.',
  },
  color: {
    label: 'Color',
    description: 'Extracts a blurred color/palette map to guide overall coloring without layout.',
  },
  densepose: {
    label: 'DensePose',
    description: 'Maps the human body surface (UV) for dense, full-body pose guidance.',
  },
  'mediapipe-face': {
    label: 'MediaPipe Face',
    description: 'Detects facial landmarks (mesh) to guide facial structure and expression.',
  },
};

/**
 * Map of orchestrator preprocess kind (kebab) → label + description. Built from
 * the ControlNet preprocessor metadata (inverting the kind mapping) plus the
 * extra kinds above, so every preprocess kind has a description in the workflow.
 */
const preprocessKindInfo: Record<string, { label: string; description: string }> = (() => {
  const map: Record<string, { label: string; description: string }> = {
    ...extraPreprocessKindInfo,
  };
  for (const [key, info] of Object.entries(controlNetPreprocessors)) {
    const kind = controlNetToPreprocessKind[key as ControlNetPreprocessorKey];
    if (kind && !map[kind]) map[kind] = { label: info.label, description: info.description };
  }
  return map;
})();

/** Resolve the label + description for an orchestrator preprocess kind (kebab-case). */
export function getPreprocessKindInfo(
  kind: string | null | undefined
): { label: string; description: string } | undefined {
  if (!kind) return undefined;
  return preprocessKindInfo[kind];
}

/**
 * Category for preprocess kinds that have no ControlNet preprocessor entry, so
 * they can still be grouped in the Control Preprocessor workflow's dropdown.
 */
const extraPreprocessKindCategory: Record<string, ControlNetCategory> = {
  'animal-pose': 'pose',
  densepose: 'pose',
  'mediapipe-face': 'pose',
  binary: 'edges',
  color: 'color',
};

/** Map of orchestrator preprocess kind (kebab) → category, for grouped pickers. */
const preprocessKindCategory: Record<string, ControlNetCategory> = (() => {
  const map: Record<string, ControlNetCategory> = { ...extraPreprocessKindCategory };
  for (const [key, info] of Object.entries(controlNetPreprocessors)) {
    const kind = controlNetToPreprocessKind[key as ControlNetPreprocessorKey];
    if (kind && !(kind in map)) map[kind] = info.category;
  }
  return map;
})();

/** Category display order for grouped preprocess-kind options. */
const PREPROCESS_CATEGORY_ORDER: ControlNetCategory[] = [
  'edges',
  'depth',
  'normals',
  'pose',
  'lineart',
  'scribble',
  'segmentation',
  'color',
];

export type PreprocessKindOptionGroup = {
  group: string;
  items: Array<{ value: string; label: string }>;
};

/**
 * Group a list of preprocess kinds by category into Mantine `Select` grouped
 * data (category header → kinds), ordered by `PREPROCESS_CATEGORY_ORDER` and
 * alphabetised within each group. Kinds with no known category fall into "Other".
 */
export function getGroupedPreprocessKindOptions(values: string[]): PreprocessKindOptionGroup[] {
  const byCategory = new Map<ControlNetCategory, Array<{ value: string; label: string }>>();
  const other: Array<{ value: string; label: string }> = [];
  for (const value of values) {
    const item = { value, label: preprocessKindInfo[value]?.label ?? value };
    const cat = preprocessKindCategory[value];
    if (!cat) {
      other.push(item);
      continue;
    }
    const bucket = byCategory.get(cat);
    if (bucket) bucket.push(item);
    else byCategory.set(cat, [item]);
  }
  const groups: PreprocessKindOptionGroup[] = PREPROCESS_CATEGORY_ORDER.filter((cat) =>
    byCategory.has(cat)
  ).map((cat) => ({
    group: controlNetCategories[cat].label,
    items: byCategory.get(cat)!.sort((a, b) => a.label.localeCompare(b.label)),
  }));
  if (other.length) {
    groups.push({ group: 'Other', items: other.sort((a, b) => a.label.localeCompare(b.label)) });
  }
  return groups;
}

/**
 * Resolve the before/after example images for a ControlNet preprocessor key
 * (camelCase). Returns `[]` for keys with no auto-preprocess recipe (e.g. `gray`).
 */
export function getControlNetPreprocessorExamples(
  key: ControlNetPreprocessorKey
): ControlNetExample[] {
  return getPreprocessKindExamples(controlNetToPreprocessKind[key]);
}

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

/**
 * Anima ControlNet support. Backed by 5 Anima-specific control models on the
 * orchestrator (`engine: comfy`, `ecosystem: anima`); each preprocessor below
 * maps to one of them upstream: an "any-test-like" model (canny, gray), a
 * lineart model (lineart variants + anyline), a depth model (depth/zoe/midas/
 * leres/metric3d depth), a pose model (openpose, dwpose), and a scribble model
 * (scribble variants + fakeScribble + hed + softedgePidinet).
 * Kinds with no Anima model (mlsd, tile, shuffle, teed, depthZoe, normals,
 * segmentation) are intentionally omitted.
 */
export const animaControlNetPreprocessors: ControlNetPreprocessorKey[] = [
  'canny',
  'gray',
  'lineartStandard',
  'lineartRealistic',
  'lineartAnime',
  'lineartManga',
  'anyline',
  'depthAnything',
  'depthAnythingV2',
  'zoeDepth',
  'zoeDepthAnything',
  'midasDepth',
  'leresDepth',
  'metric3dDepth',
  'openpose',
  'dwpose',
  'scribble',
  'scribbleXdog',
  'scribblePidinet',
  'fakeScribble',
  'hed',
  'softedgePidinet',
];
