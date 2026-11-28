// Generates the golden fixtures in model-getall/ (see README.md).
//
//   TZ=UTC node --import tsx apps/feed-go/testdata/golden/gen-models.mjs
//
// Everything here is SYNTHETIC: invented ids, names and hosts under example.test.
//
// What a fixture's EXPECTED answer is comes from the Node code path, never from feed-go:
//   - the pure steps are the REAL Node functions, imported from the repo through tsx: the image cap
//     and field trim and the per-viewer image filter (src/server/utils/model-getall-images.ts), the
//     .com face (src/shared/utils/model-sfw-face.ts), metric privacy
//     (src/server/utils/model-metric-privacy.ts), isGenerationEligible, toPublicApiVersionFlags,
//     isMatureRestricted, resolveBrowsingSettingsAddons, isBlockedTagName, isViewerUsername,
//     isModelWithheld, modelBrowsingLevelLimit, postgresSlugify;
//   - the orchestration that reads the database and the caches is transcribed below from
//     getModelsInfiniteHandler / getModelsFeed (src/server/controllers/model.controller.ts),
//     getModelsWithImagesAndModelVersions, getModelsRaw, holdForViewer, holdShowcaseImages,
//     getUserCollectionPermissionsByIds (collection.service.ts, the `read` it decides),
//     getShowcaseHeldLevels (src/server/services/model.service.ts), getCoverImages
//     (model-cover.service.ts), getModelPaidAccessGates, getUserMetricPrivacyDefaultsMap,
//     getValidCreatorMembershipMap, getOfficialModelIds (resource-select.service.ts, a fresh
//     fetchThroughCache entry), and the cache readers (createCachedObject and its appendFns in
//     src/server/redis/caches.ts and image.service.ts), with, for a fixture's `cold` keys, the
//     lookups of dataForModelsCache and modelTagCache and the writes their fetch makes.
// The answer is encoded with the real superjson, the cache values with the real msgpackr `pack`.
//
// The page query is an external system here, as the feed service is for the image fixtures: each
// fixture names the model ids Postgres returns for each page (`pages`), and the mirror checks that
// the cursor Node sends for each page is the one the fixture recorded. The SQL itself is pinned by
// internal/modelfeed's unit tests and run against a real Postgres by its integration tests.
process.env.TZ = 'UTC';

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDep, mark, packMarked } from './pack.mjs';
import { resetDevalueDir, writeDevalueBody } from './devalue-body.mjs';

if (new Date(0).getTimezoneOffset() !== 0)
  throw new Error('run with TZ=UTC (the Node pods run in UTC)');

const HERE = dirname(fileURLToPath(import.meta.url));
// Run from the repo root (as the README says): the Node modules are read from there. Named from the
// working directory, not as a path up from this file, because no app suite reads this generator
// (scripts/ci/assert-apps-paths-filter.mjs).
const REPO = process.cwd();
if (!existsSync(join(REPO, 'src/server/services/model.service.ts')))
  throw new Error('run from the repo root');
const superjson = (await importDep('superjson')).default;
/** Imports a repo TypeScript module (through tsx: run with `node --import tsx`). */
async function repo(path) {
  const m = await import(join(REPO, path));
  return { ...(m.default ?? {}), ...m };
}
const images = await repo('src/server/utils/model-getall-images.ts');
const face = await repo('src/shared/utils/model-sfw-face.ts');
const privacy = await repo('src/server/utils/model-metric-privacy.ts');
const { isGenerationEligible } = await repo(
  'packages/civitai-shared/src/generation-eligibility.ts'
);
const { toPublicApiVersionFlags } = await repo(
  'packages/civitai-shared/src/model-version-flags.constants.ts'
);
const { isMatureRestricted } = await repo('src/shared/constants/basemodel.constants.ts');
const levels = await repo('src/shared/constants/browsingLevel.constants.ts');
const { resolveBrowsingSettingsAddons } = await repo(
  'src/shared/constants/browsing-settings-addons.ts'
);
const { isBlockedTagName } = await repo('src/server/utils/blocked-browsing-tags.ts');
const { isViewerUsername } = await repo('src/utils/is-viewer.ts');
const dayjs = (await repo('src/shared/utils/dayjs.ts')).default;
const { isModelWithheld } = await repo('src/shared/utils/model-withhold.ts');
const { postgresSlugify } = await repo('src/utils/string-helpers.ts');
const { isMinorContentRestricted } = await repo(
  'packages/civitai-shared/src/minor-content-gate.ts'
);
// getAllModelsSchema's `ids`, `followed` and `newCreators` (src/server/schema/model.schema.ts) are
// these helpers.
const { commaDelimitedNumberArray, booleanString } = await repo('src/utils/zod-helpers.ts');
// getAllModelsSchema's `publishedFrom` / `publishedTo` (publishedDateSchema), and getModelsRaw's
// range check and bounds.
const { publishedDateSchema, publishedRangeBounds, publishedRangeError } = await repo(
  'src/shared/utils/published-range.ts'
);
const { subscriptionProductMetadataSchema } = await repo('src/server/schema/subscriptions.schema.ts');
const { constants } = await repo('src/server/common/constants.ts');

// ---------------------------------------------------------------------------------------------
// The synthetic world
// ---------------------------------------------------------------------------------------------
const NOW = new Date('2026-06-15T12:00:00.000Z');
const CACHED_AT = new Date('2026-06-15T11:55:00.000Z');
const HOST = { green: 'green.example.test', blue: 'blue.example.test', red: 'red.example.test' };
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (d, h = 10, ms = 0) => new Date(Date.UTC(2026, 5, d, h, 0, 0, ms));

const USERS = {
  1001: { id: 1001, username: 'artist_one', image: uuid(901), deletedAt: null },
  1002: { id: 1002, username: 'artist_two', image: null, deletedAt: null },
  1003: { id: 1003, username: 'viewer_three', image: null, deletedAt: null },
  1004: { id: 1004, username: 'mod_four', image: null, deletedAt: null },
};
const SESSIONS = {
  1001: { id: 1001, username: 'artist_one', isModerator: false, bannedAt: null, tier: null },
  1003: { id: 1003, username: 'viewer_three', isModerator: false, bannedAt: null, tier: null },
  1004: { id: 1004, username: 'mod_four', isModerator: true, bannedAt: null, tier: null },
};
const COSMETICS = {
  301: {
    id: 301,
    name: 'Golden Badge',
    type: 'Badge',
    data: { url: uuid(3011) },
    source: 'Trophy',
    flags: 0,
  },
  302: {
    id: 302,
    name: 'Golden Frame',
    type: 'ContentDecoration',
    data: { url: uuid(3021) },
    source: 'Purchase',
    flags: 0,
  },
};
const USER_COSMETICS = { 1001: [{ cosmeticId: 301, data: null }] };
const PROFILE_PICTURES = {
  1001: {
    id: 8901,
    name: null,
    url: uuid(8901),
    nsfwLevel: 1,
    hash: 'UPROFILE',
    userId: 1001,
    ingestion: 'Scanned',
    type: 'image',
    width: 512,
    height: 512,
    metadata: { width: 512, height: 512 },
  },
};
// The model frames (cosmeticEntityCaches.Model raw rows) and event hats.
const MODEL_FRAMES = { 5002: { cosmeticId: 302, equippedToId: 5002, userData: null } };
const MODEL_EVENTS = {
  5001: {
    id: 401,
    name: 'Golden Hat',
    type: 'ContentDecoration',
    source: 'Claim',
    data: { event: 'goldentest2026', url: uuid(4011) },
    equippedToId: 5001,
    equippedToType: 'Model',
    userId: 1001,
  },
};
const TAGS = {
  701: { id: 701, name: 'anime', nsfwLevel: 1, type: 'UserGenerated' },
  702: { id: 702, name: 'style', nsfwLevel: 1, type: 'UserGenerated' },
  703: { id: 703, name: 'blockedname', nsfwLevel: 1, type: 'UserGenerated' },
  9901: { id: 9901, name: 'person', nsfwLevel: 1, type: 'System' },
};
const BLOCKED_TAGS = [{ id: 703, name: 'BlockedName' }];
// system:browsing-setting-addons (system redis).
const ADDONS = [
  { type: 'some', nsfwLevels: [4, 8, 16], disableMinor: true, excludedTagIds: [9911] },
  { type: 'some', nsfwLevels: [1, 2, 4, 8, 16], disablePoi: true, excludedTagIds: [9901] },
];
// ADDONS plus an entry scoped to the "new & upcoming" boards (`scope: 'newCreators'`): it applies only
// to a `newCreators` request (resolveBrowsingSettingsAddons' scope). Its tag (701) is on model 5001
// only, which a request that resolved the addons with the scope leaves out.
const ADDONS_NEW_CREATORS = [
  ...ADDONS,
  { type: 'some', nsfwLevels: [1, 2, 4, 8, 16], scope: 'newCreators', excludedTagIds: [701] },
];
// packed:caches:new-creators:<boardId> (getNewCreatorUserIds' fetchThroughCache entry) for the models
// boards: each board's creators in board order. `cachedAt` is a number (Date.now()), fresh within the
// hour's ttl.
const NEW_CREATOR_BOARDS = { new_creators: [1002], 'new_creators-red': [1001, 1002] };
const NEW_CREATORS_CACHED_AT = NOW.getTime() - 10 * 60_000;

const rank = (d, t, c = 3) => ({
  downloadCount: d,
  thumbsUpCount: t,
  thumbsDownCount: 1,
  commentCount: c,
  collectedCount: 4,
  tippedAmountCount: 5,
});
const version = (id, baseModel, extra = {}) => ({
  id,
  index: 0,
  name: `v${id}`,
  earlyAccessTimeFrame: 0,
  baseModel,
  baseModelType: 'Standard',
  createdAt: day(1),
  trainingStatus: null,
  publishedAt: day(2),
  status: 'Published',
  flags: 0,
  availability: 'Public',
  nsfwLevel: 1,
  description: `<p>about ${id}</p>`,
  trainedWords: ['word'],
  vaeId: null,
  covered: true,
  coveredNext: true,
  ...extra,
});
const showcase = (id, userId, nsfwLevel, extra = {}) => ({
  id,
  userId,
  name: `img-${id}.png`,
  url: uuid(id),
  nsfwLevel,
  width: 832,
  height: 1216,
  hash: `UHASH${id}`,
  modelVersionId: extra.modelVersionId ?? 0,
  type: 'image',
  metadata: { width: 832, height: 1216 },
  availability: 'Public',
  onSite: false,
  hasMeta: true,
  remixOfId: null,
  hasPositivePrompt: true,
  poi: false,
  minor: false,
  ...extra,
});

/** A model as the page query and its caches hold it. */
function model(id, userId, opts = {}) {
  return {
    row: {
      id,
      name: opts.name ?? `Golden model ${id}`,
      sfwName: opts.sfwName ?? null,
      coverImageId: opts.coverImageId ?? null,
      sfwCoverImageId: opts.sfwCoverImageId ?? null,
      type: opts.type ?? 'Checkpoint',
      minor: opts.minor ?? false,
      sfwOnly: opts.sfwOnly ?? false,
      poi: opts.poi ?? false,
      nsfw: opts.nsfw ?? false,
      nsfwLevel: opts.nsfwLevel ?? 1,
      status: 'Published',
      createdAt: opts.createdAt ?? day(1),
      lastVersionAt: opts.lastVersionAt ?? day(10),
      publishedAt: opts.publishedAt ?? day(2),
      locked: false,
      meta: opts.meta ?? null,
      mode: opts.mode ?? null,
      availability: 'Public',
      rank: opts.rank ?? rank(10, 20),
      userId,
    },
    hotScore: opts.hotScore ?? 0,
    versions: opts.versions,
    hashes: opts.hashes ?? [`HASH${id}`],
    tagIds: opts.tagIds ?? [702],
  };
}

