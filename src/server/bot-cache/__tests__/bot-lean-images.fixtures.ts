/**
 * The images `bot-lean-images-parity.test.ts` renders both ways: what the page's prefetches
 * (`image.get`, `image.getGenerationData`, `hiddenPreferences.getHidden`) answer for each, and
 * which path the lean hook must take (`lean`, or the fallback reason). Shaped as those procedures
 * return their rows (`getImage`, `getImageGenerationData`); every value is distinct from every
 * other and from the page's own literals, so a renderer that copies the wrong field, or hardcodes
 * one, cannot match.
 */
import type { BotLeanFallback } from '~/server/bot-cache/bot-lean';

type Row = Record<string, unknown>;

export type Fixture = {
  label: string;
  id: number;
  /** `undefined`: `image.get` answers NOT_FOUND (deleted, hidden, or not the viewer's to see). */
  image?: Row & { id: number; nsfwLevel: number };
  generationData?: Row & { meta?: Row; resources: Row[] };
  hidden: Row;
  expect: 'lean' | BotLeanFallback;
};

const NO_HIDDEN = {
  hiddenTags: [],
  hiddenUsers: [],
  hiddenModels: [],
  hiddenImages: [],
  blockedUsers: [],
  blockedByUsers: [],
  moderatedTags: [],
};

const stats = (s: Partial<Record<string, number>> = {}) => ({
  likeCountAllTime: 0,
  laughCountAllTime: 0,
  heartCountAllTime: 0,
  cryCountAllTime: 0,
  commentCountAllTime: 0,
  collectedCountAllTime: 0,
  tippedAmountCountAllTime: 0,
  dislikeCountAllTime: 0,
  viewCountAllTime: 0,
  statsUnknown: false,
  ...s,
});

function imageRow(id: number, overrides: Row = {}) {
  return {
    id,
    name: `harbor-at-dawn-${id}.png`,
    url: `4f1c2a7e-0000-4000-8000-${String(id).padStart(12, '0')}`,
    width: 832,
    height: 1216,
    index: 0,
    hash: 'U9Fr4[~q00of00WB_3t7-;M{Rjxu',
    hideMeta: false,
    createdAt: new Date(Date.UTC(2026, 9, 14, 8, 30, 0)),
    mimeType: 'image/png',
    scannedAt: new Date(Date.UTC(2026, 9, 14, 8, 31, 0)),
    needsReview: null,
    postId: 880000 + id,
    ingestion: 'Scanned',
    blockedFor: null,
    type: 'image',
    metadata: { hash: 'U9Fr4[~q00of00WB_3t7-;M{Rjxu', width: 832, height: 1216 },
    nsfwLevel: 1,
    minor: false,
    poi: false,
    acceptableMinor: false,
    hasMeta: true,
    hasPositivePrompt: true,
    onSite: false,
    remixOfId: null,
    profilePictureId: null,
    availability: 'Public',
    publishedAt: new Date(Date.UTC(2026, 9, 14, 9, 0, 0)),
    model3dId: null,
    cosmetic: null,
    user: {
      id: 710000 + id,
      username: `tidewater_painter_${id}`,
      image: null,
      deletedAt: null,
      cosmetics: [],
      profilePicture: null,
    },
    stats: stats(),
    reactions: [],
    eventDecoration: null,
    ...overrides,
  };
}

function generationData(overrides: Row = {}) {
  return {
    type: 'image',
    onSite: false,
    process: 'txt2img',
    meta: undefined as Row | undefined,
    displayKeys: undefined,
    resources: [] as Row[],
    tools: [] as Row[],
    techniques: [] as Row[],
    external: undefined,
    canRemix: true,
    remixOfId: null,
    remixOfIds: [],
    ...overrides,
  };
}

