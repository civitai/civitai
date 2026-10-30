/**
 * A realistic `model.getById` payload (and its satellite query results) for server-rendering the
 * model page in a unit test. Shaped like a published LoRA with a long description, three versions,
 * tags, files and a full carousel, so a render of it does roughly the work a real page view does.
 *
 * Every user-visible string a test looks for is distinct from every other one, so an assertion on
 * one section can never be satisfied by another section's text.
 */
import type { ModelById } from '~/types/router';

export const MODEL_ID = 4201;
export const CREATOR_ID = 77;
export const VERSION_IDS = [9301, 9302, 9303] as const;

export const MODEL_NAME = 'Lantern Glow Portrait LoRA';
export const MODEL_DESCRIPTION_MARKER = 'lantern-description-marker';
export const VERSION_DESCRIPTION_MARKER = 'lantern-version-about-marker';
export const CREATOR_USERNAME = 'lanternsmith';
export const SHOWCASE_COLLECTION_NAME = 'Lantern showcase collection';

const paragraph = (i: number) =>
  `<p>Section ${i}: soft lantern light, rim lighting, warm bokeh and film grain. ` +
  `Use a weight between 0.6 and 0.9 and pair with a portrait checkpoint. ` +
  `<strong>Tip ${i}</strong>: describe the light source explicitly for the best results.</p>`;

const modelDescription =
  `<h2>About</h2><p>${MODEL_DESCRIPTION_MARKER}</p>` +
  Array.from({ length: 14 }, (_, i) => paragraph(i)).join('') +
  '<ul>' +
  Array.from({ length: 8 }, (_, i) => `<li>Recommended prompt fragment ${i}</li>`).join('') +
  '</ul>';

const now = new Date('2026-09-01T12:00:00Z');

const file = (versionId: number, n: number) => ({
  id: versionId * 10 + n,
  name: `lantern_glow_v${versionId}_${n}.safetensors`,
  sizeKB: 147_000 + n,
  type: 'Model',
  visibility: 'Public',
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
  pickleScanResult: 'Success',
  pickleScanMessage: null,
  virusScanResult: 'Success',
  virusScanMessage: null,
  scannedAt: now,
  hashes: [
    { type: 'AutoV2', hash: `A1B2C3D4E${n}` },
    { type: 'SHA256', hash: `A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B${n}` },
  ],
  primary: n === 0,
});

const version = (id: number, index: number) => ({
  id,
  modelId: MODEL_ID,
  name: `v${3 - index}.0`,
  description: index === 0 ? `<p>${VERSION_DESCRIPTION_MARKER}</p>${paragraph(99)}` : null,
  baseModel: 'SDXL 1.0',
  baseModelType: 'Standard',
  status: 'Published',
  availability: 'Public',
  publishedAt: now,
  createdAt: now,
  updatedAt: now,
  trainedWords: ['lanternglow', 'warm rim light'],
  steps: 4200,
  epochs: 12,
  clipSkip: 2,
  settings: { strength: 0.8 },
  trainingStatus: null,
  trainingDetails: null,
  earlyAccessDeadline: null,
  earlyAccessConfig: null,
  usageControl: 'Download',
  inaccurate: false,
  canGenerate: true,
  canDownload: true,
  requireAuth: false,
  index,
  rank: {
    downloadCountAllTime: 1200 + index,
    generationCountAllTime: 3400,
    thumbsUpCountAllTime: 410,
    thumbsDownCountAllTime: 3,
    earnedAmountAllTime: 25,
    ratingCountAllTime: 0,
    ratingAllTime: 0,
  },
  hashes: [{ type: 'AutoV2', hash: 'A1B2C3D4E0' }],
  files: [file(id, 0), file(id, 1)],
  posts: [{ id: id + 50_000 }],
  recommendedResources: [],
  linkedComponents: [],
  hiddenMetrics: null,
  meta: {},
  flags: null,
  paidAccess: null,
  licensingFee: null,
  wildcardSetId: null,
  vaeId: null,
  monetization: null,
  generationCoverage: { covered: true },
});

