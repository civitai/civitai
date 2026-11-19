// Writes the golden fixtures in v1-models/ (GET /api/v1/models and /api/v1/models/[id]).
//
//   node apps/feed-go/testdata/golden/gen-v1-models.mjs
//
// Each fixture is one request and the synthetic world it reads (`world`: the model statement's
// rows, every cache value, every replica row), plus `redis`, the same cache values packed with
// msgpackr's `pack` under their real keys for the Go harness. Everything is SYNTHETIC: invented ids,
// usernames, `*.example.test` hosts, `00000000-0000-4000-8000-…` keys.
//
// The EXPECTED answer is not written here. It is the REAL Node handler's answer over this world:
// src/server/__tests__/feed-go-v1-models.golden.test.ts runs src/pages/api/v1/models/index.ts and
// [id].ts (with getModelsRaw, getModelsWithVersions, the shapers, the file naming, the edge URLs —
// everything but I/O) and requires `expect.body` (the bytes `res.json` writes) and `expect.sql` (the
// model statement) to equal what that code produces; on a mismatch it prints the actual answer.
// This script keeps an existing fixture's `expect` when it rewrites the file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packMarked } from './pack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'v1-models');

const NOW = '2026-06-15T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const CACHED_AT = { $date: '2026-06-15T11:55:00.000Z' };
const date = (iso) => ({ $date: iso });
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CONFIG = {
  imageLocation: 'https://image.example.test/golden',
  baseUrl: 'https://site.example.test',
  coverageNext: false,
  baseModelFeedMetrics: false,
  regionRestricted: false,
};

// Default browsing-settings addons as the system redis holds them (getBrowsingSettingAddons).
const ADDONS = [
  { type: 'none', nsfwLevels: [8, 16], disablePoi: false },
  { type: 'some', nsfwLevels: [4, 8, 16], disableMinor: true, disablePoi: true },
];

// --- building blocks ---------------------------------------------------------------------------

function modelRow(id, o = {}) {
  return {
    id,
    name: `Model ${id}`,
    sfwName: null,
    coverImageId: null,
    sfwCoverImageId: null,
    description: `<p>About model ${id}</p>`,
    sfwDescription: null,
    allowNoCredit: true,
    allowCommercialUse: ['Image', 'RentCivit'],
    allowDerivatives: true,
    allowDifferentLicense: false,
    type: 'LORA',
    minor: false,
    sfwOnly: false,
    poi: false,
    nsfw: false,
    nsfwLevel: 1,
    status: 'Published',
    createdAt: date('2026-05-01T08:00:00.000Z'),
    lastVersionAt: date('2026-06-01T10:00:00.500Z'),
    publishedAt: date('2026-05-02T08:00:00.000Z'),
    locked: false,
    meta: {},
    mode: null,
    availability: 'Public',
    rank: {
      downloadCount: 10,
      thumbsUpCount: 5,
      thumbsDownCount: 0,
      commentCount: 1,
      collectedCount: 2,
      tippedAmountCount: 0,
    },
    userId: 1001,
    cursorId: `5|10|${id}`,
    ...o,
  };
}

function version(id, o = {}) {
  return {
    id,
    index: 0,
    name: `v${id}`,
    earlyAccessTimeFrame: 0,
    baseModel: 'SDXL 1.0',
    baseModelType: 'Standard',
    createdAt: date('2026-05-03T09:00:00.000Z'),
    trainingStatus: null,
    publishedAt: date('2026-05-04T09:00:00.000Z'),
    status: 'Published',
    flags: 0,
    availability: 'Public',
    nsfwLevel: 1,
    description: `<p>Version ${id}</p>`,
    trainedWords: [],
    vaeId: null,
    covered: false,
    coveredNext: false,
    ...o,
  };
}