const MODELS = {
  5001: model(5001, 1001, {
    coverImageId: 8012,
    rank: rank(100, 90),
    hotScore: 400,
    lastVersionAt: day(12, 10, 250),
    tagIds: [701, 702, 799], // 799 is not in the tag cache any more
    versions: [version(6001, 'SDXL 1.0', { flags: 32 }), version(6002, 'Pony', { nsfwLevel: 4 })],
  }),
  5002: model(5002, 1002, {
    type: 'LORA',
    coverImageId: 8031, // on its other version
    rank: rank(80, 70),
    hotScore: 600,
    lastVersionAt: day(11, 10, 125),
    versions: [version(6003, 'Pony', { covered: false }), version(6004, 'Illustrious')],
  }),
  5003: model(5003, 1002, {
    rank: rank(60, 50),
    lastVersionAt: day(9),
    versions: [version(6005, 'SD 3.5', { nsfwLevel: 4 })], // mature-restricted on model surfaces: dropped
  }),
  5004: model(5004, 1001, {
    sfwOnly: true,
    rank: rank(40, 30),
    hotScore: 800,
    lastVersionAt: day(8),
    meta: { metricVisibility: { downloads: 'hide' } },
    versions: [version(6006, 'Pony')],
  }),
  5005: model(5005, 1002, {
    rank: rank(30, 20),
    hotScore: 700,
    lastVersionAt: day(7),
    versions: [
      version(6007, 'Pony', { availability: 'Private' }),
      version(6008, 'Pony', { flags: 2 }),
    ],
  }),
  5006: model(5006, 1001, {
    name: 'Spicy model',
    sfwName: 'Safe model',
    nsfw: true,
    nsfwLevel: 1 | 4,
    coverImageId: 8061,
    sfwCoverImageId: 8062,
    rank: rank(20, 10),
    lastVersionAt: day(6),
    versions: [version(6009, 'Ernie', { covered: false, coveredNext: true })],
  }),
  5007: model(5007, 1002, {
    rank: rank(10, 5),
    hotScore: 500,
    lastVersionAt: day(5),
    tagIds: [9901], // an addon-excluded tag: left out of every page that resolves the addon
    versions: [version(6010, 'Pony')],
  }),
  5008: model(5008, 1001, {
    mode: 'TakenDown',
    coverImageId: 8090,
    rank: rank(5, 5),
    lastVersionAt: day(4),
    versions: [version(6011, 'Pony')],
  }),
  5009: model(5009, 1002, {
    rank: rank(4, 4),
    hotScore: 900,
    lastVersionAt: day(3),
    versions: [version(6012, 'Pony')],
  }),
  5010: model(5010, 1001, {
    rank: rank(3, 3),
    lastVersionAt: day(2),
    tagIds: [], // modelTagCache's lookup finds no row: a notFound marker
    hashes: ['HASH5010A', 'HASH5010B'],
    versions: [
      version(6014, 'Pony', { index: 1, trainedWords: [], description: null, publishedAt: null }),
      version(6013, 'Pony', { index: 0, trainingStatus: 'Approved', vaeId: 6099, flags: 2 }),
    ],
  }),
  // A moderator's model with a hidden buzz count: its owner is a creator-membership candidate for
  // any other viewer (cold-creator-memberships).
  5013: model(5013, 1004, {
    rank: rank(3, 2),
    lastVersionAt: day(2),
    meta: { metricVisibility: { buzz: 'hide' } },
    versions: [version(6016, 'Pony')],
  }),
  // No version at all: dataForModelsCache's lookup has no record for it (cacheNotFound off: nothing is
  // written, and the model is left out).
  5011: model(5011, 1002, { rank: rank(2, 2), versions: [], hashes: ['HASH5011'] }),
  // The minor content rule's model (minor-mature-cover-*): its cover 8150 is a minor-flagged R image.
  5012: model(5012, 1001, {
    coverImageId: 8150,
    rank: rank(1, 1),
    lastVersionAt: day(2),
    versions: [version(6015, 'Pony')],
  }),
  // Hide Paid's models (hide-paid-*): a paid version (newest, holding the cover) and a free one; one
  // paid version only; one free version only; a paid Public version and a free Private one.
  5021: model(5021, 1001, {
    coverImageId: 8301,
    rank: rank(70, 60),
    lastVersionAt: day(13),
    versions: [version(6031, 'Pony'), version(6032, 'SDXL 1.0')],
  }),
  5022: model(5022, 1002, {
    rank: rank(65, 55),
    lastVersionAt: day(13),
    versions: [version(6033, 'Flux.1 D')],
  }),
  5023: model(5023, 1002, {
    rank: rank(60, 50),
    lastVersionAt: day(13),
    versions: [version(6034, 'Illustrious')],
  }),
  5024: model(5024, 1002, {
    rank: rank(55, 45),
    lastVersionAt: day(13),
    versions: [version(6035, 'Pony'), version(6036, 'Pony', { availability: 'Private' })],
  }),
};
// The lookup orders the versions by (modelId, index): the world lists 5010's out of that order, so a
// cold read must sort them.
const byIndex = (versions) => [...versions].sort((a, b) => a.index - b.index);
// getOfficialModelIds' cached records ({id, type}, in the order the database returned them) and the
// entry's cachedAt (Date.now() when written: a minute before the fixtures' clock, inside its 5 min ttl).
// 5002 is a LORA (not pinned), 5098 an official checkpoint on another base (the pinned page finds no
// row for it).
const OFFICIAL = [
  { id: 5004, type: 'Checkpoint' },
  { id: 5002, type: 'LORA' },
  { id: 5009, type: 'Checkpoint' },
  { id: 5098, type: 'Checkpoint' },
];
// Collections as getUserCollectionPermissionsByIds reads them: the read configuration, the owner and
// each user's contributor permissions.
const COLLECTIONS = {
  41: { id: 41, read: 'Public', userId: 1002, contributors: {} },
  42: { id: 42, read: 'Private', userId: 1001, contributors: { 1003: ['ADD'] } },
  43: { id: 43, read: 'Private', userId: 1002, contributors: { 1003: ['VIEW', 'ADD'] } },
  44: { id: 44, read: 'Unlisted', userId: 1002, contributors: {} },
};
// imagesForModelVersionsCache: each version's showcase (cache order).
const VERSION_IMAGES = {
  6001: [
    showcase(8011, 1001, 1),
    showcase(8012, 1001, 1),
    showcase(8013, 1001, 4),
    showcase(8014, 1002, 1, { poi: true }),
  ],
  6002: [showcase(8021, 1001, 4)],
  6003: [showcase(8030, 1002, 1)],
  6004: [showcase(8031, 1002, 1), showcase(8032, 1002, 2)],
  6005: [showcase(8051, 1002, 4)],
  6006: [showcase(8041, 1001, 1), showcase(8042, 1001, 4)],
  6007: [showcase(8071, 1002, 1)],
  6008: [showcase(8072, 1002, 1)],
  6009: [showcase(8061, 1001, 4), showcase(8062, 1001, 1), showcase(8063, 1001, 2)],
  6010: [showcase(8100, 1002, 1)],
  6011: [showcase(8091, 1001, 1)],
  6012: Array.from({ length: 9 }, (_, i) =>
    showcase(8120 + i, 1002, [4, 4, 4, 4, 4, 4, 1, 2, 4][i])
  ),
  6013: [showcase(8130, 1001, 1)],
  6014: [showcase(8140, 1001, 1)],
  6016: [showcase(8160, 1004, 1)],
  // Cached as the lookup wrote it before the rule: 8150 (minor-flagged, R, the model's cover) is held
  // here, and the read leaves it out for every viewer; 8151 (R) and 8152 (minor-flagged, PG-13) stay.
  6015: [
    showcase(8150, 1001, 4, { minor: true }),
    showcase(8151, 1001, 4),
    showcase(8152, 1001, 2, { minor: true }),
  ],
  6031: [showcase(8301, 1001, 1)],
  6032: [showcase(8311, 1001, 1), showcase(8312, 1001, 2)],
  6033: [showcase(8321, 1002, 1)],
  6034: [showcase(8331, 1002, 1)],
  6035: [showcase(8341, 1002, 1)],
  6036: [showcase(8351, 1002, 1)],
};
for (const [vid, list] of Object.entries(VERSION_IMAGES))
  for (const i of list) i.modelVersionId = Number(vid);
// The cover of the taken-down model sits on a version its card does not show.
VERSION_IMAGES[6099] = [showcase(8090, 1001, 1, { modelVersionId: 6099 })];
const COVER_ROWS = {
  8031: { id: 8031, userId: 1002, modelVersionId: 6004, modelId: 5002 },
  8090: { id: 8090, userId: 1001, modelVersionId: 6099, modelId: 5008 },
  8150: { id: 8150, userId: 1001, modelVersionId: 6015, modelId: 5012 },
};
const imageTags = (id) => (id === 8011 ? [9911] : id % 2 ? [501] : []);
// model:gallery-settings:<id> (raw JSON), for the held models.
const GALLERY = {
  5004: {
    hiddenTags: [],
    hiddenUsers: [],
    hiddenImages: {},
    level: 1,
    pinnedPosts: {},
    sfwHeld: true,
  },
};
const PAID = { 5001: day(30), 5005: null, 5021: day(30), 5022: null, 5024: null };
// getModelPaidAccessGates' `versionIds`: each gated model's versions behind a live gate.
const PAID_VERSIONS = { 5001: [6001], 5005: [6008], 5021: [6031], 5022: [6033], 5024: [6035] };
const PRIVACY = {
  1001: { hideModelBuzz: false, hideModelDownloads: false, hideModelGenerations: true },
};
const MEMBERS = { 1001: true };
// Each viewer's Follow rows (UserEngagement, type Follow): the creators they follow.
const FOLLOWS = { 1003: [1002], 1001: [] };
// CustomerSubscription rows queryValidCreatorMembership reads for a cold membership key (status
// already filtered, as Postgres answers the query): each with its own metadata and its product's.
// 1001: a gold membership, and a silver one whose renewal email went out (skipped). 1004: a founder
// membership, and a gold one bought with Buzz (no Creator Program validity), so not valid.
const SUBSCRIPTIONS = {
  1001: [
    { metadata: {}, product: { tier: 'gold', monthlyBuzz: '5000', badgeType: 'static' } },
    { metadata: { renewalEmailSent: true }, product: { tier: 'silver' } },
  ],
  1004: [
    { metadata: {}, product: { tier: 'founder', rewardsMultiplier: 1.5 } },
    { metadata: {}, product: { tier: 'gold', buzzPurchase: 'true' } },
  ],
};
// A product whose metadata subscriptionProductMetadataSchema rejects (no tier): Node's parse throws.
const BAD_SUBSCRIPTIONS = { 1001: [{ metadata: {}, product: { monthlyBuzz: 5000 } }] };

// ---------------------------------------------------------------------------------------------
// Caches, as Node writes them; reads are traced so each fixture carries what Node read.
// ---------------------------------------------------------------------------------------------
const K = {
  basic: 'packed:caches:basic-users',
  userCosmetics: 'packed:caches:user-cosmetics',
  cosmetics: 'packed:caches:cosmetics2',
  profile: 'packed:caches:profile-pictures:v4',
  data: 'packed:caches:data-for-model-2',
  modelTags: 'packed:caches:model-tags',
  basicTags: 'packed:caches:basic-tags',
  frames: 'packed:caches:cosmetics2:Model',
  events: 'packed:caches:cosmetics2:event:v2:Model',
  versionImages: 'packed:caches:images-for-model-version-2',
  tagIds: 'packed:caches:tag-ids-for-images',
  privacy: 'packed:caches:user-metric-privacy-defaults',
  membership: 'packed:caches:creator-membership-valid',
  official: 'packed:caches:official-models',
  newCreators: 'packed:caches:new-creators',
  session: 'session:data2',
};
const notFound = (idKey, id) => ({ [idKey]: id, notFound: true, cachedAt: CACHED_AT });
const entry = (v) => ({ ...v, cachedAt: CACHED_AT });

function worldPacked(prefix, id) {
  switch (prefix) {
    case K.basic:
      return USERS[id] ? entry(USERS[id]) : undefined;
    case K.userCosmetics:
      return USER_COSMETICS[id]
        ? entry({ userId: id, cosmetics: USER_COSMETICS[id] })
        : notFound('userId', id);
    case K.cosmetics:
      return COSMETICS[id] ? entry(COSMETICS[id]) : undefined;
    case K.profile:
      return PROFILE_PICTURES[id] ? entry(PROFILE_PICTURES[id]) : notFound('userId', id);
    case K.data: {
      const m = MODELS[id];
      if (!m) return undefined;
      // The lookup's row (versions in index order, modelId dropped), tags [] until the appendFn.
      return entry({ modelId: id, hashes: m.hashes, tags: [], versions: byIndex(m.versions) });
    }
    case K.modelTags: {
      const m = MODELS[id];
      return m && m.tagIds.length
        ? entry({ modelId: id, tagIds: m.tagIds })
        : notFound('modelId', id);
    }
    case K.basicTags:
      return TAGS[id] ? entry(TAGS[id]) : notFound('id', id);
    case K.frames:
      return MODEL_FRAMES[id] ? entry(MODEL_FRAMES[id]) : notFound('equippedToId', id);
    case K.events:
      return MODEL_EVENTS[id] ? entry(MODEL_EVENTS[id]) : notFound('equippedToId', id);
    case K.versionImages:
      return VERSION_IMAGES[id]
        ? entry({ modelVersionId: id, images: VERSION_IMAGES[id] })
        : notFound('modelVersionId', id);
    case K.tagIds:
      return entry({ imageId: id, tags: imageTags(id) });
    case K.session:
      return SESSIONS[id];
  }
  throw new Error(`unknown cache ${prefix}`);
}

