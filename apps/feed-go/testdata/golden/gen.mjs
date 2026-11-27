// Generates the golden fixtures in as-posts/, v1-images/ and infinite/ (see README.md).
//
//   TZ=UTC node apps/feed-go/testdata/golden/gen.mjs
//
// Everything here is SYNTHETIC: invented user ids (1001..), usernames, image UUIDs
// (00000000-0000-4000-8000-…), hosts under example.test. No production data.
//
// What a fixture's EXPECTED answer is comes from the Node code paths, transcribed below function by
// function from the Node source (each mirror names the file it follows), never from feed-go:
//   - image.getImagesAsPostsInfinite: getImagesAsPostsInfiniteHandler (src/server/controllers/
//     image.controller.ts), getAllImagesIndex / getAllImagesUncaptured (src/server/services/
//     image.service.ts), mapSearchInputToFeedQuery (src/server/services/feed-shadow.service.ts),
//     serveFromFeed / feedHydrateQuery (src/server/services/feed-primary.service.ts), the wire trims
//     (src/server/utils/image-infinite-wire.ts, images-as-posts-wire.ts), and the cache readers
//     (packages/civitai-redis/src/cached-array.ts, src/server/redis/caches.ts).
//   - GET /api/v1/images: handleImagesRequest (src/pages/api/v1/images/index.ts), runImageSearch
//     (src/server/services/image-search.service.ts), getImagesFromFeedServiceForRest.
//   - image.getInfinite: getInfiniteImagesHandler (src/server/controllers/image.controller.ts),
//     getAllImagesIndex / getAllImages, prepareImageFeedRequest and enforceBlockedBrowsingTags
//     (src/server/services/blocked-browsing-tags.service.ts), stripImageForInfiniteWire.
// The response is then encoded with the real superjson (tRPC) / JSON.stringify (res.json), and the
// cache values with the real msgpackr `pack`, so the bytes are what Node writes.
//
// The feed service is an external system: each fixture names, per query string, what it answers.
// The mirror computes the query string Node sends and fails loudly when a fixture has no reply for
// it, so a fixture's `feed` list is exactly the calls Node makes, in order.
process.env.TZ = 'UTC';

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDep, mark, packMarked, packMarkedCompressed } from './pack.mjs';
import { resetDevalueDir, writeDevalueBody } from './devalue-body.mjs';

if (new Date(0).getTimezoneOffset() !== 0) throw new Error('run with TZ=UTC (the Node pods run in UTC)');

const superjson = (await importDep('superjson')).default;
const queryString = (await importDep('query-string')).default;
const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// The synthetic world
// ---------------------------------------------------------------------------------------------
const NOW = new Date('2026-06-15T12:00:00.000Z');
const CACHED_AT = new Date('2026-06-15T11:55:00.000Z');
const POPULATED_AT = String(Math.floor(NOW.getTime() / 1000) - 120);
const IMAGE_LOCATION = 'https://image.example.test/golden';
const HOST = { green: 'green.example.test', blue: 'blue.example.test', red: 'red.example.test' };
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (d, h = 10) => new Date(Date.UTC(2026, 5, d, h, 0, 0));

const USERS = {
  1001: { id: 1001, username: 'artist_one', image: uuid(901), deletedAt: null },
  1002: { id: 1002, username: 'artist_two', image: null, deletedAt: null },
  1003: { id: 1003, username: 'viewer_three', image: null, deletedAt: null },
  1004: { id: 1004, username: 'mod_four', image: null, deletedAt: null },
  // The system user (-1): the showcase carousel's `prioritizedUserIds: [-1]`.
  [-1]: { id: -1, username: 'golden_system', image: null, deletedAt: null },
};
// session:data2:<id> — the cached session user (packages/civitai-auth/src/session-client.ts).
const SESSIONS = {
  1001: { id: 1001, username: 'artist_one', isModerator: false, bannedAt: null, tier: null },
  1002: { id: 1002, username: 'artist_two', isModerator: false, bannedAt: null, tier: null },
  1003: { id: 1003, username: 'viewer_three', isModerator: false, bannedAt: null, tier: null },
  1004: { id: 1004, username: 'mod_four', isModerator: true, bannedAt: null, tier: null },
};
const COSMETICS = {
  301: { id: 301, name: 'Golden Badge', type: 'Badge', data: { url: uuid(3011) }, source: 'Trophy', flags: 0 },
  302: {
    id: 302,
    name: 'Golden Frame',
    type: 'ContentDecoration',
    data: { url: uuid(3021), offset: '5%', crop: '0%' },
    source: 'Purchase',
    flags: 0,
  },
  401: {
    id: 401,
    name: 'Golden Hat',
    type: 'ContentDecoration',
    data: { event: 'goldentest2026', url: uuid(4011), offset: '10%' },
    source: 'Claim',
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
    hash: 'UGOLDENPROFILE8901',
    userId: 1001,
    ingestion: 'Scanned',
    type: 'image',
    width: 512,
    height: 512,
    metadata: { width: 512, height: 512 },
  },
};
// Creator-made cosmetics (Cosmetic.createdById set): 303 is listed by its creator but not
// displayable (withheld), 304's creator listing was approved on review (shown), 305 has no listing and
// carries CosmeticFlag.Withheld (tombstoned: withheld).
Object.assign(COSMETICS, {
  303: { id: 303, name: 'Pending Badge', type: 'Badge', data: { url: uuid(3031) }, source: 'Purchase', flags: 0 },
  304: { id: 304, name: 'Creator Plate', type: 'NamePlate', data: { color: 'gold', 2: 1 }, source: 'Purchase', flags: 0 },
  305: { id: 305, name: 'Removed Badge', type: 'Badge', data: { url: uuid(3051) }, source: 'Purchase', flags: 4 },
});
const COSMETIC_CREATORS = { 303: 1009, 304: 1009, 305: 1009 };

// ---- The database behind the caches (read by a lookup only when its key is cold) ----------------
// UserCosmetic rows. The user-cosmetics cache entry of 1002 predates its 304: a cold read finds it
// (its 303 is withheld, its 305 tombstoned, its 302 owned but not equipped). The frame and event rows
// agree with FRAMES / EVENT_DECORATIONS, plus a withheld creator frame on 8007 (so 8007 shows none).
const USER_COSMETIC_ROWS = [
  { userId: 1001, cosmeticId: 301, data: null, equippedAt: day(1), equippedToId: null, equippedToType: null },
  { userId: 1002, cosmeticId: 303, data: null, equippedAt: day(2), equippedToId: null, equippedToType: null },
  { userId: 1002, cosmeticId: 304, data: { color: 'gold', 2: 1, sparkle: { on: true, at: 0.5 } }, equippedAt: day(2), equippedToId: null, equippedToType: null },
  { userId: 1002, cosmeticId: 305, data: null, equippedAt: day(3), equippedToId: null, equippedToType: null },
  { userId: 1002, cosmeticId: 302, data: null, equippedAt: null, equippedToId: null, equippedToType: null },
  { userId: 1001, cosmeticId: 302, data: null, equippedAt: day(3), equippedToId: 8001, equippedToType: 'Image' },
  { userId: 1009, cosmeticId: 303, data: { lights: 2 }, equippedAt: day(3), equippedToId: 8007, equippedToType: 'Image' },
  { userId: 1002, cosmeticId: 401, data: null, equippedAt: day(4), equippedToId: 8003, equippedToType: 'Image' },
];
// CosmeticShopItem rows: [cosmeticId, addedById, status, meta, rejectionReason].
const SHOP_ITEMS = [
  { cosmeticId: 303, addedById: 1009, status: 'PendingReview', meta: {}, rejectionReason: null },
  { cosmeticId: 304, addedById: 1009, status: 'Draft', meta: { history: [{ kind: 'reviewed', action: 'approve' }] }, rejectionReason: null },
  { cosmeticId: 304, addedById: 1010, status: 'Rejected', meta: {}, rejectionReason: 'Not theirs' },
];
/** A jsonb column's text as Postgres writes it: members ordered by key length then bytes, `", "` and
 *  `": "` separators. Prisma hands the Node code JSON.parse of exactly this. */
function jsonbText(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(', ')}]`;
  const keys = Object.keys(v).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${jsonbText(v[k])}`).join(', ')}}`;
}
const prismaJson = (v) => (v === null || v === undefined ? null : JSON.parse(jsonbText(v)));

// The Image frame each image wears (cosmeticEntityCaches.Image raw lookup rows).
const FRAMES = { 8001: { equippedToId: 8001, cosmeticId: 302, userData: null } };
// The event decoration each image wears (eventDecorationEntityCaches.Image entries).
const EVENT_DECORATIONS = {
  8003: {
    id: 401,
    name: COSMETICS[401].name,
    type: COSMETICS[401].type,
    source: COSMETICS[401].source,
    data: COSMETICS[401].data,
    equippedToId: 8003,
    equippedToType: 'Image',
    userId: 1002,
  },
};

const MODELS = {
  5001: { id: 5001, userId: 1001, mode: null, minor: false, sfwOnly: false, galleryLevel: null },
  5002: { id: 5002, userId: 1002, mode: null, minor: false, sfwOnly: true, galleryLevel: 3 },
  5003: { id: 5003, userId: 1001, mode: 'TakenDown', minor: false, sfwOnly: false, galleryLevel: null },
  5004: { id: 5004, userId: 1002, mode: null, minor: false, sfwOnly: false, galleryLevel: null },
  5005: { id: 5005, userId: 1002, mode: null, minor: false, sfwOnly: false, galleryLevel: null },
  5006: { id: 5006, userId: 1001, mode: null, minor: false, sfwOnly: false, galleryLevel: null },
};
const VERSIONS = {
  6001: 5001,
  6002: 5001,
  6101: 5002,
  6201: 5003,
  6301: 5004,
  6401: 5005,
  6501: 5006,
};
// ModelVersion.baseModel per version (the `baseModels` filter). Read only by a fixture that sends it.
const VERSION_BASE_MODELS = {
  6001: 'SDXL 1.0',
  6002: 'Pony',
  6101: 'SD 1.5',
  6201: 'SDXL 1.0',
  6301: 'Pony',
  6401: 'Illustrious',
  6501: 'SDXL 1.0',
};
const settings = (extra) => ({
  hiddenTags: [],
  hiddenUsers: [],
  hiddenImages: {},
  level: 31,
  pinnedPosts: {},
  creatorHiddenUserIds: [],
  sfwHeld: false,
  ...extra,
});
// model:gallery-settings:<modelId> (JSON, getGallerySettingsByModelId).
const GALLERY_SETTINGS = {
  5001: settings({ hiddenUsers: [{ id: 1009, username: 'hidden_nine' }], hiddenImages: { 6001: [8099] } }),
  5002: settings({ level: 3, sfwHeld: true }),
  5003: { none: true, hiddenTags: [], hiddenUsers: [], hiddenImages: {}, pinnedPosts: {} },
  5004: settings({ pinnedPosts: { 6301: [7101] } }),
  5005: settings({}),
  5006: settings({}),
};

// Posts: [id, userId, modelVersionId, publishedAt]
const POSTS = {};
for (const [id, userId, versionId, publishedAt] of [
  [7001, 1001, 6001, day(12)], // a Friday
  [7002, 1002, 6001, day(8)], // a Monday
  [7003, 1001, 6001, day(9)],
  [7004, 1002, 6001, day(10)],
  [7005, 1001, 6002, day(11)],
  [7006, 1002, 6001, day(5)],
  [7007, 1001, 6001, day(4)],
  [7008, 1002, 6002, day(3)],
  [7009, 1002, 6001, day(7)],
  [7010, 1001, null, day(6)],
  [7020, 1002, null, day(6, 6)],
  [7030, 1002, null, day(6, 18)],
  [7101, 1002, 6301, day(2)],
  [7102, 1001, 6301, day(13)],
  [7103, 1002, 6301, day(1)],
  [7201, 1001, 6401, day(14)],
  [7202, 1002, 6401, day(12)],
  [7203, 1001, 6401, day(10)],
  [7301, 1002, 6101, day(11)],
  [7401, 1001, 6201, day(11)],
  [7011, 1002, null, day(6, 12)],
  [7501, 1001, null, day(9, 14)],
  [7013, 1002, 6401, day(13)],
  // Version 6501: two posts by the system user (-1) and one by 1001 (prioritized-system-user-own-post).
  [7601, -1, 6501, day(9)],
  [7602, 1001, 6501, day(10)],
  [7603, -1, 6501, day(11)],
])
  POSTS[id] = { id, userId, modelVersionId: versionId, publishedAt };

// Images. Every column of the getAllImages SELECT, in its order (image.service.ts), plus the
// resource rows (ImageResourceNew) the image has.
const IMAGES = {};
const RESOURCES = {}; // imageId -> [{ modelVersionId, detected }]
function image(id, postId, opts = {}) {
  const post = POSTS[postId];
  const createdAt = opts.createdAt ?? new Date(post.publishedAt.getTime() - 3600_000);
  const scannedAt = opts.scannedAt ?? new Date(createdAt.getTime() + 60_000);
  const type = opts.type ?? 'image';
  const sortAt = new Date(Math.max(post.publishedAt.getTime(), scannedAt.getTime(), createdAt.getTime()));
  IMAGES[id] = {
    id,
    name: `golden-${id}.${type === 'video' ? 'mp4' : 'png'}`,
    url: uuid(id),
    nsfwLevel: opts.nsfwLevel ?? 1,
    width: type === 'video' ? 1280 : 832,
    height: type === 'video' ? 720 : 1216,
    hash: `UGOLDEN${id}`,
    hideMeta: opts.hideMeta ?? false,
    hasMeta: opts.hasMeta ?? true,
    hasPositivePrompt: opts.hasMeta ?? true,
    onSite: false,
    remixOfId: null,
    createdAt,
    sortAt,
    mimeType: type === 'video' ? 'video/mp4' : 'image/png',
    type,
    metadata: opts.metadata ?? { width: 832, height: 1216, hash: `UGOLDEN${id}` },
    ingestion: 'Scanned',
    blockedFor: null,
    scannedAt,
    needsReview: null,
    userId: post.userId,
    postId,
    postTitle: `Golden post ${postId}`,
    index: opts.index ?? 0,
    publishedAt: post.publishedAt,
    unpublishedAt: null,
    modelVersionId: post.modelVersionId,
    model3dId: null,
    availability: 'Public',
    minor: opts.minor ?? false,
    poi: false,
    acceptableMinor: false,
    restricted: false,
  };
  RESOURCES[id] = opts.resources ?? (post.modelVersionId ? [{ modelVersionId: post.modelVersionId, detected: true }] : []);
}
image(8001, 7001, { index: 0, resources: [{ modelVersionId: 6001, detected: true }, { modelVersionId: 6002, detected: false }] });
image(8002, 7001, { index: 1, nsfwLevel: 2, createdAt: day(8, 8) });
image(8003, 7002, { index: 0 });
image(8004, 7003, { index: 0, nsfwLevel: 4 });
image(8005, 7004, {
  type: 'video',
  metadata: { width: 1280, height: 720, duration: 12, thumbnailId: 8905 },
});
image(8006, 7006);
image(8007, 7007);
image(8008, 7009, { minor: true });
image(8009, 7010, {
  type: 'video',
  metadata: { width: 1280, height: 720, duration: 45, thumbnailId: 8909 },
});
// Three videos whose cached thumbnails are not servable: one marked under a block that refuses its
// owner the media, one cached before either field existed, one marked under a hold that leaves its
// owner the media (ownerMediaAllowed, src/server/common/image-block-marker.ts).
image(8031, 7020, {
  type: 'video',
  metadata: { width: 1280, height: 720, duration: 12, thumbnailId: 8931 },
});
image(8032, 7020, {
  index: 1,
  type: 'video',
  metadata: { width: 1280, height: 720, duration: 12, thumbnailId: 8932 },
});
image(8033, 7020, {
  index: 2,
  type: 'video',
  metadata: { width: 1280, height: 720, duration: 12, thumbnailId: 8933 },
});
// A post of eight, its images created on different weekdays (the createdAt string sort) and out of
// index order (the Newest index sort).
const LAZY = [
  [8011, 3, day(9, 6)],
  [8012, 0, day(10, 6)],
  [8013, 5, day(8, 6)],
  [8014, 1, day(7, 6)],
  [8015, 7, day(6, 6)],
  [8016, 2, day(5, 6)],
  [8017, 6, day(4, 6)],
  [8018, 4, day(3, 6)],
];
for (const [id, index, createdAt] of LAZY)
  image(id, 7005, { index, createdAt, scannedAt: new Date(createdAt.getTime() + 60_000) });
image(8020, 7008);
image(8101, 7101, { index: 0 });
image(8102, 7101, { index: 1, resources: [] });
image(8103, 7101, { index: 2, resources: [{ modelVersionId: 6999, detected: true }] });
image(8104, 7102);
image(8105, 7103);
image(8201, 7201, { index: 0 });
image(8202, 7201, { index: 1 });
image(8203, 7202);
image(8204, 7203);
image(8301, 7301, { index: 0 });
image(8302, 7301, { index: 1, nsfwLevel: 4 });
image(8401, 7401);
// An image that hides its meta: the column holds one, the cache and the lookup answer null.
image(8030, 7011, { hideMeta: true, hasMeta: false });
// Post 7030's three images (1002's): one carrying a block that refuses its owner the media (CSAM),
// one carrying only a hold that leaves the owner the media (AiNotVerified, OWNER_MEDIA_EXEMPT_BLOCKS
// in src/server/common/image-block-marker.ts), one with no block. The rows still read Scanned and
// rated, so only the block clauses (blockedMediaListConditions) tell them apart.
image(8041, 7030, { index: 0 });
image(8042, 7030, { index: 1 });
image(8043, 7030, { index: 2 });
IMAGES[8041].blockedFor = 'CSAM';
IMAGES[8042].blockedFor = 'AiNotVerified';
// An acceptableMinor image (1001's), listed only in a collection, and there only to its owner and to
// moderators.
image(8501, 7501);
// A post of the minor content rule's fixtures (minor-mature-*): a minor-flagged R image the rule shows
// only to its owner (1002) and moderators, an unflagged R image and a minor-flagged PG-13 image (both
// shown to every viewer at their level: the controls).
image(8701, 7013, { index: 0, nsfwLevel: 4, minor: true });
image(8702, 7013, { index: 1, nsfwLevel: 4 });
image(8703, 7013, { index: 2, nsfwLevel: 2, minor: true });
IMAGES[8501].acceptableMinor = true;
// The system user's images on version 6501 (two posts, out of id order against the post order) and
// another creator's.
image(8601, 7603, { index: 0 });
image(8602, 7601, { index: 1 });
image(8603, 7601, { index: 0 });
image(8604, 7602, { index: 0 });

// Collections (Collection rows, getUserCollectionPermissionsByIds' read) and their CollectionItem
// rows (the `ct` CTE). 9101 is public (1001's): items accepted, in review and rejected, one of each
// by 1003, a tagged one and one whose note holds no score. 9102 is private (1001's): 1002 holds VIEW
// as a contributor, 1003 a contributor row without it. 9103 is public with a judged item (a score in
// its note).
const COLLECTIONS = {
  9101: { id: 9101, read: 'Public', userId: 1001, contributors: [] },
  9102: {
    id: 9102,
    read: 'Private',
    userId: 1001,
    contributors: [
      { userId: 1002, permissions: ['VIEW', 'ADD'] },
      { userId: 1003, permissions: ['ADD'] },
    ],
  },
  9103: { id: 9103, read: 'Public', userId: 1002, contributors: [] },
};
const COLLECTION_ITEMS = [
  { id: 95001, collectionId: 9101, imageId: 8001, status: 'ACCEPTED', addedById: 1001, note: null, tagId: null },
  { id: 95004, collectionId: 9101, imageId: 8003, status: 'ACCEPTED', addedById: 1003, note: null, tagId: 31 },
  { id: 95002, collectionId: 9101, imageId: 8007, status: 'ACCEPTED', addedById: null, note: '{"comment":"no score"}', tagId: null },
  { id: 95006, collectionId: 9101, imageId: 8006, status: 'REVIEW', addedById: 1003, note: null, tagId: null },
  { id: 95005, collectionId: 9101, imageId: 8204, status: 'REVIEW', addedById: 1002, note: null, tagId: null },
  { id: 95003, collectionId: 9101, imageId: 8203, status: 'REJECTED', addedById: 1003, note: null, tagId: null },
  { id: 95101, collectionId: 9102, imageId: 8002, status: 'ACCEPTED', addedById: 1001, note: null, tagId: null },
  { id: 95102, collectionId: 9102, imageId: 8501, status: 'ACCEPTED', addedById: 1001, note: null, tagId: null },
  { id: 95103, collectionId: 9102, imageId: 8105, status: 'ACCEPTED', addedById: 1002, note: null, tagId: null },
  { id: 95201, collectionId: 9103, imageId: 8201, status: 'ACCEPTED', addedById: 1001, note: null, tagId: null },
  { id: 95202, collectionId: 9103, imageId: 8202, status: 'ACCEPTED', addedById: 1001, note: '{"score":{"theme":7,"wittiness":5}}', tagId: null },
];
// User-composed hubs (UserHub rows and their UserHubSource rows: prisma/schema.full.prisma), read by
// image.getInfinite's `hubId` (resolveHubSources). 9301 is public (1001's): a creator, a version, a
// tag AND-group and a single tag, a disabled creator, keep-outs of every kind (an exclude tag group
// sharing the include group's key) and a collection (dark: HUB_COLLECTION_SOURCES_ENABLED is false).
// 9302 is private (1003's): a Model source (expanded to its versions), a creator, a tag AND-group and
// an excluded Model. 9303 is public with its own cap (PG|PG-13|R) over an SFW-only model's version
// (5002, held at PG|PG-13). 9304 is public over a taken-down model's version (5003, 1001's). 9305 is
// public with only a collection and a disabled creator: nothing to serve.
const hubSource = (id, type, targetId, opts = {}) => ({ id, type, targetId, enabled: opts.enabled ?? true, exclude: opts.exclude ?? false, groupKey: opts.groupKey ?? null });
const HUBS = {
  9301: {
    id: 9301,
    userId: 1001,
    availability: 'Public',
    forcedBrowsingLevel: 0,
    sources: [
      hubSource(30101, 'User', 1002),
      hubSource(30102, 'ModelVersion', 6301),
      hubSource(30103, 'Tag', 501, { groupKey: 7 }),
      hubSource(30104, 'Tag', 502, { groupKey: 7 }),
      hubSource(30105, 'Tag', 520),
      hubSource(30106, 'User', 1003, { enabled: false }),
      hubSource(30107, 'User', 1009, { exclude: true }),
      hubSource(30108, 'ModelVersion', 6401, { exclude: true }),
      hubSource(30109, 'Tag', 531, { exclude: true, groupKey: 7 }),
      hubSource(30110, 'Tag', 532, { exclude: true, groupKey: 7 }),
      hubSource(30111, 'Collection', 9101),
    ],
  },
  9302: {
    id: 9302,
    userId: 1003,
    availability: 'Private',
    forcedBrowsingLevel: 0,
    sources: [
      hubSource(30201, 'Model', 5001),
      hubSource(30202, 'User', 1001),
      hubSource(30203, 'Tag', 533, { groupKey: 3 }),
      hubSource(30204, 'Tag', 531, { groupKey: 3 }),
      hubSource(30205, 'Model', 5005, { exclude: true }),
    ],
  },
  9303: {
    id: 9303,
    userId: 1002,
    availability: 'Public',
    forcedBrowsingLevel: 7,
    sources: [hubSource(30301, 'ModelVersion', 6101), hubSource(30302, 'User', 1002)],
  },
  9304: { id: 9304, userId: 1001, availability: 'Public', forcedBrowsingLevel: 0, sources: [hubSource(30401, 'ModelVersion', 6201)] },
  9306: { id: 9306, userId: 1002, availability: 'Public', forcedBrowsingLevel: 4, sources: [hubSource(30601, 'User', 1002)] },
  9305: {
    id: 9305,
    userId: 1001,
    availability: 'Public',
    forcedBrowsingLevel: 0,
    sources: [hubSource(30501, 'Collection', 9101), hubSource(30502, 'User', 1002, { enabled: false })],
  },
};

// A collection item's Random sort key under a seed: `abs(mod(hashtext(concat(ci.id::text, '<seed>')),
// 1000000000))` in the `ct` CTE. hashtext is Postgres' own (hash_any), which this mirror does not
// reimplement: these are the values a real Postgres 16 computed for each item id and seed, and
// TestIntegrationCollectionRandomSortKeys (internal/feed) pins them against the CI Postgres. A fixture
// whose request sorts a collection by Random carries them as its items' `sortKeys`.
const COLLECTION_SORT_KEYS = {
  494867: { 95001: 995023918, 95002: 296414999, 95003: 281741135, 95004: 588720858, 95005: 431780544, 95006: 522077658, 95101: 502631944, 95102: 717036926, 95103: 749353720, 95201: 325348675, 95202: 959163105 },
  494868: { 95001: 8992366, 95002: 337483310, 95003: 309553120, 95004: 409789263, 95005: 878391610, 95006: 697502928, 95101: 372575269, 95102: 332677071, 95103: 364410394, 95201: 163855030, 95202: 213911762 },
};
/** getCollectionRandomSeed (collection.service.ts): the stored seed (`Number(cached)`); a missing key
 *  is computed and written there, which no served fixture reaches (feed-go falls back on it). */
function getCollectionRandomSeed() {
  if (T.randomSeed === undefined) throw new Error('mirror: a Random collection page without a stored seed');
  T.randomSeedRead = true;
  return Number(T.randomSeed);
}
function sortKeyOf(itemId, seed) {
  const k = COLLECTION_SORT_KEYS[seed]?.[itemId];
  if (k === undefined) throw new Error(`mirror: no Postgres sort key for item ${itemId} under seed ${seed}`);
  return k;
}

// Image.meta (jsonb), the generation parameters imageMetaCache serves (withMeta). Each differs; the
// first holds an integer-like key ("10", listed first in JS, after "a" in jsonb's order), a fraction,
// a nested array and a null member. An image without an entry has a NULL meta.
const META = {
  8001: { prompt: 'golden synthetic prompt one', negativePrompt: 'blurry', cfgScale: 7.5, steps: 30, seed: 4242001, sampler: 'Euler a', 10: 'ten', a: null, resources: [{ name: 'golden-lora', type: 'lora', weight: 0.8 }] },
  8002: { prompt: 'golden synthetic prompt two', steps: 12, clipSkip: 2 },
  8003: { prompt: 'golden synthetic prompt three', cfgScale: 4, nested: { deep: { level: 3, list: [1, 'two', false] } }, comfy: null, note: 'ünïcödé ✓' },
  8004: { prompt: 'golden synthetic prompt four', seed: 9007199254740, Size: '832x1216' },
  8005: { prompt: 'golden synthetic video', fps: 23.976 },
  8006: null,
  8007: { prompt: 'golden synthetic prompt seven', steps: 7 },
  8030: { prompt: 'golden hidden prompt' },
};
// imageMetaCache entries Node wrote before the cache was compressed: plain msgpack, read as is.
const META_UNCOMPRESSED = new Set([8002]);
// imageMetaCache notFound markers (the lookup found no row when the entry was written).
const META_NOT_FOUND = new Set([8009]);
const metaOf = (id) => (IMAGES[id].hideMeta ? null : prismaJson(META[id] ?? null));

// OWNER_MEDIA_EXEMPT_BLOCKS and ownerMediaAllowed (src/server/common/image-block-marker.ts).
const OWNER_MEDIA_EXEMPT_BLOCKS = ['AiNotVerified'];
const ownerMediaAllowed = (image) =>
  image.blockedFor != null ? OWNER_MEDIA_EXEMPT_BLOCKS.includes(image.blockedFor) : image.ingestion !== 'Blocked';

// Video thumbnails (thumbnailCache, keyed by the video's id).
const THUMBNAILS = {
  8005: { id: 8905, url: uuid(8905), width: 640, height: 360, nsfwLevel: 1, blockMarked: false, parentId: 8005 },
  8009: { id: 8909, url: uuid(8909), width: 640, height: 360, nsfwLevel: 2, blockMarked: false, parentId: 8009 },
  8031: { id: 8931, url: uuid(8931), width: 640, height: 360, nsfwLevel: 1, blockMarked: true, ownerMediaAllowed: false, parentId: 8031 },
  8032: { id: 8932, url: uuid(8932), width: 640, height: 360, nsfwLevel: 1, parentId: 8032 },
  8033: { id: 8933, url: uuid(8933), width: 640, height: 360, nsfwLevel: 1, blockMarked: true, ownerMediaAllowed: true, parentId: 8033 },
};
// Tag ids per image (tagIdsForImagesCache). None are tags the addons exclude.
const tagIdsOf = (id) => [501 + (id % 3), 520 + (id % 7)];
// ImageTool rows: imageId -> its tool ids (the `tools` filter). An image not listed has none.
// 8201 (the sponsored post's approved image) has none, so a `tools` fetch of that post drops it.
const IMAGE_TOOLS = {
  8001: [41, 42],
  8002: [42],
  8003: [41, 42, 43],
  8006: [41],
  8007: [42, 41],
  8101: [42],
  8102: [41],
  8103: [42, 43],
  8104: [41, 42],
  8202: [42],
  8203: [42],
  8204: [42],
};
const toolIdsOf = (id) => IMAGE_TOOLS[id] ?? [];
// ImageTechnique rows: imageId -> its technique ids (the `techniques` filter). An image not listed has
// none.
const IMAGE_TECHNIQUES = {
  8001: [3],
  8003: [3, 4],
  8006: [4],
  8007: [3],
  8101: [3],
  8104: [4],
};
const techniqueIdsOf = (id) => IMAGE_TECHNIQUES[id] ?? [];
// Metric hashes (metrics:Image:<id>), as the watcher writes them.
function metricsOf(id) {
  const n = id % 100;
  return {
    Like: String((n * 7) % 23),
    Heart: String((n * 3) % 11),
    Laugh: String(n % 4),
    Cry: String(n % 2),
    commentCount: String((n * 5) % 13),
    Collection: String((n * 11) % 17),
    tippedAmount: String((n * 13) % 50),
    _populatedAt: POPULATED_AT,
  };
}
const REVIEWS = [
  { id: 4001, userId: 1001, modelId: 5001, modelVersionId: 6001, rating: 5, details: 'Synthetic review', recommended: true, postId: null },
  { id: 4002, userId: 1001, modelId: 5001, modelVersionId: 6001, rating: 3, details: null, recommended: false, postId: null },
  { id: 4003, userId: 1002, modelId: 5001, modelVersionId: 6002, rating: 4, details: null, recommended: true, postId: null },
];
const REACTIONS = [
  { imageId: 8001, userId: 1003, reaction: 'Like' },
  { imageId: 8001, userId: 1003, reaction: 'Heart' },
  { imageId: 8007, userId: 1003, reaction: 'Laugh' },
];
const PLACEMENTS = [
  {
    id: 9501,
    surface: 'galleryPromotion',
    targetType: 'model',
    targetId: 5005,
    status: 'approved',
    resolvedAt: new Date('2026-06-14T10:00:00.000Z'),
    data: { postId: 7201, days: 7, modelVersionIds: [6401], imageIds: [8201], acceptedLevel: 3, endsAt: '2026-06-21T10:00:00.000Z' },
  },
];
// imageTagsCache (packed:caches:image-tags, src/server/redis/caches.ts): each image's votable tags,
// listImageTagsForImages' rows (imageTagCompositeSelect, score desc then tagId asc), grouped by image.
// Every other image's entry is a notFound marker (the lookup found no ImageTag row for it).
const IMAGE_TAGS = {
  8001: [
    { tagId: 531, tagName: 'golden_fox', tagType: 'UserGenerated', score: 12, upVotes: 2, downVotes: 0, tagNsfwLevel: 1, automated: false, needsReview: false, concrete: true, lastUpvote: new Date('2026-06-12T09:30:00.000Z'), source: 'User' },
    { tagId: 532, tagName: 'forest', tagType: 'Label', score: 7.5, upVotes: 0, downVotes: 1, tagNsfwLevel: 1, automated: true, needsReview: null, concrete: true, lastUpvote: null, source: 'WD14' },
  ],
  8003: [
    { tagId: 533, tagName: 'sunset', tagType: 'Label', score: 0, upVotes: 0, downVotes: 0, tagNsfwLevel: 2, automated: true, needsReview: false, concrete: true, lastUpvote: null, source: 'Rekognition' },
  ],
  8007: [
    { tagId: 531, tagName: 'golden_fox', tagType: 'UserGenerated', score: 3, upVotes: 1, downVotes: 0, tagNsfwLevel: 1, automated: false, needsReview: false, concrete: true, lastUpvote: new Date('2026-06-10T18:00:00.125Z'), source: 'User' },
  ],
};
// TagsOnImageVote rows: what the handler merges as `vote` for a signed-in viewer. 1003's vote on 8007
// names a tag 8007 does not carry; 1001's are another viewer's.
const TAG_VOTES = [
  { imageId: 8001, tagId: 531, userId: 1003, vote: 1 },
  { imageId: 8001, tagId: 532, userId: 1003, vote: -1 },
  { imageId: 8007, tagId: 999, userId: 1003, vote: 1 },
  { imageId: 8007, tagId: 531, userId: 1001, vote: 1 },
];
// userFollowsCache (packed:caches:user-follows, src/server/redis/caches.ts): each user's followed
// creators, the lookupFn's `{userId, follows}`. 1003 follows 1002 only; every other user's entry is a
// notFound marker (the lookup found no Follow row).
const USER_FOLLOWS = {
  1003: [1002],
};
// system:blocked-browsing-tags (cache cluster): getBlockedBrowsingTags' list. Synthetic names; the
// ids are two of BLOCKED_BROWSING_TAG_IDS (src/shared/constants/browsing-settings-addons.ts).
const BLOCKED_TAGS = [
  { id: 5161, name: 'blocked_one' },
  { id: 5351, name: 'blocked_two' },
];
// system:browsing-setting-addons (system redis).
const ADDONS = [
  { type: 'some', nsfwLevels: [4, 8, 16], disableMinor: true, excludedTagIds: [9911] },
  { type: 'some', nsfwLevels: [1, 2, 4, 8, 16], disablePoi: true, excludedTagIds: [9901] },
];
// ADDONS without its minor exclusion: what a fixture of the minor content rule reads (`spec.addons`),
// so that no `disableMinor` hides a minor-flagged image and the rule alone decides on it.
const ADDONS_NO_MINOR = [ADDONS[1]];
// ADDONS plus an entry scoped to the "new & upcoming" boards (`scope: 'newCreators'`): it applies only
// to a `newCreators` request (resolveBrowsingSettingsAddons' scope), so a request that resolved the
// addons without the scope answers without its excluded tag.
const ADDONS_NEW_CREATORS = [...ADDONS, { type: 'some', nsfwLevels: [1, 2, 4, 8, 16], scope: 'newCreators', excludedTagIds: [9921] }];
// packed:caches:new-creators:<boardId> (getNewCreatorUserIds' fetchThroughCache entry): each board's
// creators in board order. `cachedAt` is a number (Date.now()), fresh within the hour's ttl.
const NEW_CREATOR_BOARDS = { 'images-new': [1002], 'images-new-red': [1001, 1002] };
const NEW_CREATORS_CACHED_AT = NOW.getTime() - 10 * 60_000;

// ---------------------------------------------------------------------------------------------
// Redis: the world's cache entries, as Node writes them ({...result, cachedAt}, or a marker)
// ---------------------------------------------------------------------------------------------
const K = {
  basic: 'packed:caches:basic-users',
  userCosmetics: 'packed:caches:user-cosmetics',
  cosmetics: 'packed:caches:cosmetics2',
  profile: 'packed:caches:profile-pictures:v4',
  frames: 'packed:caches:cosmetics2:Image',
  events: 'packed:caches:cosmetics2:event:v2:Image',
  thumbs: 'packed:caches:thumbnails',
  tagIds: 'packed:caches:tag-ids-for-images',
  resources: 'packed:caches:image-resources',
  postVersion: 'model:gallery-settings:post-version',
  versionModel: 'model:gallery-settings:version-model',
  session: 'session:data2',
  meta: 'packed:caches:image-meta',
  imageTags: 'packed:caches:image-tags',
  userFollows: 'packed:caches:user-follows',
  newCreators: 'packed:caches:new-creators',
};
const notFound = (idKey, id) => ({ [idKey]: id, notFound: true, cachedAt: CACHED_AT });
const entry = (v) => ({ ...v, cachedAt: CACHED_AT });

/** The packed value Node holds at `${prefix}:${id}`, or undefined (no key). */
function worldPacked(prefix, id) {
  switch (prefix) {
    case K.basic:
      return USERS[id] ? entry(USERS[id]) : undefined;
    case K.userCosmetics:
      return USER_COSMETICS[id] ? entry({ userId: id, cosmetics: USER_COSMETICS[id] }) : notFound('userId', id);
    case K.cosmetics:
      return COSMETICS[id] ? entry(COSMETICS[id]) : undefined;
    case K.profile:
      return PROFILE_PICTURES[id] ? entry(PROFILE_PICTURES[id]) : notFound('userId', id);
    case K.frames:
      return FRAMES[id] ? entry(FRAMES[id]) : notFound('equippedToId', id);
    case K.events:
      return EVENT_DECORATIONS[id] ? entry(EVENT_DECORATIONS[id]) : notFound('equippedToId', id);
    case K.thumbs:
      return THUMBNAILS[id] ? entry(THUMBNAILS[id]) : notFound('parentId', id);
    case K.tagIds:
      return IMAGES[id] ? entry({ imageId: id, tags: tagIdsOf(id) }) : undefined;
    case K.resources: {
      const list = RESOURCES[id] ?? [];
      if (!list.length) return notFound('imageId', id);
      return entry({
        imageId: id,
        resources: list.map((r) => {
          const modelId = VERSIONS[r.modelVersionId] ?? 5999;
          return {
            imageId: id,
            modelVersionId: r.modelVersionId,
            strength: r.detected ? null : 0.8,
            detected: r.detected,
            modelId,
            modelName: `Golden model ${modelId}`,
            modelType: r.detected ? 'Checkpoint' : 'LORA',
            versionName: `v${r.modelVersionId}`,
            baseModel: r.detected ? 'SDXL 1.0' : 'Pony',
            poi: false,
            minor: false,
          };
        }),
      });
    }
    case K.postVersion:
      return POSTS[id] ? entry({ id, modelVersionId: POSTS[id].modelVersionId }) : undefined;
    case K.versionModel:
      return VERSIONS[id] ? entry({ id, modelId: VERSIONS[id] }) : undefined;
    case K.session:
      return SESSIONS[id];
    case K.userFollows:
      if (!USERS[id]) return undefined;
      return USER_FOLLOWS[id] ? entry({ userId: id, follows: USER_FOLLOWS[id] }) : notFound('userId', id);
    case K.imageTags:
      if (!IMAGES[id]) return undefined;
      return IMAGE_TAGS[id] ? entry({ imageId: id, tags: IMAGE_TAGS[id] }) : notFound('imageId', id);
    case K.meta:
      if (META_NOT_FOUND.has(id)) return notFound('id', id);
      return IMAGES[id] ? entry({ id, meta: metaOf(id) }) : undefined;
  }
  throw new Error(`unknown cache ${prefix}`);
}

// ---------------------------------------------------------------------------------------------
// The Node mirror. Reads are traced so each fixture carries exactly the keys and rows Node read.
// ---------------------------------------------------------------------------------------------
class Trace {
  constructor(fixture) {
    this.fixture = fixture;
    this.packed = new Map(); // "prefix:id" -> value
    this.raw = new Map(); // key -> string
    this.hashes = new Map(); // key -> hash
    this.feed = []; // { query, status, body }
    this.posts = new Set(); // post ids whose rows the db fixture must hold
    this.models = new Set();
    this.cold = new Set(); // "prefix:id" keys the fixture holds absent (a cache miss)
    this.coldRead = new Set(); // the cold keys the mirror read (each must be)
    this.writes = new Map(); // key -> what Node writes on the miss ({value, ex})
    this.techniquesRead = false; // a query filtered by `techniques`: the tables then carry each image's technique rows
    this.techniquesCandidatePosts = new Set(); // posts of every row a techniques query matches without its techniques clause
    this.tagsRead = false; // a query filtered by `tags`: the tables then carry each image's tag rows
    this.tagsCandidatePosts = new Set(); // posts of every row a tags query matches without its tags clause
    this.toolsRead = false; // a query filtered by `tools`: the tables then carry each image's tool rows
    this.toolsCandidatePosts = new Set(); // posts of every row a tools query matches without its tools clause
    this.baseModelsRead = false; // a query filtered by `baseModels`: the tables then carry each version's baseModel
    this.baseModelsCandidatePosts = new Set(); // posts of every row such a query matches without that clause
    this.tagVotesRead = false; // the viewer's TagsOnImageVote rows were read (include 'tags', signed in)
    this.followedRead = false; // a query filtered by the viewer's follow list (`followed`, signed in)
    this.followedCandidatePosts = new Set(); // posts of every row such a query matches without that clause
    this.collectionIds = new Set(); // collections a request reads (`collectionId`): their rows and items are in the tables
    this.systemPostReads = new Set(); // versions whose system-user post Node looked up (hasSystemPosts)
    this.newCreatorBoards = undefined; // a fixture's own board entries (spec.newCreatorBoards), by board id
    this.hubIds = new Set(); // hubs a request reads (`hubId`): their rows and sources are in the tables
  }
}
let T; // the fixture being traced

function sizeOf(o) {
  return Object.keys(o).length;
}

/** createCachedObject.fetch over the world (packages/civitai-redis/src/cached-array.ts): hits by
 *  idKey, notFound markers skipped (or, with `negative` false, read as misses), cachedAt stripped. A
 *  key the fixture holds cold (absent) is a miss: with `lookup` (the cache's lookupFn, transcribed)
 *  it is looked up and written back as fetch writes it — `{...result, cachedAt}` with EX `ttl`, or
 *  the `{[idKey]: id, notFound: true, cachedAt}` marker with EX `notFoundTtl ?? ttl` when `negative`
 *  — and recorded in T.writes; without one it fails (the fixture must hold every key it reads). */
function cacheFetch(prefix, ids, { appendFn, lookup, idKey, ttl, notFoundTtl, negative = true } = {}) {
  const out = {};
  const misses = [];
  const markers = new Set();
  for (const id of [...new Set(ids)]) {
    const key = `${prefix}:${id}`;
    const v = T.cold.has(key) ? undefined : worldPacked(prefix, id);
    if (v === undefined) {
      if (!lookup) throw new Error(`fixture ${T.fixture}: cache miss ${key}`);
      T.coldRead.add(key);
      misses.push(id);
      continue;
    }
    T.packed.set(key, v);
    if (v.notFound) {
      if (!negative && lookup) {
        markers.add(id);
        misses.push(id);
      }
      continue;
    }
    if (v.debounce) throw new Error('debounce marker not modelled');
    const { cachedAt: _c, ...rest } = structuredClone(v);
    out[id] = rest;
  }
  if (misses.length) {
    const results = lookup(misses);
    for (const id of misses) {
      const key = `${prefix}:${id}`;
      const result = results[id];
      if (!result) {
        if (negative && !markers.has(id)) T.writes.set(key, { value: { [idKey]: id, notFound: true, cachedAt: NOW }, ex: notFoundTtl ?? ttl });
        continue;
      }
      // A marker read while `negative` is off is overwritten by Node's plain SET; feed-go's SET NX
      // leaves it. No fixture world holds that case.
      if (markers.has(id)) throw new Error(`fixture ${T.fixture}: ${key} marker over a found row is not modelled`);
      out[id] = result;
      T.writes.set(key, { value: mark({ ...result, cachedAt: NOW }), ex: ttl });
    }
  }
  if (appendFn) appendFn(out);
  return out;
}

const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;

/** getUserCollectionPermissionsById (src/server/services/collection.service.ts), its `read` flag only:
 *  Public or Unlisted, then (signed in) the owner, a moderator, a contributor row holding VIEW. A
 *  collection that does not exist reads for no one (createEmptyPermissions). */
function getUserCollectionPermissionsById({ id, userId, isModerator }) {
  T.collectionIds.add(id);
  const collection = COLLECTIONS[id];
  if (!collection) return { read: false };
  const permissions = { read: collection.read === 'Public' || collection.read === 'Unlisted' };
  if (!userId) return permissions;
  if (userId === collection.userId) permissions.read = true;
  if (isModerator && userId !== collection.userId) permissions.read = true;
  const contributor = collection.contributors.find((c) => c.userId === userId);
  if (contributor && userId !== collection.userId && contributor.permissions.includes('VIEW')) permissions.read = true;
  return permissions;
}

/** parseJudgeScore (src/server/games/daily-challenge/daily-challenge.utils.ts). */
function parseJudgeScore(note) {
  if (!note) return null;
  try {
    const parsed = JSON.parse(note);
    return parsed?.score ?? null;
  } catch {
    return null;
  }
}

/** getNewCreatorUserIds({ entity: 'images', domain }) (new-creators.service.ts): the board of the
 *  request's board color through fetchThroughCache, a fresh entry served as cached. */
function getNewCreatorUserIds(domain) {
  const boardId = domain === 'red' ? 'images-new-red' : 'images-new';
  const key = `${K.newCreators}:${boardId}`;
  const value = T.newCreatorBoards?.[boardId] ?? { data: NEW_CREATOR_BOARDS[boardId], cachedAt: NEW_CREATORS_CACHED_AT };
  T.packed.set(key, value);
  if (!(NOW.getTime() - 3600 * 1000 <= value.cachedAt)) throw new Error('an expired board is refreshed: not a served shape');
  return value.data;
}
/** getRequestBoardDomainColor (server-domain.ts) over the fixture hosts: each host is its color's
 *  primary and no alias, so the host's own color (red for the red host). */
const boardColorOf = (host) => Object.entries(HOST).find(([, h]) => h === host)?.[0];

/** getUserFollows (src/server/redis/caches.ts): `userFollows[userId]?.follows ?? []`. */
function getUserFollows(userId) {
  return cacheFetch(K.userFollows, [userId])[userId]?.follows ?? [];
}

// --- the lookupFns (src/server/redis/caches.ts) over the world tables ---------------------------
function isListingDisplayable(listing) {
  // packages/civitai-shared/src/knights-shop.ts
  if (listing.status === 'Published') return true;
  const meta = listing.meta;
  if (meta?.takedown) return false;
  if (meta?.displayApproved !== undefined) return meta.displayApproved;
  const history = meta?.history ?? [];
  let index = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].kind === 'reviewed') {
      index = i;
      break;
    }
  }
  const approved = index >= 0 ? history[index].action === 'approve' : meta?.lastApprovedAmount != null && !listing.rejectionReason;
  const DISPLAYED_FIELDS = new Set(['name', 'description', 'artwork', 'offsets', 'slug']);
  return approved && !history.slice(index + 1).some((entry) => entry.changes?.some((change) => DISPLAYED_FIELDS.has(change.field)));
}

