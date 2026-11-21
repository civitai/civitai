// Generates the golden fixtures in image-published-app/ and their devalue bodies in
// devalue/image-published-app/ (see README.md, "image-published-app").
//
//   TZ=UTC node --import tsx apps/feed-go/testdata/golden/gen-published-app.mjs
//
// Everything here is SYNTHETIC: invented ids, names, slugs and hosts.
//
// What a fixture's EXPECTED answer is comes from the Node code path, never from feed-go:
//   - the pure steps are the REAL Node functions, imported from the repo through tsx: the input schema
//     (getByIdSchema), isPgInt4, the marker key (BLOCK_PUBLISHED_APP_ID_META_KEY), the whole chip
//     decision (resolveAppChip: the scope gate, readAppIdMarker, the four viewability terms, the
//     maturity silence, the name sanitiser) and superjson / devalue;
//   - the orchestration that reads the database is transcribed below from readImageAppChip
//     (src/server/services/blocks/image-app-chip.service.ts) and readAppChip
//     (post-app-chip.service.ts): the store scope (a per-viewer Flipt answer), whether the image is
//     visible to the viewer (assertImageVisibleToViewer: image.get's visibility predicate, the minor
//     content rule among its terms, and the blocked-user check) and whether its media is
//     (viewerCanSeeImageMedia) are recorded per fixture as the world's FACTS for that viewer, with the
//     rule that decided each in `why`; the app row and the hidden listing ids are what those reads
//     returned.
//
// `go` is the outcome feed-go is held to: `served` (its answer must then equal `expect.envelope`, and
// this generator refuses a fixture it would serve whose Node answer is not null: the only answer
// feed-go serves) or the named `fallback`. `binds` is the image id Node's image reads bind (`i.id = $1`,
// `where: { id }`), or null when isPgInt4 refuses the id and nothing is read.
process.env.TZ = 'UTC';

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDep } from './pack.mjs';
import { resetDevalueDir, writeDevalueBody } from './devalue-body.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.cwd();
if (!existsSync(join(REPO, 'src/server/services/blocks/image-app-chip.service.ts')))
  throw new Error('run from the repo root');
const superjson = (await importDep('superjson')).default;
async function repo(path) {
  const m = await import(join(REPO, path));
  return { ...(m.default ?? {}), ...m };
}
const { getByIdSchema } = await repo('src/server/schema/base.schema.ts');
const { isPgInt4 } = await repo('src/server/db/prisma-sql-kysely.ts');
const { BLOCK_PUBLISHED_APP_ID_META_KEY } = await repo(
  'src/shared/utils/block-provenance-metadata.ts'
);
const { readAppIdMarker, resolveAppChip } = await repo(
  'src/server/services/blocks/post-app-chip.logic.ts'
);

if (BLOCK_PUBLISHED_APP_ID_META_KEY !== 'blockPublishedAppId')
  throw new Error(`marker key is ${BLOCK_PUBLISHED_APP_ID_META_KEY}: update appchip.MarkerKey`);

// ---------------------------------------------------------------------------------------------
// The synthetic world
// ---------------------------------------------------------------------------------------------
const HOST = 'civitai.example';
const IMAGE_ID = 8101;
const OWNER = 1001;
const VIEWERS = {
  anon: null,
  stranger: { id: 1002, isModerator: false },
  owner: { id: OWNER, isModerator: false },
  moderator: { id: 1004, isModerator: true },
};
const APP_ID = 'appblk-sketchpad';

const listing = (over = {}) => ({
  id: 'lst_sketchpad',
  slug: 'sketchpad',
  name: 'Sketchpad',
  status: 'approved',
  kind: 'onsite',
  contentRating: 'pg',
  revisionOfId: null,
  icon: null,
  ...over,
});
/** An OauthClient row as postAppChipQuery selects it. */
const app = ({ blockStatus = 'approved', ...listingOver } = {}) => ({
  name: 'Sketchpad',
  appBlocks: [
    {
      status: blockStatus,
      currentVersionDeployedAt: new Date('2026-06-01T00:00:00.000Z'),
      appListing: listing(listingOver),
    },
  ],
  connectListings: [],
});

const marked = { [BLOCK_PUBLISHED_APP_ID_META_KEY]: APP_ID, width: 832, height: 1216 };
const plain = { width: 832, height: 1216 };