class Trace {
  constructor(name, spec) {
    this.name = name;
    this.packed = new Map();
    this.raw = new Map();
    this.pages = [...(spec.pages ?? [])];
    this.pagesOut = [];
    this.dropKeys = spec.dropKeys ?? [];
    this.cold = new Set(spec.cold ?? []);
    this.coldRead = new Set();
    this.writes = new Map(); // key -> what Node's fetch writes on the cold miss ({value, ex})
    this.events = new Set(spec.events ?? []);
    this.badSubscriptions = !!spec.badSubscriptions;
    // The browsing-settings addons on the system redis (`spec.addons`, else ADDONS), and a fixture's
    // own new-creators board entries by board id (`spec.newCreatorBoards`; null: no key).
    this.addons = spec.addons ?? ADDONS;
    this.newCreatorBoards = spec.newCreatorBoards ?? {};
    this.db = {
      modelVersionRows: [],
      modelHashes: [],
      tagsOnModels: [],
      paidAccess: new Map(),
      coverImages: new Map(),
      tags: new Map(),
      usernames: new Map(),
      privacy: new Map(),
      collections: new Map(),
      userFollows: new Map(),
      followsRead: 0,
      userCosmetics: [],
      subscriptions: [],
    };
  }
}
let T;

const DAY = 24 * 60 * 60;

/** The lookupFn of a cold key's cache (createCachedObject's miss path), as the fetch writes it:
 *  dataForModelsCache (src/server/redis/caches.ts: the versions and hashes queries, then
 *  `{ modelId, hashes, tags: [], versions }` per model with a version; cacheNotFound off, so nothing for
 *  one without; EX a day) and modelTagCache (TagsOnModels rows, `{ modelId, tagIds }`, else a notFound
 *  marker; EX a day). Records the rows the queries return and the write. Returns the record, or
 *  undefined. */
function coldLookup(prefix, id) {
  const m = MODELS[id];
  switch (prefix) {
    case K.data: {
      for (const v of byIndex(m?.versions ?? []))
        T.db.modelVersionRows.push(mark({ modelId: id, ...v }));
      for (const hash of m?.hashes ?? []) T.db.modelHashes.push({ modelId: id, hash });
      if (!m?.versions.length) return undefined;
      const result = {
        modelId: id,
        hashes: [...m.hashes],
        tags: [],
        versions: structuredClone(byIndex(m.versions)),
      };
      T.writes.set(`${prefix}:${id}`, { value: { ...result, cachedAt: NOW }, ex: DAY });
      return result;
    }
    case K.userCosmetics: {
      // userCosmeticCache's lookupFn: the user's equipped cosmetics not equipped to an entity (none
      // here is a creator-made cosmetic, so none is withheld); none is a day's notFound marker.
      const equipped = USER_COSMETICS[id] ?? [];
      for (const c of equipped)
        T.db.userCosmetics.push({
          userId: id,
          cosmeticId: c.cosmeticId,
          data: c.data === null ? null : JSON.stringify(c.data),
          equippedAt: true,
          equippedToId: null,
          equippedToType: null,
        });
      if (!equipped.length) {
        T.writes.set(`${prefix}:${id}`, {
          value: { userId: id, notFound: true, cachedAt: NOW },
          ex: DAY,
        });
        return undefined;
      }
      const result = { userId: id, cosmetics: structuredClone(equipped) };
      T.writes.set(`${prefix}:${id}`, { value: { ...result, cachedAt: NOW }, ex: DAY });
      return result;
    }
    case K.modelTags: {
      for (const tagId of m?.tagIds ?? []) T.db.tagsOnModels.push({ modelId: id, tagId });
      if (!m?.tagIds.length) {
        T.writes.set(`${prefix}:${id}`, {
          value: { modelId: id, notFound: true, cachedAt: NOW },
          ex: DAY,
        });
        return undefined;
      }
      const result = { modelId: id, tagIds: [...m.tagIds] };
      T.writes.set(`${prefix}:${id}`, { value: { ...result, cachedAt: NOW }, ex: DAY });
      return result;
    }
  }
  throw new Error(`${T.name}: no cold lookup for ${prefix}`);
}

/** createCachedObject.fetch over the world: notFound markers skipped, cachedAt stripped; a cold key is
 *  looked up (coldLookup) and not held in the fixture's cache. */
function cacheFetch(prefix, ids, { appendFn } = {}) {
  const out = {};
  for (const id of [...new Set(ids)]) {
    if (T.cold.has(`${prefix}:${id}`)) {
      T.coldRead.add(`${prefix}:${id}`);
      // A later fetch (the loop's next page) reads what the first one wrote.
      const written = T.writes.get(`${prefix}:${id}`);
      if (written) {
        if (!written.value.notFound) {
          const { cachedAt: _c, ...rest } = structuredClone(written.value);
          out[id] = rest;
        }
        continue;
      }
      const result = coldLookup(prefix, id);
      if (result) out[id] = structuredClone(result);
      continue;
    }
    const v = worldPacked(prefix, id);
    if (v === undefined) throw new Error(`${T.name}: cache miss ${prefix}:${id}`);
    T.packed.set(`${prefix}:${id}`, v);
    if (v.notFound) continue;
    const { cachedAt: _c, ...rest } = structuredClone(v);
    out[id] = rest;
  }
  if (appendFn) appendFn(out);
  return out;
}

/** A packed scalar under `${prefix}:${id}` (redis.packed.mGet), or null. */
function packedScalar(prefix, id, value) {
  if (value === undefined) return null;
  T.packed.set(`${prefix}:${id}`, value);
  return value;
}

// ---------------------------------------------------------------------------------------------
// The Node mirror
// ---------------------------------------------------------------------------------------------
const {
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
  onlySelectableLevels,
  modelBrowsingLevelLimit,
} = levels;
const intersects = (a, b) => (a & b) !== 0;

/** getBlockedBrowsingTags (system-cache.ts): the cache-cluster key, read raw. */
function getBlockedBrowsingTags() {
  T.raw.set('system:blocked-browsing-tags', JSON.stringify(BLOCKED_TAGS));
  return BLOCKED_TAGS;
}

/** enforceBlockedBrowsingTagsForModels (blocked-browsing-tags.service.ts), in place. */
function enforceBlockedBrowsingTagsForModels(input, viewer) {
  const blocked = getBlockedBrowsingTags();
  const level =
    onlySelectableLevels(input.browsingLevel || publicBrowsingLevelsFlag) ||
    publicBrowsingLevelsFlag;
  const resolved = resolveBrowsingSettingsAddons(T.addons, level, {
    isModerator: viewer.isModerator,
    scope: input.newCreators ? 'newCreators' : undefined,
  });
  if (
    isBlockedTagName(
      input.tagname ?? input.tag,
      blocked.map((t) => t.name.toLowerCase())
    )
  )
    return { emptyResult: true };
  input.disablePoi = input.disablePoi || resolved.disablePoi;
  input.disableMinor = input.disableMinor || resolved.disableMinor;
  const isOwnScoped =
    !!(viewer.id && input.userId && viewer.id === input.userId) ||
    isViewerUsername(viewer, input.username);
  if (!isOwnScoped && resolved.excludedTagIds.length)
    input.excludedTagIds = [
      ...new Set([...(input.excludedTagIds ?? []), ...resolved.excludedTagIds]),
    ];
  return { emptyResult: false };
}

/** getNewCreatorUserIds({ entity: 'models', domain }) (new-creators.service.ts): the board
 *  getNewCreatorBoardId picks for the request's board color (red: `new_creators-red`; every other
 *  color, or none: `new_creators`), through fetchThroughCache; a fresh entry is served as cached. */
function getNewCreatorUserIds({ entity, domain }) {
  if (entity !== 'models') throw new Error('only the models boards are modelled');
  const boardId = domain === 'red' ? 'new_creators-red' : 'new_creators';
  const key = `${K.newCreators}:${boardId}`;
  const value =
    boardId in T.newCreatorBoards
      ? T.newCreatorBoards[boardId]
      : { data: NEW_CREATOR_BOARDS[boardId], cachedAt: NEW_CREATORS_CACHED_AT };
  if (value == null) throw new Error('a board miss is rebuilt from the database: not modelled');
  if (!(NOW.getTime() - 3600 * 1000 <= value.cachedAt))
    throw new Error('an expired board is refreshed: not modelled');
  T.packed.set(key, value);
  return [...value.data];
}

/** getRequestBoardDomainColor (server-domain.ts) over the fixture hosts: each host is its color's
 *  primary and no alias, so the host's own color. */
const boardColorOf = (host) => Object.entries(HOST).find(([, h]) => h === host)?.[0];

/** The ORDER BY fields of a sort (getModelsRaw), for the CONCAT cursor Postgres hands out. */
const SORT_FIELDS = {
  Hot: (m) => [m.hotScore, m.row.id],
  'Highest Rated': (m) => [m.row.rank.thumbsUpCount, m.row.rank.downloadCount, m.row.id],
  'Most Liked': (m) => [m.row.rank.thumbsUpCount, m.row.rank.downloadCount, m.row.id],
  'Most Downloaded': (m) => [m.row.rank.downloadCount, m.row.rank.thumbsUpCount, m.row.id],
  'Most Discussed': (m) => [m.row.rank.commentCount, m.row.rank.thumbsUpCount, m.row.id],
  'Most Collected': (m) => [m.row.rank.collectedCount, m.row.rank.thumbsUpCount, m.row.id],
  Newest: (m) => [m.row.lastVersionAt, m.row.id],
  Oldest: (m) => [m.row.lastVersionAt, m.row.id],
};
/** Postgres's text for a CONCAT argument: a timestamp(3) as `YYYY-MM-DD HH:MM:SS[.fff]` (trailing
 *  zeros trimmed), an integer as itself. */
function pgText(v) {
  if (v instanceof Date) {
    const iso = v.toISOString(); // 2026-06-12T10:00:00.250Z
    const base = iso.slice(0, 19).replace('T', ' ');
    const ms = iso.slice(20, 23).replace(/0+$/, '');
    return ms ? `${base}.${ms}` : base;
  }
  return String(v);
}

/** The values parseCursor (src/server/utils/pagination-helpers.ts, not exported) binds for a string
 *  cursor, transcribed with the real dayjs: a token with `-` that is not an integer is
 *  dayjs.utc(normalizeCursorTimestamp(token)).toDate() (the fraction padded or cut to three digits),
 *  any other parseInt(token, 10). The fixture records them so the harness checks the instant
 *  feed-go binds, not only the cursor string it was handed. */
function boundCursor(cursor) {
  if (typeof cursor !== 'string') return null;
  const normalize = (tok) =>
    tok.replace(
      /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\.(\d+)/,
      (_, head, fraction) => `${head}.${fraction.padEnd(3, '0').slice(0, 3)}`
    );
  return cursor
    .split('|')
    .map((tok) =>
      tok.includes('-') && !/^-?\d+$/.test(tok)
        ? dayjs.utc(normalize(tok)).toDate()
        : parseInt(tok, 10)
    );
}

/** The page query: the fixture's next page, checked against the cursor Node sends. With a collection
 *  the page records the values Node binds into its CollectionItem semi-join (the collection, the
 *  viewer its in-review items are kept for, the collection tag), which the harness checks feed-go
 *  binds too; likewise a non-empty `ids` (`mm."modelId" IN (…)`), a signed-in `followed`'s follow
 *  list (`mm."userId" IN (…)`, or `1 = 0` for none), the `newCreators` board (`mm."userId" IN (…)`,
 *  or `1 = 0` for an empty board) and a published range's bounds (`m."publishedAt" >= gte AND
 *  m."publishedAt" < lt`, and the `ranged` CTE over the same bounds). */
function pageQuery(
  input,
  take,
  viewerId,
  { onlyModelIds, excludeModelIds, followedUserIds, newCreatorUserIds, published } = {}
) {
  const listed = T.pages.shift();
  if (!listed) throw new Error(`${T.name}: Node asks for a page the fixture does not list`);
  const cursor = input.cursor ?? null;
  if ((listed.cursor ?? null) !== cursor)
    throw new Error(
      `${T.name}: Node sends cursor ${cursor}, the fixture recorded ${listed.cursor}`
    );
  const ids = listed.ids;
  if (ids.length > take + 1) throw new Error(`${T.name}: a page holds at most take + 1 rows`);
  const rows = ids.map((id) => {
    const m = MODELS[id];
    return {
      ...structuredClone(m.row),
      cursorId: SORT_FIELDS[input.sort](m).map(pgText).join('|'),
    };
  });
  const page = { cursor, bound: mark(boundCursor(cursor)), rows: rows.map(mark) };
  // The pin's id filters (`mm."modelId" IN (…)` / `NOT IN (…)`): the harness checks feed-go binds them.
  if (onlyModelIds?.length) page.onlyModelIds = onlyModelIds;
  if (excludeModelIds?.length) page.excludeModelIds = excludeModelIds;
  if (input.ids?.length) page.ids = input.ids;
  if (followedUserIds?.length) page.followedUserIds = followedUserIds;
  else if (followedUserIds) {
    if (rows.length) throw new Error(`${T.name}: a \`1 = 0\` page answers no row`);
    page.followedNone = true;
  }
  if (newCreatorUserIds?.length) page.newCreatorUserIds = newCreatorUserIds;
  else if (newCreatorUserIds) {
    if (rows.length) throw new Error(`${T.name}: a \`1 = 0\` page answers no row`);
    page.newCreatorsNone = true;
  }
  // getModelsRaw builds the `ranged` CTE only with both bounds (publishedRangeError refuses one end).
  if (published?.gte || published?.lt) {
    if (!published.gte || !published.lt) throw new Error(`${T.name}: one published bound`);
    page.published = mark({ gte: published.gte, lt: published.lt });
  }
  if (input.collectionId)
    page.collection = {
      collectionId: input.collectionId,
      addedById: viewerId ?? null,
      tagId: input.collectionTagId || null,
    };
  T.pagesOut.push(page);
  return rows;
}