/** getWithheldCosmeticIds (src/server/services/creator-shop-withheld.ts). */
function getWithheldCosmeticIds(cosmeticIds) {
  const withheld = new Set();
  if (!cosmeticIds.length) return withheld;
  const unique = [...new Set(cosmeticIds)];
  const listings = SHOP_ITEMS.filter((x) => unique.includes(x.cosmeticId)).map((x) => ({
    ...x,
    meta: prismaJson(x.meta),
    cosmetic: { createdById: COSMETIC_CREATORS[x.cosmeticId] ?? null },
  }));
  const displayable = new Set();
  for (const { cosmeticId, addedById, cosmetic, status, meta, rejectionReason } of listings) {
    if (cosmeticId == null || cosmetic?.createdById == null || addedById !== cosmetic.createdById) continue;
    const shown = isListingDisplayable({ status, meta, rejectionReason });
    (shown ? displayable : withheld).add(cosmeticId);
  }
  for (const id of displayable) withheld.delete(id);
  const unlisted = unique.filter((id) => !displayable.has(id) && !withheld.has(id));
  if (unlisted.length) {
    const tombstoned = unlisted.filter((id) => COSMETIC_CREATORS[id] != null).map((id) => ({ id, flags: COSMETICS[id]?.flags ?? 0 }));
    for (const { id, flags } of tombstoned) if ((flags | 4) === flags) withheld.add(id);
  }
  return withheld;
}

/** userCosmeticCache's lookupFn. */
function lookupUserCosmetics(ids) {
  const equipped = USER_COSMETIC_ROWS.filter((r) => ids.includes(r.userId) && r.equippedAt !== null && r.equippedToId === null).map((r) => ({
    userId: r.userId,
    cosmeticId: r.cosmeticId,
    data: prismaJson(r.data),
  }));
  const withheld = getWithheldCosmeticIds(equipped.map((x) => x.cosmeticId));
  return equipped
    .filter((x) => !withheld.has(x.cosmeticId))
    .reduce((acc, { userId, cosmeticId, data }) => {
      acc[userId] ??= { userId, cosmetics: [] };
      acc[userId].cosmetics.push({ cosmeticId, data });
      return acc;
    }, {});
}

const isEventData = (data) => !!data && typeof data === 'object' && typeof data.event === 'string';

/** cosmeticEntityCaches.Image's lookupFn (its appendFn is the join getAllImagesUncaptured runs). */
function lookupImageFrames(ids) {
  const entityCosmetics = USER_COSMETIC_ROWS.filter(
    (r) => ids.includes(r.equippedToId) && r.equippedToType === 'Image' && !isEventData(COSMETICS[r.cosmeticId].data)
  ).map((r) => ({ cosmeticId: r.cosmeticId, equippedToId: r.equippedToId, userData: prismaJson(r.data), createdById: COSMETIC_CREATORS[r.cosmeticId] ?? null }));
  const withheld = getWithheldCosmeticIds(entityCosmetics.filter((x) => x.createdById != null).map((x) => x.cosmeticId));
  return Object.fromEntries(entityCosmetics.filter((x) => !withheld.has(x.cosmeticId)).map(({ createdById: _, ...x }) => [x.equippedToId, x]));
}

/** eventDecorationEntityCaches.Image's lookupFn. */
function lookupImageEvents(ids) {
  const rows = USER_COSMETIC_ROWS.filter((r) => ids.includes(r.equippedToId) && r.equippedToType === 'Image' && isEventData(COSMETICS[r.cosmeticId].data));
  const cosmetics = cacheFetch(K.cosmetics, [...new Set(rows.map((x) => x.cosmeticId))]);
  const result = {};
  for (const row of rows) {
    const cosmetic = cosmetics[row.cosmeticId];
    if (!cosmetic || !isEventData(cosmetic.data)) continue;
    result[row.equippedToId] = {
      id: cosmetic.id,
      name: cosmetic.name,
      type: cosmetic.type,
      source: cosmetic.source,
      data: cosmetic.data,
      equippedToId: row.equippedToId,
      equippedToType: 'Image',
      userId: row.userId,
    };
  }
  return result;
}

/** imageMetaCache's lookupFn: `{ id, meta }` per image found, its meta NULL when it hides it. */
function lookupImageMeta(ids) {
  return Object.fromEntries(ids.filter((id) => IMAGES[id]).map((id) => [id, { id, meta: metaOf(id) }]));
}

// frame-cache-negative, as the fixtures run it (feed-go's FEED_GO_FRAME_CACHE_NEGATIVE default):
// off, so a frame marker is a miss and none is written.
const FRAME_CACHE_NEGATIVE = false;

const FLAGS = { PG: 1, PG13: 2, R: 4, X: 8, XXX: 16, Blocked: 32 };
const allBrowsingLevelsFlag = 31;
const sfwBrowsingLevelsFlag = 3;
const nsfwBrowsingLevelsFlag = 4 | 8 | 16 | 32;
const publicBrowsingLevelsFlag = 1;
const onlySelectableLevels = (l) => l & ~FLAGS.Blocked;
const intersection = (a, b) => a & b;

/** resolveBrowsingSettingsAddons (src/shared/constants/browsing-settings-addons.ts). */
function resolveAddons(data, browsingLevel, { isModerator, scope } = {}) {
  const acc = { disablePoi: false, disableMinor: false, excludedTagIds: [] };
  if (isModerator) return acc;
  for (const elem of data) {
    // An entry with a scope applies only to that surface (BROWSING_ADDON_SCOPES: 'newCreators').
    if (elem.scope && (elem.scope !== 'newCreators' || elem.scope !== scope)) continue;
    const levels = elem.nsfwLevels.filter((l) => l > 0 && (l & (l - 1)) === 0).reduce((a, b) => a | b, 0);
    const inter = browsingLevel & levels;
    let apply = false;
    if (elem.type === 'some') apply = inter !== 0;
    if (elem.type === 'all') apply = inter === levels;
    if (elem.type === 'none') apply = inter === 0;
    if (!apply) continue;
    if (elem.disablePoi !== undefined) acc.disablePoi = elem.disablePoi;
    if (elem.disableMinor !== undefined) acc.disableMinor = elem.disableMinor;
    acc.excludedTagIds.push(...(elem.excludedTagIds ?? []));
  }
  return acc;
}

/** getBrowsingSettingAddons: the system key, read raw. */
function getAddons() {
  T.raw.set('sys:system:browsing-setting-addons', JSON.stringify(T.addons));
  return T.addons;
}

/** getBlockedBrowsingTags (system-cache.ts): the cache key, read raw. Node reads it on every call;
 *  the trace records it only when a tag scope is stripped against it (the gallery and REST fixtures
 *  send none, and feed-go reads it only then). */
function getBlockedTags() {
  T.raw.set('system:blocked-browsing-tags', JSON.stringify(BLOCKED_TAGS));
  return BLOCKED_TAGS;
}

/** enforceBlockedBrowsingTags (blocked-browsing-tags.service.ts), in place: W2 strips blocked ids
 *  from `tags` (all of them blocked: an empty result), W1 the addon exclusions. */
function enforceBlockedBrowsingTags(input, viewer) {
  if (input.tags?.length) {
    const blocked = new Set(getBlockedTags().map((t) => t.id));
    const filtered = input.tags.filter((id) => !blocked.has(id));
    if (!filtered.length) return { emptyResult: true };
    input.tags = filtered;
  }
  const addons = getAddons();
  const level = onlySelectableLevels(input.browsingLevel || publicBrowsingLevelsFlag) || publicBrowsingLevelsFlag;
  const resolved = resolveAddons(addons, level, { isModerator: viewer.isModerator, scope: input.newCreators ? 'newCreators' : undefined });
  input.disablePoi = input.disablePoi || resolved.disablePoi;
  input.disableMinor = input.disableMinor || resolved.disableMinor;
  const isOwnScoped = input.userId
    ? !!(viewer.id && viewer.id === input.userId)
    : !!viewer.username && !!input.username && viewer.username.toLowerCase() === input.username.toLowerCase();
  if (!isOwnScoped && resolved.excludedTagIds.length)
    input.excludedTagIds = [...new Set([...(input.excludedTagIds ?? []), ...resolved.excludedTagIds])];
  return { emptyResult: false };
}

const CHALLENGE_TAG_ID = 676575;
function applyHideChallengesExclusion(input) {
  if (!input.hideChallenges) return;
  input.excludedTagIds = [...new Set([...(input.excludedTagIds ?? []), CHALLENGE_TAG_ID])];
}

// --- mapSearchInputToFeedQuery (feed-shadow.service.ts), the branches these inputs reach --------
const SORTS = { 'Most Reactions': 'reactions', 'Most Collected': 'collected', 'Most Comments': 'comments', Newest: 'newest', Oldest: 'oldest' };
const PERIOD_DAYS = { Day: 1, Week: 7, Month: 30, Year: 365, AllTime: undefined };
const LEVELS = [1, 2, 4, 8, 16, 32];
const present = (v) => !(v === undefined || v === null || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0));
const ints = (v) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : []);
const FEED_CURSOR_RE = /^feed:(\d{1,16}):(\d{1,12})$/;
const parseFeedCursor = (c) => {
  const m = typeof c === 'string' ? FEED_CURSOR_RE.exec(c) : null;
  return m ? `${m[1]}|${m[2]}` : undefined;
};
const encodeFeedCursor = (next) => `feed:${next.replace('|', ':')}`;

function mapSearchInputToFeedQuery(input, mode, caller) {
  const skip = (reason) => ({ ok: false, reason });
  for (const key of ['collectionId', 'collectionTagId', 'reviewId', 'prioritizedUserIds', 'imageId', 'generation', 'reactions', 'blockedFor', 'remixOfId'])
    if (present(input[key])) return skip(`input:${key}`);
  for (const flag of ['hidden', 'requiringMeta', 'pending', 'publishedOnly', 'remixesOnly', 'nonRemixesOnly'])
    if (input[flag] === true) return skip(`flag:${flag}`);
  const postIds = ints([...(Array.isArray(input.postIds) ? input.postIds : []), ...(present(input.postId) ? [Number(input.postId)] : [])]);
  if (postIds.length) {
    const inRequestedSort = caller === 'rest' || input.postIdsInRequestedSort === true;
    if (!inRequestedSort) return skip('input:postId');
    if (postIds.length > 50) return skip('postIds>50');
    if (input.postIdsInRequestedSort === true && typeof input.limit === 'number' && input.limit > 200) return skip('postIds:limit>200');
  }
  // Signed out, the search path drops the flag and serves the global feed.
  const followedOn = input.followed === true && present(input.currentUserId);
  const followed = followedOn ? input.followedUserIds : undefined;
  if (followedOn) {
    if (!Array.isArray(followed)) return skip('flag:followed');
    if (followed.length > 10_000) return skip('followed>10000');
    if (present(input.userId)) return skip('flag:followed:userId');
  }
  const newCreators = input.newCreators === true ? input.newCreatorUserIds : undefined;
  if (input.newCreators === true) {
    if (!Array.isArray(newCreators)) return skip('flag:newCreators');
    if (newCreators.length > 10_000) return skip('newCreators>10000');
    if (present(input.userId) || input.followed === true) return skip('flag:newCreators:userId');
  }
  const hub = present(input.hubId) ? mapHubSources(input) : undefined;
  if (hub && !hub.ok) return skip(hub.reason);
  const sort = SORTS[String(input.sort)];
  if (!sort) return skip(`sort:${String(input.sort || 'none')}`);
  const period = String(input.period ?? 'AllTime');
  if (!(period in PERIOD_DAYS)) return skip(`period:${period}`);
  const mask = typeof input.browsingLevel === 'number' ? input.browsingLevel : 1;
  const levels = LEVELS.filter((l) => (mask & l) !== 0);
  if (!levels.length) return skip('browsingLevel:0');
  for (const key of ['tags', 'ids']) if (Array.isArray(input[key]) && input[key].length > 0 && ints(input[key]).length === 0) return skip(`${key}:none`);
  const tags = ints(input.tags);
  const excludedTags = ints(input.excludedTagIds);
  if (tags.length > 100) return skip('tags>100');
  if (excludedTags.length > 100) return skip('excludedTags>100');
  const types = Array.isArray(input.types) ? input.types.map(String) : [];
  if (types.some((t) => !['image', 'video', 'audio'].includes(t))) return skip(`types:${types.join(',')}`);
  let versionIds;
  if (present(input.modelVersionId)) versionIds = [Number(input.modelVersionId)];
  else if (present(input.modelId)) return skip('modelId');
  const userId = present(input.userId) ? Number(input.userId) : undefined;
  let offset = 0;
  let before;
  const cursor = input.cursor;
  const feedCursor = parseFeedCursor(cursor);
  if (feedCursor) {
    if (mode !== 'primary') return skip('cursor:feed');
  } else if (typeof cursor === 'string' && cursor) {
    const m = /^(\d{1,12})(?:\|(\d{1,15}))?$/.exec(cursor);
    if (!m) return skip('cursor:unparsed');
    offset = Number(m[1]);
    if (m[2]) before = Math.floor(Number(m[2]) / 60_000) * 60_000;
  } else if (typeof cursor === 'number' && Number.isInteger(cursor) && cursor >= 0) offset = cursor;
  else if (cursor) return skip('cursor:unparsed');
  if (typeof input.offset === 'number' && input.offset > 0) offset = Math.max(offset, input.offset);
  if (offset > 20_000) return skip('offset>20000');
  const keyset = feedCursor;

  const params = new URLSearchParams();
  params.set('levels', levels.join(','));
  if (tags.length) params.set('tags', tags.join(','));
  if (excludedTags.length) params.set('excludedTags', excludedTags.join(','));
  // The hub's own refusals first: the list is cut at the feed's limit.
  const excludedUsers = [...new Set([...(hub?.excludedUserIds ?? []), ...ints(input.excludedUserIds)])];
  if (excludedUsers.length) params.set('excludedUserIds', excludedUsers.slice(0, 1000).join(','));
  if (hub) for (const [key, value] of hub.params) params.set(key, value);
  if (versionIds) params.set('versionIds', versionIds.join(','));
  if (userId) params.set('userIds', String(userId));
  const followedIds = ints(followed);
  if (followedIds.length) params.set('userIds', followedIds.join(','));
  const newCreatorIds = ints(newCreators);
  if (newCreatorIds.length) params.set('userIds', newCreatorIds.join(','));
  if (types.length) params.set('types', types.join(','));
  if (input.withMeta === true) params.set('withMeta', '1');
  if (input.fromPlatform === true) params.set('fromPlatform', '1');
  if (input.disableMinor === true) params.set('excludeMinor', '1');
  if (input.disablePoi === true) {
    params.set('excludePoi', '1');
    if (present(input.currentUserId)) params.set('viewerId', String(input.currentUserId));
  }
  const baseModels = Array.isArray(input.baseModels) ? input.baseModels.map(String).filter(Boolean) : [];
  if (baseModels.length) params.set('baseModels', baseModels.join(','));
  const tools = ints(input.tools);
  if (tools.length) params.set('tools', tools.join(','));
  const techniques = ints(input.techniques);
  if (techniques.length) params.set('techniques', techniques.join(','));
  if (postIds.length) params.set('postIds', [...new Set(postIds)].join(','));
  if (present(input.model3dId)) params.set('model3dIds', String(input.model3dId));
  params.set('sort', sort);
  const days = PERIOD_DAYS[period];
  if (days) params.set('periodDays', String(days));
  const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(input.limit, 200) : 100;
  params.set('limit', String(limit));
  if (keyset) params.set('cursor', keyset);
  else if (offset) params.set('offset', String(offset));
  if (before && sort === 'newest') params.set('before', String(before));
  return { ok: true, query: params.toString() };
}

/** fetchFeedPrimary: the fixture's answer for this exact query. */
function fetchFeed(query) {
  const reply = T.replies[query];
  if (!reply) throw new Error(`fixture ${T.fixture}: no feed reply for query\n  ${query}`);
  T.feed.push({ query, status: reply.status ?? 200, body: reply.body });
  T.usedReplies.add(query);
  if ((reply.status ?? 200) !== 200) return { status: reply.status, ids: [] };
  return {
    status: 200,
    ids: ints(reply.body.items),
    nextCursor: typeof reply.body.nextCursor === 'string' ? reply.body.nextCursor : undefined,
    route: reply.body.route,
  };
}

const HUB_ROUTES = new Set(['union-walk', 'union-gather', 'empty']);

/** serveFromFeed (feed-primary.service.ts) for a feed without degrade. */
function serveFromFeed(input, { hydrate, route }) {
  // A follow list with no creators, an unpopulated new-creators board, or a hub that resolves to
  // nothing for this viewer, is an empty feed, whatever else is set.
  if (
    (input.followed === true && input.followedUserIds?.length === 0) ||
    (input.newCreators === true && input.newCreatorUserIds?.length === 0) ||
    (!!input.hubId && input.hubSources === null)
  )
    return { ok: true, page: { data: [], nextCursor: undefined } };
  const mapping = mapSearchInputToFeedQuery(input, 'primary', route);
  if (!mapping.ok && (mapping.reason === 'tags:none' || mapping.reason === 'ids:none')) return { ok: true, page: { data: [], nextCursor: undefined } };
  if (!mapping.ok) return { ok: false, reason: mapping.reason };
  const answer = fetchFeed(mapping.query);
  if (answer.status !== 200) return { ok: false, reason: `status:${answer.status}` };
  // A feed build without the any-of sources ignores them and answers with the open feed.
  if (input.hubId && !HUB_ROUTES.has(answer.route ?? '')) return { ok: false, reason: 'hub:route' };
  const nextCursor = answer.nextCursor ? encodeFeedCursor(answer.nextCursor) : undefined;
  if (!answer.ids.length) return { ok: true, page: { data: [], nextCursor } };
  const rows = hydrate(answer.ids);
  if (!rows.length) return { ok: false, reason: 'hydrate:empty', nextCursor };
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { ok: true, page: { data: answer.ids.flatMap((id) => (byId.get(id) ? [byId.get(id)] : [])), nextCursor } };
}