export const MODEL = {
  id: MODEL_ID,
  name: MODEL_NAME,
  description: modelDescription,
  type: 'LORA',
  poi: false,
  minor: false,
  sfwOnly: false,
  nsfw: false,
  nsfwLevel: 1,
  allowNoCredit: true,
  allowCommercialUse: ['Image', 'RentCivit'],
  allowDerivatives: true,
  allowDifferentLicense: true,
  status: 'Published',
  availability: 'Public',
  mode: null,
  locked: false,
  checkpointType: null,
  publishedAt: now,
  updatedAt: now,
  createdAt: now,
  deletedAt: null,
  uploadType: 'Created',
  isOfficial: false,
  hasSuggestedResources: false,
  minorFlagged: false,
  poiFlagged: false,
  licenses: [],
  reportStats: { ownershipProcessing: 0 },
  hiddenMetrics: null,
  meta: { showcaseCollectionId: 5501 },
  rank: {
    downloadCountAllTime: 3600,
    thumbsUpCountAllTime: 1230,
    thumbsDownCountAllTime: 9,
    collectedCountAllTime: 88,
    tippedAmountCountAllTime: 140,
    generationCountAllTime: 10200,
    commentCountAllTime: 12,
    ratingCountAllTime: 0,
    ratingAllTime: 0,
  },
  user: {
    id: CREATOR_ID,
    username: CREATOR_USERNAME,
    deletedAt: null,
    image: null,
    profilePicture: null,
    cosmetics: [],
  },
  tagsOnModels: [
    { tag: { id: 1, name: 'portraits', isCategory: true } },
    ...['lighting', 'warm', 'bokeh', 'film', 'rim light', 'style'].map((name, i) => ({
      tag: { id: 10 + i, name, isCategory: false },
    })),
  ],
  modelVersions: VERSION_IDS.map((id, i) => version(id, i)),
} as unknown as ModelById;

export const IMAGES = Array.from({ length: 20 }, (_, i) => ({
  id: 70_000 + i,
  url: `fixture-image-${i}`,
  name: `image ${i}`,
  type: 'image',
  width: 832,
  height: 1216,
  hash: 'U5Bwk3of00of~qof4nof00of%Mof',
  nsfwLevel: 1,
  browsingLevel: 1,
  postId: 80_000 + i,
  createdAt: now,
  publishedAt: now,
  needsReview: null,
  userId: CREATOR_ID,
  user: { id: CREATOR_ID, username: CREATOR_USERNAME, image: null, deletedAt: null, cosmetics: [] },
  stats: {
    likeCountAllTime: 10,
    laughCountAllTime: 0,
    heartCountAllTime: 4,
    cryCountAllTime: 0,
    commentCountAllTime: 1,
    collectedCountAllTime: 2,
    tippedAmountCountAllTime: 0,
    dislikeCountAllTime: 0,
    viewCountAllTime: 100,
  },
  reactions: [],
  tags: [],
  tagIds: [],
  cosmetic: null,
  modelVersionId: VERSION_IDS[0],
  hasMeta: false,
  hasPositivePrompt: false,
  onSite: false,
  remixOfId: null,
  meta: null,
  metadata: { width: 832, height: 1216 },
  availability: 'Public',
  poi: false,
  minor: false,
}));

export const CREATOR = {
  id: CREATOR_ID,
  username: CREATOR_USERNAME,
  image: null,
  deletedAt: null,
  createdAt: now,
  muted: false,
  bannedAt: null,
  publicSettings: {},
  excludeFromLeaderboards: false,
  cosmetics: [],
  links: [{ id: 1, url: 'https://example.com/lanternsmith', type: 'Social' }],
  rank: { leaderboardRank: 12, leaderboardId: 'overall', leaderboardTitle: 'Overall' },
  stats: {
    downloadCountAllTime: 45_000,
    thumbsUpCountAllTime: 9000,
    followerCountAllTime: 3100,
    reactionCountAllTime: 12_000,
    uploadCountAllTime: 60,
    generationCountAllTime: 80_000,
  },
  _count: { models: 42 },
  profilePicture: null,
};

export const SHOWCASE_COLLECTION = { id: 5501, name: SHOWCASE_COLLECTION_NAME, itemCount: 9 };