function getModelPaidAccessGates(modelIds) {
  const out = new Map();
  for (const id of modelIds) {
    if (id in PAID) {
      if (!PAID_VERSIONS[id]) throw new Error(`model ${id}: gated with no gated versions`);
      T.db.paidAccess.set(id, { deadline: PAID[id], versionIds: PAID_VERSIONS[id] });
      out.set(id, {
        earlyAccessDeadline: PAID[id] ?? null,
        gated: true,
        versionIds: PAID_VERSIONS[id],
      });
    }
  }
  return out;
}

/** getUserCollectionPermissionsById (collection.service.ts) as getModelsRaw calls it (no
 *  isModerator), for the two flags getModelsRaw reads: `read` and `publicCollection`. */
function getUserCollectionPermissionsById({ id, userId }) {
  const collection = COLLECTIONS[id];
  T.db.collections.set(id, collection ?? null);
  const permissions = { read: false, isOwner: false, publicCollection: false };
  if (!collection) return permissions;
  if (collection.read === 'Public' || collection.read === 'Unlisted') {
    permissions.read = true;
    permissions.publicCollection = true;
  }
  if (!userId) return permissions;
  if (userId === collection.userId) {
    permissions.isOwner = true;
    permissions.read = true;
  }
  const contributorPermissions = collection.contributors[userId] ?? null;
  if (!contributorPermissions || permissions.isOwner) return permissions;
  if (contributorPermissions.includes('VIEW')) permissions.read = true;
  return permissions;
}

/** getModelsRaw (model.service.ts) for the inputs the fixtures send. */
function getModelsRaw({
  input,
  user: sessionUser,
  domain,
  include,
  eventDecorationViewer: _v,
  onlyModelIds,
  excludeModelIds,
}) {
  // Ahead of everything else: a range publishedRangeError refuses is Node's BAD_REQUEST.
  const publishedError = publishedRangeError({ from: input.publishedFrom, to: input.publishedTo });
  if (publishedError) throw new Error(`a 400 is not a served answer: ${publishedError}`);
  const enforcement = enforceBlockedBrowsingTagsForModels(input, {
    id: sessionUser?.id,
    username: sessionUser?.username,
    isModerator: sessionUser?.isModerator,
  });
  if (enforcement.emptyResult) return { items: [], isPrivate: false };
  const { take, username, user, baseModels, modelVersionIds, status, ids, followed } = input;
  const includeDetails = !!include?.includes('details');
  const tagName = input.tagname ?? input.tag;
  if (tagName)
    T.db.tags.set(
      tagName,
      Object.values(TAGS).find((t) => t.name.toLowerCase() === tagName.toLowerCase())?.id ?? null
    );
  if (username || user) {
    const name = username || user;
    const target = Object.values(USERS).find(
      (u) => u.username.toLowerCase() === name.toLowerCase()
    );
    if (!target) throw new Error('a username Node would look up on the primary is not modelled');
    T.db.usernames.set(name, target.id);
  }
  let isPrivate = false;
  // `followed && sessionUser?.id`: the viewer's Follow rows on dbRead, on every getModelsRaw call.
  let followedUserIds;
  if (followed && sessionUser?.id) {
    followedUserIds = [...(FOLLOWS[sessionUser.id] ?? [])];
    T.db.userFollows.set(sessionUser.id, followedUserIds);
    T.db.followsRead++;
    isPrivate = true;
  }
  // `newCreators`: the board of the request's board color, on every getModelsRaw call; global per
  // domain, so it does not mark the query private. An empty board is `1 = 0`.
  let newCreatorUserIds;
  if (input.newCreators) newCreatorUserIds = getNewCreatorUserIds({ entity: 'models', domain });
  const published = publishedRangeBounds({ from: input.publishedFrom, to: input.publishedTo });
  if (input.collectionId) {
    const permissions = getUserCollectionPermissionsById({
      userId: sessionUser?.id,
      id: input.collectionId,
    });
    if (!permissions.read) return { items: [], isPrivate: true };
    // getAvailableCollectionItemsFilterForUser's item filter is part of the page query (recorded by
    // pageQuery for the harness to check).
    isPrivate = !permissions.publicCollection;
  }
  const hidePrivateModels = !ids && !username && !user && !followed && !input.collectionId;
  const models = pageQuery(input, take ?? 100, sessionUser?.id, {
    onlyModelIds,
    excludeModelIds,
    followedUserIds,
    newCreatorUserIds,
    published,
  });
  const userIds = [...new Set(models.map((m) => m.userId))];
  const modelIds = models.map((m) => m.id);
  const userBasicData = cacheFetch(K.basic, userIds);
  const profilePictures = cacheFetch(K.profile, userIds);
  const userCosmetics = getCosmeticsForUsers(userIds);
  const modelData = cacheFetch(K.data, modelIds, {
    appendFn: (records) => {
      const modelTags = cacheFetch(
        K.modelTags,
        Object.values(records).map((r) => r.modelId),
        {
          appendFn: (tagRecords) => {
            const tags = cacheFetch(
              K.basicTags,
              Object.values(tagRecords).flatMap((x) => x.tagIds)
            );
            for (const r of Object.values(tagRecords))
              r.tags = r.tagIds.map((t) => tags[t]).filter(Boolean);
          },
        }
      );
      for (const r of Object.values(records)) {
        const t = modelTags[r.modelId];
        if (!t) continue;
        r.tags = t.tags.map((x) => ({ tagId: x.id, name: x.name }));
      }
    },
  });
  const cosmetics = include?.includes('cosmetics') ? getCosmeticsForEntity(modelIds) : {};
  const { hidePaid } = input;
  const paidAccessGates = getModelPaidAccessGates(modelIds);
  const eventDecorations = include?.includes('cosmetics')
    ? getEventDecorationsForModels(modelIds)
    : undefined;
  for (const model of models) {
    // Under Hide Paid the card shows only free versions, so the model-level chip would contradict it.
    const gate = hidePaid ? undefined : paidAccessGates.get(model.id);
    model.earlyAccessDeadline = gate?.earlyAccessDeadline ?? null;
    model.hasActivePaidAccess = gate?.gated ?? false;
  }
  let nextCursor;
  if (take && models.length > take) {
    nextCursor = models[models.length - 1]?.cursorId || undefined;
    models.pop();
  }
  const showSfwFace = face.showsSfwFace(input.browsingLevel);
  const items = models
    .map(({ rank: r, cursorId: _c, meta, ...rawModel }) => {
      const model = {
        ...face.resolveModelFace(rawModel, showSfwFace),
        hasSfwFace: face.hasCompleteSfwFace(rawModel),
      };
      const data = modelData[model.id.toString()];
      if (!data) return null;
      const publicVersions = data.versions.map((v) => ({
        ...v,
        flags: toPublicApiVersionFlags(v.flags),
      }));
      let modelVersions =
        showSfwFace && rawModel.sfwName != null
          ? publicVersions.map((v) => ({ ...v, description: '' }))
          : publicVersions;
      if (!sessionUser?.isModerator || !status?.length)
        modelVersions = modelVersions.filter((mv) => mv.status === 'Published');
      modelVersions = modelVersions.filter(
        (mv) =>
          !(
            (mv.nsfwLevel & nsfwBrowsingLevelsFlag) !== 0 &&
            isMatureRestricted(mv.baseModel, 'models')
          )
      );
      if (hidePrivateModels)
        modelVersions = modelVersions.filter((mv) => mv.availability === 'Public');
      if (hidePaid) {
        const gatedVersionIds = paidAccessGates.get(model.id)?.versionIds ?? [];
        modelVersions = modelVersions.filter((mv) => !gatedVersionIds.includes(mv.id));
      }
      const allBaseModels = [...new Set(modelVersions.map((mv) => mv.baseModel))];
      if (baseModels)
        modelVersions = modelVersions.filter((mv) => baseModels.includes(mv.baseModel));
      if (modelVersionIds?.length) throw new Error('not modelled');
      if (modelVersions.length === 0) return null;
      if (!includeDetails) modelVersions = modelVersions.slice(0, 1);
      if (
        input.excludedTagIds?.length &&
        data.tags.some((t) => input.excludedTagIds.includes(t.tagId))
      )
        return null;
      return {
        ...model,
        rank: {
          [`downloadCount${input.period}`]: r.downloadCount,
          [`thumbsUpCount${input.period}`]: r.thumbsUpCount,
          [`thumbsDownCount${input.period}`]: r.thumbsDownCount,
          [`commentCount${input.period}`]: r.commentCount,
          [`collectedCount${input.period}`]: r.collectedCount,
          [`tippedAmountCount${input.period}`]: r.tippedAmountCount,
        },
        modelVersions,
        baseModels: allBaseModels,
        hashes: data.hashes,
        tagsOnModels: data.tags,
        user: {
          id: model.userId,
          username: userBasicData[model.userId]?.username ?? null,
          deletedAt: userBasicData[model.userId]?.deletedAt ?? null,
          image: userBasicData[model.userId]?.image ?? null,
          profilePicture: profilePictures?.[model.userId] ?? null,
          cosmetics: userCosmetics[model.userId] ?? [],
        },
        cosmetic: cosmetics[model.id] ?? null,
        eventDecoration: eventDecorations?.[model.id] ?? null,
        metricPrivacy: privacy.pickMetaMetricPrivacy(meta),
      };
    })
    .filter(Boolean);
  return { items, nextCursor, isPrivate };
}

/** getCosmeticsForUsers (user.service.ts). */
function getCosmeticsForUsers(userIds) {
  const userCosmetics = cacheFetch(K.userCosmetics, userIds);
  const cosmeticIds = [
    ...new Set(Object.values(userCosmetics).flatMap((x) => x.cosmetics.map((y) => y.cosmeticId))),
  ];
  const cosmetics = cacheFetch(K.cosmetics, cosmeticIds);
  return Object.fromEntries(
    Object.values(userCosmetics).map((x) => [
      x.userId,
      x.cosmetics.map((y) => ({ ...y, cosmetic: cosmetics[y.cosmeticId] })),
    ])
  );
}

/** getCosmeticsForEntity(Model): the frame cache with its appendFn, claimKey stripped. */
function getCosmeticsForEntity(ids) {
  const frames = cacheFetch(K.frames, ids, {
    appendFn: (records) => {
      const cosmetics = cacheFetch(K.cosmetics, [
        ...new Set(Object.values(records).map((r) => r.cosmeticId)),
      ]);
      for (const record of Object.values(records)) {
        const cosmetic = cosmetics[record.cosmeticId];
        if (!cosmetic) continue;
        record.id = record.cosmeticId;
        delete record.cosmeticId;
        const userData = record.userData;
        record.data = userData?.lights
          ? { ...cosmetic.data, lights: userData.lights }
          : cosmetic.data;
        if (record.userData) delete record.userData;
      }
    },
  });
  const out = {};
  for (const [id, frame] of Object.entries(frames)) {
    const { claimKey: _k, ...rest } = frame;
    out[Number(id)] = rest;
  }
  return out;
}

/** getEventDecorationsForEntity(Model) for the events every viewer sees (decorationsForEvents). */
function getEventDecorationsForModels(ids) {
  if (!ids.length || !T.events.size) return {};
  const decorations = cacheFetch(K.events, ids);
  const visible = {};
  for (const [id, d] of Object.entries(decorations)) {
    if (d.data && typeof d.data.event === 'string' && T.events.has(d.data.event)) {
      const { name, type, source, data, equippedToId, equippedToType } = d;
      visible[Number(id)] = { id: d.id, name, type, source, data, equippedToId, equippedToType };
    }
  }
  return visible;
}