function feedHydrateQuery(input, ids) {
  const { cursor, skip, offset, entry, period, jumpTo, modelId, modelVersionId, hubId, hubExcludedSources, ...rest } = input;
  return { ...rest, ids, limit: ids.length, period: 'AllTime', throwOnStatementTimeout: true };
}
const withoutUnservedFilters = (input) => ({ ...input, remixesOnly: undefined, nonRemixesOnly: undefined, hideAutoResources: undefined, hideManualResources: undefined });

function answerWithoutFeed(served) {
  if (served.reason === 'hydrate:empty') return { items: [], nextCursor: served.nextCursor };
  if (['timeout', 'error', 'hydrate:error', 'breaker'].includes(served.reason) || /^status:5\d\d$/.test(served.reason))
    throw new NodeError(503, served.reason);
  if (served.reason.startsWith('sort:') || served.reason === 'offset>20000' || served.reason === 'cursor:unparsed')
    throw new NodeError(400, served.reason);
  return { items: [], nextCursor: undefined };
}
class NodeError extends Error {
  constructor(status, reason) {
    super(`${status} ${reason}`);
    this.status = status;
  }
}

// --- getAllImagesUncaptured: the SQL (over the world), hydration and per-image transform ----------
/** isMinorMatureImage (src/server/common/image-visibility.ts) over isMinorContentRestricted
 *  (packages/civitai-shared/src/minor-content-gate.ts): `minor === true` and a level that is
 *  missing, 0 or at least R. */
const isMinorMatureImage = (i) => i.minor === true && (i.nsfwLevel == null || i.nsfwLevel === 0 || i.nsfwLevel >= FLAGS.R);
/** The rows Node's getAllImages SQL returns, for the clauses these inputs reach. */
function imageSql(q) {
  if (q.techniques?.length) T.techniquesRead = true;
  if (q.tags?.length) T.tagsRead = true;
  if (q.tools?.length) T.toolsRead = true;
  if (q.baseModels?.length) T.baseModelsRead = true;
  const isModerator = !!q.user?.isModerator;
  const userId = q.user?.id;
  // getAllImagesUncaptured's prefetch: `userId && followed ? getUserFollows(userId) : undefined`, and
  // the clause only for a non-empty list.
  const follows = userId && q.followed ? getUserFollows(userId) : undefined;
  if (follows?.length) T.followedRead = true;
  let browsingLevel = onlySelectableLevels(q.browsingLevel ?? 0);
  if (!browsingLevel) browsingLevel = publicBrowsingLevelsFlag;
  // The `ct` CTE: the collection's image items, its tag, ACCEPTED or (signed in) the viewer's own
  // not REJECTED (`ownerId`: a session, as every fixture's viewer is).
  const collectionItems = q.collectionId
    ? COLLECTION_ITEMS.filter(
        (ci) =>
          ci.collectionId === q.collectionId &&
          (!q.collectionTagId || ci.tagId === q.collectionTagId) &&
          ci.imageId != null &&
          (ci.status === 'ACCEPTED' || (userId && ci.status !== 'REJECTED' && ci.addedById === userId))
      )
    : undefined;
  // A collection's Random order (getAllImagesUncaptured): the cursor's `seed:sortKey:id` (three parts
  // of String(cursor); anything else is no cursor at all), the cursor's seed when truthy, else the
  // stored one (the prefetch), each item's seeded sort key, the CTE's strict cursor clause.
  if (q.sort === 'Random' && !q.collectionId) throw new NodeError(400, 'Random sort requires a collectionId');
  const random = q.sort === 'Random' && !!q.collectionId;
  let randomSeed;
  let randomCursor;
  if (random) {
    if (q.cursor) {
      const parts = String(q.cursor).split(':');
      if (parts.length === 3) randomCursor = { seed: Number(parts[0]), sortKey: Number(parts[1]), id: Number(parts[2]) };
    }
    randomSeed = randomCursor?.seed || getCollectionRandomSeed();
    T.randomSeedsUsed.add(String(randomSeed));
  }
  // getAllImagesUncaptured's prefetch of the new-creators board (`newCreators`): `i."userId" IN
  // (board)`, or `1 = 0` for an empty one.
  const board = q.newCreators ? getNewCreatorUserIds(q.domain) : undefined;
  // `userId && reactions?.length`: the viewer's own reactions of those kinds.
  const reactionsOn = !!userId && !!q.reactions?.length;
  // The prioritizeUser branch (the version cache off): no model join; the post's version; for the
  // system user alone without a post of its own on the version, every creator ordered by an IIF,
  // else only those creators ordered oldest post first.
  const prioritized = !!q.prioritizedUserIds?.length;
  const systemAlone = prioritized && q.prioritizedUserIds.length === 1 && q.prioritizedUserIds[0] === -1;
  let hasSystemPosts = false;
  if (systemAlone && q.modelVersionId) {
    // dbRead.post.findFirst({ where: { userId: -1, modelVersionId } }).
    T.systemPostReads.add(q.modelVersionId);
    hasSystemPosts = Object.values(POSTS).some((p) => p.userId === -1 && p.modelVersionId === q.modelVersionId);
  }
  const iifOrder = systemAlone && !hasSystemPosts;
  // `without` names one more filter clause to leave out (the candidate rows below).
  let without;
  const viaVersion = q.modelVersionId || q.modelId;
  const passes = (i, applyTools, applyBaseModels = true) => {
    const p = POSTS[i.postId];
    if (without !== 'ids' && q.ids?.length && !q.ids.includes(i.id)) return false;
    if (q.types?.length && !q.types.includes(i.type)) return false;
    // `(p."publishedAt" < now())`: the owner's scheduled carve-out needs `scheduled` (and no
    // `publishedOnly`), which no fixture sends, so `publishedOnly` changes nothing here.
    if (!(p.publishedAt < NOW)) return false;
    if (!isModerator) {
      if (!((i.availability !== 'Private' && i.ingestion !== 'Blocked') || p.userId === userId)) return false;
      // blockedMediaListConditions({ userId: ownerId }) (src/server/common/image-visibility.ts): an
      // image with a blockedFor reason is moderators' alone, plus its owner's where ownerMediaAllowed
      // allows (imageBlockedForConditions); and the owner's own images only where ownerMediaAllowed
      // allows (ownerMediaSql).
      const ownersOwn = !!userId && i.userId === userId;
      if (!(i.blockedFor === null || (ownersOwn && ownerMediaAllowed(i)))) return false;
      if (ownersOwn && !ownerMediaAllowed(i)) return false;
    }
    if (q.disablePoi && !(i.poi !== true || p.userId === userId)) return false;
    if (q.disableMinor && !(i.minor !== true || (userId && i.userId === userId))) return false;
    // minorMatureImageVisibleSql({ userId: ownerId, isModerator }) (image-visibility.ts): whatever
    // disableMinor says, a restricted minor-flagged image is its owner's and moderators' only.
    if (without !== 'minorMature' && !isModerator && isMinorMatureImage(i) && !(userId && i.userId === userId)) return false;
    if (q.excludedTagIds?.length && tagIdsOf(i.id).some((t) => q.excludedTagIds.includes(t)) && !(userId && i.userId === userId)) return false;
    if (!prioritized && q.modelVersionId && !RESOURCES[i.id].some((r) => r.modelVersionId === q.modelVersionId)) return false;
    if (without !== 'model' && !prioritized && !q.modelVersionId && q.modelId && !RESOURCES[i.id].some((r) => VERSIONS[r.modelVersionId] === q.modelId)) return false;
    if (prioritized && q.modelVersionId && p.modelVersionId !== q.modelVersionId) return false;
    if (without !== 'prioritized' && prioritized && !iifOrder && !q.prioritizedUserIds.includes(i.userId)) return false;
    if (without !== 'reactions' && reactionsOn && !REACTIONS.some((r) => r.userId === userId && r.imageId === i.id && q.reactions.includes(r.reaction))) return false;
    if (q.userId && i.userId !== q.userId) return false;
    // i."userId" IN (follows), after the creator clause.
    if (without !== 'followed' && follows?.length && !follows.includes(i.userId)) return false;
    if (without !== 'newCreators' && board && !board.includes(i.userId)) return false;
    if (without !== 'tags' && q.tags?.length && !tagIdsOf(i.id).some((t) => q.tags.includes(t))) return false;
    // EXISTS (… FROM "ImageTechnique" … "techniqueId" IN (techniques)): any listed technique.
    if (without !== 'techniques' && q.techniques?.length && !techniqueIdsOf(i.id).some((t) => q.techniques.includes(t))) return false;
    if (q.postId && i.postId !== q.postId) return false;
    if (q.postIds?.length && !q.postIds.includes(i.postId)) return false;
    // `if (imageId) AND.push(i.id = imageId)` (the REST endpoint's legacy path).
    if (without !== 'imageId' && q.imageId && i.id !== q.imageId) return false;
    if (q.excludedUserIds?.length && q.excludedUserIds.includes(i.userId)) return false;
    // EXISTS (… FROM "ImageTool" … HAVING array_agg(it."toolId") @> ARRAY[tools]::integer[]): every
    // listed tool on the image; an image with no tool row has no group, so never matches.
    if (applyTools && q.tools?.length && !q.tools.every((t) => toolIdsOf(i.id).includes(t))) return false;
    // EXISTS (SELECT 1 FROM "ModelVersion" mv RIGHT JOIN "ImageResourceNew" ir ON ir."imageId" = i.id
    // AND ir."modelVersionId" = mv.id WHERE mv."baseModel" IN (baseModels)): a resource row on an
    // existing version carrying one of the names (the whole list, an empty name included).
    if (applyBaseModels && q.baseModels?.length && !RESOURCES[i.id].some((r) => r.modelVersionId in VERSION_BASE_MODELS && q.baseModels.includes(VERSION_BASE_MODELS[r.modelVersionId])))
      return false;
    if (i.needsReview !== null) return false;
    // `acceptableMinor = FALSE`; in a collection the image's owner (and a moderator) still sees it.
    if (i.acceptableMinor && (!q.collectionId || (!isModerator && i.userId !== userId))) return false;
    if ((i.nsfwLevel & browsingLevel) === 0 || i.nsfwLevel === 0) return false;
    // `if (requiringMeta) AND.push(i."blockedFor" = AiNotVerified)`, after the gates (which only the red
    // domain drops for it; no fixture sends it there).
    if (without !== 'requiringMeta' && q.requiringMeta && i.blockedFor !== 'AiNotVerified') return false;
    return true;
  };
  let rows = Object.values(IMAGES).filter((i) => passes(i, true));
  // FROM "ImageResourceNew" irr … JOIN "ModelVersion" mv … WHERE mv."modelId" = <model>: one row per
  // resource row on a version of the model, so an image that used two of its versions is listed twice.
  if (!prioritized && !q.modelVersionId && q.modelId)
    rows = rows.flatMap((i) => RESOURCES[i.id].filter((r) => VERSIONS[r.modelVersionId] === q.modelId).map(() => i));
  // JOIN ct ON ct."imageId" = i.id: one row per matching item, with its note, status and adder.
  if (collectionItems)
    rows = rows.flatMap((i) =>
      collectionItems
        .filter((ci) => ci.imageId === i.id)
        .map((ci) => ({ ...i, collectionItemId: ci.id, collectionItemNote: ci.note, collectionItemStatus: ci.status, collectionItemAddedById: ci.addedById, ...(random ? { sortKey: sortKeyOf(ci.id, String(randomSeed)) } : {}) }))
        // The CTE's own cursor clause (`"sortKey" < k OR ("sortKey" = k AND "imageId" < id)`, strict).
        .filter((r) => !randomCursor || r.sortKey < randomCursor.sortKey || (r.sortKey === randomCursor.sortKey && r.id < randomCursor.id))
    );
  // As for `tools` below: every row the query would match without its techniques (or tags) clause.
  for (const key of ['techniques', 'tags']) {
    if (!q[key]?.length) continue;
    without = key;
    for (const i of Object.values(IMAGES)) if (passes(i, true)) T[`${key}CandidatePosts`].add(i.postId);
    without = undefined;
  }
  // Each row the minor content rule alone drops (in a collection, of its items): the fixture's tables
  // must hold it, or a feed-go without the rule would answer the same.
  const shown = new Set(Object.values(IMAGES).filter((i) => passes(i, true)).map((i) => i.id));
  without = 'minorMature';
  for (const i of Object.values(IMAGES))
    if (passes(i, true) && !shown.has(i.id) && (!collectionItems || collectionItems.some((ci) => ci.imageId === i.id))) T.posts.add(i.postId);
  without = undefined;
  // The same for the ids, new-creators, reactions and prioritized-creators clauses: the tables hold every
  // row each alone decides on.
  // (`ids` only as the input's own: the feed hydrate's ids are the feed's page, whose rows are held.)
  // (`imageId`, a version-less model and `requiringMeta` only on the REST endpoint's legacy path, whose
  // fixtures postdate the rest: T.v1Candidates.)
  for (const [key, on] of [
    ['ids', !!q.ids?.length && !q.throwOnStatementTimeout && T.idsCandidates],
    ['newCreators', !!board],
    ['reactions', reactionsOn],
    ['prioritized', prioritized && !iifOrder],
    ['imageId', !!q.imageId && T.v1Candidates],
    ['model', !prioritized && !q.modelVersionId && !!q.modelId && T.v1Candidates],
    ['requiringMeta', !!q.requiringMeta && T.v1Candidates],
  ]) {
    if (!on) continue;
    without = key;
    for (const i of Object.values(IMAGES)) if (passes(i, true)) T.posts.add(i.postId);
    without = undefined;
  }
  // The same for the follow clause.
  if (follows?.length) {
    without = 'followed';
    for (const i of Object.values(IMAGES)) if (passes(i, true)) T.followedCandidatePosts.add(i.postId);
    without = undefined;
  }
  // Every row the same query would match WITHOUT the tools clause (before order, cursor and limit):
  // the fixture's tables must hold them, or a feed-go that dropped the clause would answer the same.
  if (q.tools?.length) for (const i of Object.values(IMAGES)) if (passes(i, false)) T.toolsCandidatePosts.add(i.postId);
  // The same for the baseModels clause.
  if (q.baseModels?.length) for (const i of Object.values(IMAGES)) if (passes(i, true, false)) T.baseModelsCandidatePosts.add(i.postId);
  // A post's own media (`postId` without `modelId`): ORDER BY i."index", i."id", the cursor on the
  // index (getCursor('i."index"'), inclusive), and the index as the cursor column.
  const byIndex = !!q.postId && !q.modelId;
  const asc = q.sort === 'Oldest';
  // Recently Added: ORDER BY ct."collectionItemId" DESC, the cursor on it.
  const byItem = !byIndex && q.sort === 'Recently Added';
  const baseOrder = (a, b) => {
    if (byIndex) return (a.index ?? 0) - (b.index ?? 0) || a.id - b.id;
    if (byItem) return b.collectionItemId - a.collectionItemId;
    return asc ? a.id - b.id : b.id - a.id;
  };
  if (random) rows.sort((a, b) => b.sortKey - a.sortKey || b.id - a.id); // ct."sortKey" DESC, i."id" DESC
  else if (prioritized && !iifOrder) rows.sort((a, b) => a.postId * 100 + (a.index ?? 0) - (b.postId * 100 + (b.index ?? 0)) || a.id - b.id);
  else if (iifOrder) {
    // IIF(i."userId" IN (-1), i.index, 1000), then the sort's own order (no fixture row has a NULL index).
    const iif = (r) => (r.userId === -1 ? r.index : 1000);
    rows.sort((a, b) => iif(a) - iif(b) || baseOrder(a, b));
  } else rows.sort(baseOrder);
  if (q.cursor && !random) {
    // getCursor: a single-field sort's cursor is one integer (parseCursor's parseInt). Random reads
    // its own cursor in the CTE above and never calls getCursor.
    const c = typeof q.cursor === 'string' ? parseInt(q.cursor, 10) : q.cursor;
    if (Number.isNaN(c)) throw new NodeError(400, 'cursor');
    rows = rows.filter((r) => (byIndex ? (r.index ?? 0) >= c : byItem ? r.collectionItemId <= c : asc ? r.id >= c : r.id <= c));
  }
  for (const r of rows) T.posts.add(r.postId);
  void viaVersion;
  const skip = q.skip ?? 0; // OFFSET
  return rows.slice(skip, skip + q.limit + 1).map(({ collectionItemId, sortKey, ...r }) => ({
    ...structuredClone(r),
    // Random: `concat(<seed>::text, ':', ct."sortKey"::text, ':', i."id"::text)`.
    cursorId: random ? `${randomSeed}:${sortKey}:${r.id}` : byIndex ? r.index : byItem ? collectionItemId : r.id,
  }));
}

/** toImageV2Stats(shapeImageMetrics(...)) over MetricService.fetch's parse of the hash. */
function imageStats(id) {
  const key = `metrics:Image:${id}`;
  const hash = metricsOf(id);
  T.hashes.set(key, hash);
  const m = {};
  for (const [k, v] of Object.entries(hash)) if (k !== 'notFound' && k !== '_populatedAt') m[k] = parseInt(v, 10);
  const match = {
    reactionLike: m.Like || null,
    reactionHeart: m.Heart || null,
    reactionLaugh: m.Laugh || null,
    reactionCry: m.Cry || null,
    comment: m.commentCount || null,
    collection: m.Collection || null,
    buzz: m.tippedAmount || null,
  };
  return {
    likeCountAllTime: match.reactionLike ?? 0,
    laughCountAllTime: match.reactionLaugh ?? 0,
    heartCountAllTime: match.reactionHeart ?? 0,
    cryCountAllTime: match.reactionCry ?? 0,
    commentCountAllTime: match.comment ?? 0,
    collectedCountAllTime: match.collection ?? 0,
    tippedAmountCountAllTime: match.buzz ?? 0,
    dislikeCountAllTime: 0,
    viewCountAllTime: 0,
    statsUnknown: !match,
  };
}

function getAllImagesUncaptured(input) {
  const viewer = { id: input.user?.id, username: input.user?.username, isModerator: input.user?.isModerator };
  if (enforceBlockedBrowsingTags(input, viewer).emptyResult) return { nextCursor: undefined, items: [] };
  applyHideChallengesExclusion(input);
  if (input.username && !input.userId) {
    // dbRead, then dbWrite; an unknown name is a 404 (the fixtures name known users only).
    const u = Object.values(USERS).find((x) => x.username === input.username);
    T.usernames.add(input.username);
    if (!u) throw new NodeError(404, 'user');
    input.userId = u.id;
  }
  const { limit, include = [], includeBaseModel } = input;
  const userId = input.user?.id;
  const isModerator = input.user?.isModerator ?? false;
  // The prefetched collection permission: no read is an empty page.
  if (input.collectionId && !getUserCollectionPermissionsById({ userId, isModerator, id: input.collectionId }).read)
    return { nextCursor: undefined, items: [] };
  const includeCosmetics = include.includes('cosmetics');
  const rawImages = imageSql(input);
  const imageIds = rawImages.map((i) => i.id);
  const userIds = rawImages.map((i) => i.userId);
  const videoIds = rawImages.filter((x) => x.type === 'video').map((x) => x.id);
  let nextCursor;
  if (rawImages.length > limit) nextCursor = rawImages.pop().cursorId;
  // The parallel fetch (in rawImages order before the pop; the popped row's ids are fetched too in
  // Node, which reads more keys than it needs — the trace records them).
  const ids = rawImages.map((i) => i.id);
  const uids = rawImages.map((i) => i.userId);
  const vids = rawImages.filter((x) => x.type === 'video').map((x) => x.id);
  void imageIds;
  void userIds;
  void videoIds;
  const userReactions = userId
    ? REACTIONS.filter((r) => r.userId === userId && ids.includes(r.imageId)).reduce((acc, { imageId, reaction }) => {
        (acc[imageId] ??= []).push(reaction);
        return acc;
      }, {})
    : undefined;
  const tagIdsVar = include.includes('tagIds') ? cacheFetch(K.tagIds, ids) : undefined;
  // getImageTagsForImages: imageTagsCache.fetch, each tag `{...tag, imageId, id: tagId, type: tagType,
  // nsfwLevel: tagNsfwLevel, name: tagName}`, flattened in image order.
  let tagsVar;
  if (include.includes('tags')) {
    const tagsByImage = cacheFetch(K.imageTags, ids);
    tagsVar = ids.flatMap(
      (imageId) =>
        tagsByImage[imageId]?.tags.map(({ tagId, tagName, tagType, tagNsfwLevel, ...tag }) => ({
          ...tag,
          imageId,
          id: tagId,
          type: tagType,
          nsfwLevel: tagNsfwLevel,
          name: tagName,
        })) ?? []
    );
  }
  // dbRead.tagsOnImageVote.findMany({ where: { imageId: { in: imageIds }, userId }, select: { imageId, tagId, vote } }).
  let userVotes;
  if (include.includes('tags') && userId) {
    T.tagVotesRead = true;
    userVotes = TAG_VOTES.filter((v) => v.userId === userId && ids.includes(v.imageId)).map(({ imageId, tagId, vote }) => ({ imageId, tagId, vote }));
  }
  const userBasicData = cacheFetch(K.basic, uids);
  let userCosmetics;
  if (includeCosmetics) {
    const uc = cacheFetch(K.userCosmetics, uids, { lookup: lookupUserCosmetics, idKey: 'userId', ttl: DAY });
    const cosmeticIds = [...new Set(Object.values(uc).flatMap((x) => x.cosmetics.map((y) => y.cosmeticId)))];
    const cosmetics = cacheFetch(K.cosmetics, cosmeticIds);
    userCosmetics = Object.fromEntries(Object.values(uc).map((x) => [x.userId, x.cosmetics.map((y) => ({ ...y, cosmetic: cosmetics[y.cosmeticId] }))]));
  }
  const profilePictures = include.includes('profilePictures') ? cacheFetch(K.profile, uids) : undefined;
  let frames;
  if (includeCosmetics) {
    const recs = cacheFetch(K.frames, ids, { lookup: lookupImageFrames, idKey: 'equippedToId', ttl: DAY, notFoundTtl: HOUR, negative: FRAME_CACHE_NEGATIVE });
    const cosmeticIds = [...new Set(Object.values(recs).map((x) => x.cosmeticId))];
    const cosmetics = cosmeticIds.length ? cacheFetch(K.cosmetics, cosmeticIds) : {};
    for (const record of Object.values(recs)) {
      const cosmetic = cosmetics[record.cosmeticId];
      if (!cosmetic) continue;
      record.id = record.cosmeticId;
      delete record.cosmeticId;
      const data = cosmetic.data;
      record.data = record.userData?.lights ? { ...data, lights: record.userData.lights } : data;
      if (record.userData) delete record.userData;
    }
    frames = {};
    for (const [id, frame] of Object.entries(recs)) {
      const { claimKey: _k, ...rest } = frame;
      frames[Number(id)] = rest;
    }
  }
  const thumbnails = vids.length ? cacheFetch(K.thumbs, vids) : {};
  const imageMetrics = Object.fromEntries(ids.map((id) => [id, imageStats(id)]));
  const imageResources = includeBaseModel ? cacheFetch(K.resources, ids) : undefined;
  let eventDecorations = {};
  if (ids.length && T.events.size) {
    const decorations = cacheFetch(K.events, ids, { lookup: lookupImageEvents, idKey: 'equippedToId', ttl: DAY, notFoundTtl: HOUR });
    for (const [id, d] of Object.entries(decorations))
      if (typeof d.data?.event === 'string' && T.events.has(d.data.event)) {
        const { name, type, source, data, equippedToId, equippedToType } = d;
        eventDecorations[Number(id)] = { id: d.id, name, type, source, data, equippedToId, equippedToType };
      }
  }

  // The transform's vote merge and its tagsByImageId index.
  if (tagsVar && userVotes) {
    const voteMap = new Map(userVotes.map((v) => [`${v.imageId}:${v.tagId}`, v.vote]));
    for (const tag of tagsVar) {
      const vote = voteMap.get(`${tag.imageId}:${tag.id}`);
      if (vote !== undefined) tag.vote = vote > 0 ? 1 : -1;
    }
  }
  const tagsByImageId = tagsVar
    ? tagsVar.reduce((acc, tag) => {
        const arr = acc.get(tag.imageId);
        if (arr) arr.push(tag);
        else acc.set(tag.imageId, [tag]);
        return acc;
      }, new Map())
    : undefined;
  const filtered = rawImages.filter((x) => {
    if (isModerator) return true;
    if ((!x.publishedAt || x.publishedAt > NOW || !!x.unpublishedAt) && x.userId !== userId) return false;
    return true;
  });
  const images = filtered.map(({ userId: creatorId, cursorId, unpublishedAt, collectionItemNote, ...i }) => {
    const stats = imageMetrics[i.id];
    const thumbnail = thumbnails[i.id];
    const userData = userBasicData[creatorId];
    const resources = imageResources?.[i.id]?.resources;
    return {
      ...i,
      model3dId: null,
      meta: null,
      // ...feedThumbnailFields(...): `nsfwLevel` overrides in place, `thumbnailUrl` is added here. The
      // creator gets a block-marked thumbnail only where `ownerMediaAllowed` is true (an entry cached
      // without the field counts as false).
      nsfwLevel: Math.max(thumbnail?.nsfwLevel ?? 0, i.nsfwLevel),
      thumbnailUrl:
        thumbnail &&
        (thumbnail.blockMarked === false || (creatorId === userId && thumbnail.ownerMediaAllowed === true) || isModerator)
          ? thumbnail.url
          : undefined,
      modelVersionIds: resources?.filter((r) => r.detected).map((r) => r.modelVersionId) ?? [],
      modelVersionIdsManual: resources?.filter((r) => !r.detected).map((r) => r.modelVersionId) ?? [],
      publishedAt: i.publishedAt ? i.sortAt : undefined,
      baseModel: imageResources ? resources?.find((r) => r.modelType === 'Checkpoint')?.baseModel ?? null : undefined,
      user: {
        id: creatorId,
        username: userData?.username ?? null,
        image: userData?.image ?? null,
        deletedAt: userData?.deletedAt ?? null,
        cosmetics: userCosmetics?.[creatorId] ?? [],
        profilePicture: profilePictures?.[creatorId] ?? null,
      },
      stats,
      reactions: userReactions?.[i.id]?.map((r) => ({ userId, reaction: r })) ?? [],
      tags: tagsByImageId?.get(i.id),
      tagIds: tagIdsVar?.[i.id]?.tags,
      cosmetic: frames?.[i.id] ?? null,
      eventDecoration: eventDecorations?.[i.id] ?? null,
      judgeScore: parseJudgeScore(collectionItemNote ?? null),
    };
  });
  // stripImageForInfiniteWire
  const items = images.map(({ scannedAt, mimeType, postTitle, hideMeta, acceptableMinor, ...rest }) => rest);
  return { nextCursor, items };
}

function getAllImagesIndex(input) {
  const { user } = input;
  // prepareImageFeedRequest.
  if (enforceBlockedBrowsingTags(input, { id: user?.id, username: user?.username, isModerator: user?.isModerator }).emptyResult)
    return { nextCursor: undefined, items: [] };
  applyHideChallengesExclusion(input);
  let userId = input.userId;
  if (userId === undefined && input.username) {
    const u = Object.values(USERS).find((x) => x.username === input.username);
    T.usernames.add(input.username);
    userId = u?.id;
    if (userId === undefined) throw new NodeError(404, 'User not found');
  }
  const cursorParsed = input.cursor?.toString().split('|');
  const isNumber = (v) => v !== undefined && v !== '' && !Number.isNaN(Number(v));
  const offset = isNumber(cursorParsed?.[0]) ? Number(cursorParsed?.[0]) : 0;
  const entry = isNumber(cursorParsed?.[1]) ? Number(cursorParsed?.[1]) : undefined;
  const searchInput = { ...input, userId, currentUserId: user?.id, isModerator: user?.isModerator, offset, entry };
  // serveImagesFromFeedService: the viewer's follow list, signed in only.
  if (searchInput.followed && searchInput.currentUserId) searchInput.followedUserIds = getUserFollows(searchInput.currentUserId);
  if (searchInput.newCreators) searchInput.newCreatorUserIds = getNewCreatorUserIds(searchInput.domain);
  // `{ ...searchInput, followedUserIds, newCreatorUserIds, ...hub }`: the hub's sources, and (when it
  // resolved) the level the feed is asked at; the hydrate below keeps `input`'s own level.
  const hub = searchInput.hubId ? resolveHubForFeed(searchInput) : undefined;
  const served = serveFromFeed(withoutUnservedFilters({ ...searchInput, ...hub }), {
    route: 'website',
    hydrate: (ids) => {
      const q = feedHydrateQuery(input, ids);
      // hydrateWithReadRescue: a non-empty first read is the answer.
      return getAllImagesUncaptured(structuredCloneInput(q)).items;
    },
  });
  if (served.ok) return { items: served.page.data, nextCursor: served.page.nextCursor, source: 'feed' };
  return { ...answerWithoutFeed(served), source: 'feed' };
}

/** Copies an input whose `user` must stay the same object. */
function structuredCloneInput(q) {
  const { user, ...rest } = q;
  return { ...structuredClone(rest), user };
}

const getAllImages = (input) => getAllImagesUncaptured(structuredCloneInput(input));