/** The image as Node's reads see it for this fixture's viewer. */
const image = (over = {}) => ({
  id: IMAGE_ID,
  userId: OWNER,
  metadata: plain,
  visible: true,
  mediaVisible: true,
  why: 'a published image every viewer may open, rated within the domain cap',
  ...over,
});

const input = (json) => JSON.stringify(superjson.serialize(json));

const specs = [
  // --- served: no marker, every viewer and scope ---------------------------------------------
  {
    name: 'anon-scope-none-plain',
    viewer: 'anon',
    input: input({ id: IMAGE_ID }),
    world: { storeScope: 'none', image: image() },
    go: { served: true, viewerClass: 'anon' },
  },
  {
    name: 'anon-scope-full-plain',
    viewer: 'anon',
    input: input({ id: IMAGE_ID }),
    world: { storeScope: 'full', image: image() },
    go: { served: true, viewerClass: 'anon' },
  },
  {
    name: 'anon-scope-public-external-plain',
    viewer: 'anon',
    input: input({ id: IMAGE_ID }),
    world: { storeScope: 'public-external', image: image() },
    go: { served: true, viewerClass: 'anon' },
  },
  {
    name: 'signed-in-scope-full-plain',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: { storeScope: 'full', image: image() },
    go: { served: true, viewerClass: 'user' },
  },
  {
    name: 'owner-scope-full-plain',
    viewer: 'owner',
    input: input({ id: IMAGE_ID }),
    world: { storeScope: 'full', image: image() },
    go: { served: true, viewerClass: 'owner' },
  },
  {
    name: 'moderator-scope-full-plain',
    viewer: 'moderator',
    input: input({ id: IMAGE_ID }),
    world: { storeScope: 'full', image: image() },
    go: { served: true, viewerClass: 'moderator' },
  },
  {
    name: 'signed-in-hid-owner-plain',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({
        why: 'the viewer hid the owner: image.get does not read HiddenUsers, so still visible',
      }),
    },
    go: { served: true, viewerClass: 'user' },
  },
  // --- served: empty results --------------------------------------------------------------------
  {
    name: 'no-such-image',
    viewer: 'stranger',
    input: input({ id: 8199 }),
    world: { storeScope: 'full', image: image() },
    go: { served: true, viewerClass: 'user' },
  },
  {
    name: 'id-past-int4',
    viewer: 'stranger',
    input: input({ id: 2147483648 }),
    world: { storeScope: 'full', image: image() },
    go: { served: true, viewerClass: 'user' },
  },
  {
    name: 'id-fraction',
    viewer: 'anon',
    input: input({ id: 8101.5 }),
    world: { storeScope: 'full', image: image() },
    go: { served: true, viewerClass: 'anon' },
  },
  {
    name: 'id-negative',
    viewer: 'anon',
    input: input({ id: -3 }),
    world: { storeScope: 'full', image: image() },
    go: { served: true, viewerClass: 'anon' },
  },
  // --- hidden / blocked users, the minor content rule, NSFW levels -----------------------------
  {
    name: 'blocked-by-owner-plain',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({ visible: false, why: 'the owner blocked the viewer (amIBlockedByUser)' }),
    },
    go: { served: true, viewerClass: 'user' },
  },
  {
    name: 'blocked-by-owner-marked',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({
        metadata: marked,
        visible: false,
        why: 'the owner blocked the viewer (amIBlockedByUser)',
      }),
      apps: { [APP_ID]: app() },
    },
    go: { fallback: 'published-app-marked' },
  },
  {
    name: 'minor-mature-stranger-plain',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({
        visible: false,
        why: 'minor + mature: minorMatureImageVisibleSql hides it from anyone but its owner',
      }),
    },
    go: { served: true, viewerClass: 'user' },
  },
  {
    name: 'minor-mature-stranger-marked',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({
        metadata: marked,
        visible: false,
        why: 'minor + mature: minorMatureImageVisibleSql hides it from anyone but its owner',
      }),
      apps: { [APP_ID]: app() },
    },
    go: { fallback: 'published-app-marked' },
  },
  {
    name: 'minor-mature-owner-marked',
    viewer: 'owner',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({
        metadata: marked,
        why: 'minor + mature, viewed by its owner: visible, and an owner sees their own media',
      }),
      apps: { [APP_ID]: app() },
    },
    go: { fallback: 'published-app-marked' },
  },
  {
    name: 'nsfw-media-capped-plain',
    viewer: 'anon',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({
        mediaVisible: false,
        why: 'an R image on a domain capped to PG (canViewImageMedia): no media',
      }),
    },
    go: { served: true, viewerClass: 'anon' },
  },
  {
    name: 'nsfw-media-capped-marked',
    viewer: 'anon',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({
        metadata: marked,
        mediaVisible: false,
        why: 'an R image on a domain capped to PG (canViewImageMedia): no media',
      }),
      apps: { [APP_ID]: app() },
    },
    go: { fallback: 'published-app-marked' },
  },
  // --- marked: every chip outcome falls back ---------------------------------------------------
  {
    name: 'marked-scope-none-gated',
    viewer: 'anon',
    input: input({ id: IMAGE_ID }),
    world: { storeScope: 'none', image: image({ metadata: marked }), apps: { [APP_ID]: app() } },
    go: { fallback: 'published-app-marked' },
  },
  {
    name: 'marked-chip-linked',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: { storeScope: 'full', image: image({ metadata: marked }), apps: { [APP_ID]: app() } },
    go: { fallback: 'published-app-marked' },
  },
  {
    name: 'marked-lifecycle-unlinked',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({ metadata: marked }),
      apps: { [APP_ID]: app({ status: 'pending' }) },
    },
    go: { fallback: 'published-app-marked' },
  },
  {
    name: 'marked-mature-app-silenced',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({ metadata: marked }),
      apps: { [APP_ID]: app({ contentRating: 'x' }) },
    },
    go: { fallback: 'published-app-marked' },
  },
  {
    name: 'marked-unresolved-app',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: { storeScope: 'full', image: image({ metadata: marked }), apps: {} },
    go: { fallback: 'published-app-marked' },
  },
  {
    name: 'marker-whitespace',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({ metadata: { [BLOCK_PUBLISHED_APP_ID_META_KEY]: '  \t' } }),
    },
    go: { fallback: 'published-app-marked' },
  },
  // --- marker values that are no marker ---------------------------------------------------------
  {
    name: 'marker-empty-string',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({ metadata: { [BLOCK_PUBLISHED_APP_ID_META_KEY]: '' } }),
      apps: { '': app() },
    },
    go: { served: true, viewerClass: 'user' },
  },
  {
    name: 'marker-number',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({ metadata: { [BLOCK_PUBLISHED_APP_ID_META_KEY]: 42 } }),
    },
    go: { served: true, viewerClass: 'user' },
  },
  {
    name: 'marker-null',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({ metadata: { [BLOCK_PUBLISHED_APP_ID_META_KEY]: null } }),
    },
    go: { served: true, viewerClass: 'user' },
  },
  {
    name: 'marker-object',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({ metadata: { [BLOCK_PUBLISHED_APP_ID_META_KEY]: { id: APP_ID } } }),
    },
    go: { served: true, viewerClass: 'user' },
  },
  {
    name: 'metadata-array',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID }),
    world: { storeScope: 'full', image: image({ metadata: [APP_ID] }) },
    go: { served: true, viewerClass: 'user' },
  },
  {
    name: 'other-provenance-key',
    viewer: 'owner',
    input: input({ id: IMAGE_ID }),
    world: {
      storeScope: 'full',
      image: image({ metadata: { blockUploadedAppId: APP_ID } }),
      apps: { [APP_ID]: app() },
    },
    go: { served: true, viewerClass: 'owner' },
  },
  // --- the viewer ---------------------------------------------------------------------------------
  {
    name: 'banned-session',
    viewer: 'anon',
    banned: { id: 1003, isModerator: false },
    input: input({ id: IMAGE_ID }),
    world: { storeScope: 'none', image: image() },
    go: { fallback: 'published-app-banned-session' },
  },
  // --- input --------------------------------------------------------------------------------------
  {
    name: 'input-transport-key',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID, authed: true }),
    world: { storeScope: 'full', image: image() },
    go: { served: true, viewerClass: 'user' },
  },
  {
    name: 'input-unknown-key',
    viewer: 'stranger',
    input: input({ id: IMAGE_ID, postId: 77 }),
    world: { storeScope: 'full', image: image() },
    go: { fallback: 'input-unknown-key' },
  },
  {
    name: 'input-id-missing',
    viewer: 'anon',
    input: input({}),
    world: { storeScope: 'none', image: image() },
    go: { fallback: 'input-invalid' },
  },
  {
    name: 'input-id-null',
    viewer: 'anon',
    input: input({ id: null }),
    world: { storeScope: 'none', image: image() },
    go: { fallback: 'input-invalid' },
  },
  {
    name: 'input-id-string',
    viewer: 'anon',
    input: input({ id: String(IMAGE_ID) }),
    world: { storeScope: 'none', image: image() },
    go: { fallback: 'input-invalid' },
  },
  {
    name: 'input-id-bigint',
    viewer: 'anon',
    input: input({ id: BigInt(IMAGE_ID) }),
    world: { storeScope: 'none', image: image() },
    go: { fallback: 'input-invalid' },
  },
];