/** isMinorMatureImage (src/server/common/image-visibility.ts), over the real isMinorContentRestricted. */
const isMinorMatureImage = (image) =>
  isMinorContentRestricted({ minor: image.minor === true, nsfwLevel: image.nsfwLevel });

/** getImagesForModelVersionCache: the version cache with its appendFn (the images the minor content
 *  rule restricts dropped, then the image tag ids). */
function getImagesForModelVersionCache(versionIds) {
  return cacheFetch(K.versionImages, versionIds, {
    appendFn: (records) => {
      for (const r of Object.values(records)) r.images = r.images.filter((i) => !isMinorMatureImage(i));
      const tagIds = cacheFetch(
        K.tagIds,
        Object.values(records).flatMap((r) => r.images.map((i) => i.id))
      );
      for (const r of Object.values(records))
        for (const image of r.images) image.tags = tagIds?.[image.id]?.tags ?? [];
    },
  });
}

/** getShowcaseHeldLevels for models whose flags were read with the row. */
function getShowcaseHeldLevels(models) {
  const levelsOf = new Map();
  for (const m of models) {
    if (!m.minor && !m.sfwOnly) continue;
    const gallery = GALLERY[m.modelId];
    T.raw.set(`model:gallery-settings:${m.modelId}`, JSON.stringify(gallery ?? { none: true }));
    if (gallery?.sfwHeld) levelsOf.set(m.modelId, gallery.level);
    else levelsOf.set(m.modelId, modelBrowsingLevelLimit({ minor: m.minor, sfwOnly: m.sfwOnly }));
  }
  return levelsOf;
}

/** holdForViewer (model.service.ts) over holdShowcaseImages (no viewer passed down). */
function holdForViewer(byVersion, models, viewer) {
  const modelOf = new Map(
    models.flatMap((m) =>
      m.modelVersions.map((v) => [v.id, { modelId: m.id, minor: m.minor, sfwOnly: m.sfwOnly }])
    )
  );
  const levelsOf = getShowcaseHeldLevels([...modelOf.values()]);
  const held = {};
  for (const [key, e] of Object.entries(byVersion)) {
    const m = modelOf.get(Number(key));
    const level = !m ? 0 : levelsOf.get(m.modelId);
    held[key] =
      level === undefined
        ? e
        : { ...e, images: e.images.filter((i) => intersects(level, i.nsfwLevel)) };
  }
  if (!viewer) return held;
  for (const model of models)
    if (model.user.id === viewer.id)
      for (const v of model.modelVersions) if (byVersion[v.id]) held[v.id] = byVersion[v.id];
  return held;
}

function holdCovers(covers, models, viewer) {
  const byVersion = {};
  for (const model of models) {
    const cover = covers.get(model.id);
    const shown = model.modelVersions[0]?.id;
    if (cover && shown) byVersion[shown] = { images: [cover] };
  }
  const held = holdForViewer(byVersion, models, viewer);
  const result = new Map();
  for (const model of models) {
    const cover = held[model.modelVersions[0]?.id]?.images[0];
    if (cover) result.set(model.id, cover);
  }
  return result;
}

/** getCoverImages (model-cover.service.ts). */
function getCoverImages({ covers, modelVersionImages, sameVersionOnly }) {
  const found = new Map();
  const wanted = covers.filter((c) => c.coverId != null);
  if (!wanted.length) return found;
  const pending = [];
  for (const cover of wanted) {
    const shown = cover.shownVersionId ? modelVersionImages[cover.shownVersionId]?.images : [];
    const image = shown?.find((c) => c.id === cover.coverId);
    if (image) found.set(cover.modelId, image);
    else pending.push(cover);
  }
  if (!pending.length || sameVersionOnly) return found;
  const located = pending.flatMap((cover) => {
    const row = COVER_ROWS[cover.coverId];
    T.db.coverImages.set(cover.coverId, row ?? null);
    const owned = row?.modelId === cover.modelId && row.userId === cover.ownerId;
    return owned && row.modelVersionId ? [{ ...cover, versionId: row.modelVersionId }] : [];
  });
  if (!located.length) return found;
  const byVersion = getImagesForModelVersionCache([...new Set(located.map((c) => c.versionId))]);
  for (const cover of located) {
    const image = byVersion[cover.versionId]?.images.find((c) => c.id === cover.coverId);
    if (image) found.set(cover.modelId, image);
  }
  return found;
}

function getUserMetricPrivacyDefaultsMap(userIds) {
  const result = new Map();
  for (const id of [...new Set(userIds)]) {
    const v = PRIVACY[id] ?? {
      hideModelBuzz: false,
      hideModelDownloads: false,
      hideModelGenerations: false,
    };
    packedScalar(K.privacy, id, v);
    result.set(id, v);
  }
  return result;
}

/** queryValidCreatorMembership (creator-membership.service.ts) over the fixture's subscriptions, with
 *  the real subscriptionProductMetadataSchema and tierOrder, TIER_METADATA_KEY at its default. */
function queryValidCreatorMembership(userIds) {
  const result = new Map();
  const tierOrder = constants.memberships.tierOrder;
  const highestTierByUser = new Map();
  for (const id of userIds)
    for (const sub of (T.badSubscriptions ? BAD_SUBSCRIPTIONS : SUBSCRIPTIONS)[id] ?? []) {
      T.db.subscriptions.push({
        userId: id,
        metadata: JSON.stringify(sub.metadata),
        productMetadata: JSON.stringify(sub.product),
      });
      const subMeta = sub.metadata ?? {};
      if (subMeta.renewalEmailSent) continue;
      const productMeta = subscriptionProductMetadataSchema.parse(sub.product);
      if (productMeta.buzzPurchase) continue;
      const tier = productMeta?.tier ?? 'free';
      const prev = highestTierByUser.get(id);
      if (prev === undefined || tierOrder.indexOf(tier) > tierOrder.indexOf(prev))
        highestTierByUser.set(id, tier);
    }
  for (const id of userIds) {
    const tier = highestTierByUser.get(id);
    result.set(id, !!tier && tier !== 'free' && tier !== 'founder');
  }
  return result;
}

/** getValidCreatorMembershipMap: the cached booleans; a cold key is a miss, computed with the origin
 *  and written back (a plain SET for MEMBERSHIP_CACHE_TTL, 10 minutes). */
function getValidCreatorMembershipMap(userIds) {
  const result = new Map();
  const misses = [];
  for (const id of [...new Set(userIds)]) {
    const key = `${K.membership}:${id}`;
    if (T.cold.has(key)) {
      T.coldRead.add(key);
      const written = T.writes.get(key);
      if (written) result.set(id, written.value);
      else misses.push(id);
      continue;
    }
    result.set(id, packedScalar(K.membership, id, MEMBERS[id] ?? false));
  }
  if (misses.length) {
    const fresh = queryValidCreatorMembership(misses);
    for (const id of misses) {
      const value = fresh.get(id) ?? false;
      result.set(id, value);
      T.writes.set(`${K.membership}:${id}`, { value, ex: 600 });
    }
  }
  return result;
}

/** getModelsWithImagesAndModelVersions (model.service.ts). */
function getModelsWithImagesAndModelVersions({
  input,
  user,
  domain,
  imagesPerModel,
  biasImageSlice,
  metricPrivacyEnabled,
  heldViewer,
  coverage,
  onlyModelIds,
  excludeModelIds,
}) {
  input.limit = input.limit ?? 100;
  const rawInput = { ...input, take: input.limit };
  const { items, isPrivate, nextCursor } = getModelsRaw({
    input: rawInput,
    user,
    domain,
    include: ['cosmetics'],
    onlyModelIds,
    excludeModelIds,
  });
  const modelVersionIds = items
    .filter((m) => !isModelWithheld(m))
    .flatMap((m) => m.modelVersions)
    .map((m) => m.id);
  const holdExempt = heldViewer ? user : undefined;
  let modelVersionImages = {};
  const { excludedTagIds } = rawInput;
  if (modelVersionIds.length) {
    if (input.pending) throw new Error('not modelled');
    modelVersionImages = getImagesForModelVersionCache(modelVersionIds);
    if (!holdExempt?.isModerator)
      modelVersionImages = holdForViewer(modelVersionImages, items, holdExempt);
  }
  const showSfwFace = face.showsSfwFace(input.browsingLevel);
  const unheldCovers = getCoverImages({
    covers: items.map((m) => ({
      modelId: m.id,
      ownerId: m.user.id,
      shownVersionId: m.modelVersions[0]?.id,
      coverId: face.pickCoverImageId(m, showSfwFace),
    })),
    modelVersionImages,
    sameVersionOnly: !!input.baseModels?.length || !!input.hidePaid,
  });
  const coverImages = holdExempt?.isModerator
    ? unheldCovers
    : holdCovers(unheldCovers, items, holdExempt);
  const isMod = !!user?.isModerator;
  let feedOwnerSettingsMap = new Map();
  let feedMembershipMap = new Map();
  if (metricPrivacyEnabled) {
    feedOwnerSettingsMap = getUserMetricPrivacyDefaultsMap(items.map((m) => m.user.id));
    const candidates = new Set();
    for (const it of items) {
      const ownerId = it.user.id;
      if (isMod || ownerId === user?.id) continue;
      const defHidden = privacy.getUserMetricPrivacyDefaults(feedOwnerSettingsMap.get(ownerId));
      if (
        privacy.anyMetricHidden(privacy.getMetaMetricPrivacy(it.metricPrivacy)) ||
        privacy.anyMetricHidden(defHidden)
      )
        candidates.add(ownerId);
    }
    feedMembershipMap = getValidCreatorMembershipMap([...candidates]);
  }
  const next = coverage.next;
  if (coverage.next && !coverage.member) throw new Error('readiness not modelled');
  return {
    nextCursor,
    isPrivate,
    items: items
      .map(({ hashes, modelVersions, rank: r, tagsOnModels, metricPrivacy, ...model }) => {
        const [version] = modelVersions;
        if (!version) return null;
        const faceImages = face.imagesForFace(
          face.hoistCoverImage(
            modelVersionImages[version.id]?.images ?? [],
            coverImages.get(model.id)
          ),
          model,
          showSfwFace
        );
        const versionImages = images.filterImagesForViewer(faceImages, {
          browsingLevel: input.browsingLevel || publicBrowsingLevelsFlag,
          modelNsfw: model.nsfw,
          disablePoi: rawInput.disablePoi,
          disableMinor: rawInput.disableMinor,
          viewer: user,
        });
        const filteredImages =
          excludedTagIds && model.user.id !== user?.id
            ? versionImages.filter(
                (x) => x.tags && x.tags.every((id) => !excludedTagIds.includes(id))
              )
            : versionImages;
        const showImageless =
          (user?.isModerator || model.user.id === user?.id) && (input.user || input.username);
        if (!filteredImages.length && !showImageless) return null;
        // feedVersionCanGenerate with the audience (every viewer a member here): coveragePairWithReadiness.
        const canGenerate = isGenerationEligible({
          covered: (next ? version.coveredNext : version.covered) ?? false,
          coveredLive: version.covered ?? false,
          baseModel: version.baseModel ?? '',
          modelType: model.type,
          flags: version.flags ?? 0,
        });
        const isOwner = isMod || model.user.id === user?.id;
        const modelHidden = privacy.gateHiddenMetrics(metricPrivacyEnabled, () =>
          privacy.resolveModelHiddenMetrics({
            modelMeta: metricPrivacy,
            userSettings: feedOwnerSettingsMap.get(model.user.id),
            isOwnerOrModerator: isOwner,
            hasValidMembership: feedMembershipMap.get(model.user.id) ?? false,
          })
        );
        return {
          ...model,
          tags: tagsOnModels.map((x) => x.tagId),
          hashes: hashes.map((h) => h.toLowerCase()),
          hiddenMetrics: modelHidden,
          rank: {
            downloadCount: modelHidden.downloads ? null : r?.[`downloadCount${input.period}`] ?? 0,
            thumbsUpCount: r?.[`thumbsUpCount${input.period}`] ?? 0,
            thumbsDownCount: r?.[`thumbsDownCount${input.period}`] ?? 0,
            commentCount: r?.[`commentCount${input.period}`] ?? 0,
            collectedCount: r?.[`collectedCount${input.period}`] ?? 0,
            tippedAmountCount: modelHidden.buzz
              ? null
              : r?.[`tippedAmountCount${input.period}`] ?? 0,
          },
          version,
          images: images.buildGetAllModelImages(filteredImages, imagesPerModel, biasImageSlice),
          canGenerate,
        };
      })
      .filter(Boolean),
  };
}

/** getOfficialModelIds (resource-select.service.ts): fetchThroughCache over the one entry, read
 *  fresh (cachedAt within its 5 min ttl), its data. */