// --- getImagesAsPostsInfiniteHandler --------------------------------------------------------------
const GALLERY_POST_IMAGE_SLICE = 6;
function buildPostImagesWire(images, { lazy }) {
  const slice = lazy && images.length > GALLERY_POST_IMAGE_SLICE ? images.slice(0, GALLERY_POST_IMAGE_SLICE) : images;
  const wire = slice.map(({ meta, availability, acceptableMinor, baseModel, judgeScore, ...rest }) => rest);
  return lazy ? { imageCount: images.length, images: wire } : { images: wire };
}
function packPostCompletions(postIds, rowsOf) {
  const batches = [];
  let batch = [];
  let rows = 0;
  for (const postId of postIds) {
    const r = rowsOf(postId);
    const full = batch.length >= 25 || rows + r > 200;
    if (batch.length && full) {
      batches.push(batch);
      batch = [];
      rows = 0;
    }
    batch.push(postId);
    rows += r;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
const getReactionTotals = (post) => {
  const stats = post.images[0]?.stats;
  if (!stats) return 0;
  return stats.likeCountAllTime + stats.laughCountAllTime + stats.heartCountAllTime + stats.cryCountAllTime - stats.dislikeCountAllTime;
};

/** getHeldGalleryLevel / isModelGalleryWithheld over resolveImageModelIds (model.service.ts). */
function resolveImageModelIds({ modelId, modelVersionId, postId, postIds = [] }) {
  const required = new Set();
  if (modelVersionId) required.add(modelVersionId);
  const listed = new Set();
  // `postId || postIds?.length`: every listed post's version; only a missing `postId` is null.
  if (postId || postIds?.length) {
    const ids = new Set(postIds);
    if (postId) ids.add(postId);
    const posts = cacheFetch(K.postVersion, [...ids]);
    if (postId && !posts[postId]) return null;
    for (const id of ids) if (posts[id]?.modelVersionId) listed.add(posts[id].modelVersionId);
  }
  const versionIds = new Set([...listed, ...required]);
  const modelIds = new Set();
  if (modelId) modelIds.add(modelId);
  if (versionIds.size) {
    const versions = cacheFetch(K.versionModel, [...versionIds]);
    for (const id of required) if (!versions[id]) return null;
    for (const v of Object.values(versions)) modelIds.add(v.modelId);
  }
  for (const m of modelIds) T.models.add(m);
  return modelIds;
}
/** getGallerySettingsByModelId's rebuild of an absent key (model.service.ts), for what the hold
 *  reads: `getModel` (getDbWithoutLag('model', id): no lag flag in any fixture, so the replica's row),
 *  null for no row; `sfwHeld = minor || sfwOnly`; and, when the model has settings or is held,
 *  getGalleryHiddenPreferences' `level` (`settings.level ?? allBrowsingLevelsFlag`, over the stored
 *  settings with `level: heldGalleryLevel(stored.level, model)` for a held model). Node then SETs the
 *  key for a week; feed-go does not (the entry's creatorHiddenUserIds is a primary read), so the write
 *  is not recorded. The hidden tags, users and images and the pinned posts are not modelled: no reader
 *  of a rebuilt entry here reads them. */
function rebuildGallerySettingsHold(modelId) {
  const model = MODELS[modelId];
  if (!model) return null;
  const sfwHeld = model.minor || model.sfwOnly;
  const stored = model.galleryLevel === null ? {} : { level: model.galleryLevel };
  if (model.galleryLevel === null && !sfwHeld) return null;
  if (!sfwHeld) return { level: stored.level ?? allBrowsingLevelsFlag, sfwHeld };
  // heldGalleryLevel: Flags.intersection(stored ?? 0, limit) || limit (browsingLevel.constants.ts),
  // limit = modelBrowsingLevelLimit (minorContentBrowsingLevelsFlag = sfwBrowsingLevelsFlag here).
  const limit = model.minor || model.sfwOnly ? sfwBrowsingLevelsFlag : allBrowsingLevelsFlag;
  return { level: intersection(stored.level ?? 0, limit) || limit, sfwHeld };
}
function gallerySettingsOf(modelId) {
  const key = `model:gallery-settings:${modelId}`;
  T.models.add(modelId);
  if (T.cold.has(key)) {
    T.coldRead.add(key);
    return rebuildGallerySettingsHold(modelId);
  }
  T.raw.set(key, JSON.stringify(GALLERY_SETTINGS[modelId]));
  const cached = GALLERY_SETTINGS[modelId];
  if ('none' in cached) return null;
  if (cached.sfwHeld === undefined) throw new Error('rebuild not modelled');
  return cached;
}
function getHeldGalleryLevel(selector) {
  const modelIds = resolveImageModelIds(selector);
  if (!modelIds) return 0;
  let held;
  for (const id of modelIds) {
    const g = gallerySettingsOf(id);
    if (g?.sfwHeld) held = intersection(held ?? allBrowsingLevelsFlag, g.level);
  }
  return held;
}
function isModelGalleryWithheld(selector, viewerId) {
  const modelIds = resolveImageModelIds(selector);
  if (!modelIds) return true;
  if (!modelIds.size) return false;
  return [...modelIds].some((id) => MODELS[id].mode === 'TakenDown' && MODELS[id].userId !== viewerId);
}

function asPostsHandler({ input: { limit, cursor, hidden, ...input }, ctx }) {
  const { user, features } = ctx;
  const fetchFn = features.imageIndexFeed ? getAllImagesIndex : getAllImages;
  const posts = {};
  const pinned = {};
  const moderatorView = !!user?.isModerator;
  const modelGallerySettings = input.modelId ? gallerySettingsOf(input.modelId) : null;
  const heldLevel = moderatorView ? undefined : getHeldGalleryLevel(input);
  const withheld = moderatorView ? false : isModelGalleryWithheld(input, user?.id);
  if (withheld) return { nextCursor: undefined, items: [] };
  if (heldLevel !== undefined) {
    const browsingLevel = intersection(input.browsingLevel, heldLevel);
    if (!browsingLevel) return { nextCursor: undefined, items: [] };
    input = { ...input, browsingLevel, preCapBrowsingLevel: intersection(input.preCapBrowsingLevel ?? input.browsingLevel, heldLevel) };
  }
  const pinnedPosts = modelGallerySettings?.pinnedPosts ?? {};
  const versionPinnedPosts = input.modelVersionId ? pinnedPosts[input.modelVersionId] ?? [] : [];
  if (versionPinnedPosts.length && !cursor) {
    const { items: pinnedPostsImages } = getAllImages({
      ...input,
      modelVersionId: undefined,
      modelId: undefined,
      reviewId: undefined,
      limit: 20 * 20,
      followed: false,
      postIds: versionPinnedPosts,
      user,
      include: [...input.include, 'tagIds', 'profilePictures'],
    });
    let versionPinnedImages = pinnedPostsImages;
    if (input.modelVersionId && pinnedPostsImages.length) {
      // getResourceIdsForImages (ImageResourceNew rows).
      versionPinnedImages = pinnedPostsImages.filter((image) => {
        const res = RESOURCES[image.id].map((r) => r.modelVersionId);
        return !res.length || res.includes(input.modelVersionId);
      });
    }
    for (const image of versionPinnedImages) {
      if (!image?.postId) continue;
      (pinned[image.postId] ??= []).push(image);
    }
  }
  const sponsored = [];
  let sponsoredPost;
  if (!cursor && input.modelId && input.modelVersionId && features.creatorPromotions) {
    const since = new Date(NOW.getTime() - 7 * 86400_000);
    const rows = PLACEMENTS.filter((p) => p.surface === 'galleryPromotion' && p.targetType === 'model' && p.targetId === input.modelId && p.status === 'approved' && p.resolvedAt > since);
    const live = rows.flatMap((row) => {
      const d = row.data;
      const end = d.endsAt ? new Date(d.endsAt) : new Date(row.resolvedAt.getTime() + d.days * 86400_000);
      if (!(row.resolvedAt <= NOW && NOW < end)) return [];
      if (!d.modelVersionIds.includes(input.modelVersionId)) return [];
      return [{ placementId: row.id, ...d }];
    });
    if (live.length > 1) throw new Error('rotation is random in Node; not a golden shape');
    const picked = live[0];
    if (picked) {
      const model = MODELS[input.modelId];
      const platform = model.minor || model.sfwOnly ? sfwBrowsingLevelsFlag : allBrowsingLevelsFlag;
      const servingLevel = picked.acceptedLevel ? intersection(picked.acceptedLevel, platform) : platform;
      if (servingLevel) sponsoredPost = { placementId: picked.placementId, postId: picked.postId, imageIds: picked.imageIds, servingLevel };
    }
  }
  const sponsoredLevel = sponsoredPost ? intersection(input.preCapBrowsingLevel ?? input.browsingLevel, sponsoredPost.servingLevel) : 0;
  if (sponsoredPost && sponsoredLevel && !versionPinnedPosts.includes(sponsoredPost.postId)) {
    const { items: sponsoredImages } = getAllImages({
      ...input,
      modelVersionId: undefined,
      modelId: undefined,
      reviewId: undefined,
      browsingLevel: sponsoredLevel,
      limit: 20,
      followed: false,
      postIds: [sponsoredPost.postId],
      user,
      include: [...input.include, 'tagIds', 'profilePictures'],
    });
    const approved = new Set(sponsoredPost.imageIds);
    sponsored.push(...sponsoredImages.filter((image) => approved.has(image.id)));
  }
  const sponsoredPostId = sponsored.length ? sponsoredPost?.postId : undefined;

  const pageFetchArgs = { ...input, followed: false, ids: undefined, user, include: [...input.include, 'tagIds', 'profilePictures'] };
  while (true) {
    const { nextCursor, items } = fetchFn(structuredCloneInput({ ...pageFetchArgs, cursor, limit: Math.ceil(limit * 2) }));
    for (const image of items) {
      if (!image?.postId || versionPinnedPosts.includes(image.postId) || image.postId === sponsoredPostId) continue;
      (posts[image.postId] ??= []).push(image);
    }
    cursor = nextCursor;
    if (!cursor) break;
    if (Object.keys(posts).length >= limit) break;
  }
  if (features.galleryLazyPostImages) {
    const pagePostIds = Object.keys(posts).map(Number);
    // getPostImageCounts: every row of each post.
    const rowCounts = new Map(pagePostIds.map((id) => [id, Object.values(IMAGES).filter((i) => i.postId === id).length]));
    for (const id of pagePostIds) T.posts.add(id);
    const rowCountOf = (postId) => rowCounts?.get(postId) ?? 20;
    const partialPostIds = pagePostIds.filter((postId) => rowCountOf(postId) > posts[postId].length);
    const completions = packPostCompletions(partialPostIds, rowCountOf).map((postIds) =>
      fetchFn(structuredCloneInput({ ...pageFetchArgs, cursor: undefined, postIds, postIdsInRequestedSort: true, limit: postIds.reduce((s, id) => s + rowCountOf(id), 0) }))
    );
    for (const { items: wholePosts } of completions)
      for (const image of wholePosts) {
        const post = image?.postId ? posts[image.postId] : undefined;
        if (post && !post.some((x) => x.id === image.id)) post.push(image);
      }
  }
  const mergedPosts = Object.values({ ...pinned, ...posts });
  const userIds = [...new Set(mergedPosts.map(([post]) => post.user.id))];
  const reviews =
    input.modelId || input.modelVersionId
      ? REVIEWS.filter(
          (r) =>
            userIds.includes(r.userId) &&
            (input.modelId === undefined || r.modelId === input.modelId) &&
            (input.modelVersionId === undefined || r.modelVersionId === input.modelVersionId) &&
            (r.postId === null || POSTS[r.postId].publishedAt <= NOW || r.userId === user?.id)
        ).sort((a, b) => b.rating - a.rating)
      : [];
  const results = mergedPosts.map((images) => {
    const [image] = images;
    const user = image.user;
    const review = reviews.find((review) => review.userId === user.id);
    const createdAt = images.map((image) => new Date(image.sortAt)).sort()[0];
    if (input.sort === 'Newest') images.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.id - b.id);
    let nsfwLevel = 0;
    for (const x of images) nsfwLevel = nsfwLevel | x.nsfwLevel;
    return {
      postId: image.postId,
      pinned: !!(image.postId && pinned[image.postId]),
      sponsored: false,
      nsfwLevel,
      modelVersionId: image.modelVersionId,
      publishedAt: image.publishedAt,
      sortAt: image.sortAt,
      createdAt,
      user,
      ...buildPostImagesWire(images, { lazy: features.galleryLazyPostImages }),
      review: review ? { rating: review.rating, details: review.details, recommended: review.recommended, id: review.id } : undefined,
    };
  });
  const cmp = {
    Newest: (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    Oldest: (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    'Most Reactions': (a, b) => getReactionTotals(b) - getReactionTotals(a),
    'Most Comments': (a, b) => (b.images[0].stats?.commentCountAllTime ?? 0) - (a.images[0].stats?.commentCountAllTime ?? 0),
    'Most Collected': (a, b) => (b.images[0].stats?.collectedCountAllTime ?? 0) - (a.images[0].stats?.collectedCountAllTime ?? 0),
  }[input.sort];
  if (cmp)
    results.sort((a, b) => {
      if (a.pinned && b.pinned) return cmp(a, b);
      if (a.pinned) return -1;
      if (b.pinned) return 1;
      return cmp(a, b);
    });
  if (sponsoredPostId) {
    const [first] = sponsored;
    const createdAt = sponsored.map((image) => new Date(image.sortAt)).sort()[0];
    let nsfwLevel = 0;
    for (const image of sponsored) nsfwLevel = nsfwLevel | image.nsfwLevel;
    const pinnedCount = results.filter((r) => r.pinned).length;
    results.splice(pinnedCount || Math.min(1, results.length), 0, {
      postId: sponsoredPostId,
      pinned: false,
      sponsored: true,
      nsfwLevel,
      modelVersionId: first.modelVersionId,
      publishedAt: first.publishedAt,
      sortAt: first.sortAt,
      createdAt,
      user: first.user,
      ...buildPostImagesWire(sponsored, { lazy: features.galleryLazyPostImages }),
      review: undefined,
    });
  }
  return { nextCursor: cursor, items: results };
}

/** The tRPC request as the procedure sees it: applyDomainFeature on the raw input, then the schema. */
function runAsPosts(spec) {
  const session = spec.viewer ? SESSIONS[spec.viewer] : null;
  if (session) T.packed.set(`${K.session}:${session.id}`, session);
  const user = session && !session.bannedAt ? { ...session } : undefined;
  const color = Object.entries(HOST).find(([, h]) => h === spec.host)?.[0] ?? 'blue';
  const canViewNsfw = color === 'blue' || color === 'red';
  const cap = !user ? publicBrowsingLevelsFlag : !canViewNsfw ? sfwBrowsingLevelsFlag : undefined;
  const raw = structuredClone(spec.input);
  if (cap !== undefined) {
    raw.browsingLevel = ((raw.browsingLevel ?? 0) & cap) || cap;
    if (raw.preCapBrowsingLevel !== undefined) raw.preCapBrowsingLevel = (raw.preCapBrowsingLevel & cap) || cap;
  }
  const input = {
    browsingLevel: allBrowsingLevelsFlag,
    limit: 100,
    period: 'AllTime',
    periodMode: 'published',
    sort: 'Most Reactions',
    withMeta: false,
    include: ['cosmetics'],
    ...raw,
  };
  const features = { imageIndexFeed: spec.nodeFlags.imageIndexFeed, galleryLazyPostImages: spec.nodeFlags.lazy, creatorPromotions: spec.nodeFlags.creatorPromotions };
  return { value: asPostsHandler({ input, ctx: { user, features } }), cacheable: !session && !isViewerScopedImageFeed(raw) };
}

// --- image.getInfinite's `hubId` --------------------------------------------------------------------
// resolveHubForFeed (src/server/services/image.service.ts) over resolveHubSources,
// resolveExcludedSources, groupTagIds and hubBrowsingLevel (src/server/services/user-hub.service.ts),
// getWithheldVersionIds and getHeldGalleryLevel (src/server/services/model.service.ts); mapHubSources
// (src/server/services/feed-shadow.service.ts). The constants are user-hub.schema.ts's.
const HUB_COLLECTION_SOURCES_ENABLED = false;
const HUB_RESOLVED_VERSION_IDS = 750; // hubLimits.resolvedVersionIds
const MAX_HUB = { users: 50, versions: 750, tagGroups: 50, tagsPerGroup: 50, excludedTagGroups: 20 };
const hubSourceKey = (source) => `${source.type}:${source.targetId}`;
const hubTagGroupKey = (source) => `${source.exclude ? 'x' : 'i'}-${source.groupKey}`;
const hubRowTagGroupKey = (source) => (source.type === 'Tag' && source.groupKey != null ? hubTagGroupKey(source) : undefined);

/** groupTagIds (user-hub.service.ts). */
function groupTagIds(sources) {
  const groups = [];
  const byKey = new Map();
  for (const source of sources) {
    if (source.type !== 'Tag') continue;
    if (source.groupKey == null) {
      groups.push([source.targetId]);
      continue;
    }
    const key = hubTagGroupKey(source);
    const held = byKey.get(key);
    if (held) {
      held.push(source.targetId);
      continue;
    }
    const group = [source.targetId];
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

/** resolveHubSources' `dbRead.userHub.findFirst({ where: { id, ...hubViewerWhere({ userId, isModerator }) },
 *  select: { forcedBrowsingLevel, sources: { where: { enabled: true } } } })`: a moderator opens any hub,
 *  everyone else their own and the Public ones. The sources in id order: Prisma names none (the heap's
 *  order), and feed-go reads them by id, so the fixtures pin that one order of the same sets. */
function findHubForViewer({ hubId, userId, isModerator }) {
  T.hubIds.add(hubId);
  const hub = HUBS[hubId];
  if (!hub) return null;
  if (!isModerator && !(userId && hub.userId === userId) && hub.availability !== 'Public') return null;
  return {
    forcedBrowsingLevel: hub.forcedBrowsingLevel,
    sources: hub.sources
      .filter((s) => s.enabled)
      .sort((a, b) => a.id - b.id)
      .map(({ type, targetId, exclude, groupKey }) => ({ type, targetId, exclude, groupKey })),
  };
}

/** resolveHubSources' version ranking ($queryRaw over "ModelVersion"): each model's versions by id
 *  descending, rank `rn`, those at most maxRank, ordered by id descending. */
function rankedModelVersions(modelIds, maxRank) {
  const rows = [];
  for (const modelId of modelIds) {
    const ids = Object.entries(VERSIONS)
      .filter(([, m]) => m === modelId)
      .map(([id]) => Number(id))
      .sort((a, b) => b - a);
    ids.forEach((id, i) => {
      if (i + 1 <= maxRank) rows.push({ id, modelId, rn: i + 1 });
    });
  }
  return rows.sort((a, b) => b.id - a.id);
}

/** resolveExcludedSources (user-hub.service.ts); the versions of the excluded models in id order
 *  (Prisma's findMany names none). */
function resolveExcludedSources(sources) {
  const byType = (type) => sources.filter((s) => s.type === type).map((s) => s.targetId);
  const modelIds = byType('Model');
  const versionIds = byType('ModelVersion');
  if (modelIds.length)
    versionIds.push(
      ...Object.entries(VERSIONS)
        .filter(([, m]) => modelIds.includes(m))
        .map(([id]) => Number(id))
        .sort((a, b) => a - b)
    );
  return { userIds: byType('User'), modelVersionIds: [...new Set(versionIds)], tagGroups: groupTagIds(sources) };
}

/** getWithheldVersionIds (model.service.ts): of the versions, those whose model is taken down and not
 *  the viewer's, through the version→model cache. */
function getWithheldVersionIds(modelVersionIds, viewerId) {
  const withheld = new Set();
  if (!modelVersionIds.length) return withheld;
  const versions = cacheFetch(K.versionModel, [...new Set(modelVersionIds)]);
  const modelIds = [...new Set(Object.values(versions).map((v) => v.modelId))];
  if (!modelIds.length) return withheld;
  const withheldModelIds = new Set(modelIds.filter((id) => MODELS[id] && MODELS[id].mode === 'TakenDown' && MODELS[id].userId !== viewerId));
  for (const id of modelVersionIds) if (versions[id] && withheldModelIds.has(versions[id].modelId)) withheld.add(id);
  return withheld;
}

/** getHeldGalleryLevel({ modelIds, modelVersionIds }) (model.service.ts): resolveImageModelIds over the
 *  named models and the listed versions' models (a list, so a missing version is skipped), then the
 *  intersection of every held model's level. */
function getHubHeldGalleryLevel({ modelIds, modelVersionIds }) {
  const ids = new Set(modelIds);
  if (modelVersionIds.length) {
    const versions = cacheFetch(K.versionModel, [...new Set(modelVersionIds)]);
    for (const v of Object.values(versions)) ids.add(v.modelId);
  }
  let held;
  for (const id of ids) {
    const g = gallerySettingsOf(id);
    if (g?.sfwHeld) held = intersection(held ?? allBrowsingLevelsFlag, g.level);
  }
  return held;
}

/** resolveHubSources (user-hub.service.ts). */
function resolveHubSources({ hubId, userId, isModerator, holdExempt, galleryOwnerId, excludedSources }) {
  const hub = findHubForViewer({ hubId, userId, isModerator });
  if (!hub) return null;
  const sessionExcluded = new Set((excludedSources ?? []).map(hubSourceKey));
  const negativeSources = hub.sources.filter((s) => s.exclude);
  const positive = hub.sources.filter((s) => !s.exclude);
  const toggledOffGroups = new Set(
    positive
      .filter((s) => sessionExcluded.has(hubSourceKey(s)))
      .map(hubRowTagGroupKey)
      .filter((key) => !!key)
  );
  const positiveSources = positive.filter((s) => {
    if (sessionExcluded.has(hubSourceKey(s))) return false;
    const group = hubRowTagGroupKey(s);
    return !group || !toggledOffGroups.has(group);
  });
  const byType = (type) => positiveSources.filter((s) => s.type === type).map((s) => s.targetId);
  const modelIds = byType('Model');
  const explicitVersionIds = byType('ModelVersion');
  const budget = Math.max(0, HUB_RESOLVED_VERSION_IDS - new Set(explicitVersionIds).size);
  const perModel = modelIds.length ? Math.max(1, Math.floor(budget / modelIds.length)) : 0;
  const excluded = resolveExcludedSources(negativeSources);
  let truncated = false;
  const versionIdsOfModels = [];
  const modelOfVersion = new Map();
  if (modelIds.length && perModel > 0) {
    for (const row of rankedModelVersions(modelIds, perModel + 1)) {
      if (Number(row.rn) > perModel) truncated = true;
      else {
        versionIdsOfModels.push(row.id);
        modelOfVersion.set(row.id, row.modelId);
      }
    }
  } else if (modelIds.length) truncated = true;
  const allVersionIds = [...new Set([...explicitVersionIds, ...versionIdsOfModels])];
  const cappedVersionIds = allVersionIds.slice(0, HUB_RESOLVED_VERSION_IDS);
  if (allVersionIds.length > cappedVersionIds.length) truncated = true;
  const [withheldVersionIds, heldBrowsingLevel] =
    cappedVersionIds.length && !holdExempt
      ? [
          getWithheldVersionIds(cappedVersionIds, galleryOwnerId),
          getHubHeldGalleryLevel({
            modelIds: [...new Set(cappedVersionIds.flatMap((id) => (modelOfVersion.has(id) ? [modelOfVersion.get(id)] : [])))],
            modelVersionIds: cappedVersionIds.filter((id) => !modelOfVersion.has(id)),
          }),
        ]
      : [new Set(), undefined];
  return {
    userIds: byType('User'),
    modelVersionIds: cappedVersionIds.filter((id) => !withheldVersionIds.has(id)),
    truncated,
    collectionIds: byType('Collection'),
    tagGroups: groupTagIds(positiveSources),
    forcedBrowsingLevel: hub.forcedBrowsingLevel,
    heldBrowsingLevel,
    excluded,
  };
}

/** hubBrowsingLevel (user-hub.service.ts). */
function hubBrowsingLevel(browsingLevel, sources) {
  const { forcedBrowsingLevel, heldBrowsingLevel } = sources;
  if (!forcedBrowsingLevel && heldBrowsingLevel === undefined) return browsingLevel;
  let level = browsingLevel || FLAGS.PG;
  if (forcedBrowsingLevel) level &= forcedBrowsingLevel;
  if (heldBrowsingLevel !== undefined) level &= heldBrowsingLevel;
  return level;
}

/** resolveHubForFeed (image.service.ts), for a session viewer (asOwner): moderator rights are the
 *  session's (feedViewer, moderatorView), the gallery owner the viewer. */
function resolveHubForFeed(input) {
  if (!input.hubId) return undefined;
  const sources = resolveHubSources({
    hubId: input.hubId,
    userId: input.currentUserId,
    isModerator: input.isModerator,
    holdExempt: !!input.isModerator,
    galleryOwnerId: input.currentUserId,
    excludedSources: input.hubExcludedSources,
  });
  const hasSource =
    !!sources &&
    (sources.userIds.length > 0 ||
      sources.modelVersionIds.length > 0 ||
      sources.tagGroups.length > 0 ||
      (HUB_COLLECTION_SOURCES_ENABLED && sources.collectionIds.length > 0));
  if (!sources || !hasSource) return { hubSources: null };
  const browsingLevel = hubBrowsingLevel(input.browsingLevel, sources);
  if (browsingLevel !== undefined && !browsingLevel) return { hubSources: null };
  return { hubSources: sources, browsingLevel };
}

/** mapHubSources (feed-shadow.service.ts). */
function mapHubSources(input) {
  const skip = (reason) => ({ ok: false, reason });
  const sources = input.hubSources;
  if (!sources) return skip('input:hubId');
  if (
    present(input.userId) ||
    input.followed === true ||
    input.newCreators === true ||
    present(input.ids) ||
    present(input.postId) ||
    present(input.postIds) ||
    present(input.model3dId)
  )
    return skip('hub:driver');
  if (HUB_COLLECTION_SOURCES_ENABLED && sources.collectionIds.length) return skip('hub:collections');
  const whole = (list) => ints(list).length === list.length;
  const groupsWhole = (groups) => groups.every((g) => g.length > 0 && whole(g));
  const { userIds, modelVersionIds, tagGroups, excluded } = sources;
  if (!whole(userIds) || !whole(modelVersionIds) || !groupsWhole(tagGroups) || !whole(excluded.userIds) || !whole(excluded.modelVersionIds) || !groupsWhole(excluded.tagGroups))
    return skip('hub:ids');
  if (!userIds.length && !modelVersionIds.length && !tagGroups.length) return skip('hub:none');
  if (modelVersionIds.length) for (const flag of ['hideAutoResources', 'hideManualResources']) if (input[flag] === true) return skip(`flag:${flag}`);
  if (userIds.length > MAX_HUB.users) return skip(`hub:users>${MAX_HUB.users}`);
  if (modelVersionIds.length > MAX_HUB.versions) return skip(`hub:versions>${MAX_HUB.versions}`);
  if (tagGroups.length > MAX_HUB.tagGroups) return skip(`hub:tagGroups>${MAX_HUB.tagGroups}`);
  if (excluded.modelVersionIds.length > MAX_HUB.versions) return skip(`hub:excludedVersions>${MAX_HUB.versions}`);
  if (excluded.tagGroups.length > MAX_HUB.excludedTagGroups) return skip(`hub:excludedTagGroups>${MAX_HUB.excludedTagGroups}`);
  if ([...tagGroups, ...excluded.tagGroups].some((g) => g.length > MAX_HUB.tagsPerGroup)) return skip(`hub:tagsPerGroup>${MAX_HUB.tagsPerGroup}`);
  const tagGroupsParam = (groups) => groups.map((g) => g.join(',')).join(';');
  const params = [];
  if (userIds.length) params.push(['anyUserIds', userIds.join(',')]);
  if (modelVersionIds.length) params.push(['anyVersionIds', modelVersionIds.join(',')]);
  if (tagGroups.length) params.push(['anyTagGroups', tagGroupsParam(tagGroups)]);
  if (excluded.modelVersionIds.length) params.push(['excludedVersionIds', excluded.modelVersionIds.join(',')]);
  if (excluded.tagGroups.length) params.push(['excludedTagGroups', tagGroupsParam(excluded.tagGroups)]);
  return { ok: true, params, excludedUserIds: excluded.userIds };
}

// --- image.getInfinite ----------------------------------------------------------------------------
/**
 * isViewerScopedImageFeed and isViewerScopedInfiniteFeed (src/server/schema/image.schema.ts), read
 * on the raw input as noEdgeCacheWhen reads it: the answer depends on the viewer, so it is not
 * edge-cached. A copy, as requiresImageDbPath below is: this script cannot import the app's modules.
 */
const isViewerScopedImageFeed = (input) =>
  !!input.reactions?.length ||
  ['followed', 'hidden', 'pending', 'notPublished', 'scheduled', 'poiOnly', 'minorOnly', 'pendingReviewOnly'].some((k) => !!input[k]);
const isViewerScopedInfiniteFeed = (input) =>
  isViewerScopedImageFeed(input) || ['hatSort', 'hatTurfMine', 'hideTurfHats', 'hideWornHats'].some((k) => !!input[k]);

/** requiresImageDbPath (src/server/schema/image.schema.ts), for the inputs these fixtures send. */
const requiresImageDbPath = (input) =>
  !!input.postId ||
  !!input.postIds?.length ||
  !!input.collectionId ||
  !!input.reactions?.length ||
  !!input.ids?.length ||
  (!!input.modelId && !input.modelVersionId) ||
  (!!input.prioritizedUserIds?.length && (!!input.modelId || !!input.modelVersionId)) ||
  (!!input.publishedOnly && !!input.userId);

/** The handler's withoutHeldFromViewer over getHeldLevelsByPost (withOwners): an image on a held
 *  model's post only at a level intersecting the hold, or to the model's owner (a session); a
 *  moderator sees every image. */
function withoutHeldFromViewer(user, images) {
  const postIds = images.map((image) => image.postId).filter((id) => id != null);
  if (!postIds.length || user?.isModerator) return images;
  const ids = [...new Set(postIds)];
  const posts = cacheFetch(K.postVersion, ids);
  const versionIds = [...new Set(Object.values(posts).map((post) => post.modelVersionId))].filter((id) => id != null);
  const held = new Map();
  if (!versionIds.length) return images;
  const versions = cacheFetch(K.versionModel, versionIds);
  const levels = new Map();
  for (const v of Object.values(versions)) {
    const g = gallerySettingsOf(v.modelId);
    if (g?.sfwHeld) levels.set(v.modelId, g.level);
  }
  if (!levels.size) return images;
  // dbRead.model.findMany({ where: { id: { in: [...levels.keys()] } }, select: { id, userId } }).
  const ownerOf = new Map([...levels.keys()].map((id) => [id, MODELS[id]?.userId]));
  for (const id of ids) {
    const versionId = posts[id]?.modelVersionId;
    const modelId = versionId ? versions[versionId]?.modelId : undefined;
    const level = modelId ? levels.get(modelId) : undefined;
    if (modelId && level !== undefined) held.set(id, { level, ownerId: ownerOf.get(modelId) });
  }
  return images.filter((image) => {
    const hold = image.postId ? held.get(image.postId) : undefined;
    const owner = !!user && hold?.ownerId === user.id;
    return !hold || owner || (hold.level & image.nsfwLevel) !== 0;
  });
}

/** getInfiniteImagesHandler (image.controller.ts) without Hat Turf (no fixture sends a hat key); then
 *  withSharedFeedUsers, which changes no decoded value (one shared `user` object per
 *  creator is a superjson referential equality, not a different value). */
function infiniteHandler({ input, ctx }) {
  const { user, features } = ctx;
  // `hubId` is a plain feed input behind the `userHubs` feature: refused (UNAUTHORIZED) while it is off.
  if (input.hubId && !features.userHubs) throw new NodeError(401, 'Hubs are not available yet');
  const { hatSort: _s, hatTeams: _t, hatTurfMine: _m, hideTurfHats: _h, hideWornHats: _w, ...unhatted } = input;
  // `publishedOnly` beside a `userId` that is not the caller's own is withdrawn (the own-content
  // submit pickers only ever send their own id): it neither pins the DB path nor reaches the mapper.
  let scopedInput =
    unhatted.publishedOnly && unhatted.userId && unhatted.userId !== user?.id
      ? { ...unhatted, publishedOnly: undefined }
      : unhatted;
  // A hub is only expressible on the feed service, so it pins the feed path whatever the flag says.
  const useIndex = !!input.hubId || (features.imageIndexFeed && !requiresImageDbPath(scopedInput));
  const moderatorView = !!user?.isModerator;
  const heldLevel = moderatorView ? undefined : getHeldGalleryLevel(scopedInput);
  const withheld = moderatorView ? false : isModelGalleryWithheld(scopedInput, user?.id);
  if (withheld) return { items: [], nextCursor: undefined };
  if (heldLevel !== undefined) {
    const browsingLevel = intersection(scopedInput.browsingLevel, heldLevel);
    if (!browsingLevel) return { items: [], nextCursor: undefined };
    scopedInput = { ...scopedInput, browsingLevel };
  }
  const args = { ...scopedInput, user, domain: ctx.domain, include: [...scopedInput.include, 'tagIds'] };
  // Images picked by id name no model, so each is held by its own post's model.
  const byId = !!scopedInput.imageId || !!scopedInput.ids?.length;
  if (useIndex) return getAllImagesIndex(structuredCloneInput(args));
  const result = getAllImages(args);
  return { ...result, items: byId ? withoutHeldFromViewer(user, result.items) : result.items, source: 'db' };
}

/** parseVerifiedBotHeader (bot-detection/header.ts). */
const parseVerifiedBotHeader = (raw) => (raw === 'googlebot' || raw === 'bingbot' ? raw : null);

function runInfinite(spec) {
  const session = spec.viewer ? SESSIONS[spec.viewer] : null;
  if (session) T.packed.set(`${K.session}:${session.id}`, session);
  const user = session && !session.bannedAt ? { ...session } : undefined;
  const color = Object.entries(HOST).find(([, h]) => h === spec.host)?.[0] ?? 'blue';
  const canViewNsfw = color === 'blue' || color === 'red';
  // requestDomainBrowsingLevelCap: a verified crawler (the header as the API policy left it) counts as
  // signed in where mature content is allowed.
  const crawler = parseVerifiedBotHeader(spec.headers?.['x-civitai-verified-bot']) !== null;
  const isAuthorized = !!user || (crawler && canViewNsfw);
  const cap = !isAuthorized ? publicBrowsingLevelsFlag : !canViewNsfw ? sfwBrowsingLevelsFlag : undefined;
  // zod strips the keys getInfiniteImagesSchema lacks (the legacy clients' `useIndex` and `search`).
  const { useIndex: _useIndex, search: _search, ...raw } = structuredClone(spec.input);
  if (cap !== undefined) raw.browsingLevel = ((raw.browsingLevel ?? 0) & cap) || cap;
  const input = {
    browsingLevel: allBrowsingLevelsFlag,
    limit: 100,
    period: 'AllTime',
    periodMode: 'published',
    sort: 'Most Reactions',
    withMeta: false,
    include: ['cosmetics'],
    ...raw,
  };
  const features = { imageIndexFeed: spec.nodeFlags.imageIndexFeed, userHubs: !!spec.nodeFlags.userHubs };
  // createContext's policy (cacheable without a session and without a verified crawler), lowered by
  // noEdgeCacheWhen when the answer depends on the viewer.
  return {
    value: infiniteHandler({ input, ctx: { user, features, domain: boardColorOf(spec.host) } }),
    cacheable: !session && !crawler && !isViewerScopedInfiniteFeed(raw),
  };
}

// --- GET /api/v1/images ----------------------------------------------------------------------------
/** Next's req.query: URLSearchParams, a repeated key collected into an array. */
function nextQuery(search) {
  const q = {};
  for (const [k, v] of new URLSearchParams(search)) {
    if (k in q) q[k] = Array.isArray(q[k]) ? [...q[k], v] : [q[k], v];
    else q[k] = v;
  }
  return q;
}
const DEPRECATED = { None: 1, Soft: 3, Mature: 7, X: 31, Blocked: 32 };
const REVERSE_DEPRECATED = { 1: 'None', 2: 'Soft', 4: 'Mature', 8: 'X', 16: 'X', 32: 'Blocked' };
const booleanString = (v) => ['true', '1', 'yes', 'on', 'y', 'enabled'].includes(String(v).toLowerCase());

function getEdgeUrl(src, { type, anim, transcode, original, optimized, skip } = {}) {
  if (!src || src.startsWith('http') || src.startsWith('blob')) return src;
  if (original === undefined) original = true;
  const modified = { anim: anim ? undefined : anim, transcode: transcode ? true : undefined, width: undefined, height: undefined, original, optimized, skip };
  const params = Object.entries(modified)
    .map(([k, v]) => (v !== undefined ? `${k}=${v}` : undefined))
    .filter((x) => x !== undefined)
    .join(',');
  const ext = { image: '.jpeg', video: '.mp4', audio: '.mp3' }[type ?? 'image'];
  let name = src.replaceAll('%', '');
  name = name.includes('.') ? name.split('.').slice(0, -1).join('.') + ext : name + ext;
  return [IMAGE_LOCATION, src, params, name].filter(Boolean).join('/');
}
const getStillUrl = (src, options) => getEdgeUrl(src, { ...options, original: false, optimized: true }).replace('original=false,', '');
function getSkipValue({ type, metadata }) {
  if (!metadata || typeof metadata.height !== 'number' || typeof metadata.width !== 'number') return undefined;
  if (type !== 'video' || !metadata.duration) return undefined;
  return metadata.duration > 30 ? metadata.thumbnailFrame ?? 4 : undefined;
}
function getPublicVideoThumbnail({ image, customThumbnail, browsingLevel }) {
  if (image.type !== 'video') return null;
  const allowed = browsingLevel & allBrowsingLevelsFlag;
  if (customThumbnail?.nsfwLevel && (customThumbnail.nsfwLevel & allowed) !== 0)
    return { url: getStillUrl(customThumbnail.url, { type: 'image', anim: false }), width: customThumbnail.width ?? null, height: customThumbnail.height ?? null };
  return {
    url: getStillUrl(image.url, { type: 'image', anim: false, transcode: true, skip: getSkipValue({ type: image.type, metadata: image.metadata }) }),
    width: image.width ?? null,
    height: image.height ?? null,
  };
}

function runV1(spec) {
  const session = spec.viewer ? SESSIONS[spec.viewer] : null;
  if (session) T.packed.set(`${K.session}:${session.id}`, session);
  const user = session && !session.bannedAt ? { ...session } : undefined; // whenBanned: 'anonymous'
  const query = nextQuery(spec.query);
  const num = (v) => (v === undefined ? undefined : Number(v));
  const p = {
    limit: query.limit === undefined ? 100 : Number(query.limit),
    page: num(query.page),
    postId: num(query.postId),
    modelId: num(query.modelId),
    modelVersionId: num(query.modelVersionId),
    imageId: num(query.imageId),
    username: query.username,
    userId: num(query.userId),
    period: query.period ?? 'AllTime',
    sort: query.sort ?? 'Most Reactions',
    nsfw: (() => {
      const v = query.nsfw;
      if (v === undefined) return undefined;
      if (v in DEPRECATED) return DEPRECATED[v];
      const b = booleanString(v);
      if (!b) return undefined;
      return nsfwBrowsingLevelsFlag;
    })(),
    browsingLevel: num(query.browsingLevel),
    cursor: query.cursor,
    type: query.type,
    // commaDelimitedNumberArray(z.number().int().positive().array().min(1).max(IMAGE_IDS_BATCH_MAX)).
    ids: (() => {
      if (query.ids === undefined) return undefined;
      const ids = String(query.ids)
        .split(',')
        .map((x) => Number(x.trim()));
      if (!ids.length || ids.length > 100 || ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new NodeError(400, 'ids');
      return ids;
    })(),
    withMeta: query.withMeta === undefined ? false : booleanString(query.withMeta),
    requiringMeta: query.requiringMeta === undefined ? undefined : booleanString(query.requiringMeta),
    flatMeta: query.flatMeta === undefined ? undefined : booleanString(query.flatMeta),
  };
  const { limit, page, cursor, nsfw, browsingLevel, type, withMeta, flatMeta, ...data } = p;
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  const usingPaging = page && !cursor;
  if (usingPaging && page * limit > 1000) throw new NodeError(429, 'paging');
  const skip = usingPaging ? (page - 1) * limit : undefined;
  let level = browsingLevel ?? nsfw ?? publicBrowsingLevelsFlag;
  const ok = (body) => ({ value: body });
  if (data.modelId || data.modelVersionId || data.postId) {
    if (isModelGalleryWithheld(data)) return ok({ items: [], metadata: {} });
    const held = getHeldGalleryLevel(data);
    if (held !== undefined) {
      level = intersection(level, held);
      if (!level) return ok({ items: [], metadata: {} });
    }
  }
  // runImageSearch's useLegacyMethod: an `ids` batch, an `imageId`, or a `modelId` without a version
  // take the legacy path (getAllImages), everything else the feed (`postOrder` is the posts route's).
  const useLegacyMethod =
    (Array.isArray(data.ids) && data.ids.length > 0) || data.imageId ? true : !!data.modelId && !data.modelVersionId;
  if (!useLegacyMethod && cursor !== undefined && cursor !== '' && !parseFeedCursor(cursor) && !/^(-?\d+)(?:\|[^|]*)?$/.test(cursor))
    throw new NodeError(400, 'cursor');
  const include = ['tagIds', 'profilePictures'];
  const dbQuery = { ...data, types: type ? [type] : undefined, limit, skip, cursor, include, periodMode: 'published', browsingLevel: level, withMeta: false, user, disableMinor: true, disablePoi: true, includeBaseModel: true };
  const searchQuery = { ...data, types: type ? [type] : undefined, limit, skip, cursor, include, periodMode: 'published', browsingLevel: level, withMeta: false, currentUserId: user?.id, isModerator: user?.isModerator, disableMinor: true, disablePoi: true };
  let result;
  if (useLegacyMethod) result = getAllImages(dbQuery);
  else if (searchQuery.limit < 1) result = { items: [], nextCursor: undefined };
  else {
    const input = withoutUnservedFilters(searchQuery);
    enforceBlockedBrowsingTags(input, { id: input.currentUserId, isModerator: input.isModerator });
    applyHideChallengesExclusion(input);
    let userId = input.userId;
    if (userId === undefined && input.username) {
      const u = Object.values(USERS).find((x) => x.username === input.username);
      T.usernames.add(input.username);
      userId = u?.id;
    }
    if (input.username && userId === undefined) result = { items: [], nextCursor: undefined };
    else {
      const served = serveFromFeed(
        { ...input, userId },
        {
          route: 'rest',
          hydrate: (ids) => getAllImagesUncaptured(structuredCloneInput(feedHydrateQuery({ ...dbQuery, userId, excludedTagIds: input.excludedTagIds }, ids))).items,
        }
      );
      if (served.ok) result = { items: served.page.data.map((image) => ({ ...image, createdAt: image.sortAt })), nextCursor: served.page.nextCursor };
      else {
        if (parseFeedCursor(cursor) !== undefined && served.reason !== 'hydrate:empty') throw new NodeError(400, 'feed cursor');
        result = answerWithoutFeed(served);
      }
    }
  }
  // imageMetaCache.fetch (5h EX: ttl 4h plus the 1h stale-while-revalidate tail), on a miss its lookup.
  let imageMetas = {};
  if (withMeta && result.items.length > 0) {
    T.metaRead = true;
    imageMetas = cacheFetch(K.meta, result.items.map((img) => img.id), { lookup: lookupImageMeta, idKey: 'id', ttl: 5 * HOUR });
  }
  const videoIds = result.items.filter((i) => i.type === 'video').map((i) => i.id);
  // servableThumbnails
  const customThumbnails = videoIds.length
    ? Object.fromEntries(Object.entries(cacheFetch(K.thumbs, videoIds)).filter(([, t]) => t.blockMarked === false))
    : {};
  const shaped = result.items.map((image) => {
    const nsfwName = REVERSE_DEPRECATED[image.nsfwLevel] ?? 'None';
    return {
      id: image.id,
      url: getEdgeUrl(image.url, { original: true, type: image.type }),
      hash: image.hash,
      width: image.width,
      height: image.height,
      nsfwLevel: nsfwName,
      type: image.type,
      nsfw: nsfwName !== 'None',
      browsingLevel: image.nsfwLevel,
      createdAt: image.createdAt,
      postId: image.postId,
      thumbnail: getPublicVideoThumbnail({ image, customThumbnail: customThumbnails[image.id], browsingLevel: level }),
      stats: {
        cryCount: image.stats?.cryCountAllTime ?? 0,
        laughCount: image.stats?.laughCountAllTime ?? 0,
        likeCount: image.stats?.likeCountAllTime ?? 0,
        dislikeCount: image.stats?.dislikeCountAllTime ?? 0,
        heartCount: image.stats?.heartCountAllTime ?? 0,
        commentCount: image.stats?.commentCountAllTime ?? 0,
      },
      meta: (() => {
        if (!withMeta) return null;
        const imageMeta = imageMetas[image.id]?.meta ?? null;
        const useFlat = flatMeta !== undefined ? flatMeta : !useLegacyMethod;
        return useFlat ? imageMeta : { id: image.id, meta: imageMeta };
      })(),
      username: typeof image.user.username === 'number' ? String(image.user.username) : image.user.username,
      baseModel: image.baseModel,
      modelVersionIds: image.modelVersionIds,
      tags: undefined,
    };
  });
  // withoutHeldImages: getHeldLevelsByPost(withOwners false).
  const postIds = [...new Set(shaped.map((i) => i.postId))];
  let items = shaped;
  if (postIds.length) {
    const posts = cacheFetch(K.postVersion, postIds);
    const versionIds = [...new Set(Object.values(posts).map((x) => x.modelVersionId))].filter((x) => x != null);
    if (versionIds.length) {
      const versions = cacheFetch(K.versionModel, versionIds);
      const levels = new Map();
      for (const v of Object.values(versions)) {
        const g = gallerySettingsOf(v.modelId);
        if (g?.sfwHeld) levels.set(v.modelId, g.level);
      }
      if (levels.size)
        items = shaped.filter((image) => {
          const versionId = posts[image.postId]?.modelVersionId;
          const modelId = versionId ? versions[versionId]?.modelId : undefined;
          const lvl = modelId ? levels.get(modelId) : undefined;
          return lvl === undefined || (lvl & image.browsingLevel) !== 0;
        });
    }
  }
  const metadata = { nextCursor: result.nextCursor };
  if (usingPaging) {
    metadata.currentPage = page;
    metadata.pageSize = limit;
  }
  metadata.nextPage = (() => {
    if (!metadata.nextCursor) return undefined;
    const base = new URL(`/api/v1/images?${spec.query}`, `https://${spec.host}`);
    const qp = { ...query };
    if (metadata.currentPage) qp.page = metadata.currentPage + 1;
    else qp.cursor = metadata.nextCursor;
    return `${base.origin}${base.pathname}?${queryString.stringify(qp, { skipEmptyString: true, skipNull: true, sort: false })}`;
  })();
  return ok({ items, metadata });
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
const FLAGS_ON = { imageIndexFeed: true, lazy: true, creatorPromotions: false };
const GO_ON = { imageIndexFeed: true, lazyPostImages: true, creatorPromotions: 'false', decorationEvents: [] };
const fc = (a, b) => ({ nextCursor: `${a}|${b}` });
// A `hubId` fixture's switch and flag: FEED_GO_INFINITE_SERVE_INPUT_HUB_ID on, and `user-hubs` on for
// its viewer on both sides.
const HUB_ON = { goConfig: { serveHubId: true, userHubs: 'on' }, nodeFlags: { userHubs: true } };

const AS_POSTS = [
  {
    name: 'version-signed-out-most-reactions',
    description: 'Model-version gallery, signed out (domain cap PG): page 1 with a feed cursor, a framed image, a video with a thumbnail, a minor image (signed out resolves no minor exclusion at PG), a creator review, lazy completion of a post the page holds part of.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 3 },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6001&excludePoi=1&sort=reactions&limit=6': { body: { items: [8001, 8003, 8008, 8005], ...fc('1718000000000', '8005') } },
      'levels=1&excludedTags=9901&versionIds=6001&excludePoi=1&postIds=7001&sort=reactions&limit=2': { body: { items: [8001] } },
    },
  },
  {
    name: 'version-signed-in-blue-newest',
    description: 'Signed in on an NSFW host: uncapped level 31, both addons resolve (minor + POI exclusions, viewerId), Newest with the per-post index sort, the viewer’s own reactions, a page that ends the feed (no cursor).',
    viewer: 1003,
    host: HOST.blue,
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Newest', period: 'AllTime', browsingLevel: 31, limit: 10 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901&versionIds=6001&excludeMinor=1&excludePoi=1&viewerId=1003&sort=newest&limit=20': {
        body: { items: [8007, 8006, 8005, 8004, 8003, 8002, 8001] },
      },
    },
  },
  {
    name: 'version-signed-in-green-capped-week-hidden-users',
    description: 'Signed in on an SFW host: browsingLevel 31 capped to PG|PG-13, period Week, excludedUserIds the client sends for the gallery’s hidden users (the settings’ hiddenUsers/hiddenImages are not applied server-side without `hidden`), Most Comments.',
    viewer: 1003,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Comments', period: 'Week', browsingLevel: 31, excludedUserIds: [1009], limit: 4 },
    replies: {
      'levels=1%2C2&excludedTags=9901&excludedUserIds=1009&versionIds=6001&excludePoi=1&viewerId=1003&sort=comments&periodDays=7&limit=8': {
        body: { items: [8001, 8002, 8003], nextCursor: '1717600000000|8003' },
      },
      // Two posts < limit 4 with a cursor: the page loop asks again from the feed's cursor.
      'levels=1%2C2&excludedTags=9901&excludedUserIds=1009&versionIds=6001&excludePoi=1&viewerId=1003&sort=comments&periodDays=7&limit=8&cursor=1717600000000%7C8003': {
        body: { items: [8007] },
      },
    },
  },
  {
    name: 'held-gallery-moderator',
    description: 'A moderator on an SFW-only model’s version: the hold is not applied (moderatorView), no addons (moderators bypass), Most Collected.',
    viewer: 1004,
    host: HOST.blue,
    input: { modelId: 5002, modelVersionId: 6101, sort: 'Most Collected', browsingLevel: 31, limit: 5 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&versionIds=6101&sort=collected&limit=10': { body: { items: [8302, 8301] } },
    },
  },
  {
    name: 'held-gallery-signed-in',
    description: 'An SFW-only model’s version for a signed-in viewer on an NSFW host: level 31 intersected with the held level 3.',
    viewer: 1003,
    host: HOST.blue,
    input: { modelId: 5002, modelVersionId: 6101, sort: 'Most Reactions', browsingLevel: 31, limit: 5 },
    replies: {
      'levels=1%2C2&excludedTags=9901&versionIds=6101&excludePoi=1&viewerId=1003&sort=reactions&limit=10': { body: { items: [8301] } },
      // The post has two rows (one R): completed, and the feed holds the R one back at these levels.
      'levels=1%2C2&excludedTags=9901&versionIds=6101&excludePoi=1&viewerId=1003&postIds=7301&sort=reactions&limit=2': { body: { items: [8301] } },
    },
  },
  {
    name: 'withheld-gallery-signed-out',
    description: 'A taken-down model’s gallery, signed out: withheld, the empty page.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5003, modelVersionId: 6201, sort: 'Most Reactions', browsingLevel: 1, limit: 10 },
    replies: {},
  },
  {
    name: 'withheld-gallery-owner',
    description: 'The same taken-down gallery for its owner: served.',
    viewer: 1001,
    host: HOST.blue,
    sessionUser: 1001,
    input: { modelId: 5003, modelVersionId: 6201, sort: 'Most Reactions', browsingLevel: 1, limit: 10 },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6201&excludePoi=1&viewerId=1001&sort=reactions&limit=20': { body: { items: [8401] } },
    },
  },
  {
    name: 'page2-feed-cursor',
    description: 'Page 2 by the feed’s own cursor (feed:<a>:<b> → cursor=<a>|<b>): no pinned or sponsored fetch, the last page (no next cursor).',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Reactions', browsingLevel: 1, limit: 3, cursor: 'feed:1718000000000:8005' },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6001&excludePoi=1&sort=reactions&limit=6&cursor=1718000000000%7C8005': { body: { items: [8006, 8007] } },
    },
  },
  {
    name: 'page2-offset-entry-cursor-newest',
    description: 'Page 2 by a search-index `offset|entry` cursor under Newest: offset 200 and the entry minute as `before`.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Newest', browsingLevel: 1, limit: 2, cursor: '200|1718000012345' },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6001&excludePoi=1&sort=newest&limit=4&offset=200&before=1717999980000': { body: { items: [8007, 8006], ...fc('1717000000000', '8006') } },
    },
  },
  {
    name: 'page2-numeric-cursor',
    description: 'A numeric cursor on the feed path is an offset (cursor 40 → offset=40).',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Oldest', browsingLevel: 1, limit: 2, cursor: 40 },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6001&excludePoi=1&sort=oldest&limit=4&offset=40': { body: { items: [8006, 8007], ...fc('1717500000000', '8007') } },
    },
  },
  {
    name: 'lazy-post-completion-newest',
    description: 'A post of eight images the page holds two of: completed by postIds in the requested sort, then sent as its first six (after the Newest index sort) with imageCount 8; the createdAt string-sort quirk across weekdays.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6002, sort: 'Newest', browsingLevel: 1, limit: 2 },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6002&excludePoi=1&sort=newest&limit=4': { body: { items: [8011, 8013, 8020], ...fc('1717400000000', '8020') } },
      'levels=1&excludedTags=9901&versionIds=6002&excludePoi=1&postIds=7005&sort=newest&limit=8': { body: { items: [8012, 8011, 8013, 8014, 8015, 8016, 8017, 8018] } },
    },
  },
  {
    name: 'lazy-post-completion-most-reactions',
    description: 'The same post completed under Most Reactions: the feed’s completion order is kept (no index sort), first six of eight.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6002, sort: 'Most Reactions', browsingLevel: 1, limit: 2 },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6002&excludePoi=1&sort=reactions&limit=4': { body: { items: [8014, 8020, 8017], ...fc('1717400000000', '8017') } },
      'levels=1&excludedTags=9901&versionIds=6002&excludePoi=1&postIds=7005&sort=reactions&limit=8': { body: { items: [8018, 8017, 8016, 8015, 8014, 8013, 8012, 8011] } },
    },
  },
  {
    name: 'pinned-post-first-page',
    description: 'A version with a pinned post: fetched whole on Postgres, narrowed to media the version made or with no resource rows, kept off the feed page, sorted first.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5004, modelVersionId: 6301, sort: 'Most Reactions', browsingLevel: 1, limit: 5 },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6301&excludePoi=1&sort=reactions&limit=10': { body: { items: [8101, 8104, 8105] } },
    },
  },
  {
    name: 'sponsored-post-first-page',
    description: 'A live sponsored post on page 1 (creator-promotions on for everyone): fetched at (preCap ?? level) & serving level, only the approved images, spliced in second, kept off the page.',
    viewer: null,
    host: HOST.green,
    nodeFlags: { creatorPromotions: true },
    goConfig: { creatorPromotions: 'everyone' },
    input: { modelId: 5005, modelVersionId: 6401, sort: 'Most Reactions', browsingLevel: 1, limit: 5 },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6401&excludePoi=1&sort=reactions&limit=10': { body: { items: [8201, 8203, 8204] } },
    },
  },
  {
    name: 'event-decoration-visible',
    description: 'An event whose hats every viewer sees (FEED_GO_DECORATION_EVENTS): the image wearing one carries its eventDecoration.',
    viewer: null,
    host: HOST.green,
    events: ['goldentest2026'],
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Reactions', browsingLevel: 1, limit: 3 },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6001&excludePoi=1&sort=reactions&limit=6': { body: { items: [8003, 8006, 8007] } },
    },
  },
  {
    name: 'db-path-version-newest',
    description: 'image-index-feed off: the Postgres page query on the version (irr.imageId DESC, overscan limit×2), its numeric cursor, and lazy completion through getAllImages.',
    viewer: null,
    host: HOST.green,
    nodeFlags: { imageIndexFeed: false },
    goConfig: { imageIndexFeed: false },
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Newest', browsingLevel: 1, limit: 2 },
    replies: {},
  },
  {
    name: 'tools-pinned-and-feed-page',
    description: 'A `tools` filter on a version with a pinned post: the feed query carries tools=42; the pinned post (Postgres) keeps only its images holding tool 42 (8102, which has no resource row and would pass the version narrowing, has only tool 41); the hydrate of the feed’s ids drops 8105, which the feed named but which has no tool row.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5004, modelVersionId: 6301, sort: 'Most Reactions', browsingLevel: 1, limit: 5, tools: [42] },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6301&excludePoi=1&tools=42&sort=reactions&limit=10': { body: { items: [8101, 8104, 8105] } },
    },
  },
  {
    name: 'db-path-tools-all-of',
    description: 'image-index-feed off, signed in on an NSFW host: `tools: [41, 42]` keeps only images holding both (8002 has 42 only, 8006 41 only); the lazy completion of post 7001 is filtered the same way, so 8002 is not appended.',
    viewer: 1003,
    host: HOST.blue,
    nodeFlags: { imageIndexFeed: false },
    goConfig: { imageIndexFeed: false },
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Newest', browsingLevel: 31, limit: 3, tools: [41, 42] },
    replies: {},
  },
  {
    name: 'tools-sponsored-post-filtered-out',
    description: 'A live sponsored post on page 1 under `tools: [42]`: the sponsored fetch (Postgres) applies tools too, so its only approved image (8201, no tool row) is dropped and no sponsored post is spliced in; its post then shows on the page like any other, completed through the feed with tools.',
    viewer: null,
    host: HOST.green,
    nodeFlags: { creatorPromotions: true },
    goConfig: { creatorPromotions: 'everyone' },
    input: { modelId: 5005, modelVersionId: 6401, sort: 'Most Reactions', browsingLevel: 1, limit: 5, tools: [42] },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6401&excludePoi=1&tools=42&sort=reactions&limit=10': { body: { items: [8202, 8203, 8204] } },
      'levels=1&excludedTags=9901&versionIds=6401&excludePoi=1&tools=42&postIds=7201&sort=reactions&limit=2': { body: { items: [8202, 8201] } },
    },
  },
  {
    name: 'tags-blocked-stripped-pinned-and-feed-page',
    description: '`tags: [5161, 502]` on a version with a pinned post: the blocked 5161 is stripped, so the feed query carries tags=502 only; the pinned post (Postgres) keeps only its image carrying tag 502 (8101; 8102 and 8103 carry other tags); the hydrate of the feed’s ids drops 8105, which the feed named but which does not carry 502.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5004, modelVersionId: 6301, sort: 'Most Reactions', browsingLevel: 1, limit: 5, tags: [5161, 502] },
    replies: {
      'levels=1&tags=502&excludedTags=9901&versionIds=6301&excludePoi=1&sort=reactions&limit=10': { body: { items: [8104, 8105] } },
    },
  },
  {
    name: 'db-path-tags-any-of',
    description: 'image-index-feed off: `tags: [520, 503]` keeps the images carrying either (8007 carries neither, 8002 is above the level); the lazy completion of post 7001 is filtered the same way, so 8002 is not appended. Never cached (getAllImages marks a tag filter personalized).',
    viewer: null,
    host: HOST.green,
    nodeFlags: { imageIndexFeed: false },
    goConfig: { imageIndexFeed: false },
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Newest', browsingLevel: 1, limit: 3, tags: [520, 503] },
    replies: {},
  },
  {
    name: 'tags-all-blocked',
    description: 'Only blocked tags: every getAllImagesIndex call strips them to nothing and answers its own empty page, so the gallery is empty and the feed is never asked.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Reactions', browsingLevel: 1, limit: 3, tags: [5161, 5351] },
    replies: {},
  },
  {
    name: 'techniques-feed-page',
    description: '`techniques: [4, 0, 4]`: the feed query sends the positive ids as given (4,4); the hydrate keeps the images with a row for any of them and drops 8007 (technique 3 only), which the feed named.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Reactions', browsingLevel: 1, limit: 3, techniques: [4, 0, 4] },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6001&excludePoi=1&techniques=4%2C4&sort=reactions&limit=6': { body: { items: [8003, 8006, 8007] } },
    },
  },
  {
    name: 'db-path-techniques-any-of',
    description: 'image-index-feed off: `techniques: [3]` keeps 8007, 8003 and 8001 (any listed technique); the lazy completion of post 7001 is filtered the same way, so 8002 (no technique row) is not appended.',
    viewer: null,
    host: HOST.green,
    nodeFlags: { imageIndexFeed: false },
    goConfig: { imageIndexFeed: false },
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Newest', browsingLevel: 1, limit: 2, techniques: [3] },
    replies: {},
  },
  // Fallbacks: shapes feed-go does not answer.
  {
    name: 'fallback-techniques-not-int4',
    description: 'A `techniques` entry that is not an int4: Node binds it against an integer column, which is not reproduced.',
    fallback: 'input-techniques',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Reactions', browsingLevel: 1, limit: 3, techniques: [1.5] },
  },
  {
    name: 'fallback-unparsed-cursor',
    description: 'A cursor the feed mapper cannot read: Node answers 400 (CURSOR_UNPARSED).',
    fallback: 'feed-cursor:unparsed',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Reactions', browsingLevel: 1, limit: 3, cursor: 'not-a-cursor' },
  },
  {
    name: 'fallback-random-sort',
    description: 'Sort Random is not ported.',
    fallback: 'input-sort',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Random', browsingLevel: 1, limit: 3 },
  },
  {
    name: 'fallback-bearer-token',
    description: 'An API key / OAuth bearer: scopes and moderatorView differ; not ported.',
    fallback: 'bearer-token',
    viewer: null,
    host: HOST.green,
    headers: { authorization: 'Bearer golden-not-a-real-key' },
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Reactions', browsingLevel: 1, limit: 3 },
  },
  // Cold caches: a key Node finds absent and fills by its lookup (the miss feed-go computes). Each
  // fixture's expect.writes is what Node's fetch writes for it.
  {
    name: 'cold-user-cosmetics',
    description: 'A creator whose user-cosmetics entry is not cached: the lookup reads their equipped cosmetics and drops the withheld (a creator listing not displayable) and tombstoned ones; the entry is written back for a day.',
    viewer: null,
    host: HOST.green,
    cold: [`${K.userCosmetics}:1002`],
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Reactions', browsingLevel: 1, limit: 3 },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6001&excludePoi=1&sort=reactions&limit=6': { body: { items: [8003, 8006, 8007] } },
    },
  },
  {
    name: 'cold-image-frames',
    description: 'A framed image whose frame entry is not cached: the lookup finds its frame row (written back for a day); with frame-cache-negative off every frame marker is looked up too (8007\'s withheld creator frame shows none) and no marker is written.',
    viewer: null,
    host: HOST.green,
    cold: [`${K.frames}:8001`],
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 3 },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6001&excludePoi=1&sort=reactions&limit=6': { body: { items: [8001, 8003, 8008, 8005], ...fc('1718000000000', '8005') } },
      'levels=1&excludedTags=9901&versionIds=6001&excludePoi=1&postIds=7001&sort=reactions&limit=2': { body: { items: [8001] } },
    },
  },
  {
    name: 'cold-event-decoration',
    description: 'Two images whose event-decoration entries are not cached: one wears a hat (built from the cosmetic record, written back for a day), the other none (a notFound marker for an hour).',
    viewer: null,
    host: HOST.green,
    events: ['goldentest2026'],
    cold: [`${K.events}:8003`, `${K.events}:8006`],
    input: { modelId: 5001, modelVersionId: 6001, sort: 'Most Reactions', browsingLevel: 1, limit: 3 },
    replies: {
      'levels=1&excludedTags=9901&versionIds=6001&excludePoi=1&sort=reactions&limit=6': { body: { items: [8003, 8006, 8007] } },
    },
  },
  {
    name: 'fallback-sponsored-unknown-audience',
    description: 'A page that would carry a sponsored post while the creator-promotions audience is unknown here (the mirror unset).',
    fallback: 'sponsored-post',
    viewer: null,
    host: HOST.green,
    goConfig: { creatorPromotions: '' },
    input: { modelId: 5005, modelVersionId: 6401, sort: 'Most Reactions', browsingLevel: 1, limit: 5 },
  },
  // The minor content rule (minorMatureImageVisibleSql) on the gallery's Postgres path: post 7013 on
  // version 6401 holds 8701 (minor-flagged, R, by 1002), 8702 (R) and 8703 (minor-flagged, PG-13). The
  // addons carry no minor exclusion, so the rule alone decides on 8701.
  ...[
    [1003, 'stranger', 'another signed-in viewer: 8701 is left out of the page and of the post completion'],
    [1002, 'owner', 'its owner: 8701 is kept'],
    [1004, 'moderator', 'a moderator: 8701 is kept'],
  ].map(([viewer, who, what]) => ({
    name: `minor-mature-db-path-${who}`,
    ...(who === 'stranger' ? { alsoCached: [8701] } : {}),
    description: `image-index-feed off, level 31 on an NSFW host, the addons without the minor exclusion, for ${what}; 8702 and 8703 are shown to every viewer.`,
    viewer,
    host: HOST.blue,
    addons: ADDONS_NO_MINOR,
    nodeFlags: { imageIndexFeed: false },
    goConfig: { imageIndexFeed: false },
    input: { modelId: 5005, modelVersionId: 6401, sort: 'Newest', browsingLevel: 31, limit: 1 },
    replies: {},
  })),
];