export const FIXTURES: Fixture[] = [
  {
    label: 'a safe image with a prompt',
    id: 3101,
    image: imageRow(3101),
    generationData: generationData({
      meta: {
        prompt: 'a quiet harbor at dawn, fishing boats, low mist over the water',
        steps: 28,
        cfgScale: 6.5,
        sampler: 'Euler a',
        seed: 918273645,
      },
    }),
    hidden: NO_HIDDEN,
    expect: 'lean',
  },
  {
    label: 'resources, tools, techniques, reactions and an avatar',
    id: 3102,
    image: imageRow(3102, {
      name: 'lighthouse-storm.jpeg',
      user: {
        id: 713102,
        username: 'gale_cartographer',
        image: '9a8b7c6d-0000-4000-8000-0000000a3102',
        deletedAt: null,
        cosmetics: [],
        profilePicture: null,
      },
      stats: stats({
        likeCountAllTime: 1234,
        heartCountAllTime: 56,
        cryCountAllTime: 3,
        tippedAmountCountAllTime: 12500,
        commentCountAllTime: 9,
      }),
    }),
    generationData: generationData({
      process: 'img2img',
      meta: {
        prompt: 'a lighthouse in a winter storm, crashing waves, dramatic sky',
        negativePrompt: 'blurry, watermark, extra limbs',
        steps: 35,
        cfgScale: 4,
        sampler: 'DPM++ 2M Karras',
        seed: 5550123,
        clipSkip: 2,
      },
      resources: [
        {
          imageId: 3102,
          modelVersionId: 66001,
          strength: 0.75,
          modelId: 44001,
          modelName: 'Stormlight Detail Enhancer',
          modelType: 'LORA',
          versionId: 66001,
          versionName: 'v2.1 Gusty',
          baseModel: 'SDXL 1.0',
        },
        {
          imageId: 3102,
          modelVersionId: 66002,
          strength: undefined,
          modelId: 44002,
          modelName: 'Maritime Realism XL',
          modelType: 'Checkpoint',
          versionId: 66002,
          versionName: 'Lantern Edition',
          baseModel: 'SDXL 1.0',
        },
        {
          imageId: 3102,
          modelVersionId: 66003,
          strength: 1,
          modelId: 44003,
          modelName: 'Foam Texture Embedding',
          modelType: 'TextualInversion',
          versionId: 66003,
          versionName: 'Seaspray',
          baseModel: 'SDXL 1.0',
        },
        {
          imageId: 3102,
          modelVersionId: 66004,
          strength: undefined,
          modelId: 44004,
          modelName: 'Cold Palette VAE',
          modelType: 'VAE',
          versionId: 66004,
          versionName: 'Frost',
          baseModel: 'SDXL 1.0',
        },
      ],
      tools: [
        { id: 301, name: 'Tidal Upscaler Pro', icon: null, domain: null, priority: 2, notes: null },
        {
          id: 302,
          name: 'Brine Inpaint',
          icon: null,
          domain: null,
          priority: 1,
          notes: 'masked sky',
        },
      ],
      techniques: [{ id: 401, name: 'Outpainting', notes: 'widened the horizon by 30%' }],
    }),
    hidden: NO_HIDDEN,
    expect: 'lean',
  },
  {
    label: 'no name, no post and no generation data',
    id: 3103,
    image: imageRow(3103, { name: null, postId: null, hasMeta: false, hasPositivePrompt: false }),
    generationData: generationData(),
    hidden: NO_HIDDEN,
    expect: 'lean',
  },
  {
    label: 'PG-13 for the anonymous crawler viewer (login gate)',
    id: 3104,
    image: imageRow(3104, { nsfwLevel: 2 }),
    generationData: generationData({ meta: { prompt: 'a moody pier under a streetlamp' } }),
    hidden: NO_HIDDEN,
    expect: 'gated',
  },
  {
    label: 'R-rated on green (moved-to-red gate)',
    id: 3105,
    image: imageRow(3105, { nsfwLevel: 4 }),
    generationData: generationData({ meta: { prompt: 'a crimson tide at midnight' } }),
    hidden: NO_HIDDEN,
    expect: 'gated',
  },
  {
    label: 'deleted or hidden (image.get answers NOT_FOUND)',
    id: 3106,
    image: undefined,
    generationData: undefined,
    hidden: NO_HIDDEN,
    expect: 'not-found',
  },
  {
    label: 'a video (not drawn by the lean page)',
    id: 3107,
    image: imageRow(3107, { type: 'video', name: 'waves-loop.mp4', mimeType: 'video/mp4' }),
    generationData: generationData(),
    hidden: NO_HIDDEN,
    expect: 'unsupported',
  },
];