function getOfficialModelIds() {
  const value = { data: OFFICIAL, cachedAt: NOW.getTime() - 60 * 1000 };
  if (NOW.getTime() - 300 * 1000 > value.cachedAt)
    throw new Error('the official entry is expired: not modelled');
  T.packed.set(K.official, value);
  // The rows its fetchFn would read (the same world): the harness answers a copy whose entry was
  // emptied from them.
  T.db.officialModels = OFFICIAL;
  return structuredClone(value.data);
}

/** getModelsFeed (model.controller.ts) after resolveRequestBrowsingLevels. */
function getModelsFeed(input, ctx) {
  let loopCount = 0;
  let nextCursor;
  const slim = ctx.features.getAllModelImagesSlim;
  const queryOptions = {
    user: ctx.user,
    heldViewer: true, // a session (or signed out)
    domain: ctx.domain, // getRequestBoardDomainColor
    imagesPerModel: slim ? images.GET_ALL_IMAGES_PER_MODEL_SLIM : images.GET_ALL_IMAGES_PER_MODEL,
    biasImageSlice: slim,
    metricPrivacyEnabled: true,
    coverage: { next: ctx.features.coverageNext, member: true },
  };
  // Hot with a base-model filter leads with the official checkpoints, dropped from every page.
  const pinnedIds =
    input.sort === 'Hot' && input.baseModels?.length && !input.query
      ? (getOfficialModelIds() ?? []).filter((m) => m.type === 'Checkpoint').map((m) => m.id)
      : [];
  const pinned =
    pinnedIds.length && !input.cursor
      ? getModelsWithImagesAndModelVersions({
          ...queryOptions,
          input: { ...input, limit: pinnedIds.length },
          onlyModelIds: pinnedIds,
        })
      : undefined;
  const results = [];
  while (results.length < (input.limit ?? 100) && loopCount < 3) {
    const result = getModelsWithImagesAndModelVersions({
      ...queryOptions,
      input,
      excludeModelIds: pinnedIds,
    });
    results.push(...result.items);
    if (!result.nextCursor) break;
    input.cursor = result.nextCursor;
    nextCursor = result.nextCursor;
    loopCount++;
  }
  return { items: [...(pinned?.items ?? []), ...results], nextCursor };
}

/** The tRPC request: applyDomainFeature + resolveRequestBrowsingLevels on the parsed input. */
function runModels(spec) {
  const session = spec.viewer ? SESSIONS[spec.viewer] : null;
  if (session) T.packed.set(`${K.session}:${session.id}`, session);
  const user = session && !session.bannedAt ? { ...session } : undefined;
  const color = Object.entries(HOST).find(([, h]) => h === spec.host)?.[0] ?? 'blue';
  const canViewNsfw = color === 'blue' || color === 'red';
  const cap = !user ? publicBrowsingLevelsFlag : !canViewNsfw ? sfwBrowsingLevelsFlag : undefined;
  const raw = structuredClone(spec.input);
  if (user && raw.browsingLevel === undefined) throw new Error('the saved level is not modelled');
  if (cap !== undefined) raw.browsingLevel = (raw.browsingLevel ?? 0) & cap || cap;
  const input = {
    sort: 'Highest Rated',
    period: 'AllTime',
    periodMode: 'published',
    favorites: false,
    hidden: false,
    ...raw,
  };
  if (input.username !== undefined) input.username = postgresSlugify(input.username);
  // The schema's own transforms of `ids`, `followed` and `hidePaid` (commaDelimitedNumberArray,
  // booleanString).
  if ('ids' in raw) input.ids = commaDelimitedNumberArray().optional().parse(raw.ids);
  if ('followed' in raw) input.followed = booleanString().optional().parse(raw.followed);
  if ('hidePaid' in raw) input.hidePaid = booleanString().optional().parse(raw.hidePaid);
  if ('newCreators' in raw) input.newCreators = booleanString().optional().parse(raw.newCreators);
  for (const key of ['publishedFrom', 'publishedTo'])
    if (key in raw) input[key] = publishedDateSchema.optional().parse(raw[key]);
  const features = {
    getAllModelImagesSlim: spec.config.modelImagesSlim,
    coverageNext: spec.config.coverageNext,
  };
  return getModelsFeed(input, { user, features, domain: boardColorOf(spec.host) });
}

// ---------------------------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------------------------
// The flag states production runs; feed-go ports no other (a mirror off is the `flag-off-state` fallback).
const CONFIG = {
  baseModelMetrics: true,
  modelImagesSlim: true,
  coverageNext: true,
  loadingOpenToAll: true,
  decorationEvents: [],
};