const V1 = [
  {
    name: 'signed-out-defaults',
    description: 'Defaults: Most Reactions, AllTime, level PG; addons at PG; nextCursor and nextPage (cursor set, strict-encoded).',
    query: 'limit=3',
    replies: { 'levels=1&excludedTags=9901&excludeMinor=1&excludePoi=1&sort=reactions&limit=3': { body: { items: [8001, 8003, 8006], ...fc('1718000000000', '8006') } } },
  },
  {
    name: 'nsfw-true',
    description: '`nsfw=true` is the NSFW levels (R|X|XXX|Blocked); the addons resolve at the selectable part.',
    query: 'nsfw=true&limit=2',
    replies: { 'levels=4%2C8%2C16%2C32&excludedTags=9911%2C9901&excludeMinor=1&excludePoi=1&sort=reactions&limit=2': { body: { items: [8004] } } },
  },
  {
    name: 'nsfw-deprecated-name-x',
    description: '`nsfw=X` (a deprecated level name) is PG..XXX.',
    query: 'nsfw=X&sort=Most%20Comments&limit=3',
    replies: { 'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901&excludeMinor=1&excludePoi=1&sort=comments&limit=3': { body: { items: [8002, 8004, 8001] } } },
  },
  {
    name: 'nsfw-false',
    description: '`nsfw=false` maps to undefined: the default PG.',
    query: 'nsfw=false&limit=2',
    replies: { 'levels=1&excludedTags=9901&excludeMinor=1&excludePoi=1&sort=reactions&limit=2': { body: { items: [8007, 8006] } } },
  },
  {
    name: 'browsing-level-newest-month',
    description: '`browsingLevel=3`, Newest, period Month (periodDays=30).',
    query: 'browsingLevel=3&sort=Newest&period=Month&limit=3',
    replies: { 'levels=1%2C2&excludedTags=9901&excludeMinor=1&excludePoi=1&sort=newest&periodDays=30&limit=3': { body: { items: [8001, 8002, 8003], ...fc('1717800000000', '8003') } } },
  },
  {
    name: 'username-filter',
    description: '`username` resolved to its id on the replica (userIds=1001).',
    query: 'username=artist_one&limit=3',
    replies: { 'levels=1&excludedTags=9901&userIds=1001&excludeMinor=1&excludePoi=1&sort=reactions&limit=3': { body: { items: [8007, 8001] } } },
  },
  {
    name: 'user-id-own-feed-signed-in',
    description: '`userId` naming the signed-in viewer: their own feed keeps the tag exclusions off; viewerId on the POI exclusion.',
    query: 'userId=1001&limit=3',
    viewer: 1001,
    replies: { 'levels=1&userIds=1001&excludeMinor=1&excludePoi=1&viewerId=1001&sort=reactions&limit=3': { body: { items: [8001, 8007] } } },
  },
  {
    name: 'post-id-filter',
    description: '`postId`: the post’s version’s model gates it (not held); the rest caller serves a post in the requested sort.',
    query: 'postId=7005&limit=10',
    replies: { 'levels=1&excludedTags=9901&excludeMinor=1&excludePoi=1&postIds=7005&sort=reactions&limit=10': { body: { items: [8012, 8011, 8013] } } },
  },
  {
    name: 'model-version-id-filter',
    description: '`modelVersionId`: versionIds; the video’s custom thumbnail is allowed at PG.',
    query: 'modelVersionId=6001&limit=3',
    replies: { 'levels=1&excludedTags=9901&versionIds=6001&excludeMinor=1&excludePoi=1&sort=reactions&limit=3': { body: { items: [8005, 8001, 8003], ...fc('1718100000000', '8003') } } },
  },
  {
    name: 'model-and-version-id',
    description: '`modelId` with `modelVersionId` takes the feed (versionIds), not the legacy path.',
    query: 'modelId=5001&modelVersionId=6001&sort=Most%20Collected&limit=2',
    replies: { 'levels=1&excludedTags=9901&versionIds=6001&excludeMinor=1&excludePoi=1&sort=collected&limit=2': { body: { items: [8006, 8007] } } },
  },
  {
    name: 'held-model-version',
    description: 'An SFW-only model’s version: level 31 intersected with the held level 3.',
    query: 'modelVersionId=6101&browsingLevel=31&limit=5',
    replies: { 'levels=1%2C2&excludedTags=9901&versionIds=6101&excludeMinor=1&excludePoi=1&sort=reactions&limit=5': { body: { items: [8301] } } },
  },
  {
    name: 'withheld-model-version',
    description: 'A taken-down model’s version: `{ items: [], metadata: {} }` for everyone.',
    query: 'modelVersionId=6201&limit=5',
    replies: {},
  },
  {
    name: 'held-images-on-page',
    description: 'A global page holding an R image posted to an SFW-only model: withoutHeldImages drops it, the PG image stays.',
    query: 'browsingLevel=7&limit=5',
    replies: { 'levels=1%2C2%2C4&excludedTags=9911%2C9901&excludeMinor=1&excludePoi=1&sort=reactions&limit=5': { body: { items: [8302, 8301, 8004] } } },
  },
  {
    name: 'page-paging',
    description: '`page=2`: currentPage and pageSize in metadata, nextPage with page=3 (the feed query carries no offset for a page).',
    query: 'page=2&limit=2',
    replies: { 'levels=1&excludedTags=9901&excludeMinor=1&excludePoi=1&sort=reactions&limit=2': { body: { items: [8006, 8007], ...fc('1717900000000', '8007') } } },
  },
  {
    name: 'cursor-page2-last',
    description: 'Page 2 by the feed cursor, the last page: metadata is empty (no nextCursor, no nextPage).',
    query: 'cursor=feed%3A1718000000000%3A8006&limit=3',
    replies: { 'levels=1&excludedTags=9901&excludeMinor=1&excludePoi=1&sort=reactions&limit=3&cursor=1718000000000%7C8006': { body: { items: [8007] } } },
  },
  {
    name: 'video-thumbnails',
    description: '`type=video`: one custom thumbnail allowed at PG, one rated above the request (the still is cut from the video, past the first seconds of a long one); the thumbnail raises the image’s level.',
    query: 'type=video&limit=5',
    replies: { 'levels=1&excludedTags=9901&types=video&excludeMinor=1&excludePoi=1&sort=reactions&limit=5': { body: { items: [8005, 8009] } } },
  },
  {
    name: 'video-thumbnails-unservable',
    description: '`ids` of three videos whose cached thumbnails are not servable (one marked under a block that refuses the owner, one with no marker field, one marked under a hold that leaves the owner the media): each falls back to a still cut from the video.',
    query: 'ids=8031,8032,8033&type=video',
  },
  {
    name: 'signed-in-moderator',
    description: 'A moderator session: no addons (excludedTags off), viewerId on the POI exclusion, moderator SQL.',
    query: 'browsingLevel=31&sort=Oldest&limit=3',
    viewer: 1004,
    replies: { 'levels=1%2C2%2C4%2C8%2C16&excludeMinor=1&excludePoi=1&viewerId=1004&sort=oldest&limit=3': { body: { items: [8001, 8002, 8004], ...fc('1717000000000', '8004') } } },
  },
  {
    name: 'fallback-unknown-key',
    description: 'A key outside imagesEndpointSchema: Node strips it (and keeps it in nextPage), but a key the app added after the Go build was generated is one it reads, so feed-go never treats it as absent.',
    query: 'foo=bar&limit=2&sort=Newest',
    fallback: 'input-unknown-key',
  },
  // `ids`: the legacy Postgres path (getAllImages), in its own order, never the request's.
  {
    name: 'ids-order-duplicates-unknown',
    description: '`ids` out of order, one repeated, one unknown: by id descending (the default sort), each once, the unknown one simply absent; createdAt is the image’s own, not its sortAt.',
    query: 'ids=8003,8001,8999,8007,8001',
  },
  {
    name: 'ids-limit-next-cursor',
    description: '`ids` with `limit`: the look-ahead row’s id is nextCursor, a NUMBER, and nextPage carries it; the R image is below the requested level.',
    query: 'ids=8001,8002,8003,8004,8006&browsingLevel=3&limit=2',
  },
  {
    name: 'ids-cursor-page2',
    description: '`ids` continued by the numeric cursor (inclusive): the last page, no nextCursor.',
    query: 'ids=8001,8002,8003,8004,8006&browsingLevel=3&limit=2&cursor=8002',
  },
  {
    name: 'ids-page-offset',
    description: '`ids` with `page=2`: OFFSET (page - 1) * limit, currentPage and pageSize, a numeric nextCursor and nextPage with page=3.',
    query: 'ids=8001,8002,8003,8006,8007&browsingLevel=3&limit=2&page=2',
  },
  {
    name: 'ids-oldest-videos',
    description: '`ids` with `sort=Oldest` and `type=video`: ascending ids, videos only; one custom thumbnail allowed, one above the level (a still cut from the video).',
    query: 'ids=8009,8001,8005,8003&sort=Oldest&type=video',
  },
  {
    name: 'ids-post-index-order',
    description: '`ids` with `postId`: the post’s own order (its index), and the next cursor is the look-ahead row’s INDEX.',
    query: 'ids=8011,8012,8013,8014,8003&postId=7005&limit=2',
  },
  {
    name: 'ids-model-version-held',
    description: '`ids` with an SFW-only model’s version: the level is held to PG|PG-13, the resource join keeps only the version’s images.',
    query: 'ids=8301,8302,8001&modelVersionId=6101&browsingLevel=31',
  },
  {
    name: 'ids-username-own-signed-in',
    description: '`ids` with `username` naming the signed-in viewer: resolved to their id; on this path the session username makes it their own feed.',
    query: 'ids=8001,8003,8007&username=artist_one',
    viewer: 1001,
  },
  {
    name: 'ids-unknown-only',
    description: '`ids` naming no image: an empty page, `{ items: [], metadata: {} }`.',
    query: 'ids=8998,8999',
  },
  {
    name: 'ids-limit-zero',
    description: '`ids` with `limit=0`: LIMIT 1 reads one row and pops it, so the page is empty but carries a nextCursor and nextPage.',
    query: 'ids=8001,8003&limit=0',
  },
  // withMeta: imageMetaCache (brotli-compressed values), flat on the feed path, `{ id, meta }` on the legacy one.
  {
    name: 'ids-with-meta-wrapped',
    description: '`ids` with `withMeta`: the legacy path wraps each meta as `{ id, meta }`; compressed entries, a plain one written before compression, a cold key read from the database, a hidden meta (null).',
    query: 'ids=8001,8002,8003,8004,8030&withMeta=true&browsingLevel=7',
    cold: ['packed:caches:image-meta:8004'],
  },
  {
    name: 'ids-with-meta-flat',
    description: '`ids` with `withMeta` and `flatMeta=true`: the meta itself; a NULL meta and a notFound marker are both null.',
    query: 'ids=8001,8006,8009&withMeta=true&flatMeta=true&browsingLevel=3',
  },
  {
    name: 'with-meta-feed-flat',
    description: '`withMeta` on the feed path: flat by default, in the feed’s order.',
    query: 'withMeta=true&limit=3',
    replies: { 'levels=1&excludedTags=9901&excludeMinor=1&excludePoi=1&sort=reactions&limit=3': { body: { items: [8003, 8001, 8007] } } },
  },
  {
    name: 'with-meta-feed-flat-false',
    description: '`withMeta` with `flatMeta=false` on the feed path: wrapped as `{ id, meta }`.',
    query: 'withMeta=true&flatMeta=false&limit=2',
    replies: { 'levels=1&excludedTags=9901&excludeMinor=1&excludePoi=1&sort=reactions&limit=2': { body: { items: [8005, 8001], ...fc('1718000000000', '8001') } } },
  },
  // `imageId` and a `modelId` without a version: the same legacy path (runImageSearch's
  // useLegacyMethod), each behind its own switch (FEED_GO_V1_IMAGES_SERVE_IMAGE_ID / _MODEL_ONLY).
  {
    name: 'image-id',
    description: '`imageId`: getAllImages with `i.id = <imageId>` (no model gate: it names no model); the post’s other image is not on the page.',
    query: 'imageId=8002&browsingLevel=3',
    goConfig: { serveV1ImageId: true },
  },
  {
    name: 'image-id-below-level',
    description: '`imageId` of an R image at the default PG level: the level clause drops it, an empty page.',
    query: 'imageId=8004',
    goConfig: { serveV1ImageId: true },
  },
  {
    name: 'image-id-held-post',
    description: '`imageId` of an R image posted to an SFW-only model: no gallery gate (no model named), so the query returns it, and withoutHeldImages drops it by its post’s hold.',
    query: 'imageId=8302&browsingLevel=31',
    goConfig: { serveV1ImageId: true },
  },
  {
    name: 'image-id-limit-zero',
    description: '`imageId` with `limit=0`: LIMIT 1 reads the image and pops it as the look-ahead row, so the page is empty with a numeric nextCursor and a nextPage.',
    query: 'imageId=8001&limit=0',
    goConfig: { serveV1ImageId: true },
  },
  {
    name: 'image-id-with-model',
    description: '`imageId` with a `modelId` and no version: the model’s resource join lists an image once per version of the model it used (8001 used two), and the image clause keeps both rows.',
    query: 'imageId=8001&modelId=5001',
    goConfig: { serveV1ImageId: true, serveV1ModelOnly: true },
  },
  {
    name: 'model-only',
    description: '`modelId` without a version: getAllImages over the model’s resource rows, by `irr."imageId"` descending (the engagement sorts collapse to it); the look-ahead row’s id is a numeric nextCursor.',
    query: 'modelId=5001&limit=3',
    goConfig: { serveV1ModelOnly: true },
  },
  {
    name: 'model-only-oldest-duplicate',
    description: '`modelId` without a version, Oldest: by id ascending; image 8001 used two of the model’s versions, so it is two rows, and both are items.',
    query: 'modelId=5001&sort=Oldest&limit=3&browsingLevel=3',
    goConfig: { serveV1ModelOnly: true },
  },
  {
    name: 'model-only-cursor',
    description: '`modelId` without a version continued by a numeric cursor (inclusive on `irr."imageId"`).',
    query: 'modelId=5001&limit=2&cursor=8006',
    goConfig: { serveV1ModelOnly: true },
  },
  {
    name: 'model-only-page',
    description: '`modelId` without a version with `page=2`: OFFSET (page - 1) * limit, currentPage and pageSize, nextPage with page=3.',
    query: 'modelId=5001&page=2&limit=2&sort=Newest',
    goConfig: { serveV1ModelOnly: true },
  },
  {
    name: 'model-only-held',
    description: '`modelId` of an SFW-only model: level 31 held to PG|PG-13, so its R image is not read.',
    query: 'modelId=5002&browsingLevel=31',
    goConfig: { serveV1ModelOnly: true },
  },
  {
    name: 'model-only-withheld',
    description: '`modelId` of a taken-down model: `{ items: [], metadata: {} }`, no query.',
    query: 'modelId=5003',
    goConfig: { serveV1ModelOnly: true },
  },
  {
    name: 'model-only-requiring-meta',
    description: '`modelId` without a version with `requiringMeta`: getAllImages adds `i."blockedFor" = AiNotVerified`, which a signed-out caller’s block clauses never keep: an empty page.',
    query: 'modelId=5001&requiringMeta=true',
    goConfig: { serveV1ModelOnly: true },
  },
  {
    name: 'ids-requiring-meta-owner',
    description: '`ids` with `requiringMeta`, signed in as the posts’ creator: only the image blocked as AiNotVerified (its owner keeps it), not the unblocked one, nor the CSAM-blocked one (refused to its owner too).',
    query: 'ids=8041,8042,8043&requiringMeta=true',
    viewer: 1002,
  },
  // Fallbacks.
  { name: 'fallback-image-id', description: '`imageId` with FEED_GO_V1_IMAGES_SERVE_IMAGE_ID off: the shape falls back as before its port.', query: 'imageId=8001', fallback: 'v1-image-id' },
  {
    name: 'fallback-image-id-zero',
    description: '`imageId=0` with FEED_GO_V1_IMAGES_SERVE_IMAGE_ID on: falsy to runImageSearch (no legacy path) but present to the feed mapper (an empty page), so not ported: the shape’s fallback.',
    query: 'imageId=0',
    goConfig: { serveV1ImageId: true, serveV1ModelOnly: true },
    fallback: 'v1-image-id',
  },
  { name: 'fallback-ids-hex', description: '`ids` spelled as Number() reads hex: Node takes it, feed-go reads only plain decimals.', query: 'ids=8001,0x1f43', fallback: 'v1-input-ids' },
  { name: 'fallback-ids-feed-cursor', description: 'A feed cursor on an `ids` batch: getCursor cannot read it (a 400 on Node).', query: 'ids=8001&cursor=feed%3A1%3A2', fallback: 'v1-legacy-cursor' },
  { name: 'fallback-model-only', description: 'A `modelId` without a version with FEED_GO_V1_IMAGES_SERVE_MODEL_ONLY off: the shape falls back as before its port.', query: 'modelId=5001', fallback: 'v1-model-only' },
  { name: 'fallback-page-limit', description: '`page * limit > 1000` is a 429 on Node.', query: 'page=20&limit=100', fallback: 'v1-page-limit' },
];