// ---------------------------------------------------------------------------------------------
// The Node code path
// ---------------------------------------------------------------------------------------------

/**
 * getImagePublishedWithAppHandler for one request: the tRPC input parse (superjson, then the zod
 * schema: a refusal is the 400 BAD_REQUEST), then readImageAppChip → readAppChip → resolveAppChip.
 * A banned session's user is on `bannedUser`, not `user` (trpcViewer), so the chip reads it as signed
 * out.
 */
async function handler(spec) {
  const raw = superjson.deserialize(JSON.parse(spec.input));
  const parsed = getByIdSchema.safeParse(raw);
  if (!parsed.success) return { status: 400 };
  const id = parsed.data.id;
  const user = VIEWERS[spec.viewer] ?? undefined;
  const world = spec.world;
  let chip;
  // readAppChip: everything inside its try; any throw is the `degraded` null.
  try {
    const { chip: c } = await resolveAppChip({
      // resolveStoreVisibilityScope({ user }): the per-viewer Flipt answer, a fact of the fixture.
      storeScope: world.storeScope,
      host: HOST,
      viewerBrowsingLevel: undefined,
      // readImageAppChip's readMarker.
      readMarker: async () => {
        // assertImageVisibleToViewer: an id isPgInt4 refuses is NOT_FOUND before any read; so is an
        // image the visibility read does not return (no row, or a rule refusing this viewer, or the
        // owner's block). readMarker answers null for NOT_FOUND.
        if (!isPgInt4(id)) return null;
        const row = world.image && world.image.id === id ? world.image : null;
        if (!row || !row.visible) return null;
        // viewerCanSeeImageMedia.
        if (!row.mediaVisible) return null;
        // dbRead.image.findUnique({ where: { id: visible.id }, select: { metadata: true } }).
        return readAppIdMarker(row.metadata ?? null, BLOCK_PUBLISHED_APP_ID_META_KEY);
      },
      readHiddenListingIds: async (ids) =>
        new Set((world.hiddenListingIds ?? []).filter((x) => ids.includes(x))),
      readApp: async (appId) => world.apps?.[appId] ?? null,
    });
    chip = c;
  } catch {
    chip = null;
  }
  return { status: 200, value: chip, id };
}