const SPECS = [
  {
    name: 'highest-rated-signed-out',
    description:
      'The browse page signed out (PG): a cover hoisted, a cover found on another version, a gate with an end date, a frame, the partner flag bits stripped, the lookahead cursor.',
    host: HOST.green,
    input: { sort: 'Highest Rated', limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001, 5002, 5009] }],
  },
  {
    name: 'highest-rated-page2-loop',
    description:
      'A short first page (a mature-restricted version and an addon-excluded tag leave two models out) loops to a second one with the lookahead cursor; the second has no lookahead, so the answer keeps the first page’s cursor; a gate with no end date.',
    host: HOST.green,
    input: { sort: 'Highest Rated', limit: 3, browsingLevel: 1, cursor: '90|100|5001' },
    pages: [
      { cursor: '90|100|5001', ids: [5001, 5003, 5007, 5009] },
      { cursor: '4|4|5009', ids: [5009, 5002] },
    ],
  },
  {
    name: 'newest-timestamp-cursor',
    description:
      'Newest: the cursor is a timestamp with a 3-digit fraction and an id, as Postgres writes it in CONCAT; the instant bound is the one the row holds.',
    host: HOST.blue,
    viewer: 1003,
    input: { sort: 'Newest', limit: 1, browsingLevel: 31, cursor: '2026-06-11 10:00:00.125|5002' },
    pages: [{ cursor: '2026-06-11 10:00:00.125|5002', ids: [5002, 5004] }],
  },
  {
    name: 'base-model-single-moderator',
    description:
      'One base model (the per-base-model table drives): the version filter selects the Pony version; a moderator sees held and mature images.',
    host: HOST.blue,
    viewer: 1004,
    input: { sort: 'Most Downloaded', limit: 3, browsingLevel: 31, baseModels: ['Pony'] },
    pages: [{ cursor: null, ids: [5001, 5004, 5005] }],
  },
  {
    name: 'base-models-multi-signed-in',
    description:
      'Several base models: the cover of model 5002 stays on the shown version (no lookup), the badge lists every visible base.',
    host: HOST.blue,
    viewer: 1003,
    input: {
      sort: 'Most Downloaded',
      limit: 5,
      browsingLevel: 31,
      baseModels: ['Pony', 'Illustrious'],
      types: ['LORA', 'Checkpoint'],
    },
    pages: [{ cursor: null, ids: [5002, 5004, 5005] }],
  },
  {
    name: 'creator-page-owner',
    description:
      'A creator’s own page (username, slugified): Private versions are listed, the addon exclusions are off for their own name, their held showcase is whole and their metrics are their own.',
    host: HOST.blue,
    viewer: 1001,
    input: { sort: 'Newest', limit: 4, browsingLevel: 31, username: 'Artist One' },
    pages: [{ cursor: null, ids: [5001, 5004, 5006, 5008] }],
  },
  {
    name: 'creator-page-other-viewer',
    description:
      'The same creator for another viewer: the SFW-only model is held to its gallery level, the hidden downloads of a member are null, and the taken-down model is not listed (the page query leaves it out for anyone but its owner and moderators).',
    host: HOST.blue,
    viewer: 1003,
    input: { sort: 'Newest', limit: 4, browsingLevel: 31, username: 'artist_one' },
    pages: [{ cursor: null, ids: [5001, 5004, 5006] }],
  },
  {
    name: 'sfw-face-green-signed-in',
    description:
      'A mature model with a .com face on the SFW domain: its .com name and cover, PG/PG-13 images only, a blank version description; a model-locked checkpoint answers by the live coverage column.',
    host: HOST.green,
    viewer: 1003,
    input: { sort: 'Highest Rated', limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5006, 5009] }],
  },
  {
    name: 'tag-filter',
    description:
      'A tag filter by name (case-insensitive): the tag is looked up, and an image wearing an excluded tag is dropped.',
    host: HOST.blue,
    viewer: 1003,
    input: {
      sort: 'Highest Rated',
      limit: 2,
      browsingLevel: 31,
      tagname: 'Anime',
      excludedTagIds: [9911],
    },
    pages: [{ cursor: null, ids: [5001] }],
  },
  {
    name: 'blocked-tag-empty',
    description: 'A blocked tag name is an empty page: no query is sent.',
    host: HOST.blue,
    viewer: 1003,
    input: { sort: 'Highest Rated', limit: 2, browsingLevel: 31, tag: 'blockedname' },
    pages: [],
  },
  {
    name: 'slim-images',
    description:
      'Nine showcase images: six by the coverage slice (getAllModelImagesSlim, on in production).',
    host: HOST.blue,
    viewer: 1003,
    input: { sort: 'Oldest', limit: 1, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5009] }],
  },
  {
    name: 'decoration-visible',
    description: 'An event hat every viewer sees (FEED_GO_DECORATION_EVENTS) on a model card.',
    host: HOST.blue,
    viewer: 1003,
    events: ['goldentest2026'],
    input: { sort: 'Highest Rated', limit: 1, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001] }],
  },
  {
    name: 'hot-official-pin-page1',
    description:
      'Hot with a base-model filter, first page: the official checkpoints (5004, 5009 and 5098; 5002 is a LORA) are fetched first as one page of the same query restricted to them (take 3; 5098 has no row on this base, and 5004 is held to its SFW gallery level) and lead the answer; the main page drops them and loops on its own limit, its lookahead the answer’s cursor.',
    host: HOST.blue,
    viewer: 1003,
    input: { sort: 'Hot', baseModels: ['Pony'], limit: 2, browsingLevel: 31 },
    pages: [
      { cursor: null, ids: [5009, 5004] },
      { cursor: null, ids: [5005, 5002, 5007] },
    ],
  },
  {
    name: 'hot-official-pin-page2',
    description:
      'The next page of the same feed (the cursor from page 1): no pinned page, and the main page still drops the official checkpoints; an addon-excluded model leaves one item, and no lookahead leaves no cursor.',
    host: HOST.blue,
    viewer: 1003,
    input: { sort: 'Hot', baseModels: ['Pony'], limit: 2, browsingLevel: 31, cursor: '500|5007' },
    pages: [{ cursor: '500|5007', ids: [5007, 5001] }],
  },
  {
    name: 'hot-official-pin-signed-out',
    description:
      'The pin signed out on the SFW domain, with several base models: the pinned page runs the multi-base-model query restricted to the checkpoints at the capped level; the main page has no lookahead, so no cursor.',
    host: HOST.green,
    input: { sort: 'Hot', baseModels: ['Pony', 'Illustrious'], limit: 3, browsingLevel: 31 },
    pages: [
      { cursor: null, ids: [5009, 5004] },
      { cursor: null, ids: [5005, 5002] },
    ],
  },
  {
    name: 'fallback-official-models-miss',
    description:
      'The official-models entry absent with the miss computation off (FEED_GO_COMPUTE_MISSES=false; on, it is read from the replica).',
    host: HOST.blue,
    viewer: 1003,
    config: { computeMissesOff: true },
    input: { sort: 'Hot', baseModels: ['Pony'], limit: 2, browsingLevel: 31 },
    pages: [
      { cursor: null, ids: [5009, 5004] },
      { cursor: null, ids: [5005, 5002, 5007] },
    ],
    dropKeys: [K.official],
    fallback: 'official-models-miss',
  },
  {
    name: 'cold-model-data',
    description:
      'Model data entries absent: computed with dataForModelsCache’s lookup (the versions in index order with their computed vaeId and coverage, the SHA256 hashes) and written back for a day; a model with no version is left out and nothing is written for it; the lookahead row’s entry, computed on page 1, is read again on page 2.',
    host: HOST.blue,
    viewer: 1003,
    input: { sort: 'Highest Rated', limit: 3, browsingLevel: 31 },
    pages: [
      { cursor: null, ids: [5002, 5011, 5010, 5009] },
      { cursor: '4|4|5009', ids: [5009] },
    ],
    cold: [`${K.data}:5010`, `${K.data}:5011`, `${K.data}:5009`],
  },
  {
    name: 'cold-model-tags',
    description:
      'Model tags entries absent: computed with modelTagCache’s lookup (the tag ids in row order; a model with no tag gets a day’s notFound marker and keeps its data entry’s own tags) and written back.',
    host: HOST.blue,
    viewer: 1003,
    input: { sort: 'Highest Rated', limit: 3, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001, 5010, 5009] }],
    cold: [`${K.modelTags}:5001`, `${K.modelTags}:5010`],
  },
  {
    name: 'fallback-flag-off-state',
    description:
      'A flag mirror in the state production does not run (here getAllModelImagesSlim off) is not ported.',
    host: HOST.blue,
    config: { modelImagesSlim: false },
    input: { browsingLevel: 1 },
    fallback: 'flag-off-state',
  },
  {
    name: 'fallback-query',
    description: 'A text query goes to Meilisearch: not ported.',
    host: HOST.blue,
    input: { query: 'lora', browsingLevel: 1 },
    fallback: 'input-query',
  },
  {
    name: 'collection-public-signed-out',
    description:
      'A Public collection signed out: read by anyone, only its accepted items (the page query binds no viewer), and a Private version is listed (hidePrivateModels is off with a collection).',
    host: HOST.green,
    input: { collectionId: 41, sort: 'Highest Rated', limit: 3, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001, 5002, 5005] }],
  },
  {
    name: 'collection-private-owner',
    description:
      'A Private collection read by its owner: served, the page query keeping the owner’s own in-review items.',
    host: HOST.blue,
    viewer: 1001,
    input: { collectionId: 42, sort: 'Newest', limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001, 5005] }],
  },
  {
    name: 'collection-private-other-viewer',
    description:
      'The same Private collection for a viewer who is a contributor without VIEW: no read, an empty answer with no nextCursor, and no page query.',
    host: HOST.blue,
    viewer: 1003,
    input: { collectionId: 42, sort: 'Newest', limit: 2, browsingLevel: 31 },
    pages: [],
  },
  {
    name: 'collection-private-signed-out',
    description:
      'A Private collection signed out: an empty answer, cacheable like every signed-out one.',
    host: HOST.green,
    input: { collectionId: 42, sort: 'Newest', limit: 2, browsingLevel: 31 },
    pages: [],
  },
  {
    name: 'collection-private-contributor-view',
    description:
      'A Private collection read through a contributor row with VIEW, narrowed to one collection tag.',
    host: HOST.blue,
    viewer: 1003,
    input: {
      collectionId: 43,
      collectionTagId: 77,
      sort: 'Highest Rated',
      limit: 2,
      browsingLevel: 31,
    },
    pages: [{ cursor: null, ids: [5002, 5009] }],
  },
  {
    name: 'collection-missing',
    description: 'A collection that does not exist reads for no one: an empty answer.',
    host: HOST.blue,
    viewer: 1001,
    input: { collectionId: 49, browsingLevel: 31 },
    pages: [],
  },
  {
    name: 'collection-unlisted-page2-loop',
    description:
      'An Unlisted collection from a cursor: a short first page loops to a second one from its lookahead, each page filtered by the collection.',
    host: HOST.blue,
    viewer: 1003,
    input: {
      collectionId: 44,
      sort: 'Highest Rated',
      limit: 3,
      browsingLevel: 1,
      cursor: '90|100|5001',
    },
    pages: [
      { cursor: '90|100|5001', ids: [5001, 5003, 5007, 5009] },
      { cursor: '4|4|5009', ids: [5009, 5002] },
    ],
  },
  {
    name: 'fallback-collection-recently-added',
    description: 'Recently Added orders by the collection item: not ported.',
    host: HOST.blue,
    input: { collectionId: 41, sort: 'Recently Added', browsingLevel: 1 },
    fallback: 'model-sort-recently-added',
  },
  {
    name: 'fallback-collection-fraction',
    description: 'A collection id that is not an integer: not ported.',
    host: HOST.blue,
    input: { collectionId: 41.5, browsingLevel: 1 },
    fallback: 'model-collection-id',
  },
  {
    name: 'fallback-number-cursor',
    description: 'A number cursor for a two- or three-field sort is a 400 on Node.',
    host: HOST.blue,
    input: { cursor: 5, browsingLevel: 1 },
    fallback: 'model-cursor',
  },
  {
    name: 'fallback-images-miss',
    description:
      'A version-images miss falls back with the miss computation off (FEED_GO_COMPUTE_MISSES=false; on, it is computed).',
    host: HOST.green,
    config: { computeMissesOff: true },
    input: { sort: 'Highest Rated', limit: 1, browsingLevel: 1 },
    pages: [{ cursor: null, ids: [5009] }],
    dropKeys: [`${K.versionImages}:6012`],
    fallback: 'model-images-miss',
  },
  // `ids` and `followed` (each served only behind its switch: FEED_GO_GETALL_SERVE_INPUT_IDS,
  // FEED_GO_GETALL_SERVE_INPUT_FOLLOWED; off, the input-ids / input-followed fallback).
  {
    name: 'ids-embed-signed-out',
    description:
      'An id list (the embeds’ lookup): the page is held to those ids, in the sort’s order, and a Private version is listed (any `ids` turns hidePrivateModels off).',
    host: HOST.green,
    config: { serveInputIds: true },
    input: { ids: [5005, 5001], limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001, 5005] }],
  },
  {
    name: 'ids-comma-string-showcase',
    description:
      'A profile showcase: `ids` as a comma-separated string (split and trimmed) with the creator’s name, for another signed-in viewer.',
    host: HOST.blue,
    viewer: 1003,
    config: { serveInputIds: true },
    input: { ids: '5005, 5002', username: 'artist_two', period: 'AllTime', limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5002, 5005] }],
  },
  {
    name: 'ids-empty-string',
    description: '`ids: ""` is [0]: the page is held to model 0, which no row is.',
    host: HOST.blue,
    config: { serveInputIds: true },
    input: { ids: '', limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [] }],
  },
  {
    name: 'ids-empty-list',
    description:
      'An empty list filters nothing, but is still `ids`: a Private version is listed, and the lookahead cursor is kept.',
    host: HOST.blue,
    config: { serveInputIds: true },
    input: { ids: [], limit: 1, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5005, 5009] }],
  },
  {
    name: 'fallback-ids-off',
    description: '`ids` with its switch off (the default): not served.',
    host: HOST.blue,
    input: { ids: [5001], browsingLevel: 1 },
    fallback: 'input-ids',
  },
  {
    name: 'fallback-ids-not-integer',
    description: 'An id JS Number does not read as an int4 integer: left to Node.',
    host: HOST.blue,
    config: { serveInputIds: true },
    input: { ids: ['0x10'], browsingLevel: 1 },
    fallback: 'model-ids',
  },
  {
    name: 'followed-signed-in',
    description:
      'Followed creators only, signed in: the page is held to the creators the viewer follows (read on every page), and a Private version is listed.',
    host: HOST.blue,
    viewer: 1003,
    config: { serveInputFollowed: true },
    input: { followed: true, sort: 'Newest', limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5002, 5005, 5009] }],
  },
  {
    name: 'followed-no-follows',
    description: 'Followed creators only, for a viewer who follows no one: `1 = 0`, an empty answer.',
    host: HOST.blue,
    viewer: 1001,
    config: { serveInputFollowed: true },
    input: { followed: 'true', sort: 'Newest', limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [] }],
  },
  {
    name: 'followed-signed-out',
    description:
      '`followed` signed out filters nothing (Node reads it only with a user), but still turns hidePrivateModels off.',
    host: HOST.green,
    config: { serveInputFollowed: true },
    input: { followed: true, limit: 1, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5005] }],
  },
  {
    name: 'fallback-followed-off',
    description: '`followed` with its switch off (the default): not served.',
    host: HOST.blue,
    viewer: 1003,
    input: { followed: true, browsingLevel: 1 },
    fallback: 'input-followed',
  },
  // An owner's user-cosmetics miss: computed only behind FEED_GO_GETALL_SERVE_USER_COSMETICS_MISS
  // (default off: the user-cosmetics-miss fallback).
  {
    name: 'cold-user-cosmetics',
    description:
      'User cosmetics entries absent: computed with userCosmeticCache’s lookup (the owner’s equipped badge; an owner with none gets a day’s notFound marker) and written back.',
    host: HOST.blue,
    viewer: 1003,
    config: { serveUserCosmeticsMiss: true },
    input: { sort: 'Highest Rated', limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001, 5002, 5009] }],
    cold: [`${K.userCosmetics}:1001`, `${K.userCosmetics}:1002`],
  },
  {
    name: 'fallback-user-cosmetics-miss',
    description:
      'The same user cosmetics entries absent with the switch off (the default): not served.',
    host: HOST.blue,
    viewer: 1003,
    input: { sort: 'Highest Rated', limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001, 5002, 5009] }],
    cold: [`${K.userCosmetics}:1001`, `${K.userCosmetics}:1002`],
    fallback: 'user-cosmetics-miss',
  },
  // An owner's creator-membership miss: computed only behind FEED_GO_GETALL_SERVE_MEMBERSHIP_MISS
  // (default off: the membership-miss fallback).
  {
    name: 'cold-creator-memberships',
    description:
      'Creator-membership entries absent for two owners with a hidden metric: computed with getValidCreatorMembershipMap’s origin (a gold membership, a renewal-emailed one skipped: valid; a founder one and a gold one bought with Buzz: not) and written back for 10 minutes; the valid owner’s hidden count stays hidden.',
    host: HOST.blue,
    viewer: 1003,
    config: { serveMembershipMiss: true },
    input: { sort: 'Highest Rated', limit: 3, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001, 5002, 5013, 5009] }],
    cold: [`${K.membership}:1001`, `${K.membership}:1004`],
  },
  {
    name: 'fallback-membership-miss',
    description: 'The same membership entries absent with the switch off (the default): not served.',
    host: HOST.blue,
    viewer: 1003,
    input: { sort: 'Highest Rated', limit: 3, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001, 5002, 5013, 5009] }],
    cold: [`${K.membership}:1001`, `${K.membership}:1004`],
    fallback: 'membership-miss',
  },
  {
    name: 'fallback-membership-shape',
    description:
      'A product metadata subscriptionProductMetadataSchema rejects (no tier): Node’s parse throws, so feed-go hands the request to Node.',
    host: HOST.blue,
    viewer: 1003,
    config: { serveMembershipMiss: true },
    input: { sort: 'Highest Rated', limit: 1, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001, 5002] }],
    cold: [`${K.membership}:1001`],
    badSubscriptions: true,
    nodeThrows: /tier/,
    fallback: 'membership-shape',
  },
  // The minor content rule on the shared version-showcase cache (imagesForModelVersionsCache's
  // appendFn): viewer-independent, so 8150 is left out for every viewer, its owner and moderators
  // included; the cover is then looked up on the replica, found on the same version, and left out
  // there too, so the card has no cover and shows 8151 and 8152.
  ...[
    [1001, 'owner', 'its owner'],
    [1004, 'moderator', 'a moderator'],
    [1003, 'stranger', 'another signed-in viewer (whose addons also hide every minor-flagged image)'],
  ].map(([viewer, who, what]) => ({
    name: `minor-mature-cover-${who}`,
    alsoCached: [`${K.tagIds}:8150`],
    description: `A model whose cover is a minor-flagged R image, for ${what}: the image is left out of the card and is not its cover.`,
    host: HOST.blue,
    viewer,
    input: { sort: 'Highest Rated', limit: 1, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5012] }],
  })),
  // Hide Paid (#9385's free-version rule), served only behind FEED_GO_GETALL_SERVE_HIDE_PAID; off, the
  // input-hidePaid fallback.
  {
    name: 'fallback-hide-paid-off',
    description: 'Hide Paid with its switch off: handed back to Node (input-hidePaid).',
    host: HOST.green,
    input: { sort: 'Highest Rated', limit: 10, browsingLevel: 1, hidePaid: true },
    fallback: 'input-hidePaid',
  },
  {
    name: 'hide-paid-free-version-signed-out',
    description:
      'Hide Paid signed out: a model with a paid and a free version shows the free one (its own images; the cover on the paid version is not borrowed), its base models are the free version’s, and no chip or deadline; a free model is unchanged. The page query leaves out the model with only a paid version (pinned by the integration tests).',
    host: HOST.green,
    config: { serveHidePaid: true },
    input: { sort: 'Highest Rated', limit: 10, browsingLevel: 1, hidePaid: true },
    pages: [{ cursor: null, ids: [5021, 5023] }],
  },
  {
    name: 'hide-paid-off-same-world',
    description:
      'The same models with Hide Paid off: the paid version is shown with its chip and deadline, the paid-only model is listed with its chip.',
    host: HOST.green,
    input: { sort: 'Highest Rated', limit: 10, browsingLevel: 1 },
    pages: [{ cursor: null, ids: [5021, 5022, 5023] }],
  },
  {
    name: 'hide-paid-creator-private-free-version',
    description:
      'Hide Paid on a creator’s page (Private versions are listed there): a model whose only free version is Private shows it; a model with only a paid version, if the page query returned it, has no version left and is left out.',
    host: HOST.blue,
    viewer: 1003,
    config: { serveHidePaid: true },
    input: { sort: 'Highest Rated', limit: 10, browsingLevel: 1, username: 'artist_two', hidePaid: 'true' },
    pages: [{ cursor: null, ids: [5022, 5023, 5024] }],
  },
  // `newCreators` (behind FEED_GO_GETALL_SERVE_INPUT_NEW_CREATORS): the "new & upcoming" models board of
  // the request's board color (new_creators: [1002]; new_creators-red: [1001, 1002]), and the addons
  // under the `newCreators` scope (701, on model 5001 only).
  {
    name: 'new-creators-signed-out',
    description:
      '`newCreators` signed out on the SFW host: the page is held to the SFW board’s creators (`mm."userId" IN (…)`).',
    host: HOST.green,
    addons: ADDONS_NEW_CREATORS,
    config: { serveInputNewCreators: true },
    input: { newCreators: true, sort: 'Newest', limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5002, 5009] }],
  },
  {
    name: 'new-creators-red-board',
    description:
      '`newCreators` (as a string) signed in on the red host: the red board (two creators) on every page; the scoped addon’s tag leaves 5001 out, so the loop reads a second page.',
    host: HOST.red,
    viewer: 1003,
    addons: ADDONS_NEW_CREATORS,
    config: { serveInputNewCreators: true },
    input: { newCreators: 'true', sort: 'Highest Rated', limit: 2, browsingLevel: 31 },
    pages: [
      { cursor: null, ids: [5001, 5002, 5009] },
      { cursor: '4|4|5009', ids: [5009] },
    ],
  },
  {
    name: 'new-creators-empty-board',
    description: 'An unpopulated board: `1 = 0`, an empty answer (never the unfiltered feed).',
    host: HOST.green,
    config: { serveInputNewCreators: true },
    newCreatorBoards: { new_creators: { data: [], cachedAt: NEW_CREATORS_CACHED_AT } },
    input: { newCreators: true, limit: 2, browsingLevel: 1 },
    pages: [{ cursor: null, ids: [] }],
  },
  {
    name: 'new-creators-false',
    description:
      '`newCreators: false` with the switch on: no board is read (none is held) and the scoped addon does not apply.',
    host: HOST.green,
    addons: ADDONS_NEW_CREATORS,
    config: { serveInputNewCreators: true },
    input: { newCreators: false, sort: 'Highest Rated', limit: 2, browsingLevel: 31 },
    pages: [{ cursor: null, ids: [5001, 5002, 5009] }],
  },
  {
    name: 'fallback-new-creators-off',
    description: '`newCreators` with its switch off (the default): not served.',
    host: HOST.green,
    input: { newCreators: true, browsingLevel: 1 },
    fallback: 'input-newCreators',
  },
  {
    name: 'fallback-new-creators-miss',
    description: 'No board entry: Node builds it from the database (fetchThroughCache’s fetch).',
    host: HOST.green,
    config: { serveInputNewCreators: true },
    newCreatorBoards: { new_creators: null },
    input: { newCreators: true, browsingLevel: 1 },
    fallback: 'new-creators-miss',
  },
  {
    name: 'fallback-new-creators-stale',
    description:
      'A board entry older than its hour: Node refreshes it (or serves it stale under another caller’s lock).',
    host: HOST.green,
    config: { serveInputNewCreators: true },
    newCreatorBoards: { new_creators: { data: [1002], cachedAt: NOW.getTime() - 2 * 3600_000 } },
    input: { newCreators: true, browsingLevel: 1 },
    fallback: 'new-creators-stale',
  },
  {
    name: 'fallback-new-creators-null',
    description: '`newCreators: null`: booleanString().optional() refuses it, Node’s BAD_REQUEST.',
    host: HOST.green,
    config: { serveInputNewCreators: true },
    input: { newCreators: null, browsingLevel: 1 },
    node400: () => !booleanString().optional().safeParse(null).success,
    fallback: 'input-invalid',
  },
  // `publishedFrom` / `publishedTo` (behind FEED_GO_GETALL_SERVE_INPUT_PUBLISHED_RANGE): UTC days, the
  // half-open range [from 00:00Z, to + 1 day 00:00Z), at most 31 days.
  {
    name: 'published-range-signed-out',
    description:
      'A published range of the widest span (31 days), signed out: the bounds and the `ranged` CTE in the page query, the lookahead cursor kept.',
    host: HOST.green,
    config: { servePublishedRange: true },
    input: {
      publishedFrom: '2026-05-15',
      publishedTo: '2026-06-15',
      sort: 'Newest',
      limit: 2,
      browsingLevel: 1,
    },
    pages: [{ cursor: null, ids: [5002, 5009, 5001] }],
  },
  {
    name: 'published-range-split-cursor-types',
    description:
      'One day, a type filter and a split keyset cursor: the CTE (with the type) leads the UNION ALL form.',
    host: HOST.blue,
    viewer: 1003,
    config: { servePublishedRange: true },
    input: {
      publishedFrom: '2026-06-02',
      publishedTo: '2026-06-02',
      types: ['LORA'],
      sort: 'Highest Rated',
      limit: 1,
      cursor: '70|80|5002',
      browsingLevel: 31,
    },
    pages: [{ cursor: '70|80|5002', ids: [5002] }],
  },
  {
    name: 'fallback-published-from-off',
    description: '`publishedFrom` with its switch off (the default): not served.',
    host: HOST.green,
    input: { publishedFrom: '2026-06-01', publishedTo: '2026-06-02', browsingLevel: 1 },
    fallback: 'input-publishedFrom',
  },
  {
    name: 'fallback-published-to-off',
    description: '`publishedTo` alone with its switch off: not served (`input-publishedTo`).',
    host: HOST.green,
    input: { publishedTo: '2026-06-02', browsingLevel: 1 },
    fallback: 'input-publishedTo',
  },
  ...[
    ['one-end', { publishedFrom: '2026-06-01' }, 'only one end'],
    ['reversed', { publishedFrom: '2026-06-02', publishedTo: '2026-06-01' }, 'the end before the start'],
    ['too-wide', { publishedFrom: '2026-05-14', publishedTo: '2026-06-15' }, '32 days'],
  ].map(([what, range, desc]) => ({
    name: `fallback-published-range-${what}`,
    description: `A published range getModelsRaw refuses (${desc}): Node’s BAD_REQUEST.`,
    host: HOST.green,
    config: { servePublishedRange: true },
    input: { ...range, browsingLevel: 1 },
    node400: () => !!publishedRangeError({ from: range.publishedFrom, to: range.publishedTo }),
    fallback: 'input-published-range',
  })),
  ...[
    ['not-a-day', '2026-02-30', 'a day the calendar does not have'],
    ['null', null, 'null'],
  ].map(([what, from, desc]) => ({
    name: `fallback-published-date-${what}`,
    description: `A publishedFrom publishedDateSchema refuses (${desc}): Node’s BAD_REQUEST.`,
    host: HOST.green,
    config: { servePublishedRange: true },
    input: { publishedFrom: from, publishedTo: '2026-03-01', browsingLevel: 1 },
    node400: () => !publishedDateSchema.optional().safeParse(from).success,
    fallback: 'input-invalid',
  })),
];