function file(id, versionId, o = {}) {
  const { metadata, hashes, ...rest } = o;
  return {
    id,
    url: `https://storage.example.test/models/${id}.safetensors`,
    sizeKB: 12345.6789,
    name: `file_${id}.safetensors`,
    overrideName: null,
    type: 'Model',
    visibility: 'Public',
    pickleScanResult: 'Success',
    pickleScanMessage: 'No Pickle imports',
    virusScanResult: 'Success',
    virusScanMessage: null,
    scannedAt: date('2026-05-04T09:30:00.000Z'),
    modelVersionId: versionId,
    hashes: hashes ?? [
      { type: 'AutoV2', hash: `A${id}` },
      { type: 'SHA256', hash: `ABCDEF${id}` },
    ],
    ...rest,
    metadata: metadata ?? { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
  };
}

function image(id, versionId, o = {}) {
  return {
    id,
    userId: 1001,
    name: `${uuid(id)}.jpeg`,
    url: uuid(id),
    nsfwLevel: 1,
    width: 832,
    height: 1216,
    hash: `UHASH${id}`,
    type: 'image',
    metadata: { width: 832, height: 1216, hash: `UHASH${id}` },
    onSite: false,
    hasMeta: true,
    hasPositivePrompt: true,
    remixOfId: null,
    poi: false,
    minor: false,
    availability: 'Public',
    modelVersionId: versionId,
    ...o,
  };
}

const USERS = {
  1001: { id: 1001, username: 'artist_one', deletedAt: null, image: uuid(901) },
  1002: { id: 1002, username: 'artist_two', deletedAt: null, image: null },
};
const PICTURES = {
  1001: {
    id: 8901,
    name: null,
    url: uuid(8901),
    nsfwLevel: 1,
    hash: 'UPROFILE8901',
    userId: 1001,
    ingestion: 'Scanned',
    type: 'image',
    width: 512,
    height: 512,
    metadata: { width: 512, height: 512 },
  },
  // No servable profile picture: the cache holds the notFound marker.
  1002: 'notFound',
};

function baseWorld() {
  return {
    models: [],
    modelData: {},
    modelTags: {},
    tags: {
      11: { id: 11, name: 'character', nsfwLevel: 1, type: 'UserGenerated' },
      12: { id: 12, name: 'style', nsfwLevel: 1, type: 'Label' },
      13: { id: 13, name: 'excluded thing', nsfwLevel: 1, type: 'UserGenerated' },
    },
    users: { ...USERS },
    profilePictures: { ...PICTURES },
    paidAccessGates: [],
    paidAccess: {},
    images: {},
    imageTags: {},
    files: {},
    metricPrivacy: {},
    membership: {},
    gallerySettings: {},
    addons: ADDONS,
    stats: { vaeLinked: [], modelMetrics: [], versionMetrics: [], versionMeta: [] },
    vaeFiles: [],
    usernames: {},
    responseCache: {},
  };
}

/** Adds a model: its row, data record, tags, files, images, metrics and version metrics. */
function addModel(w, row, versions, { tagIds = [11, 12], files = {}, images = {}, metrics } = {}) {
  w.models.push(row);
  w.modelData[row.id] = { modelId: row.id, hashes: [`H${row.id}`], tags: [], versions };
  w.modelTags[row.id] = tagIds.length ? { modelId: row.id, tagIds } : 'notFound';
  for (const v of versions) {
    w.files[v.id] = files[v.id] ? { modelVersionId: v.id, files: files[v.id] } : 'notFound';
    w.images[v.id] = images[v.id] ? { modelVersionId: v.id, images: images[v.id] } : 'notFound';
    w.paidAccess[v.id] ??= 'notFound';
    w.stats.versionMetrics.push({
      modelVersionId: v.id,
      downloadCount: 100 + (v.id % 7),
      thumbsUpCount: 20 + (v.id % 5),
      thumbsDownCount: 1,
    });
    w.stats.versionMeta.push({ id: v.id, meta: {} });
    for (const img of images[v.id] ?? []) w.imageTags[img.id] ??= { imageId: img.id, tags: [] };
  }
  w.stats.modelMetrics.push(
    metrics ?? {
      modelId: row.id,
      downloadCount: 1000 + (row.id % 11),
      thumbsUpCount: 300 + (row.id % 13),
      thumbsDownCount: 3,
      commentCount: 12,
      tippedAmountCount: 40,
    }
  );
  w.metricPrivacy[row.userId] ??= {
    hideModelBuzz: false,
    hideModelDownloads: false,
    hideModelGenerations: false,
  };
}

// --- fixtures ----------------------------------------------------------------------------------

const fixtures = [];
const fx = (name, request, world, extra = {}) =>
  fixtures.push({
    name,
    now: NOW,
    config: { ...CONFIG, ...(extra.config ?? {}) },
    request,
    world,
    expect: extra.expect,
  });
const detail = (id, headers = {}) => ({
  path: `/api/v1/models/${id}`,
  query: '',
  headers: { host: 'site.example.test', 'cf-ipcountry': 'US', ...headers },
});
const list = (query, headers = {}) => ({
  path: '/api/v1/models',
  query,
  headers: { host: 'site.example.test', 'cf-ipcountry': 'US', ...headers },
});

// 1. One model, all levels: two versions (the draft is left out), the primary file elected by the
// default preference, a config file with its own discriminators, a gated version, a creator avatar.
{
  const w = baseWorld();
  addModel(
    w,
    modelRow(5001, { type: 'Checkpoint', nsfwLevel: 31, nsfw: true, cursorId: '330|1001|5001' }),
    [
      version(6001, { trainedWords: ['golden token'], covered: true }),
      version(6002, { index: 1, status: 'Draft' }),
      version(6003, { index: 2, baseModel: 'Pony', nsfwLevel: 4 }),
    ],
    {
      files: {
        6001: [
          file(7001, 6001, {
            name: 'model.safetensors',
            metadata: { format: 'SafeTensor', size: 'full', fp: 'fp32' },
          }),
          file(7002, 6001, { name: 'golden_pruned.safetensors' }),
          file(7003, 6001, { type: 'Config', name: 'config.yaml', metadata: { format: 'Other' } }),
          file(7004, 6001, { visibility: 'Private', name: 'secret.bin' }),
          file(7006, 6001, { name: 'model.safetensors' }),
        ],
        6003: [file(7005, 6003, { name: 'pony_v3.safetensors' })],
      },
      images: {
        6001: [
          image(8001, 6001),
          image(8002, 6001, { nsfwLevel: 4, type: 'video', url: `${uuid(8002)}.mp4` }),
        ],
        6003: [image(8003, 6003, { nsfwLevel: 8 })],
      },
    }
  );
  w.paidAccess[6003] = {
    entityId: 6003,
    ownerId: 1001,
    endsAtMs: NOW_MS + 86_400_000,
    timeframeDays: 7,
    terms: {},
    sales: [],
  };
  w.paidAccessGates = [5001];
  fx('detail-all-levels', detail(5001), w);
}

// 2. A restricted region: SFW level, the model's .com face (name, description, every version's
// description blanked), images and the creator avatar held to PG/PG-13.
{
  const w = baseWorld();
  addModel(
    w,
    modelRow(5002, {
      nsfwLevel: 7,
      sfwName: 'Safe Golden Model',
      sfwDescription: '<p>Safe words</p>',
      sfwCoverImageId: 8011,
      coverImageId: 8012,
      cursorId: '1|2|5002',
    }),
    [version(6011, { nsfwLevel: 7 })],
    {
      files: { 6011: [file(7011, 6011)] },
      images: { 6011: [image(8011, 6011, { nsfwLevel: 2 }), image(8012, 6011, { nsfwLevel: 4 })] },
    }
  );
  w.profilePictures[1001] = { ...PICTURES[1001], nsfwLevel: 4 };
  fx('detail-restricted-sfw-face', detail(5002, { 'cf-ipcountry': 'GB' }), w, {
    config: { regionRestricted: true },
  });
}

// 3. A linked VAE (a file of another version: unpinned, discriminator URL), an owner who hides
// downloads (on the model) and tips (by default) with a valid membership.
{
  const w = baseWorld();
  addModel(
    w,
    modelRow(5003, {
      userId: 1002,
      meta: { metricVisibility: { downloads: 'hide' } },
      cursorId: '1|1|5003',
    }),
    [version(6021, { vaeId: 6999 })],
    { files: { 6021: [file(7021, 6021)] }, images: { 6021: [image(8021, 6021, { userId: 1002 })] } }
  );
  w.stats.vaeLinked = [
    {
      sourceId: 6021,
      resourceId: 6999,
      settings: { isLinkedComponent: true, componentType: 'VAE', fileId: 7999 },
    },
  ];
  w.vaeFiles = [
    {
      id: 7999,
      url: 'https://storage.example.test/models/7999.safetensors',
      sizeKB: 320000,
      name: 'golden_vae.safetensors',
      overrideName: null,
      type: 'Model',
      visibility: 'Public',
      metadata: { format: 'SafeTensor', size: 'full', fp: 'fp16' },
      pickleScanResult: 'Success',
      pickleScanMessage: null,
      virusScanResult: 'Success',
      virusScanMessage: null,
      scannedAt: date('2026-04-01T00:00:00.000Z'),
      modelVersionId: 6999,
      hashes: [{ type: 'SHA256', hash: 'VAE7999' }],
    },
  ];
  w.metricPrivacy[1002] = {
    hideModelBuzz: true,
    hideModelDownloads: false,
    hideModelGenerations: false,
  };
  w.membership[1002] = true;
  fx('detail-vae-hidden-metrics', detail(5003), w);
}

// 4. A fresh origin-cache entry: Node serves it as stored, without building.
{
  const w = baseWorld();
  w.responseCache['packed:caches:public-model-response:v2:5004:31'] = {
    data: {
      id: 5004,
      name: 'Cached Model',
      type: 'Checkpoint',
      creator: { username: 'artist_one', image: null },
      tags: ['style'],
      modelVersions: [
        {
          id: 6031,
          name: 'v1',
          publishedAt: date('2026-05-04T09:00:00.000Z'),
          files: [{ id: 7031, name: 'cached.safetensors', type: 'Model', sizeKB: 1.5 }],
          downloadUrl: 'https://site.example.test/api/download/models/6031',
        },
      ],
    },
    cachedAt: NOW_MS - 60_000,
  };
  fx('detail-origin-cache-hit', detail(5004), w);
}

// 5. A minor model: its showcase held to its gallery level; a taken-down model in the list form is
// separate (7).
{
  const w = baseWorld();
  addModel(
    w,
    modelRow(5005, { minor: true, nsfwLevel: 3, cursorId: '1|1|5005' }),
    [version(6041, { nsfwLevel: 3 })],
    {
      files: { 6041: [file(7041, 6041)] },
      images: { 6041: [image(8041, 6041, { nsfwLevel: 1 }), image(8042, 6041, { nsfwLevel: 2 })] },
    }
  );
  w.gallerySettings[5005] = JSON.stringify({
    hiddenTags: [],
    hiddenUsers: [],
    hiddenImages: {},
    level: 1,
    pinnedPosts: {},
    creatorHiddenUserIds: [],
    sfwHeld: true,
  });
  fx('detail-minor-held-showcase', detail(5005), w);
}

// 6. A Training Data file the listing would check against the replica: not ported.
{
  const w = baseWorld();
  addModel(w, modelRow(5006), [version(6051)], {
    files: {
      6051: [
        file(7051, 6051),
        file(7052, 6051, { type: 'Training Data', name: 'data.zip', metadata: {} }),
      ],
    },
  });
  fx('fallback-detail-training-data', detail(5006), w, {
    expect: { fallback: 'v1-models-training-data' },
  });
}

// 7. The default list (PG, Highest Rated): a lookahead row (nextCursor, nextPage), a Private version
// left out, a mature version on a restricted base model left out, a taken-down model's images.
{
  const w = baseWorld();
  addModel(
    w,
    modelRow(5101, { cursorId: '320|1009|5101' }),
    [
      version(6101),
      version(6102, { index: 1, availability: 'Private' }),
      version(6103, { index: 2, baseModel: 'SD 3.5', nsfwLevel: 4 }),
    ],
    {
      files: { 6101: [file(7101, 6101)], 6102: [file(7102, 6102)], 6103: [file(7103, 6103)] },
      images: { 6101: [image(8101, 6101), image(8102, 6101, { nsfwLevel: 2 })] },
    }
  );
  addModel(
    w,
    modelRow(5102, { mode: 'TakenDown', userId: 1002, cursorId: '310|1004|5102' }),
    [version(6111)],
    {
      files: { 6111: [file(7111, 6111, { name: 'Taken Model.safetensors' })] },
      images: { 6111: [image(8111, 6111)] },
    }
  );
  addModel(w, modelRow(5103, { cursorId: '300|999|5103' }), [version(6121)], {
    files: { 6121: [file(7121, 6121)] },
  });
  fx('list-defaults-lookahead', list('limit=2&foo=bar'), w);
}

// 8. Newest, every level (nsfw=true: images pass through), two types, a date cursor (split into
// the tuple and equality branches).
{
  const w = baseWorld();
  addModel(
    w,
    modelRow(5201, {
      type: 'LoCon',
      nsfwLevel: 28,
      nsfw: true,
      cursorId: '2026-06-01 10:00:00.5|5201',
    }),
    [version(6201, { nsfwLevel: 28, covered: true, coveredNext: true })],
    {
      files: { 6201: [file(7201, 6201, { name: 'lowres.safetensors' })] },
      images: {
        6201: [image(8201, 6201, { nsfwLevel: 16 }), image(8202, 6201, { nsfwLevel: 32 })],
      },
    }
  );
  fx(
    'list-newest-nsfw-date-cursor',
    list(
      'types=LORA&types=LoCon&sort=Newest&nsfw=true&limit=1&cursor=2026-06-02%2009%3A00%3A00.250%7C5300'
    ),
    w
  );
}

// 9. Oldest over a month (the period bound), its cursor the OR-chain (an ASC head is not split);
// archived models included, one archived (no files, no download URL).
{
  const w = baseWorld();
  addModel(
    w,
    modelRow(5301, { mode: 'Archived', cursorId: '2026-06-10 00:00:00|5301' }),
    [version(6301)],
    {
      files: { 6301: [file(7301, 6301)] },
      images: { 6301: [image(8301, 6301)] },
    }
  );
  fx(
    'list-oldest-month-archived-cursor',
    list('sort=Oldest&period=Month&archived=true&cursor=2026-06-05%2000%3A00%3A00%7C5250'),
    w
  );
}

// 10. A username (slugified, resolved on the replica), paging metadata, primary file only.
{
  const w = baseWorld();
  addModel(
    w,
    modelRow(5401, { type: 'Checkpoint', userId: 1002, cursorId: '1|1|5401' }),
    [version(6401), version(6402, { index: 1, availability: 'EarlyAccess' })],
    {
      files: {
        6401: [
          file(7401, 6401, {
            name: 'model.safetensors',
            metadata: { format: 'SafeTensor', size: 'full', fp: 'fp16' },
          }),
          file(7402, 6401, {
            name: 'model.safetensors',
            metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
          }),
        ],
        6402: [file(7403, 6402)],
      },
    }
  );
  w.usernames.artist_two = 1002;
  fx(
    'list-username-paging-primary-only',
    list('username=Artist%20Two&page=2&limit=5&primaryFileOnly=true'),
    w
  );
}

// 11. Base models with the per-base-model metrics (the aggregate path), Most Downloaded.
{
  const w = baseWorld();
  addModel(
    w,
    modelRow(5501, { type: 'Checkpoint', cursorId: '900|10|5501' }),
    [
      version(6501, { baseModel: 'Pony' }),
      version(6502, { index: 1, baseModel: 'Illustrious' }),
      version(6503, { index: 2, baseModel: 'SDXL 1.0' }),
    ],
    {
      files: {
        6501: [file(7501, 6501, { name: 'model.safetensors' })],
        6502: [file(7502, 6502)],
        6503: [
          file(7503, 6503, {
            type: 'Pruned Model',
            metadata: { format: 'SafeTensor', size: 'pruned', fp: 'bf16' },
          }),
        ],
      },
    }
  );
  fx(
    'list-base-models-metrics',
    list('baseModels=SDXL%201.0&baseModels=Pony&sort=Most%20Downloaded&types=Checkpoint'),
    w,
    {
      config: { baseModelFeedMetrics: true },
    }
  );
}

// 12. The addons at PG exclude a tag: the statement's NOT EXISTS, a model carrying it dropped, a
// showcase image carrying it filtered out.
{
  const w = baseWorld();
  w.addons = [{ type: 'some', nsfwLevels: [1], excludedTagIds: [13], disablePoi: true }];
  addModel(w, modelRow(5601, { cursorId: '1|1|5601' }), [version(6601)], {
    files: { 6601: [file(7601, 6601)] },
    images: { 6601: [image(8601, 6601), image(8602, 6601), image(8603, 6601, { poi: true })] },
  });
  w.imageTags[8602] = { imageId: 8602, tags: [13] };
  addModel(w, modelRow(5602, { cursorId: '1|1|5602' }), [version(6611)], {
    tagIds: [13],
    files: { 6611: [file(7611, 6611)] },
  });
  fx('list-addon-excluded-tags', list('limit=10'), w);
}

// Fallbacks before any read.
fx('fallback-list-query', list('query=golden&limit=5'), baseWorld(), {
  expect: { fallback: 'v1-models-query' },
});
fx('fallback-list-favorites', list('favorites=false'), baseWorld(), {
  expect: { fallback: 'v1-models-authed-only' },
});

// --- writing -------------------------------------------------------------------------------------

/** The world's cache values under their real keys, as the Node app writes them. */
function redisEntries(w) {
  const out = {};
  const record = (key, id, v, cached = true) => {
    out[`${key}:${id}`] = {
      value:
        v === 'notFound'
          ? { notFound: true, cachedAt: CACHED_AT }
          : cached
          ? { ...v, cachedAt: CACHED_AT }
          : v,
    };
  };
  for (const [id, v] of Object.entries(w.modelData))
    record('packed:caches:data-for-model-2', id, v);
  for (const [id, v] of Object.entries(w.modelTags)) record('packed:caches:model-tags', id, v);
  for (const [id, v] of Object.entries(w.tags)) record('packed:caches:basic-tags', id, v);
  for (const [id, v] of Object.entries(w.users)) record('packed:caches:basic-users', id, v);
  for (const [id, v] of Object.entries(w.profilePictures))
    record('packed:caches:profile-pictures:v4', id, v);
  for (const [id, v] of Object.entries(w.paidAccess))
    record('packed:caches:paid-access:ModelVersion', id, v);
  for (const [id, v] of Object.entries(w.images))
    record('packed:caches:images-for-model-version-2', id, v);
  for (const [id, v] of Object.entries(w.files))
    record('packed:caches:files-for-model-version-2', id, v);
  for (const [id, v] of Object.entries(w.imageTags))
    record('packed:caches:tag-ids-for-images', id, v);
  for (const [id, v] of Object.entries(w.metricPrivacy))
    record('packed:caches:user-metric-privacy-defaults', id, v, false);
  for (const [id, v] of Object.entries(w.membership))
    out[`packed:caches:creator-membership-valid:${id}`] = { value: v };
  for (const [key, v] of Object.entries(w.responseCache)) out[key] = { value: v };
  for (const e of Object.values(out)) e.packed = packMarked(e.value);
  for (const [id, raw] of Object.entries(w.gallerySettings))
    out[`model:gallery-settings:${id}`] = { raw };
  return out;
}

mkdirSync(OUT, { recursive: true });
for (const f of fixtures) {
  const path = join(OUT, `${f.name}.json`);
  const prev = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  const doc = {
    name: f.name,
    now: f.now,
    config: f.config,
    request: f.request,
    world: f.world,
    redis: redisEntries(f.world),
    sysRedis: { 'system:browsing-setting-addons': { raw: JSON.stringify(f.world.addons) } },
    expect: f.expect ?? prev?.expect ?? { body: null, sql: null },
  };
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}
console.log(`wrote ${fixtures.length} fixtures to ${OUT}`);