// image.getInfinite: one page of images (the flat shape). The global feed asks the feed service
// with no scope; the creator and tag scopes are feed queries too; a post's media and a model without
// a version take the Postgres query (requiresImageDbPath).
const INFINITE = [
  {
    name: 'cold-global-signed-out',
    description: 'The global feed signed out with a cold frame entry and a cold user-cosmetics entry: the page hydrator computes both misses as on the gallery procedure (Node writes both back).',
    viewer: null,
    host: HOST.green,
    cold: [`${K.frames}:8001`, `${K.userCosmetics}:1002`],
    input: { sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8005, 8001, 8003, 8007], ...fc('1718000000000', '8007') } },
    },
  },
  {
    name: 'global-signed-out-most-reactions',
    description: 'The global feed signed out (domain cap PG): the feed’s page in its order, its next cursor, a framed image, a video with its thumbnail, no profile pictures (not in include), source feed.',
    viewer: null,
    host: HOST.green,
    input: { sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8005, 8001, 8003, 8007], ...fc('1718000000000', '8007') } },
    },
  },
  {
    name: 'global-signed-in-blue-newest',
    description: 'Signed in on an NSFW host: level 31 uncapped, both addons (minor + POI exclusions, viewerId), Newest, the viewer’s own reactions, the last page (no cursor).',
    viewer: 1003,
    host: HOST.blue,
    input: { sort: 'Newest', browsingLevel: 31, limit: 10 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901&excludeMinor=1&excludePoi=1&viewerId=1003&sort=newest&limit=10': { body: { items: [8204, 8007, 8006, 8004, 8002, 8001] } },
    },
  },
  {
    name: 'global-signed-in-green-week-capped',
    description: 'Signed in on an SFW host: 31 capped to PG|PG-13, period Week (periodDays=7), Most Comments, excludedUserIds sent by the client, hideChallenges unioned into the excluded tags.',
    viewer: 1003,
    host: HOST.green,
    input: { sort: 'Most Comments', period: 'Week', browsingLevel: 31, excludedUserIds: [1009], hideChallenges: true, limit: 3 },
    replies: {
      'levels=1%2C2&excludedTags=9901%2C676575&excludedUserIds=1009&excludePoi=1&viewerId=1003&sort=comments&periodDays=7&limit=3': { body: { items: [8002, 8001, 8003], ...fc('1717600000000', '8003') } },
    },
  },
  {
    name: 'global-moderator-oldest',
    description: 'A moderator: no addons, the moderator SQL (no availability or block clauses), Oldest.',
    viewer: 1004,
    host: HOST.blue,
    input: { sort: 'Oldest', browsingLevel: 31, limit: 3 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&sort=oldest&limit=3': { body: { items: [8001, 8002, 8004], ...fc('1717000000000', '8004') } },
    },
  },
  {
    name: 'page2-feed-cursor',
    description: 'Page 2 by the feed’s own cursor (feed:<a>:<b> → cursor=<a>|<b>), the last page.',
    viewer: null,
    host: HOST.green,
    input: { sort: 'Most Reactions', browsingLevel: 1, limit: 4, cursor: 'feed:1718000000000:8007' },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4&cursor=1718000000000%7C8007': { body: { items: [8006, 8020] } },
    },
  },
  {
    name: 'page2-offset-entry-newest',
    description: 'A search-index `offset|entry` cursor under Newest: offset and the entry minute as `before`.',
    viewer: null,
    host: HOST.green,
    input: { sort: 'Newest', browsingLevel: 1, limit: 2, cursor: '100|1718000012345' },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=newest&limit=2&offset=100&before=1717999980000': { body: { items: [8007, 8006], ...fc('1717000000000', '8006') } },
    },
  },
  {
    name: 'version-held-signed-in',
    description: 'An SFW-only model’s version for a signed-in viewer on an NSFW host: 31 intersected with the held level 3; the feed scopes the version, the hydrate drops it.',
    viewer: 1003,
    host: HOST.blue,
    input: { modelVersionId: 6101, sort: 'Most Reactions', browsingLevel: 31, limit: 5 },
    replies: {
      'levels=1%2C2&excludedTags=9901&versionIds=6101&excludePoi=1&viewerId=1003&sort=reactions&limit=5': { body: { items: [8301] } },
    },
  },
  {
    name: 'version-withheld-signed-out',
    description: 'A taken-down model’s version, signed out: the handler’s own empty page (no source, no feed call).',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5003, modelVersionId: 6201, browsingLevel: 1, limit: 10 },
    replies: {},
  },
  {
    name: 'user-id-own-feed',
    description: '`userId` naming the signed-in viewer: their own feed keeps the addon tag exclusions off (POI and minor still on, viewerId), userIds on the feed, the creator filter on the hydrate.',
    viewer: 1001,
    host: HOST.blue,
    input: { userId: 1001, sort: 'Newest', browsingLevel: 31, limit: 5 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&userIds=1001&excludeMinor=1&excludePoi=1&viewerId=1001&sort=newest&limit=5': { body: { items: [8007, 8004, 8001] } },
    },
  },
  {
    name: 'user-id-other-creator-viewer-username',
    description: '`userId` naming another creator beside the signed-in viewer’s own `username`: not the viewer’s own feed (every creator identifier must name the viewer), so the addon tag exclusions apply; userIds from the id.',
    viewer: 1003,
    host: HOST.blue,
    input: { userId: 1001, username: 'viewer_three', sort: 'Newest', browsingLevel: 31, limit: 5 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901&userIds=1001&excludeMinor=1&excludePoi=1&viewerId=1003&sort=newest&limit=5': { body: { items: [8007, 8004, 8001] } },
    },
  },
  {
    name: 'username-scope-signed-out',
    description: '`username` resolved to its id on the replica (userIds=1002), the addons applied (not the viewer’s own).',
    viewer: null,
    host: HOST.green,
    input: { username: 'artist_two', sort: 'Most Collected', browsingLevel: 1, limit: 3 },
    replies: {
      'levels=1&excludedTags=9901&userIds=1002&excludePoi=1&sort=collected&limit=3': { body: { items: [8006, 8003, 8020], ...fc('1717300000000', '8020') } },
    },
  },
  {
    name: 'post-scope-first-page',
    description: 'A post’s own media (`postId`): always the Postgres query, ordered by the image index, its next cursor the look-ahead row’s index, source db.',
    viewer: null,
    host: HOST.green,
    input: { postId: 7005, browsingLevel: 1, limit: 5 },
    replies: {},
  },
  {
    name: 'post-scope-index-cursor',
    description: 'The same post from index cursor 5 (inclusive), signed in: its last three images, no next cursor.',
    viewer: 1003,
    host: HOST.blue,
    input: { postId: 7005, browsingLevel: 31, limit: 5, cursor: 5 },
    replies: {},
  },
  {
    name: 'tag-scope-hydrate-filter',
    description: '`tags`: sent to the feed after `levels`, and applied again by the hydrate (an id the feed returned that does not carry the tag is dropped); not blocked.',
    viewer: null,
    host: HOST.green,
    input: { tags: [501], sort: 'Most Reactions', browsingLevel: 1, limit: 4 },
    replies: {
      'levels=1&tags=501&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8001, 8007, 8004, 8104] } },
    },
  },
  {
    name: 'tag-scope-all-blocked',
    description: 'A tag scope made only of blocked tags: stripBlockedTagIds empties it, getAllImagesIndex’s own empty page (no source, no feed call).',
    viewer: null,
    host: HOST.green,
    input: { tags: [5161, 5351], browsingLevel: 1, limit: 4 },
    replies: {},
  },
  {
    name: 'techniques-global-feed',
    description: 'The global feed signed out with `techniques: [3]`: sent to the feed after the POI exclusion, and the hydrate drops 8006 (technique 4 only), which the feed named.',
    viewer: null,
    host: HOST.green,
    input: { sort: 'Newest', browsingLevel: 1, limit: 3, techniques: [3] },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&techniques=3&sort=newest&limit=3': { body: { items: [8007, 8006, 8001] } },
    },
  },
  {
    name: 'include-profile-pictures',
    description: '`include: [cosmetics, profilePictures]`: the creators’ profile pictures are read and sent.',
    viewer: null,
    host: HOST.green,
    input: { include: ['cosmetics', 'profilePictures'], browsingLevel: 1, limit: 2 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=2': { body: { items: [8001, 8003], ...fc('1718000000000', '8003') } },
    },
  },
  {
    name: 'model-only-db-path',
    description: 'A model without a version: the feed has no model dimension, so the Postgres query (through ModelVersion, irr.imageId DESC), its numeric cursor, source db.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, sort: 'Newest', browsingLevel: 1, limit: 3 },
    replies: {},
  },
  {
    name: 'tools-global-feed',
    description: 'The global feed signed out with `tools: [42, 42, 41]`: the feed query sends the list as given (repeat kept), and the hydrate drops 8006 (tool 41 only), which the feed named.',
    viewer: null,
    host: HOST.green,
    input: { sort: 'Newest', browsingLevel: 31, limit: 3, tools: [42, 42, 41] },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&tools=42%2C42%2C41&sort=newest&limit=3': { body: { items: [8007, 8006, 8001], ...fc('1717500000000', '8001') } },
    },
  },
  {
    name: 'tools-model-only-db-path',
    description: 'A model without a version (the Postgres path) with `tools: [41]`: only images holding tool 41, in irr.imageId DESC order, with the look-ahead row’s id as the cursor.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, sort: 'Newest', browsingLevel: 1, limit: 2, tools: [41] },
    replies: {},
  },
  {
    name: 'base-models-global-feed',
    description: 'The global feed signed out with `baseModels: [SDXL 1.0, "", Illustrious, SDXL 1.0]`: the feed query sends the non-empty names in order, repeat kept, after the POI exclusion; the hydrate binds the whole list and drops 8020 (Pony only), which the feed named.',
    viewer: null,
    host: HOST.green,
    input: { sort: 'Most Reactions', browsingLevel: 1, limit: 4, baseModels: ['SDXL 1.0', '', 'Illustrious', 'SDXL 1.0'] },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&baseModels=SDXL+1.0%2CIllustrious%2CSDXL+1.0&sort=reactions&limit=4': { body: { items: [8204, 8007, 8020, 8001], ...fc('1717900000000', '8001') } },
    },
  },
  {
    name: 'base-models-model-only-db-path',
    description: 'A model without a version (the Postgres path) with `baseModels: [SDXL 1.0]`: only images with a resource on an SDXL 1.0 version (the Pony version 6002’s images 8011-8020 are dropped), in irr.imageId DESC order, the look-ahead row’s id as the cursor.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5001, sort: 'Newest', browsingLevel: 1, limit: 2, baseModels: ['SDXL 1.0'] },
    replies: {},
  },
  {
    name: 'legacy-keys-ignored',
    description: 'A legacy client’s `useIndex` and `search`: not getInfiniteImagesSchema keys, so zod strips them and the answer is the one without them.',
    viewer: null,
    host: HOST.green,
    input: { sort: 'Newest', browsingLevel: 1, limit: 2, useIndex: true, search: 'golden fox' },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=newest&limit=2': { body: { items: [8007, 8006], ...fc('1717000000000', '8006') } },
    },
  },
  {
    name: 'include-count-report',
    description: '`include: [cosmetics, count, report]`: two include values getAllImagesUncaptured never reads, so the answer is the default include’s.',
    viewer: null,
    host: HOST.green,
    input: { include: ['cosmetics', 'count', 'report'], browsingLevel: 1, limit: 2 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=2': { body: { items: [8001, 8003], ...fc('1718000000000', '8003') } },
    },
  },
  {
    name: 'include-tags-signed-out',
    description: '`include: [cosmetics, tags]` signed out: each image’s votable tags from imageTagsCache, as getImageTagsForImages renames them; `tags` undefined where the entry is a notFound marker; no vote read.',
    viewer: null,
    host: HOST.green,
    input: { include: ['cosmetics', 'tags'], sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8005, 8001, 8003, 8007], ...fc('1718000000000', '8007') } },
    },
  },
  {
    name: 'include-tags-signed-in-votes',
    description: '`include: [cosmetics, tags]` signed in: the viewer’s TagsOnImageVote rows merged as `vote` (1 / -1) on the tags they voted; none for a vote on a tag the image does not carry, nor for another viewer’s vote.',
    viewer: 1003,
    host: HOST.blue,
    input: { include: ['cosmetics', 'tags'], sort: 'Newest', browsingLevel: 31, limit: 10 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901&excludeMinor=1&excludePoi=1&viewerId=1003&sort=newest&limit=10': { body: { items: [8204, 8007, 8006, 8004, 8002, 8001] } },
    },
  },
  {
    name: 'followed-signed-in',
    description: '`followed: true` signed in: the viewer’s follow list (userFollowsCache: 1002) as the feed’s userIds, and as the hydrate’s `i."userId" IN (…)`, which drops 8004 (1001’s), which the feed named.',
    viewer: 1003,
    host: HOST.blue,
    input: { followed: true, sort: 'Newest', browsingLevel: 31, limit: 10 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901&userIds=1002&excludeMinor=1&excludePoi=1&viewerId=1003&sort=newest&limit=10': { body: { items: [8006, 8004, 8003] } },
    },
  },
  {
    name: 'followed-signed-in-no-follows',
    description: '`followed: true` signed in with an empty follow list (a notFound marker): serveFromFeed’s empty page, no feed call.',
    viewer: 1001,
    host: HOST.green,
    input: { followed: true, sort: 'Newest', browsingLevel: 1, limit: 10 },
    replies: {},
  },
  {
    name: 'followed-signed-out',
    description: '`followed: true` signed out: the flag is dropped (no follow read, no userIds): the global feed.',
    viewer: null,
    host: HOST.green,
    input: { followed: true, sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8005, 8001, 8003, 8007], ...fc('1718000000000', '8007') } },
    },
  },
  {
    name: 'followed-with-creator',
    description: '`followed: true` with a `userId` signed in: the mapper refuses a follow list beside a creator (flag:followed:userId), an empty page; no feed call.',
    viewer: 1003,
    host: HOST.blue,
    input: { followed: true, userId: 1001, sort: 'Newest', browsingLevel: 31, limit: 5 },
    replies: {},
  },
  {
    name: 'followed-model-only-db-path',
    description: '`followed: true` signed in on the Postgres path (a model without a version): only the followed creator’s (1002) images of the model, irr.imageId DESC, the look-ahead row’s id as the cursor.',
    viewer: 1003,
    host: HOST.blue,
    input: { followed: true, modelId: 5001, sort: 'Newest', browsingLevel: 31, limit: 2 },
    replies: {},
  },
  {
    name: 'collection-public-signed-out',
    description: 'A public collection (9101) signed out: its ACCEPTED items only (not 8006 or 8204 in review, nor the rejected 8203), Newest; 8007’s note holds no score (judgeScore null).',
    viewer: null,
    host: HOST.green,
    input: { collectionId: 9101, sort: 'Newest', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'collection-public-signed-in-own-items',
    description: 'A public collection (9101) signed in as 1003: the ACCEPTED items and 1003’s own item in review (8006), not 1002’s in review (8204) nor 1003’s rejected one (8203); Recently Added (item id DESC), the look-ahead item’s id as the cursor.',
    viewer: 1003,
    host: HOST.blue,
    input: { collectionId: 9101, sort: 'Recently Added', browsingLevel: 31, limit: 3 },
  },
  {
    name: 'collection-recently-added-cursor',
    description: 'The next Recently Added page of 9101 for 1003: the cursor is an item id, inclusive.',
    viewer: 1003,
    host: HOST.blue,
    input: { collectionId: 9101, sort: 'Recently Added', cursor: 95002, browsingLevel: 31, limit: 3 },
  },
  {
    name: 'collection-tag',
    description: 'A collection narrowed by `collectionTagId` (31): only 8003’s item.',
    viewer: null,
    host: HOST.green,
    input: { collectionId: 9101, collectionTagId: 31, sort: 'Newest', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'collection-public-moderator',
    description: 'A public collection read by a moderator (1004): read is granted whatever the branch, so it is answered; the moderator view’s filters apply.',
    viewer: 1004,
    host: HOST.blue,
    input: { collectionId: 9101, sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'collection-private-owner',
    description: 'A private collection (9102) read by its owner (1001): its items, 1001’s acceptableMinor 8501 included (an owner still sees it in a collection).',
    viewer: 1001,
    host: HOST.blue,
    input: { collectionId: 9102, sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'collection-private-other-viewer',
    description: 'A private collection (9102) read by 1003, whose contributor row holds no VIEW: no read, Node’s empty page; no page query.',
    viewer: 1003,
    host: HOST.blue,
    input: { collectionId: 9102, sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'collection-private-signed-out',
    description: 'A private collection (9102) signed out: no read, the empty page.',
    viewer: null,
    host: HOST.green,
    input: { collectionId: 9102, browsingLevel: 1, limit: 10 },
  },
  {
    name: 'collection-missing',
    description: 'A collection that does not exist (88): createEmptyPermissions reads for no one, the empty page.',
    viewer: null,
    host: HOST.green,
    input: { collectionId: 88, browsingLevel: 1, limit: 10 },
  },
  // `publishedOnly` (FEED_GO_INFINITE_SERVE_INPUT_PUBLISHED_ONLY): the own-content submit pickers.
  {
    name: 'published-only-own-picker',
    description: '`publishedOnly` beside the viewer’s own `userId` (the submit pickers): requiresImageDbPath, so the Postgres page of the creator’s images, Newest (i."id" DESC), the look-ahead row’s id as the cursor; no feed call.',
    goConfig: { servePublishedOnly: true },
    viewer: 1001,
    host: HOST.blue,
    input: { userId: 1001, publishedOnly: true, sort: 'Newest', browsingLevel: 31, limit: 2 },
  },
  {
    name: 'published-only-own-picker-cursor',
    description: 'The next page of the own picker: the numeric cursor is an image id, inclusive.',
    goConfig: { servePublishedOnly: true },
    viewer: 1001,
    host: HOST.blue,
    input: { userId: 1001, publishedOnly: true, sort: 'Newest', cursor: 8004, browsingLevel: 31, limit: 2 },
  },
  {
    name: 'published-only-foreign-creator',
    description: '`publishedOnly` beside another creator’s `userId`: the handler withdraws the flag, so the creator’s feed on the index (userIds=1001) as without it.',
    goConfig: { servePublishedOnly: true },
    viewer: 1003,
    host: HOST.blue,
    input: { userId: 1001, publishedOnly: true, sort: 'Newest', browsingLevel: 31, limit: 5 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901&userIds=1001&excludeMinor=1&excludePoi=1&viewerId=1003&sort=newest&limit=5': { body: { items: [8007, 8004, 8001] } },
    },
  },
  {
    name: 'published-only-signed-out',
    description: '`publishedOnly` with a `userId` signed out: no caller id to match, so withdrawn; the creator’s feed, edge-cacheable.',
    goConfig: { servePublishedOnly: true },
    viewer: null,
    host: HOST.green,
    input: { userId: 1001, publishedOnly: true, sort: 'Newest', browsingLevel: 1, limit: 5 },
    replies: {
      'levels=1&excludedTags=9901&userIds=1001&excludePoi=1&sort=newest&limit=5': { body: { items: [8007, 8004, 8001] } },
    },
  },
  {
    name: 'published-only-without-creator',
    description: '`publishedOnly` without a `userId`: no DB routing, and the mapper refuses the flag (flag:publishedOnly), an empty page; no feed call.',
    goConfig: { servePublishedOnly: true },
    viewer: 1003,
    host: HOST.blue,
    input: { publishedOnly: true, sort: 'Newest', browsingLevel: 31, limit: 5 },
  },
  {
    name: 'published-only-own-username',
    description: '`publishedOnly` beside the viewer’s own `username` and no `userId`: only `userId` is compared, so the flag stays and does not route to Postgres; the name resolves, then the mapper’s empty page.',
    goConfig: { servePublishedOnly: true },
    viewer: 1001,
    host: HOST.blue,
    input: { username: 'artist_one', publishedOnly: true, sort: 'Newest', browsingLevel: 31, limit: 5 },
  },
  {
    name: 'published-only-false',
    description: '`publishedOnly: false` beside the viewer’s own `userId`: no routing, the creator’s own feed on the index.',
    goConfig: { servePublishedOnly: true },
    viewer: 1001,
    host: HOST.blue,
    input: { userId: 1001, publishedOnly: false, sort: 'Newest', browsingLevel: 31, limit: 5 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&userIds=1001&excludeMinor=1&excludePoi=1&viewerId=1001&sort=newest&limit=5': { body: { items: [8007, 8004, 8001] } },
      },
    },
  // `postIds` (FEED_GO_INFINITE_SERVE_INPUT_POST_IDS): several posts' media, always the Postgres path.
  {
    name: 'post-ids-signed-out',
    description: '`postIds` signed out: requiresImageDbPath, the Postgres page of those posts’ images only (`i."postId" = ANY(…)`), Newest (i."id" DESC), the look-ahead row’s id as the cursor; no feed call; edge-cacheable.',
    goConfig: { servePostIds: true },
    viewer: null,
    host: HOST.green,
    input: { postIds: [7101, 7201], sort: 'Newest', browsingLevel: 1, limit: 2 },
  },
  {
    name: 'post-ids-cursor',
    description: 'The next page of the same posts: the numeric cursor is an image id, inclusive.',
    goConfig: { servePostIds: true },
    viewer: null,
    host: HOST.green,
    input: { postIds: [7101, 7201], sort: 'Newest', cursor: 8103, browsingLevel: 1, limit: 2 },
  },
  {
    name: 'post-ids-signed-in-oldest',
    description: '`postIds` signed in at every level, Oldest (i."id" ASC): another creator’s posts, the viewer’s addon exclusions applied.',
    goConfig: { servePostIds: true },
    viewer: 1003,
    host: HOST.blue,
    input: { postIds: [7002, 7004, 7009], sort: 'Oldest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'post-ids-beside-post-id',
    description: '`postIds` beside a `postId`: both clauses, and the post scope’s order (i."index", i."id").',
    goConfig: { servePostIds: true },
    viewer: null,
    host: HOST.green,
    input: { postId: 7101, postIds: [7101, 7201], browsingLevel: 1, limit: 2 },
  },
  {
    name: 'post-ids-held-model',
    description: '`postIds` naming a post on an SFW-only model (7301 on 5002, held at 3): the gallery gate folds every listed post’s model into the hold, so the page is served at 31 & 3 (8302 at 4 dropped).',
    goConfig: { servePostIds: true },
    viewer: 1003,
    host: HOST.blue,
    input: { postIds: [7301, 7101], sort: 'Newest', browsingLevel: 31, limit: 10 },
    alsoCached: [8302],
  },
  {
    name: 'post-ids-taken-down-stranger',
    description: '`postIds` naming a post on a taken-down model (7401 on 5003) read by someone else: the gallery is withheld, the handler’s empty page.',
    goConfig: { servePostIds: true },
    viewer: 1003,
    host: HOST.blue,
    input: { postIds: [7401, 7101], sort: 'Newest', browsingLevel: 31, limit: 10 },
    // The rows only: their per-image caches would be read by no Node answer (the harness's cold-metrics
    // runs require a held metric hash to be read).
    alsoPosts: [7401, 7101],
  },
  {
    name: 'post-ids-taken-down-owner',
    description: 'The same posts read by the taken-down model’s owner (1001): not withheld, the posts’ images.',
    goConfig: { servePostIds: true },
    viewer: 1001,
    host: HOST.blue,
    input: { postIds: [7401, 7101], sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'post-ids-empty-list',
    description: '`postIds: []`: no filter and no routing (`?.length`), the global feed.',
    goConfig: { servePostIds: true },
    viewer: null,
    host: HOST.green,
    input: { postIds: [], sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8005, 8001, 8003, 8007], ...fc('1718000000000', '8007') } },
    },
  },
  // A collection's Random sort (FEED_GO_INFINITE_SERVE_SORT_RANDOM on): the stored hourly seed, each
  // item's seeded hash as its sort key, the `seed:sortKey:id` cursor.
  {
    name: 'collection-random-first-page',
    description: 'Random on a public collection (9101) signed out: the stored seed (494868) hashes each ACCEPTED item; the highest sort key first; the look-ahead row’s seed:sortKey:id as the cursor.',
    viewer: null,
    host: HOST.green,
    goConfig: { serveSortRandom: true },
    randomSeed: '494868',
    input: { collectionId: 9101, sort: 'Random', browsingLevel: 1, limit: 1 },
  },
  {
    name: 'collection-random-cursor',
    description: 'The next Random page from the first page’s cursor: strictly below its sort key (the CTE’s `<`), so the look-ahead row itself (8007) is not on it, as in Node; the end, no cursor.',
    viewer: null,
    host: HOST.green,
    goConfig: { serveSortRandom: true },
    randomSeed: '494868',
    input: { collectionId: 9101, sort: 'Random', cursor: '494868:337483310:8007', browsingLevel: 1, limit: 1 },
  },
  {
    name: 'collection-random-cursor-seed-wins',
    description: 'A Random cursor from the previous hour (seed 494867) signed in as 1003: the cursor’s seed, not the stored one, orders the items (1003’s own 8006 in review included) and is the next cursor’s.',
    viewer: 1003,
    host: HOST.blue,
    goConfig: { serveSortRandom: true },
    randomSeed: '494868',
    input: { collectionId: 9101, sort: 'Random', cursor: '494867:588720858:8003', browsingLevel: 31, limit: 1 },
  },
  {
    name: 'collection-random-numeric-cursor',
    description: 'A numeric cursor with Random: String(cursor) is not seed:sortKey:id, so Node reads no cursor at all: the first page under the stored seed.',
    viewer: null,
    host: HOST.green,
    goConfig: { serveSortRandom: true },
    randomSeed: '494868',
    input: { collectionId: 9101, sort: 'Random', cursor: 95002, browsingLevel: 1, limit: 1 },
  },
  {
    name: 'collection-random-cursor-zero-seed',
    description: 'A Random cursor whose seed is 0 (falsy): the stored seed orders the page, the cursor’s sort key and id still page it.',
    viewer: null,
    host: HOST.green,
    goConfig: { serveSortRandom: true },
    randomSeed: '494868',
    input: { collectionId: 9101, sort: 'Random', cursor: '0:400000000:9999', browsingLevel: 1, limit: 1 },
  },
  // A model's gallery-settings key absent (getShowcaseHeldLevels' miss: getGallerySettingsByModelId
  // rebuilds it from the model row), answered with FEED_GO_INFINITE_SERVE_GALLERY_SETTINGS_MISS on.
  {
    name: 'cold-gallery-settings-version-held',
    description: 'version-held-signed-in with model 5002’s gallery-settings key absent: the rebuild reads the row (SFW-only, stored level 3), held at heldGalleryLevel(3) = PG|PG-13, so the same page. Node also writes the key back; feed-go does not.',
    viewer: 1003,
    host: HOST.blue,
    goConfig: { serveGallerySettingsMiss: true },
    cold: ['model:gallery-settings:5002'],
    input: { modelVersionId: 6101, sort: 'Most Reactions', browsingLevel: 31, limit: 5 },
    replies: {
      'levels=1%2C2&excludedTags=9901&versionIds=6101&excludePoi=1&viewerId=1003&sort=reactions&limit=5': { body: { items: [8301] } },
    },
  },
  {
    name: 'cold-gallery-settings-ids-held-stranger',
    description: 'ids-held-stranger with model 5002’s gallery-settings key absent: getHeldLevelsByPost’s hold is rebuilt from the row (SFW-only: PG|PG-13), so 8302 (R) is still left out.',
    viewer: 1003,
    host: HOST.blue,
    goConfig: { serveGallerySettingsMiss: true },
    cold: ['model:gallery-settings:5002'],
    input: { ids: [8302, 8301, 8001, 8999], sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'cold-gallery-settings-model-unheld',
    description: 'model-only-db-path with model 5001’s gallery-settings key absent: the rebuild finds it neither minor nor SFW-only, so no hold.',
    viewer: null,
    host: HOST.green,
    goConfig: { serveGallerySettingsMiss: true },
    cold: ['model:gallery-settings:5001'],
    input: { modelId: 5001, sort: 'Newest', browsingLevel: 1, limit: 3 },
    replies: {},
  },
  // `hubId` (FEED_GO_INFINITE_SERVE_INPUT_HUB_ID, with the `user-hubs` flag on for the viewer): a
  // user-composed hub resolved to the feed's any-of sources (resolveHubForFeed, mapHubSources).
  {
    name: 'hub-public-signed-out',
    description: 'Public hub 9301 signed out: its enabled sources (creator 1002, version 6301, tag group 501+502 and tag 520; the disabled creator and the dark collection left out) as the any-of lists, its keep-outs (creator 1009 first in excludedUserIds, version 6401, the exclude group 531+532 kept apart from the include group of the same key), the feed’s union route, its cursor; edge-cacheable.',
    ...HUB_ON,
    viewer: null,
    host: HOST.green,
    input: { hubId: 9301, sort: 'Newest', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludedUserIds=1009&anyUserIds=1002&anyVersionIds=6301&anyTagGroups=501%2C502%3B520&excludedVersionIds=6401&excludedTagGroups=531%2C532&excludePoi=1&sort=newest&limit=4': {
        body: { items: [8104, 8101, 8003, 8005], route: 'union-walk', ...fc('1717400000000', '8005') },
      },
    },
  },
  {
    name: 'hub-public-cursor',
    description: 'Page 2 of hub 9301 by the feed’s cursor (union-gather), the last page.',
    ...HUB_ON,
    viewer: null,
    host: HOST.green,
    input: { hubId: 9301, sort: 'Newest', browsingLevel: 31, limit: 4, cursor: 'feed:1717400000000:8005' },
    replies: {
      'levels=1&excludedTags=9901&excludedUserIds=1009&anyUserIds=1002&anyVersionIds=6301&anyTagGroups=501%2C502%3B520&excludedVersionIds=6401&excludedTagGroups=531%2C532&excludePoi=1&sort=newest&limit=4&cursor=1717400000000%7C8005': {
        body: { items: [8006], route: 'union-gather' },
      },
    },
  },
  {
    name: 'hub-session-exclusions',
    description: 'Hub 9301 signed in (1003) with two sources switched off for the session: creator 1002 leaves the hub, and tag 501 takes its whole AND-group (502 too); the keep-outs are untouched (a session toggle narrows only the positive sources).',
    ...HUB_ON,
    viewer: 1003,
    host: HOST.blue,
    input: { hubId: 9301, hubExcludedSources: [{ type: 'User', targetId: 1002 }, { type: 'Tag', targetId: 501, ignored: true }], sort: 'Newest', browsingLevel: 31, limit: 10 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901&excludedUserIds=1009&anyVersionIds=6301&anyTagGroups=520&excludedVersionIds=6401&excludedTagGroups=531%2C532&excludeMinor=1&excludePoi=1&viewerId=1003&sort=newest&limit=10': {
        body: { items: [8104, 8101, 8102], route: 'union-walk' },
      },
    },
  },
  {
    name: 'hub-private-owner-version-expansion',
    description: 'Private hub 9302 read by its owner (1003): its Model source 5001 expanded to its versions under the per-model budget (6002, 6001: newest id first), creator 1001, the excluded Model 5005 expanded to all its versions (6401); the tag group 533+531 switched off for the session by one member. The versions’ model is neither taken down nor held.',
    ...HUB_ON,
    viewer: 1003,
    host: HOST.blue,
    input: { hubId: 9302, hubExcludedSources: [{ type: 'Tag', targetId: 533 }], sort: 'Most Reactions', browsingLevel: 31, limit: 5 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901&anyUserIds=1001&anyVersionIds=6002%2C6001&excludedVersionIds=6401&excludeMinor=1&excludePoi=1&viewerId=1003&sort=reactions&limit=5': {
        body: { items: [8001, 8004, 8007, 8501], route: 'union-gather' },
      },
    },
  },
  {
    name: 'hub-private-moderator',
    description: 'Private hub 9302 read by a moderator (1004): any hub opens to a moderator, no addons, and no hold or taken-down read (holdExempt); the tag AND-group 533+531 is served.',
    ...HUB_ON,
    viewer: 1004,
    host: HOST.blue,
    input: { hubId: 9302, sort: 'Oldest', browsingLevel: 31, limit: 3 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&anyUserIds=1001&anyVersionIds=6002%2C6001&anyTagGroups=533%2C531&excludedVersionIds=6401&sort=oldest&limit=3': {
        body: { items: [8001, 8003], route: 'union-walk' },
      },
    },
  },
  {
    name: 'hub-private-signed-out',
    description: 'Private hub 9302 signed out: hubViewerWhere opens only Public hubs, so no hub (`hubSources: null`): the empty page, no feed call.',
    ...HUB_ON,
    viewer: null,
    host: HOST.green,
    input: { hubId: 9302, sort: 'Newest', browsingLevel: 31, limit: 4 },
  },
  {
    name: 'hub-private-stranger',
    description: 'Private hub 9302 read by someone else (1002): not theirs and not Public, the empty page.',
    ...HUB_ON,
    viewer: 1002,
    host: HOST.blue,
    input: { hubId: 9302, sort: 'Newest', browsingLevel: 31, limit: 4 },
  },
  {
    name: 'hub-held-and-capped',
    description: 'Hub 9303 (its own cap PG|PG-13|R) over a version of SFW-only model 5002 (held at PG|PG-13), signed in at every level: the feed is asked at 31 & 7 & 3 = PG|PG-13, while the hydrate keeps the request’s level 31 (feedHydrateQuery hydrates the uncapped input); the addons resolve at 31.',
    ...HUB_ON,
    viewer: 1003,
    host: HOST.blue,
    input: { hubId: 9303, sort: 'Newest', browsingLevel: 31, limit: 10 },
    replies: {
      'levels=1%2C2&excludedTags=9911%2C9901&anyUserIds=1002&anyVersionIds=6101&excludeMinor=1&excludePoi=1&viewerId=1003&sort=newest&limit=10': {
        body: { items: [8301, 8003], route: 'union-walk' },
      },
    },
  },
  {
    name: 'hub-held-moderator',
    description: 'Hub 9303 read by a moderator: not held (holdExempt), so only the hub’s own cap (31 & 7).',
    ...HUB_ON,
    viewer: 1004,
    host: HOST.blue,
    input: { hubId: 9303, sort: 'Newest', browsingLevel: 31, limit: 10 },
    replies: {
      'levels=1%2C2%2C4&anyUserIds=1002&anyVersionIds=6101&sort=newest&limit=10': {
        body: { items: [8302, 8301], route: 'union-walk' },
      },
    },
  },
  {
    name: 'hub-capped-to-nothing',
    description: 'Hub 9306 capped to R signed out (the domain cap PG): PG & R is nothing, so no hub and the empty page.',
    ...HUB_ON,
    viewer: null,
    host: HOST.green,
    input: { hubId: 9306, sort: 'Newest', browsingLevel: 31, limit: 4 },
  },
  {
    name: 'hub-taken-down-stranger',
    description: 'Hub 9304 over a version of taken-down model 5003 read by someone else (1003): the version leaves the hub (getWithheldVersionIds), no source is left, the empty page.',
    ...HUB_ON,
    viewer: 1003,
    host: HOST.blue,
    input: { hubId: 9304, sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'hub-taken-down-owner',
    description: 'Hub 9304 read by the taken-down model’s owner (1001): the version stays.',
    ...HUB_ON,
    viewer: 1001,
    host: HOST.blue,
    input: { hubId: 9304, sort: 'Newest', browsingLevel: 31, limit: 10 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901&anyVersionIds=6201&excludeMinor=1&excludePoi=1&viewerId=1001&sort=newest&limit=10': {
        body: { items: [8401], route: 'union-walk' },
      },
    },
  },
  {
    name: 'hub-no-source',
    description: 'Hub 9305 holds only a collection (dark: HUB_COLLECTION_SOURCES_ENABLED is false) and a disabled creator: nothing to serve, the empty page.',
    ...HUB_ON,
    viewer: null,
    host: HOST.green,
    input: { hubId: 9305, sort: 'Newest', browsingLevel: 31, limit: 4 },
  },
  {
    name: 'hub-not-found',
    description: 'A hub id no row has (and a negative one): the empty page, never the open feed.',
    ...HUB_ON,
    viewer: 1003,
    host: HOST.blue,
    input: { hubId: -5, sort: 'Newest', browsingLevel: 31, limit: 4 },
  },
  {
    name: 'hub-route-not-a-union',
    description: 'Hub 9301 answered on a route that is not one of HUB_ROUTES (a feed build that ignored the sources): serveFromFeed’s `hub:route`, which answerWithoutFeed serves as the empty page.',
    ...HUB_ON,
    viewer: null,
    host: HOST.green,
    input: { hubId: 9301, sort: 'Newest', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludedUserIds=1009&anyUserIds=1002&anyVersionIds=6301&anyTagGroups=501%2C502%3B520&excludedVersionIds=6401&excludedTagGroups=531%2C532&excludePoi=1&sort=newest&limit=4': {
        body: { items: [8001, 8003], route: 'walk' },
      },
    },
  },
  {
    name: 'hub-beside-user-id',
    description: 'Hub 9301 beside a creator scope: the feed takes one driver (`hub:driver`), the mapper’s empty page, no feed call.',
    ...HUB_ON,
    viewer: null,
    host: HOST.green,
    input: { hubId: 9301, userId: 1002, sort: 'Newest', browsingLevel: 31, limit: 4 },
  },
  {
    name: 'hub-index-feed-off',
    description: 'Hub 9301 with the image-index-feed flag off: a hub is only expressible on the feed service, so it pins the feed path anyway.',
    ...HUB_ON,
    goConfig: { ...HUB_ON.goConfig, imageIndexFeed: false },
    nodeFlags: { ...HUB_ON.nodeFlags, imageIndexFeed: false },
    viewer: null,
    host: HOST.green,
    input: { hubId: 9301, sort: 'Most Reactions', browsingLevel: 1, limit: 2 },
    replies: {
      'levels=1&excludedTags=9901&excludedUserIds=1009&anyUserIds=1002&anyVersionIds=6301&anyTagGroups=501%2C502%3B520&excludedVersionIds=6401&excludedTagGroups=531%2C532&excludePoi=1&sort=reactions&limit=2': {
        body: { items: [8005, 8003], route: 'union-gather' },
      },
    },
  },
  {
    name: 'hub-id-zero',
    description: '`hubId: 0` is no hub (every Node check is truthiness): the global feed, the flag never consulted.',
    ...HUB_ON,
    viewer: null,
    host: HOST.green,
    input: { hubId: 0, sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8005, 8001, 8003, 8007], ...fc('1718000000000', '8007') } },
    },
  },
  {
    name: 'hub-excluded-sources-without-hub',
    description: '`hubExcludedSources` without a `hubId`: validated, then read by nothing; the global feed.',
    ...HUB_ON,
    viewer: null,
    host: HOST.green,
    input: { hubExcludedSources: [{ type: 'User', targetId: 1002 }], sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8005, 8001, 8003, 8007], ...fc('1718000000000', '8007') } },
    },
  },
  // Fallbacks.
  {
    name: 'fallback-published-only-off',
    description: 'The own picker with FEED_GO_INFINITE_SERVE_INPUT_PUBLISHED_ONLY off: the shape falls back, as before the port.',
    fallback: 'input-publishedOnly',
    viewer: 1001,
    host: HOST.blue,
    input: { userId: 1001, publishedOnly: true, sort: 'Newest', browsingLevel: 31, limit: 2 },
  },
  {
    name: 'fallback-published-only-null',
    description: '`publishedOnly: null`: z.boolean().optional() refuses a null, Node’s BAD_REQUEST, which it answers itself.',
    fallback: 'input-invalid',
    goConfig: { servePublishedOnly: true },
    viewer: 1001,
    host: HOST.blue,
    input: { userId: 1001, publishedOnly: null, sort: 'Newest', browsingLevel: 31, limit: 2 },
  },
  {
    name: 'fallback-post-ids-off',
    description: '`postIds` with FEED_GO_INFINITE_SERVE_INPUT_POST_IDS off: the shape falls back, as before the port.',
    fallback: 'input-postIds',
    viewer: null,
    host: HOST.green,
    input: { postIds: [7001, 7003], sort: 'Newest', browsingLevel: 1, limit: 2 },
  },
  {
    name: 'fallback-post-ids-not-int4',
    description: 'A `postIds` entry that is not an int4 integer: Node binds it against the integer column, which Postgres refuses; not answered here.',
    fallback: 'input-postIds',
    goConfig: { servePostIds: true },
    viewer: null,
    host: HOST.green,
    input: { postIds: [7001, 1.5], browsingLevel: 1, limit: 2 },
  },
  {
    name: 'fallback-post-ids-null',
    description: '`postIds: null`: z.number().array().optional() refuses a null, Node’s BAD_REQUEST, which it answers itself.',
    fallback: 'input-invalid',
    goConfig: { servePostIds: true },
    viewer: null,
    host: HOST.green,
    input: { postIds: null, browsingLevel: 1, limit: 2 },
  },
  {
    name: 'fallback-followed-not-a-boolean',
    description: '`followed: "true"`: z.boolean() is not coerced, so the schema’s BAD_REQUEST, which Node answers itself.',
    fallback: 'input-invalid',
    viewer: 1003,
    host: HOST.blue,
    input: { followed: 'true', browsingLevel: 31, limit: 2 },
  },
  {
    name: 'fallback-base-models-not-a-list',
    description: '`baseModels` as a bare string: the schema’s BAD_REQUEST (z.string().array()), which Node answers itself.',
    fallback: 'input-invalid',
    viewer: null,
    host: HOST.green,
    input: { baseModels: 'Pony', browsingLevel: 1, limit: 2 },
  },
  {
    name: 'fallback-include-meta-select',
    description: '`include: [cosmetics, tags, metaSelect]`: the tags are answered, but metaSelect (getMetaForImages) is not ported.',
    fallback: 'input-include',
    viewer: null,
    host: HOST.green,
    input: { include: ['cosmetics', 'tags', 'metaSelect'], browsingLevel: 1, limit: 2 },
  },
  {
    name: 'fallback-unknown-key',
    description: 'A key outside getInfiniteImagesSchema that is not a known stripped key still hands back, beside an ignored legacy one.',
    fallback: 'input-unknown-key',
    viewer: null,
    host: HOST.green,
    input: { someNewFilter: true, useIndex: true, browsingLevel: 1, limit: 2 },
  },
  {
    name: 'fallback-hat-turf-sort',
    description: 'A Hat Turf sort: Node reads the event engine and the turf rank; not ported.',
    fallback: 'infinite-hat-turf',
    viewer: 1003,
    host: HOST.blue,
    input: { hatSort: 'most', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'fallback-hub',
    description: 'A hub (`hubId`): its sources are resolved server-side; not ported.',
    fallback: 'input-hubId',
    viewer: null,
    host: HOST.green,
    input: { hubId: 77, browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-hub-excluded-sources-off',
    description: '`hubExcludedSources` with FEED_GO_INFINITE_SERVE_INPUT_HUB_ID off: the key falls back, as before the port.',
    fallback: 'input-hubExcludedSources',
    viewer: null,
    host: HOST.green,
    input: { hubExcludedSources: [{ type: 'User', targetId: 1002 }], browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-hub-flag-off',
    description: 'A `hubId` for a viewer the `user-hubs` flag is off for: Node’s UNAUTHORIZED, which it answers itself.',
    fallback: 'infinite-hub-flag-off',
    goConfig: { serveHubId: true, userHubs: 'off' },
    viewer: 1003,
    host: HOST.blue,
    input: { hubId: 9301, browsingLevel: 31, limit: 10 },
  },
  {
    name: 'fallback-hub-flag-unknown',
    description: 'A `hubId` with no `user-hubs` flag reader: never served without knowing the flag is on.',
    fallback: 'infinite-hub-flag-unknown',
    goConfig: { serveHubId: true },
    viewer: null,
    host: HOST.green,
    input: { hubId: 9301, browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-hub-flag-error',
    description: 'A `hubId` whose `user-hubs` read fails: the same unknown-flag fallback.',
    fallback: 'infinite-hub-flag-unknown',
    goConfig: { serveHubId: true, userHubs: 'error' },
    viewer: 1003,
    host: HOST.blue,
    input: { hubId: 9301, browsingLevel: 31, limit: 10 },
  },
  {
    name: 'fallback-hub-id-not-int4',
    description: 'A `hubId` that is not an int4 integer: Prisma refuses it in the hub read (a 500); not answered here.',
    fallback: 'input-hubId',
    goConfig: { serveHubId: true, userHubs: 'on' },
    viewer: null,
    host: HOST.green,
    input: { hubId: 1.5, browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-hub-id-null',
    description: '`hubId: null`: z.number().optional() refuses a null, Node’s BAD_REQUEST.',
    fallback: 'input-invalid',
    goConfig: { serveHubId: true, userHubs: 'on' },
    viewer: null,
    host: HOST.green,
    input: { hubId: null, browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-hub-beside-post-id',
    description: 'A `hubId` beside a `postId` (an input that routes to Postgres): the schema’s superRefine refuses it, Node’s BAD_REQUEST.',
    fallback: 'input-invalid',
    goConfig: { serveHubId: true, userHubs: 'on' },
    viewer: null,
    host: HOST.green,
    input: { hubId: 9301, postId: 7101, browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-hub-excluded-sources-invalid',
    description: 'A `hubExcludedSources` entry whose type is not a UserHubSourceType: the schema’s BAD_REQUEST.',
    fallback: 'input-invalid',
    goConfig: { serveHubId: true, userHubs: 'on' },
    viewer: null,
    host: HOST.green,
    input: { hubId: 9301, hubExcludedSources: [{ type: 'Image', targetId: 8001 }], browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-collection-contributor',
    description: 'A private collection read by a contributor whose row holds VIEW (1002 on 9102): Node grants read; the contributor branch is not answered here.',
    fallback: 'collection-contributor',
    viewer: 1002,
    host: HOST.blue,
    input: { collectionId: 9102, sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'fallback-collection-moderator',
    description: 'A private collection read by a moderator who does not own it (1004 on 9102): Node grants read; the moderator branch is not answered here.',
    fallback: 'collection-moderator',
    viewer: 1004,
    host: HOST.blue,
    input: { collectionId: 9102, sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'fallback-collection-judge-score',
    description: 'A collection item whose note holds a judge’s score (9103’s 8202): parseJudgeScore’s value is not rebuilt here.',
    fallback: 'collection-judge-score',
    viewer: null,
    host: HOST.green,
    input: { collectionId: 9103, sort: 'Newest', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-collection-random',
    description: 'A collection’s Random sort with FEED_GO_INFINITE_SERVE_SORT_RANDOM off: the input-sort fallback, as before the port.',
    fallback: 'input-sort',
    viewer: null,
    host: HOST.green,
    randomSeed: '494868',
    input: { collectionId: 9101, sort: 'Random', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-random-without-collection',
    description: 'Random without a collectionId, the port on: Node’s BAD_REQUEST (Random sort requires a collectionId), which it answers itself.',
    fallback: 'input-sort',
    viewer: null,
    host: HOST.green,
    goConfig: { serveSortRandom: true },
    randomSeed: '494868',
    input: { sort: 'Random', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-collection-random-seed-miss',
    description: 'Random with no stored seed: Node computes the hour’s seed and writes it to the system redis, which this service does not write.',
    fallback: 'collection-random-seed-miss',
    viewer: null,
    host: HOST.green,
    goConfig: { serveSortRandom: true },
    input: { collectionId: 9101, sort: 'Random', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-collection-random-seed-stale',
    description: 'A stored seed that is not digits: Node binds Number() of it (NaN here), which this service does not reproduce.',
    fallback: 'collection-random-seed-stale',
    viewer: null,
    host: HOST.green,
    goConfig: { serveSortRandom: true },
    randomSeed: 'not-a-seed',
    input: { collectionId: 9101, sort: 'Random', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-collection-random-cursor',
    description: 'A seed:sortKey:id cursor whose sort key is not digits: Node inlines NaN into the SQL (its own error), not reproduced here.',
    fallback: 'collection-random-cursor',
    viewer: null,
    host: HOST.green,
    goConfig: { serveSortRandom: true },
    randomSeed: '494868',
    input: { collectionId: 9101, sort: 'Random', cursor: '494868:x:8007', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-collection-random-post-id',
    description: 'Random beside a postId: getAllImages’ Random branch replaces the post scope’s i."index" order and builds a seed:sortKey:id cursor, which the post scope here would not; left to Node.',
    fallback: 'collection-random-post-id',
    viewer: null,
    host: HOST.green,
    goConfig: { serveSortRandom: true },
    randomSeed: '494868',
    input: { collectionId: 9101, postId: 7101, sort: 'Random', browsingLevel: 1, limit: 1 },
  },
  {
    name: 'fallback-collection-tag-without-collection',
    description: 'A `collectionTagId` without a `collectionId`: Node’s BAD_REQUEST, which it answers itself.',
    fallback: 'input-collectionTagId',
    viewer: null,
    host: HOST.green,
    input: { collectionTagId: 31, browsingLevel: 1, limit: 10 },
  },
  // `ids` (requiresImageDbPath: always Postgres), each answered image held by its own post's model
  // (withoutHeldFromViewer): 8302 is an R image on 7301, whose model 5002 is held at PG|PG-13.
  {
    name: 'ids-held-stranger',
    description: '`ids` signed in on an NSFW host: only those images, newest first, and 8302 (R, on held model 5002) left out for a viewer who does not own the model.',
    viewer: 1003,
    host: HOST.blue,
    input: { ids: [8302, 8301, 8001, 8999], sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'ids-held-owner',
    description: '`ids` for the held model’s owner (1002 owns 5002): 8302 is kept.',
    viewer: 1002,
    host: HOST.blue,
    input: { ids: [8302, 8301, 8001], sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'ids-held-moderator',
    description: '`ids` for a moderator: no hold read at all, 8302 kept.',
    viewer: 1004,
    host: HOST.blue,
    input: { ids: [8302, 8301, 8001], sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'ids-blocked-owner',
    description: 'Post 7030’s three images for their owner: the image under a block that refuses the owner the media (CSAM) is left out (blockedMediaListConditions); the one under a hold that leaves the owner the media (AiNotVerified) is kept, as is the unblocked one.',
    viewer: 1002,
    host: HOST.green,
    input: { ids: [8041, 8042, 8043], sort: 'Newest', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'ids-blocked-other-user',
    description: 'The same images for a signed-in viewer who is not their owner: only the unblocked one.',
    viewer: 1001,
    host: HOST.green,
    input: { ids: [8041, 8042, 8043], sort: 'Newest', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'ids-blocked-signed-out',
    description: 'The same images signed out: only the unblocked one.',
    viewer: null,
    host: HOST.green,
    input: { ids: [8041, 8042, 8043], sort: 'Newest', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'ids-blocked-moderator',
    description: 'The same images for a moderator (the positive control): no block clause, all three.',
    viewer: 1004,
    host: HOST.green,
    input: { ids: [8041, 8042, 8043], sort: 'Newest', browsingLevel: 1, limit: 10 },
  },
  {
    name: 'ids-single-signed-out',
    description: 'A single id, signed out (PG): the image alone, cacheable.',
    viewer: null,
    host: HOST.green,
    input: { ids: [8003], browsingLevel: 31, limit: 10 },
  },
  {
    name: 'ids-max-length',
    description: '200 ids (the schema’s max), most of them no image, Oldest with a limit of 3: the first three of the ones that exist, and the next cursor.',
    viewer: null,
    host: HOST.green,
    input: { ids: Array.from({ length: 200 }, (_, i) => 8001 + i), sort: 'Oldest', browsingLevel: 1, limit: 3 },
  },
  {
    name: 'ids-with-types',
    description: '`ids` combined with `types: [image]`: the video among them is left out.',
    viewer: null,
    host: HOST.green,
    input: { ids: [8005, 8003, 8001], types: ['image'], browsingLevel: 1, limit: 10 },
  },
  {
    name: 'ids-video-thumbnails-unservable',
    description: 'Three videos whose cached thumbnails are not servable (one marked under a block that refuses the owner, one with no marker field, one marked under a hold that leaves the owner the media), signed out: no thumbnailUrl; the thumbnail still counts toward the level.',
    viewer: null,
    host: HOST.green,
    input: { ids: [8031, 8032, 8033], types: ['video'], browsingLevel: 1, limit: 10 },
  },
  {
    name: 'ids-video-thumbnails-unservable-creator',
    description: 'The same videos for their creator: only the thumbnail whose block leaves the owner the media (ownerMediaAllowed) has a thumbnailUrl; the refused one and the one cached without the field have none.',
    viewer: 1002,
    host: HOST.green,
    input: { ids: [8031, 8032, 8033], types: ['video'], browsingLevel: 1, limit: 10 },
  },
  {
    name: 'ids-video-thumbnails-unservable-other-user',
    description: 'The same videos for a signed-in viewer who is not their creator: no thumbnailUrl, not even where the block leaves the owner the media.',
    viewer: 1001,
    host: HOST.green,
    input: { ids: [8031, 8032, 8033], types: ['video'], browsingLevel: 1, limit: 10 },
  },
  {
    name: 'ids-and-reactions-empty',
    description: '`ids: []` and `reactions: []`: no filter and no Postgres routing (`?.length`), so the feed page.',
    viewer: null,
    host: HOST.green,
    input: { ids: [], reactions: [], sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8005, 8001, 8003, 8007], ...fc('1718000000000', '8007') } },
    },
  },
  {
    name: 'fallback-ids-too-many',
    description: '201 ids: past the schema’s max(200), Node’s BAD_REQUEST.',
    fallback: 'input-invalid',
    viewer: null,
    host: HOST.green,
    input: { ids: Array.from({ length: 201 }, (_, i) => 8001 + i), browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-ids-not-int4',
    description: 'A fractional id: the schema accepts it and Postgres refuses the `::int[]` bind (a 500 not reproduced).',
    fallback: 'ids-not-int4',
    viewer: null,
    host: HOST.green,
    input: { ids: [8001, 8003.5], browsingLevel: 1, limit: 10 },
  },
  // `reactions` (requiresImageDbPath): the viewer's own reactions of those kinds; signed out, no clause.
  {
    name: 'reactions-signed-in',
    description: '`reactions: [Like, Laugh]` for 1003: the images 1003 reacted to with either (8001 Like, 8007 Laugh), newest first, never cached.',
    viewer: 1003,
    host: HOST.blue,
    input: { reactions: ['Like', 'Laugh'], sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'reactions-with-tags',
    description: '`reactions` combined with a tag scope: 8007 alone carries tag 526.',
    viewer: 1003,
    host: HOST.blue,
    input: { reactions: ['Like', 'Laugh'], tags: [526], sort: 'Newest', browsingLevel: 31, limit: 10 },
  },
  {
    name: 'reactions-signed-out',
    description: '`reactions` signed out: still the Postgres path, but no reaction clause (`userId && …`): the PG page.',
    viewer: null,
    host: HOST.green,
    input: { reactions: ['Heart'], sort: 'Newest', browsingLevel: 1, limit: 3 },
  },
  {
    name: 'pending-signed-out',
    description: '`pending: true` signed out: no moderator or owner, so the reviewed published page; the answer depends on the viewer, so it is not edge-cached.',
    viewer: null,
    host: HOST.green,
    input: { pending: true, sort: 'Newest', browsingLevel: 1, limit: 3 },
  },
  {
    name: 'fallback-reactions-not-an-enum',
    description: 'A reaction outside ReviewReactions: the schema’s BAD_REQUEST.',
    fallback: 'input-invalid',
    viewer: 1003,
    host: HOST.blue,
    input: { reactions: ['Love'], browsingLevel: 31, limit: 10 },
  },
  // `newCreators`: the "new & upcoming" board of the request's board color (images-new: [1002];
  // images-new-red: [1001, 1002]), and the addons under the `newCreators` scope (9921).
  {
    name: 'new-creators-feed-signed-out',
    description: '`newCreators` on the global feed, signed out on the SFW host: the SFW board’s creators as userIds, the scoped addon’s tag excluded, the hydrate keeping the board’s creators only.',
    viewer: null,
    host: HOST.green,
    addons: ADDONS_NEW_CREATORS,
    input: { newCreators: true, sort: 'Newest', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901%2C9921&userIds=1002&excludePoi=1&sort=newest&limit=4': { body: { items: [8006, 8003, 8001] } },
    },
  },
  {
    name: 'new-creators-feed-red-board',
    description: '`newCreators` signed in on the red host: the red board (two creators), in board order.',
    viewer: 1003,
    host: HOST.red,
    addons: ADDONS_NEW_CREATORS,
    input: { newCreators: true, sort: 'Newest', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901%2C9921&userIds=1001%2C1002&excludeMinor=1&excludePoi=1&viewerId=1003&sort=newest&limit=4': { body: { items: [8204, 8007, 8006] } },
    },
  },
  {
    name: 'new-creators-db-path',
    description: '`newCreators` on a model without a version (the Postgres path): `i."userId" IN (board)` after the model scope.',
    viewer: null,
    host: HOST.green,
    input: { newCreators: true, modelId: 5001, browsingLevel: 1, limit: 10 },
  },
  {
    name: 'new-creators-empty-board-feed',
    description: 'An unpopulated board on the feed path: an empty page with no feed call.',
    viewer: null,
    host: HOST.green,
    newCreatorBoards: { 'images-new': { data: [], cachedAt: NEW_CREATORS_CACHED_AT } },
    input: { newCreators: true, browsingLevel: 1, limit: 4 },
  },
  {
    name: 'new-creators-empty-board-db-path',
    description: 'An unpopulated board on the Postgres path: `1 = 0`, no row (never the unfiltered gallery).',
    viewer: null,
    host: HOST.green,
    newCreatorBoards: { 'images-new': { data: [], cachedAt: NEW_CREATORS_CACHED_AT } },
    input: { newCreators: true, modelId: 5001, browsingLevel: 1, limit: 10 },
  },
  {
    name: 'new-creators-with-followed',
    description: '`newCreators` beside `followed` (signed in, a non-empty follow list): the feed takes one userIds, so the mapper refuses it and the answer is an empty page.',
    viewer: 1003,
    host: HOST.blue,
    input: { newCreators: true, followed: true, browsingLevel: 31, limit: 4 },
  },
  {
    name: 'new-creators-false',
    description: '`newCreators: false`: no board read, the plain feed.',
    viewer: null,
    host: HOST.green,
    input: { newCreators: false, sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8005, 8001, 8003, 8007], ...fc('1718000000000', '8007') } },
    },
  },
  {
    name: 'fallback-new-creators-miss',
    description: 'No board entry: Node builds it from the database (fetchThroughCache’s fetch).',
    fallback: 'new-creators-miss',
    viewer: null,
    host: HOST.green,
    input: { newCreators: true, browsingLevel: 1, limit: 4 },
  },
  {
    name: 'fallback-new-creators-stale',
    description: 'A board entry older than its hour: Node refreshes it (or serves it stale under another caller’s lock).',
    fallback: 'new-creators-stale',
    viewer: null,
    host: HOST.green,
    newCreatorBoards: { 'images-new': { data: [1002], cachedAt: NOW.getTime() - 2 * 3600_000 } },
    input: { newCreators: true, browsingLevel: 1, limit: 4 },
  },
  {
    name: 'fallback-new-creators-null',
    description: '`newCreators: null`: z.boolean().optional() refuses it, Node’s BAD_REQUEST.',
    fallback: 'input-invalid',
    viewer: null,
    host: HOST.green,
    input: { newCreators: null, browsingLevel: 1, limit: 4 },
  },
  // `prioritizedUserIds: [-1]` (the system user alone; the model showcase carousel).
  {
    name: 'prioritized-system-user-no-post',
    description: 'The system user alone on version 6401, where it has no post: every creator’s images on the version (no creator clause), ordered by the IIF (all 1000 here), then newest first.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5005, modelVersionId: 6401, prioritizedUserIds: [-1], browsingLevel: 1, limit: 10 },
  },
  {
    name: 'prioritized-system-user-own-post',
    description: 'The system user alone on version 6501, where it has posts: only its images, oldest post first, then by index and id.',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5006, modelVersionId: 6501, prioritizedUserIds: [-1], browsingLevel: 1, limit: 10 },
  },
  {
    name: 'fallback-prioritized-system-user-no-version',
    description: 'The system user alone on a model without a version: Node sorts every visible image on the site by an IIF; left to Node.',
    fallback: 'prioritized-system-user-no-version',
    viewer: null,
    host: HOST.green,
    input: { modelId: 5005, prioritizedUserIds: [-1], browsingLevel: 1, limit: 10 },
  },
  // A verified crawler: the header as the app's API policy left it (`googlebot` / `bingbot`).
  {
    name: 'verified-bot-nsfw-host',
    description: 'A verified crawler, signed out, on an NSFW host: authorized for the cap (level 31 uncapped), no viewer, never edge-cached.',
    viewer: null,
    host: HOST.blue,
    headers: { 'x-civitai-verified-bot': 'googlebot' },
    input: { sort: 'Newest', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1%2C2%2C4%2C8%2C16&excludedTags=9911%2C9901&excludeMinor=1&excludePoi=1&sort=newest&limit=4': { body: { items: [8204, 8007, 8006, 8004] } },
    },
  },
  {
    name: 'verified-bot-sfw-host',
    description: 'A verified crawler on the SFW host: no NSFW there, so it counts as signed out for the cap (PG), and still not edge-cached.',
    viewer: null,
    host: HOST.green,
    headers: { 'x-civitai-verified-bot': 'bingbot' },
    input: { sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8005, 8001, 8003, 8007], ...fc('1718000000000', '8007') } },
    },
  },
  {
    name: 'verified-bot-header-not-a-crawler',
    description: 'A verified-crawler header whose value is no crawler the app names: parseVerifiedBotHeader reads it as none, so the signed-out PG page, edge-cacheable.',
    viewer: null,
    host: HOST.blue,
    headers: { 'x-civitai-verified-bot': '1' },
    input: { sort: 'Most Reactions', period: 'AllTime', browsingLevel: 31, limit: 4 },
    replies: {
      'levels=1&excludedTags=9901&excludePoi=1&sort=reactions&limit=4': { body: { items: [8005, 8001, 8003, 8007], ...fc('1718000000000', '8007') } },
    },
  },
  // The minor content rule (minorMatureImageVisibleSql) on image.getInfinite, on the feed-service
  // hydrate and on the Postgres path (a post's own media), over post 7013 (see the gallery fixtures):
  // 8701 is shown only to its owner (1002) and moderators.
  ...[
    [1003, 'stranger', 'another signed-in viewer: 8701 is left out', 'levels=1%2C2%2C4%2C8%2C16&excludedTags=9901&excludePoi=1&viewerId=1003&sort=newest&limit=10'],
    [1002, 'owner', 'its owner: 8701 is kept', 'levels=1%2C2%2C4%2C8%2C16&excludedTags=9901&excludePoi=1&viewerId=1002&sort=newest&limit=10'],
    [1004, 'moderator', 'a moderator: 8701 is kept', 'levels=1%2C2%2C4%2C8%2C16&sort=newest&limit=10'],
  ].flatMap(([viewer, who, what, query]) => [
    {
      name: `minor-mature-feed-hydrate-${who}`,
      ...(who === 'stranger' ? { alsoCached: [8701] } : {}),
      description: `The global feed at level 31 on an NSFW host, the addons without the minor exclusion: the feed names 8701, 8702 and 8703, and the hydrate decides, for ${what}.`,
      viewer,
      host: HOST.blue,
      addons: ADDONS_NO_MINOR,
      input: { sort: 'Newest', browsingLevel: 31, limit: 10 },
      replies: { [query]: { body: { items: [8701, 8702, 8703] } } },
    },
    {
      name: `minor-mature-post-scope-${who}`,
      ...(who === 'stranger' ? { alsoCached: [8701] } : {}),
      description: `Post 7013's own media (the Postgres path) at level 31 on an NSFW host, the addons without the minor exclusion, for ${what}.`,
      viewer,
      host: HOST.blue,
      addons: ADDONS_NO_MINOR,
      input: { postId: 7013, browsingLevel: 31, limit: 5 },
      replies: {},
    },
  ]),
];

// ---------------------------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------------------------
function dbTables({ tags = false, meta = false } = {}) {
  // A `techniques` or `tags` fixture, as a `tools` one below: each image the feed named, each row the
  // query would match without that clause, and (techniques) each image with a technique row. Every
  // image carries tags, so a tags fixture has no third set.
  if (T.techniquesRead || T.tagsRead) {
    for (const f of T.feed) for (const id of f.body?.items ?? []) if (IMAGES[id]) T.posts.add(IMAGES[id].postId);
    for (const id of [...T.techniquesCandidatePosts, ...T.tagsCandidatePosts]) T.posts.add(id);
    if (T.techniquesRead) for (const id of Object.keys(IMAGE_TECHNIQUES)) T.posts.add(IMAGES[id].postId);
  }
  if (T.toolsRead) {
    // A `tools` fixture holds every image the tools clause decides on, so a row only that clause drops
    // is one feed-go must drop too: each image the feed named (the hydrate), each row every tools
    // query would match without the clause (the Postgres reads: page, completion, pinned, sponsored,
    // hydrate), and each image with a tool row.
    for (const f of T.feed) for (const id of f.body?.items ?? []) if (IMAGES[id]) T.posts.add(IMAGES[id].postId);
    for (const id of T.toolsCandidatePosts) T.posts.add(id);
    for (const id of Object.keys(IMAGE_TOOLS)) T.posts.add(IMAGES[id].postId);
  }
  if (T.baseModelsRead) {
    // Likewise for `baseModels`: each image the feed named and each row the clause alone decides on.
    for (const f of T.feed) for (const id of f.body?.items ?? []) if (IMAGES[id]) T.posts.add(IMAGES[id].postId);
    for (const id of T.baseModelsCandidatePosts) T.posts.add(id);
  }
  if (T.followedRead) {
    // And for the follow clause: each row it alone decides on (another creator's).
    for (const id of T.followedCandidatePosts) T.posts.add(id);
  }
  // A collection request: every item's image of the collections it reads, whatever its status or
  // tag, so a row the status, tag or permission check alone decides on is in the tables.
  // A Random page's items carry their Postgres sort key under each seed it hashed with.
  const collectionItems = COLLECTION_ITEMS.filter((ci) => T.collectionIds.has(ci.collectionId)).map((ci) =>
    T.randomSeedsUsed?.size ? { ...ci, sortKeys: Object.fromEntries([...T.randomSeedsUsed].map((seed) => [seed, sortKeyOf(ci.id, seed)])) } : ci
  );
  for (const ci of collectionItems) T.posts.add(IMAGES[ci.imageId].postId);
  const postIds = [...T.posts].sort((a, b) => a - b);
  const images = Object.values(IMAGES)
    .filter((i) => postIds.includes(i.postId))
    // `_tags`: the image's TagsOnImageDetails rows (the tag scope's subquery), in infinite/ and in a
    // fixture whose query filters by `tags`.
    // `_meta`: its meta column as Postgres prints it (the image-meta lookup), in v1-images/ only.
    // `_tools`: its ImageTool tool ids (the `tools` filter), only in a fixture whose query reads them.
    // `_techniques`: its ImageTechnique ids (the `techniques` filter), likewise.
    .map((i) =>
      mark({
        ...i,
        _resources: RESOURCES[i.id],
        ...(tags || T.tagsRead ? { _tags: tagIdsOf(i.id) } : {}),
        ...(T.toolsRead ? { _tools: toolIdsOf(i.id) } : {}),
        ...(T.techniquesRead ? { _techniques: techniqueIdsOf(i.id) } : {}),
        ...(meta ? { _meta: META[i.id] == null ? null : jsonbText(META[i.id]) } : {}),
      })
    );
  return {
    images,
    posts: postIds.map((id) => ({ id, modelVersionId: POSTS[id].modelVersionId })),
    modelVersions: Object.entries(VERSIONS).map(([id, modelId]) => ({
      id: Number(id),
      modelId,
      ...(T.baseModelsRead ? { baseModel: VERSION_BASE_MODELS[id] } : {}),
    })),
    models: Object.values(MODELS),
    reviews: REVIEWS,
    reactions: REACTIONS,
    placements: PLACEMENTS.map(mark),
    users: Object.values(USERS).map(mark),
    // Every lookup reads these as text columns (`::text`), so they are written as Postgres prints them.
    userCosmetics: USER_COSMETIC_ROWS.map((r) => ({ ...r, data: r.data === null ? null : jsonbText(r.data), equippedAt: r.equippedAt !== null })),
    cosmetics: Object.values(COSMETICS).map((c) => ({ id: c.id, name: c.name, type: c.type, source: c.source, data: jsonbText(c.data), flags: c.flags, createdById: COSMETIC_CREATORS[c.id] ?? null })),
    cosmeticShopItems: SHOP_ITEMS.map((x) => ({ ...x, meta: jsonbText(x.meta) })),
    // The TagsOnImageVote rows, only in a fixture whose request read the viewer's votes.
    ...(T.tagVotesRead ? { tagVotes: TAG_VOTES } : {}),
    // The Collection rows (with their contributor rows) and CollectionItem rows, only in a fixture
    // whose request names a collection.
    ...(T.collectionIds.size
      ? {
          collections: [...T.collectionIds].filter((id) => COLLECTIONS[id]).map((id) => COLLECTIONS[id]),
          collectionItems,
        }
      : {}),
    // The UserHub rows (with their source rows) a `hubId` request read, only in such a fixture.
    ...(T.hubIds.size ? { hubs: [...T.hubIds].filter((id) => HUBS[id]).map((id) => HUBS[id]) } : {}),
  };
}

/** What Node writes on this fixture's misses, as the Go harness compares it. */
function writeEntries() {
  for (const key of T.cold) if (!T.coldRead.has(key)) throw new Error(`fixture ${T.fixture}: cold key ${key} never read`);
  const out = {};
  for (const [key, w] of [...T.writes.entries()].sort()) {
    out[key] = { value: mark(w.value), packed: packMarked(mark(w.value)), ex: w.ex };
  }
  return out;
}

function redisEntries(dropKeys = []) {
  const out = {};
  for (const [key, value] of [...T.packed.entries()].sort()) {
    if (dropKeys.includes(key)) continue;
    const marked = mark(value);
    // imageMetaCache is `compress: true`: its values are brotli-compressed at rest, except a notFound
    // marker (fetch writes it uncompressed) and an entry written before compression was turned on.
    if (key.startsWith(`${K.meta}:`) && !value.notFound && !META_UNCOMPRESSED.has(value.id)) {
      out[key] = { value: marked, compressed: true, packed: packMarkedCompressed(marked) };
      continue;
    }
    out[key] = { value: marked, packed: packMarked(marked) };
  }
  for (const [key, raw] of [...T.raw.entries()].sort()) if (!key.startsWith('sys:')) out[key] = { raw };
  for (const [key, hash] of [...T.hashes.entries()].sort()) out[key] = { hash };
  return out;
}

/** Every key a request of this fixture reads, for a fallback fixture (no mirror run): the whole
 *  world for the images it could touch. */
function traceWorldFor(imageIds, userIds, modelIds) {
  for (const id of imageIds) {
    for (const k of [K.tagIds, K.frames]) T.packed.set(`${k}:${id}`, worldPacked(k, id));
    T.hashes.set(`metrics:Image:${id}`, metricsOf(id));
    T.posts.add(IMAGES[id].postId);
  }
  for (const id of userIds) for (const k of [K.basic, K.userCosmetics, K.profile]) T.packed.set(`${k}:${id}`, worldPacked(k, id));
  T.packed.set(`${K.cosmetics}:301`, worldPacked(K.cosmetics, 301));
  T.packed.set(`${K.cosmetics}:302`, worldPacked(K.cosmetics, 302));
  for (const id of modelIds) gallerySettingsOf(id);
  getAddons();
}

function newTrace(name, spec) {
  T = new Trace(name);
  T.replies = spec.replies ?? {};
  T.usedReplies = new Set();
  T.events = new Set(spec.events ?? []);
  T.cold = new Set(spec.cold ?? []);
  T.addons = spec.addons ?? ADDONS;
  T.usernames = new Set();
  T.metaRead = false;
  // The stored collection Random seed (`collection:random-seed` on the system redis; absent: no key),
  // and the seeds a Random page hashed its items with.
  T.randomSeed = spec.randomSeed;
  T.randomSeedsUsed = new Set();
}

/** `spec.alsoCached`: images whose per-image cache entries (tag ids, frame, metric hash) the fixture
 *  holds although Node's answer reads none of them (an image the answer leaves out), so a feed-go that
 *  kept the image fails on its answer, not on a cache miss. */
function alsoCached(spec) {
  for (const id of spec.alsoCached ?? []) {
    for (const k of [K.tagIds, K.frames]) T.packed.set(`${k}:${id}`, worldPacked(k, id));
    T.hashes.set(`metrics:Image:${id}`, metricsOf(id));
  }
}

function checkReplies(spec) {
  for (const q of Object.keys(spec.replies ?? {})) if (!T.usedReplies.has(q)) throw new Error(`${spec.name}: reply never asked for: ${q}`);
}

function writeFixture(dir, name, fixture) {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2) + '\n');
}

function emitAsPosts() {
  const dir = join(HERE, 'as-posts');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  resetDevalueDir('as-posts');
  for (const spec of AS_POSTS) {
    newTrace(spec.name, spec);
    const nodeFlags = { ...FLAGS_ON, ...(spec.nodeFlags ?? {}) };
    const goConfig = { ...GO_ON, ...(spec.goConfig ?? {}), decorationEvents: spec.events ?? [], frameCacheNegative: FRAME_CACHE_NEGATIVE };
    const inputEnvelope = JSON.stringify(superjson.serialize(spec.input));
    let expect;
    if (spec.fallback) {
      if (spec.viewer) T.packed.set(`${K.session}:${spec.viewer}`, SESSIONS[spec.viewer]);
      traceWorldFor([8001, 8003, 8006, 8007, 8201, 8202, 8203, 8204], [1001, 1002], [spec.input.modelId]);
      // Whatever the page would read before the fallback point is held too.
      for (const [q, r] of Object.entries(spec.replies ?? {})) T.feed.push({ query: q, status: 200, body: r.body });
      expect = { fallback: spec.fallback };
    } else {
      const { value, cacheable } = runAsPosts({ ...spec, nodeFlags });
      checkReplies(spec);
      alsoCached(spec);
      expect = { envelope: superjson.serialize(value), cacheable, writes: writeEntries() };
      writeDevalueBody('as-posts', spec.name, value);
    }
    writeFixture(dir, spec.name, {
      name: spec.name,
      description: spec.description,
      now: NOW.toISOString(),
      config: goConfig,
      request: {
        input: inputEnvelope,
        headers: { host: spec.host, ...(spec.headers ?? {}) },
        session: spec.viewer ? { userId: spec.viewer } : null,
      },
      feed: T.feed,
      redis: redisEntries(spec.dropKeys),
      sysRedis: { 'system:browsing-setting-addons': { raw: JSON.stringify(T.addons) } },
      db: dbTables(),
      expect,
    });
  }
  return AS_POSTS.length;
}

function emitV1() {
  const dir = join(HERE, 'v1-images');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const spec of V1) {
    newTrace(spec.name, spec);
    // The tables of an `imageId` or version-less model page hold every row its clause alone decides on.
    T.v1Candidates = true;
    const host = spec.host ?? HOST.blue;
    let expect;
    if (spec.fallback) {
      expect = { fallback: spec.fallback };
    } else {
      const { value } = runV1({ ...spec, host });
      checkReplies(spec);
      expect = { body: JSON.parse(JSON.stringify(value)) };
    }
    writeFixture(dir, spec.name, {
      name: spec.name,
      description: spec.description,
      now: NOW.toISOString(),
      config: { imageLocation: IMAGE_LOCATION, ...(spec.goConfig ?? {}) },
      request: {
        query: spec.query,
        path: '/api/v1/images',
        headers: { host, ...(spec.headers ?? {}) },
        session: spec.viewer ? { userId: spec.viewer } : null,
      },
      feed: T.feed,
      redis: redisEntries(),
      sysRedis: { 'system:browsing-setting-addons': { raw: JSON.stringify(T.addons) } },
      db: { ...dbTables({ meta: T.metaRead }), usernames: [...T.usernames] },
      expect,
    });
  }
  return V1.length;
}

function emitInfinite() {
  const dir = join(HERE, 'infinite');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  resetDevalueDir('infinite');
  for (const spec of INFINITE) {
    newTrace(spec.name, spec);
    const nodeFlags = { ...FLAGS_ON, ...(spec.nodeFlags ?? {}) };
    const goConfig = { ...GO_ON, ...(spec.goConfig ?? {}), decorationEvents: spec.events ?? [], frameCacheNegative: FRAME_CACHE_NEGATIVE };
    let expect;
    // A collection's rows are in the tables whether or not the mirror runs: a fallback fixture's
    // reason may be decided on them.
    if (spec.input.collectionId) T.collectionIds.add(spec.input.collectionId);
    T.newCreatorBoards = spec.newCreatorBoards;
    // image.getInfinite's own `ids` (the REST endpoint's legacy ids fixtures predate this, and keep
    // their tables).
    T.idsCandidates = true;
    if (spec.fallback) {
      if (spec.viewer) T.packed.set(`${K.session}:${spec.viewer}`, SESSIONS[spec.viewer]);
      // The board entries a fallback fixture's reason is decided on (an expired one).
      for (const [id, v] of Object.entries(spec.newCreatorBoards ?? {})) T.packed.set(`${K.newCreators}:${id}`, v);
      // The gallery gates run before a scoped request's own fallback: its model's settings are held.
      if (spec.input.modelId || spec.input.modelVersionId) getHeldGalleryLevel(spec.input);
      expect = { fallback: spec.fallback };
    } else {
      const { value, cacheable } = runInfinite({ ...spec, nodeFlags });
      checkReplies(spec);
      alsoCached(spec);
      // `spec.alsoPosts`: posts whose rows the tables hold although Node's answer reads none of them (a
      // withheld gallery), so a feed-go that skipped the gate would answer them.
      for (const id of spec.alsoPosts ?? []) T.posts.add(id);
      expect = { envelope: superjson.serialize(value), cacheable, writes: writeEntries() };
      writeDevalueBody('infinite', spec.name, value);
    }
    // Every image the feed named is in the tables, so a row the hydrate's own filters drop (the tag
    // scope) is one feed-go must drop too, not one the fixture never held.
    for (const f of T.feed) for (const id of f.body?.items ?? []) if (IMAGES[id]) T.posts.add(IMAGES[id].postId);
    writeFixture(dir, spec.name, {
      name: spec.name,
      description: spec.description,
      now: NOW.toISOString(),
      config: goConfig,
      request: {
        input: JSON.stringify(superjson.serialize(spec.input)),
        headers: { host: spec.host, ...(spec.headers ?? {}) },
        session: spec.viewer ? { userId: spec.viewer } : null,
      },
      feed: T.feed,
      redis: redisEntries(spec.dropKeys),
      sysRedis: {
        'system:browsing-setting-addons': { raw: JSON.stringify(T.addons) },
        ...(spec.randomSeed !== undefined ? { 'collection:random-seed': { raw: spec.randomSeed } } : {}),
      },
      db: {
        ...dbTables({ tags: true }),
        usernames: [...T.usernames],
        // The system user's posts on each version Node looked one up for (hasSystemPosts).
        ...(T.systemPostReads.size
          ? { systemPosts: Object.values(POSTS).filter((p) => p.userId === -1 && T.systemPostReads.has(p.modelVersionId)).map((p) => ({ id: p.id, modelVersionId: p.modelVersionId })) }
          : {}),
      },
      expect,
    });
  }
  return INFINITE.length;
}

const a = emitAsPosts();
const b = emitV1();
const c = emitInfinite();
for (const d of ['as-posts', 'v1-images', 'infinite']) if (!readdirSync(join(HERE, d)).length) throw new Error(`${d} is empty`);
console.log(`as-posts: ${a} fixtures, v1-images: ${b} fixtures, infinite: ${c} fixtures`);
void sizeOf;