/** What Node writes on this fixture's cold misses, as the Go harness compares it. */
function writeEntries() {
  for (const key of T.cold)
    if (!T.coldRead.has(key)) throw new Error(`${T.name}: cold key ${key} never read`);
  const out = {};
  for (const [key, w] of [...T.writes.entries()].sort())
    out[key] = { value: mark(w.value), packed: packMarked(mark(w.value)), ex: w.ex };
  return out;
}

function redisEntries(dropKeys) {
  const out = {};
  for (const [key, value] of [...T.packed.entries()].sort()) {
    if (dropKeys.includes(key)) continue;
    const marked = mark(value);
    out[key] = { value: marked, packed: packMarked(marked) };
  }
  for (const [key, raw] of [...T.raw.entries()].sort()) out[key] = { raw };
  return out;
}

function dbTables() {
  const m2o = (map, f) => [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(f);
  const tables = {
    modelPages: T.pagesOut,
    paidAccess: m2o(T.db.paidAccess, ([modelId, { deadline, versionIds }]) =>
      mark({ modelId, deadline, versionIds })
    ),
    coverImages: m2o(
      T.db.coverImages,
      ([id, row]) => row ?? { id, userId: null, modelVersionId: null, modelId: null }
    ).filter((r) => r.modelId != null),
    tags: m2o(T.db.tags, ([name, id]) => ({ name, id })).filter((t) => t.id != null),
    creators: m2o(T.db.usernames, ([username, id]) => ({ username, id })),
  };
  // Only a fixture with a cold model-data or model-tags key lists the lookups' rows.
  if (T.db.modelVersionRows.length) tables.modelDataVersions = T.db.modelVersionRows;
  if (T.db.modelHashes.length) tables.modelHashes = T.db.modelHashes;
  if (T.db.tagsOnModels.length) tables.tagsOnModels = T.db.tagsOnModels;
  if (T.db.officialModels) tables.officialModels = T.db.officialModels;
  // Only a fixture whose request reads the viewer's follows lists them, and how often Node read them.
  if (T.db.followsRead) {
    tables.userFollows = m2o(T.db.userFollows, ([userId, ids]) =>
      ids.map((targetUserId) => ({ userId, targetUserId }))
    ).flat();
    tables.followsRead = T.db.followsRead;
  }
  // Only a fixture with a cold user-cosmetics key lists the UserCosmetic rows its lookup read.
  if ([...T.cold].some((k) => k.startsWith(`${K.userCosmetics}:`)))
    tables.userCosmetics = T.db.userCosmetics;
  // Only a fixture with a cold membership key lists the subscription rows its origin read.
  if (T.db.subscriptions.length) tables.subscriptions = T.db.subscriptions;
  // Only a fixture that reads a collection lists the table (a missing collection is no row).
  if (T.db.collections.size)
    tables.collections = m2o(T.db.collections, ([, c]) => c)
      .filter((c) => c != null)
      .map((c) => ({
        id: c.id,
        read: c.read,
        userId: c.userId,
        contributors: Object.entries(c.contributors).map(([userId, permissions]) => ({
          userId: Number(userId),
          permissions,
        })),
      }));
  return tables;
}

const dir = join(HERE, 'model-getall');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
resetDevalueDir('model-getall');
for (const spec of SPECS) {
  T = new Trace(spec.name, spec);
  // `spec.alsoCached`: cache keys the fixture holds although Node's answer reads none of them (an
  // image the answer leaves out), so a feed-go that kept the image fails on its answer, not on a miss.
  for (const key of spec.alsoCached ?? []) {
    const at = key.lastIndexOf(':');
    T.packed.set(key, worldPacked(key.slice(0, at), Number(key.slice(at + 1))));
  }
  const config = { ...CONFIG, ...(spec.config ?? {}), decorationEvents: spec.events ?? [] };
  const inputEnvelope = JSON.stringify(superjson.serialize(spec.input));
  let expect;
  // `spec.node400`: the request is one Node answers with its BAD_REQUEST (checked with Node's own
  // schema helpers and range check here), so the fixture's fallback is a 400 left to Node.
  if (spec.node400 && !spec.node400())
    throw new Error(`${spec.name}: Node does not refuse this input`);
  if (spec.fallback && !spec.pages) {
    // A fallback read after the cache: the board entries it reads are held (a stale one included).
    for (const [boardId, value] of Object.entries(spec.newCreatorBoards ?? {}))
      if (value != null) T.packed.set(`${K.newCreators}:${boardId}`, value);
    expect = { fallback: spec.fallback };
  } else {
    let value;
    try {
      value = runModels({ ...spec, config });
    } catch (err) {
      // `nodeThrows`: Node's own error is the expected outcome (feed-go must hand it to Node).
      if (!(spec.nodeThrows && spec.nodeThrows.test(String(err?.message ?? err))))
        throw new Error(`${spec.name}: ${err.message}`);
      T.pages = [];
    }
    if (T.pages.length)
      throw new Error(`${spec.name}: ${T.pages.length} listed page(s) never asked for`);
    expect = spec.fallback
      ? { fallback: spec.fallback }
      : {
          envelope: JSON.parse(JSON.stringify(superjson.serialize(value))),
          writes: writeEntries(),
        };
    if (!spec.fallback) writeDevalueBody('model-getall', spec.name, value);
  }
  writeFileSync(
    join(dir, `${spec.name}.json`),
    JSON.stringify(
      {
        name: spec.name,
        description: spec.description,
        now: NOW.toISOString(),
        config,
        request: {
          input: inputEnvelope,
          headers: { host: spec.host },
          session: spec.viewer ? { userId: spec.viewer } : null,
        },
        redis: redisEntries(T.dropKeys),
        sysRedis: { 'system:browsing-setting-addons': { raw: JSON.stringify(T.addons) } },
        db: dbTables(),
        expect,
      },
      null,
      2
    ) + '\n'
  );
}
if (!readdirSync(dir).length) throw new Error('model-getall is empty');
console.log(`model-getall: ${SPECS.length} fixtures`);