const OUT = join(HERE, 'image-published-app');
if (existsSync(OUT)) for (const f of readdirSync(OUT)) rmSync(join(OUT, f));
mkdirSync(OUT, { recursive: true });
resetDevalueDir('image-published-app');
const names = new Set();
for (const spec of specs) {
  if (names.has(spec.name)) throw new Error(`duplicate fixture ${spec.name}`);
  names.add(spec.name);
  const out = await handler(spec);
  if (spec.go.served && (out.status !== 200 || out.value !== null))
    throw new Error(`${spec.name}: feed-go serves only null, Node answered ${JSON.stringify(out)}`);
  if (spec.go.fallback === 'input-invalid' && out.status !== 400)
    throw new Error(`${spec.name}: an input-invalid fallback must be Node's 400`);
  const viewer = spec.banned ? null : VIEWERS[spec.viewer];
  const fixture = {
    name: spec.name,
    request: {
      input: spec.input,
      viewer,
      banned: spec.banned ?? null,
      host: HOST,
    },
    world: {
      storeScope: spec.world.storeScope,
      image: spec.world.image,
      apps: spec.world.apps ?? {},
      hiddenListingIds: spec.world.hiddenListingIds ?? [],
    },
    binds: out.status === 200 && isPgInt4(out.id) ? { imageId: out.id } : null,
    expect: out.status === 200 ? { envelope: superjson.serialize(out.value) } : { status: 400 },
    go: spec.go,
  };
  writeFileSync(join(OUT, `${spec.name}.json`), JSON.stringify(fixture, null, 2) + '\n');
  if (out.status === 200 && spec.go.served)
    writeDevalueBody('image-published-app', spec.name, out.value);
}
console.log(`wrote ${specs.length} fixtures to ${OUT}`);
