import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type * as z from 'zod';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { scanSource } from '../../../../test/source-scan';
import { stripComments } from '../../../../test/strip-comments';
import {
  createCrucibleInputBaseSchema,
  updateCrucibleSchema,
} from '~/server/schema/crucible.schema';

/**
 * Seam guard for the server-owned `Image` columns `id`, `postId` and `index`.
 *
 * `image-server-owned-columns.test.ts` proves the route inputs and the shared writers behave.
 * This pins the two POPULATIONS that decide whether that stays true, and fails when either
 * grows or shrinks:
 *
 *  1. Every reference to the shared image schemas. Route inputs use `imageInputSchema`
 *     (no `id`/`postId`/`index`) or `imageReferenceInputSchema` (adds an `id` naming an
 *     existing row); the full `imageSchema` is for server-internal callers.
 *  2. Every `Image` insert site — `.image.(create|createMany|createManyAndReturn|upsert)(`,
 *     raw `INSERT INTO "Image"`, and nested `create`/`connectOrCreate`/`upsert` under a
 *     relation field typed `Image` — with every value it spreads into the row and every
 *     server-owned column it assigns. A spread of anything but `pickClientImageColumns(…)`
 *     is how client input reaches a server-owned column, so each one is listed.
 *
 * Plus the `createImage` callers, since `createImage` writes the `postId`/`index` it is given.
 *
 * Population: non-test `.ts`/`.tsx` under `src/`. A nested create is found when it follows an
 * `Image` relation key within 300 characters of the same statement. Sites are counted per
 * enclosing function (the nearest `function` or `const x = async` declaration before them).
 */

const ROOT = process.cwd();
const URL_UUID = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';

/** The check both collection cover writes make before pointing the cover at an image. */
const COLLECTION_MANAGE_GUARD =
  "if (!permission.manage) { throw throwAuthorizationError('You do not have permission to manage this collection'); }";

// #region population 1: shared image schemas

const SCHEMA_NAMES = [
  'imageSchema',
  'imageInputSchema',
  'imageReferenceInputSchema',
  'comfylessImageSchema',
  'imagePositionSchema',
  'postAddImageInput',
] as const;
type SchemaName = (typeof SCHEMA_NAMES)[number];

/** Every non-test file referencing a shared image schema, with its reference counts. */
const SCHEMA_REFERENCE_LEDGER: Record<string, Partial<Record<SchemaName, number>>> = {
  // Definitions: `imageInputSchema` omits the three columns; the others derive from it.
  'src/server/schema/image.schema.ts': {
    imageSchema: 3,
    imageInputSchema: 4,
    imageReferenceInputSchema: 3,
    imagePositionSchema: 1,
    comfylessImageSchema: 1,
  },
  // post.addImage (`postAddImageInput`, whose `postId` addPostImage checks against the
  // caller) and post.createWithImages.
  'src/server/schema/post.schema.ts': {
    imageInputSchema: 3,
    imagePositionSchema: 3,
    postAddImageInput: 1,
  },
  'src/server/routers/post.router.ts': { postAddImageInput: 2 },
  // Covers: an `id` is a reference the service checks (resolveCoverImageId's assertOwnership,
  // or a moderator-only route).
  'src/server/schema/article.schema.ts': { imageReferenceInputSchema: 2 },
  'src/server/schema/announcement.schema.ts': { imageReferenceInputSchema: 2 },
  'src/server/schema/challenge.schema.ts': { imageReferenceInputSchema: 4 },
  'src/server/schema/user-profile.schema.ts': { imageReferenceInputSchema: 3 },
  // collection.upsert cover (a reference any collection manager may set; see
  // CONNECT_EXISTING_LEDGER) and collection.addSimpleImagePost (no id).
  'src/server/schema/collection.schema.ts': { imageInputSchema: 2, imageReferenceInputSchema: 2 },
  // Bounty images: an `id` keeps or links an existing image; updateEntityImages checks links.
  'src/server/schema/bounty.schema.ts': { imageReferenceInputSchema: 2 },
  'src/server/schema/bounty-entry.schema.ts': { imageReferenceInputSchema: 2 },
  // Moderator-only routes.
  'src/server/schema/cosmetic-shop.schema.ts': { comfylessImageSchema: 2 },
  'src/server/schema/purchasable-reward.schema.ts': { comfylessImageSchema: 2 },
  // `modelVersionUpsertSchema.images`, reachable from no router input.
  'src/server/schema/model-version.schema.ts': { imageInputSchema: 2 },
  // `.pick({ url, type })` of a generation resource: no server-owned column survives.
  'src/server/schema/generation.schema.ts': { imageSchema: 2 },
  // Client form schemas. Their payloads go to `article.upsert` and to a report flow that keeps
  // only `url`, so the server parses them again with its own input schema.
  'src/components/Article/ArticleUpsertForm.tsx': { imageSchema: 2 },
  'src/components/Report/OwnershipForm.tsx': { imageSchema: 2 },
};

// #endregion

// #region population 2: Image insert sites

type InsertSite = {
  sites: number;
  /** Every `...x` spread into the row, whitespace-collapsed. */
  spreads: string[];
  /** Every `id`/`postId`/`index` the site assigns, `select` blocks excluded. */
  serverColumns: string[];
  /** What must sit in the function body, before the write, for the assignments to be safe. */
  guards?: string[];
};

const INSERT_SITE_LEDGER: Record<string, InsertSite> = {
  // `postId`/`index` arrive only from addPostImage, which checked the post; `assertPostOwnedBy`
  // re-checks here so no other path can write into someone else's post.
  'src/server/services/image.service.ts#createImage': {
    sites: 1,
    spreads: ['pickClientImageColumns(image)'],
    serverColumns: ['postId: image.postId', 'index: image.index'],
    guards: [
      'if (image.postId != null) await assertPostOwnedBy({ postId: image.postId, userId: image.userId });',
    ],
  },
  'src/server/services/image.service.ts#createEntityImages': {
    sites: 1,
    spreads: ['pickClientImageColumns(image)'],
    serverColumns: [],
  },
  'src/server/services/image.service.ts#updateEntityImages': {
    sites: 1,
    spreads: ['pickClientImageColumns(image)'],
    serverColumns: [],
    guards: [
      'const owned = await dbClient.image.count({ where: { id: { in: linkIds }, userId } });' +
        ' if (owned !== new Set(linkIds).size) throw throwAuthorizationError();',
    ],
  },
  // `where` looks up an existing cover by id, which any collection manager may set (unchanged
  // from main); the `create` branch writes client columns only.
  'src/server/services/collection.service.ts#upsertCollection': {
    sites: 1,
    spreads: ['pickClientImageColumns(image)'],
    serverColumns: ['id: image.id ?? -1', 'id: undefined'],
    guards: [COLLECTION_MANAGE_GUARD],
  },
  // Only reached when the client sent no `id`, so `where` is always `-1`.
  'src/server/services/user-profile.service.ts#updateUserProfile': {
    sites: 1,
    spreads: ['pickClientImageColumns(image)'],
    serverColumns: ['id: image.id ?? -1'],
  },
  'src/server/controllers/user.controller.ts#updateUserHandler': {
    sites: 1,
    spreads: ['pickClientImageColumns(newPicture)', 'newPicture.metadata'],
    serverColumns: [],
  },
  // Server-built rows: nothing from a client image object is spread.
  'src/server/services/article.service.ts#linkArticleContentImages': {
    sites: 1,
    spreads: [],
    serverColumns: [],
  },
  'src/pages/api/admin/temp/migrate-article-images.ts#processBatch': {
    sites: 1,
    spreads: [],
    serverColumns: [],
  },
  'src/server/services/blocks/app-listing-assets.service.ts#createStoredImage': {
    sites: 1,
    spreads: ['(args.autogenerated ? { appListingAutogenerated: true } : {})'],
    serverColumns: [],
  },
  // `INSERT … SELECT` copying listed columns of an existing row; see DUPLICATE_COLUMNS below.
  'src/server/jobs/daily-challenge-processing.ts#duplicateImage': {
    sites: 1,
    spreads: [],
    serverColumns: [],
  },
};

// #endregion

// #region createImage callers

/**
 * Every function calling `createImage`, with what it spreads in and which server-owned
 * columns it passes. Only addPostImage passes a `postId`/`index`, and only after checking
 * the post belongs to the caller.
 */
const CREATE_IMAGE_CALLER_LEDGER: Record<
  string,
  { calls: number; spreads: string[]; serverColumns: string[] }
> = {
  'src/server/services/post.service.ts#addPostImage': {
    calls: 1,
    spreads: ['imageProps'],
    serverColumns: [],
  },
  // `productionCoverImageDeps.createImage`, a pass-through counted under the function above it.
  'src/server/services/cover-image.service.ts#logExistenceUnknown': {
    calls: 1,
    spreads: [],
    serverColumns: [],
  },
  // `deps.createImage`.
  'src/server/services/cover-image.service.ts#resolveCoverImageId': {
    calls: 1,
    spreads: ['pickClientImageColumns(image)'],
    serverColumns: [],
  },
  'src/server/services/image.service.ts#setVideoThumbnail': {
    calls: 1,
    spreads: ['pickClientImageColumns(customThumbnail)'],
    serverColumns: [],
  },
  'src/pages/api/admin/temp/upload-avatar-starters.ts#store': {
    calls: 1,
    spreads: [],
    serverColumns: [],
  },
  'src/pages/api/testing/model3d-seed.ts#handler': { calls: 1, spreads: [], serverColumns: [] },
  'src/server/services/blocks/block-image-upload.service.ts#persistBlockUploadImage': {
    calls: 1,
    spreads: ['storedObjectEtagMetadata(measured.etag)'],
    serverColumns: [],
  },
  'src/server/services/blocks/block-image-upload.service.ts#persistBlockWorkflowOutputImage': {
    calls: 1,
    spreads: [],
    serverColumns: [],
  },
  'src/server/services/blocks/listing-meta.service.ts#ingestListingAssetFromUrl': {
    calls: 1,
    spreads: [],
    serverColumns: [],
  },
  'src/server/services/blocks/listing-meta.service.ts#ingestListingAssetFromDataUri': {
    calls: 1,
    spreads: [],
    serverColumns: [],
  },
  'src/server/services/blocks/offsite-listing.service.ts#persistListingAssetImage': {
    calls: 1,
    spreads: ['storedObjectEtagMetadata(measured.etag)'],
    serverColumns: [],
  },
  'src/server/services/orchestrator/handlers/polyGen.handler.ts#ingestThumbnailImage': {
    calls: 1,
    spreads: [],
    serverColumns: [],
  },
  'src/server/services/orchestrator/poll-iteration.ts#downloadAndUploadImage': {
    calls: 1,
    spreads: [],
    serverColumns: [],
  },
  // Every comics call sits under the nearest async declaration above it.
  'src/server/routers/comics.router.ts#createSinglePanel': {
    calls: 11,
    spreads: [],
    serverColumns: [],
  },
};

// #endregion

// #region existing-image references

/**
 * Every `resolveCoverImageId` caller. A cover input may carry an `id` naming an existing row,
 * which the resolver returns as-is after the caller's `assertOwnership`, so each caller either
 * passes one, sits behind a moderator-only route, or takes an input with no `id`.
 */
const COVER_RESOLVER_CALLER_LEDGER: Record<
  string,
  { calls: number; decision: 'assertOwnership' | 'moderator-route' | 'input-has-no-id' }
> = {
  'src/server/services/article.service.ts#upsertArticle': { calls: 1, decision: 'assertOwnership' },
  'src/server/services/creator-announcement.service.ts#upsertCreatorAnnouncement': {
    calls: 1,
    decision: 'assertOwnership',
  },
  'src/server/services/challenge.service.ts#upsertUserChallenge': {
    calls: 1,
    decision: 'assertOwnership',
  },
  // `challenge.upsert` and `challenge.upsertEvent` are moderatorProcedure.
  'src/server/services/challenge.service.ts#upsertChallenge': {
    calls: 1,
    decision: 'moderator-route',
  },
  'src/server/services/challenge.service.ts#upsertChallengeEvent': {
    calls: 1,
    decision: 'moderator-route',
  },
  // The crucible inputs' cover and hero schemas have no `id`.
  'src/server/services/crucible.service.ts#createCrucible': {
    calls: 2,
    decision: 'input-has-no-id',
  },
  'src/server/services/crucible.service.ts#updateCrucible': {
    calls: 2,
    decision: 'input-has-no-id',
  },
};

/**
 * Every relation `connect` / `connectOrCreate` pointing an `Image` relation at an existing row by
 * id, with the guard that decides it. Direct writes of an `…ImageId` column are not in this set.
 *
 * `decides` says what the guard checks: `image` — the id itself (the caller's own image, or a
 * server-resolved one); `collection-manager` — only that the caller may manage the collection,
 * which lets any collection manager point its cover at any existing image. The collection rows
 * are unchanged from main; they are recorded here so the population stays complete.
 */
const CONNECT_EXISTING_LEDGER: Record<
  string,
  {
    sites: number;
    guard: string;
    guardFollows?: boolean;
    decides: 'image' | 'collection-manager';
  }
> = {
  // Covers `imageId` and `image.id` alike.
  'src/server/services/collection.service.ts#upsertCollection': {
    sites: 1,
    guard: COLLECTION_MANAGE_GUARD,
    decides: 'collection-manager',
  },
  'src/server/services/collection.service.ts#updateCollectionCoverImage': {
    sites: 1,
    guard: COLLECTION_MANAGE_GUARD,
    decides: 'collection-manager',
  },
  // Both ids are what `resolveCoverImageId` returned, not client values.
  'src/server/services/crucible.service.ts#updateCrucible': {
    sites: 2,
    guard: 'const heroImageId = changes.heroImage ? await resolveCoverImageId({',
    decides: 'image',
  },
  // The `where` is reached only when the client sent no `id`, so it is always `-1`.
  // Found through the `(image: …)` parameter of `buildCoverImageUpdate`, not a relation key.
  'src/server/services/user-profile.service.ts#updateUserProfile': {
    sites: 1,
    guard: 'image !== undefined && !image?.id',
    guardFollows: true,
    decides: 'image',
  },
};

// #endregion

// #region detectors

const WRITE_CALL = /\.image\s*\.\s*(?:create|createMany|createManyAndReturn|upsert)\s*\(/g;
const RAW_INSERT = /INSERT\s+INTO\s+(?:"?public"?\.)?"Image"/gi;
const COVER_RESOLVER_CALL = /(?<![.\w])resolveCoverImageId\s*\(/g;
const CREATE_IMAGE_CALL = /(?:(?<![.\w])|(?<=\bdeps\.))createImage\s*\(/g;

/** Relation fields of type `Image` (or `Image?` / `Image[]`) on any Prisma model. */
const IMAGE_RELATION_FIELDS = [
  ...new Set(
    [
      ...readFileSync(
        join(ROOT, 'packages/civitai-db-schema/prisma/schema.full.prisma'),
        'utf8'
      ).matchAll(/^[ \t]+(\w+)[ \t]+Image(?:\?|\[\])?[ \t\r\n]/gm),
    ].map((m) => m[1])
  ),
].sort();
const NESTED_CREATE = new RegExp(
  String.raw`\b(?:${IMAGE_RELATION_FIELDS.join(
    '|'
  )})\s*:[^;]{0,300}?\b(?:create|createMany|connectOrCreate|upsert)\s*:`,
  'g'
);

/** A relation typed `Image` pointed at an existing row: `connect` or `connectOrCreate`'s `where`. */
const CONNECT_EXISTING = new RegExp(
  String.raw`\b(?:${IMAGE_RELATION_FIELDS.join(
    '|'
  )})\s*:[^;]{0,300}?\b(?:connect\s*:\s*\{\s*id\s*[:,}]|connectOrCreate\s*:\s*\{\s*where\s*:\s*\{\s*id\s*[:,}])`,
  'g'
);

const DECLARATION =
  /(?:\bfunction\s*\*?\s*(\w+)\s*[<(])|(?:\b(?:const|let)\s+(\w+)\s*=\s*async\b)/g;

function enclosingFunction(text: string, offset: number): { name: string; start: number } {
  let found = { name: '<module>', start: 0 };
  for (const m of text.matchAll(DECLARATION)) {
    if (m.index === undefined || m.index >= offset) break;
    found = { name: m[1] ?? m[2], start: m.index };
  }
  return found;
}

function balanced(text: string, open: number, openCh: string, closeCh: string): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === openCh) depth++;
    else if (text[i] === closeCh && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/** The object literal starting at the first `{` at or after `from`, or '' if something else is. */
function objectAfter(text: string, from: number): string {
  const open = text.indexOf('{', from);
  if (open === -1 || text.slice(from, open).trim() !== '') return '';
  return balanced(text, open, '{', '}');
}

/** The raw SQL statement from `offset` to the end of its template literal. */
function rawStatement(text: string, offset: number): string {
  const end = text.indexOf('`', offset);
  return text.slice(offset, end === -1 ? text.length : end);
}

type Site = { key: string; region: string; body: string; after: string };

function sitesIn(file: string, text: string, re: RegExp): Site[] {
  return [...text.matchAll(re)].map((m) => {
    const offset = m.index ?? 0;
    const fn = enclosingFunction(text, offset);
    const region =
      re === RAW_INSERT
        ? rawStatement(text, offset)
        : re === NESTED_CREATE
        ? objectAfter(text, offset + m[0].length)
        : balanced(text, text.indexOf('(', offset + m[0].length - 1), '(', ')');
    return {
      key: `${file}#${fn.name}`,
      region,
      body: text.slice(fn.start, offset),
      after: text.slice(offset, offset + 400),
    };
  });
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
/** `collapse`, minus the trailing commas the formatter adds when it wraps a call. */
const normalized = (s: string) => collapse(s).replace(/,(\s*[}\])])/g, '$1');

/** Strips `select: { … }` blocks, which name columns to read rather than write. */
function withoutSelects(region: string): string {
  let out = region;
  for (let i = out.search(/\bselect\s*:\s*\{/); i !== -1; i = out.search(/\bselect\s*:\s*\{/)) {
    const block = balanced(out, out.indexOf('{', i), '{', '}');
    out = out.slice(0, i) + out.slice(out.indexOf('{', i) + block.length);
  }
  return out;
}

/** Every spread expression: an identifier path with an optional call, or a parenthesised one. */
function spreadsOf(region: string): string[] {
  const found: string[] = [];
  for (const m of region.matchAll(/\.\.\.\s*(\(|[\w.]+)/g)) {
    const at = (m.index ?? 0) + m[0].length;
    if (m[1] === '(') {
      found.push(collapse(balanced(region, at - 1, '(', ')')));
      continue;
    }
    const call = region[at] === '(' ? balanced(region, at, '(', ')') : '';
    found.push(collapse(m[1] + call));
  }
  return found;
}

const SERVER_COLUMN = /(?<![\w.])(['"]?)(id|postId|index)\1\s*:\s*([^,\n}]+)/g;
const SERVER_COLUMN_SHORTHAND = /[{,]\s*(id|postId|index)\s*(?=[,}\n])/g;
function serverColumnsOf(region: string): string[] {
  const text = withoutSelects(region);
  return [
    ...[...text.matchAll(SERVER_COLUMN)].map((m) => collapse(`${m[2]}: ${m[3]}`)),
    ...[...text.matchAll(SERVER_COLUMN_SHORTHAND)].map((m) => m[1]),
  ];
}

// #endregion

const scan = scanSource(ROOT);
const files = scan.files;
const commentless = new Map(
  files.map((f) => [f, stripComments(readFileSync(join(ROOT, f), 'utf8'))] as const)
);
const collect = (re: RegExp) => files.flatMap((f) => sitesIn(f, commentless.get(f)!, re));
const keysOf = (sites: Site[]) => [...new Set(sites.map((s) => s.key))].sort();
const countsOf = (sites: Site[]) =>
  Object.fromEntries(keysOf(sites).map((k) => [k, sites.filter((s) => s.key === k).length]));
const merged = (sites: Site[], of: (region: string) => string[]) =>
  Object.fromEntries(
    keysOf(sites).map((k) => [k, sites.filter((s) => s.key === k).flatMap((s) => of(s.region))])
  );

describe('population', () => {
  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('src/server/services/image.service.ts');
    expect(IMAGE_RELATION_FIELDS).toContain('coverImage');
    expect(IMAGE_RELATION_FIELDS).toContain('profilePicture');
  });
});

describe('shared image schemas', () => {
  it('every reference is classified, and no classified reference has gone', () => {
    const re = new RegExp(String.raw`\b(${SCHEMA_NAMES.join('|')})\b`, 'g');
    const actual: Record<string, Partial<Record<SchemaName, number>>> = {};
    for (const f of files) {
      for (const [, name] of scan.code.get(f)!.matchAll(re)) {
        const refs = (actual[f] ??= {});
        refs[name as SchemaName] = (refs[name as SchemaName] ?? 0) + 1;
      }
    }
    expect(actual).toEqual(SCHEMA_REFERENCE_LEDGER);
  });

  it('the generation resource keeps only url and type', () => {
    expect(collapse(scan.code.get('src/server/schema/generation.schema.ts')!)).toContain(
      'image: imageSchema .pick({ url: true, type: true })'
    );
  });
});

describe('Image insert sites', () => {
  const sites = [...collect(WRITE_CALL), ...collect(RAW_INSERT), ...collect(NESTED_CREATE)];

  it('every insert site is classified, and no classified site has gone', () => {
    expect(countsOf(sites)).toEqual(
      Object.fromEntries(Object.entries(INSERT_SITE_LEDGER).map(([k, v]) => [k, v.sites]))
    );
  });

  it('every value spread into a row is listed', () => {
    expect(merged(sites, spreadsOf)).toEqual(
      Object.fromEntries(Object.entries(INSERT_SITE_LEDGER).map(([k, v]) => [k, v.spreads]))
    );
  });

  it('every server-owned column a site assigns is listed', () => {
    expect(merged(sites, serverColumnsOf)).toEqual(
      Object.fromEntries(Object.entries(INSERT_SITE_LEDGER).map(([k, v]) => [k, v.serverColumns]))
    );
  });

  it('each listed guard runs before its write', () => {
    const missing = sites.flatMap((site) =>
      (INSERT_SITE_LEDGER[site.key]?.guards ?? [])
        .filter((guard) => !normalized(site.body).includes(normalized(guard)))
        .map((guard) => `${site.key}: ${guard}`)
    );
    expect(missing).toEqual([]);
  });

  it('the copied-row insert copies no server-owned column', () => {
    const source = commentless.get('src/server/jobs/daily-challenge-processing.ts')!;
    const list = source.match(/const duplicateImageColumns\s*=\s*\[([\s\S]*?)\]/);
    expect(list).not.toBeNull();
    const columns = [...list![1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(columns).toContain('url');
    expect(columns).not.toContain('id');
    expect(columns).not.toContain('postId');
    expect(columns).not.toContain('index');
  });
});

describe('createImage callers', () => {
  const calls = collect(CREATE_IMAGE_CALL).filter(
    (s) => s.key !== 'src/server/services/image.service.ts#createImage'
  );

  it('every caller is classified, with what it spreads and the columns it passes', () => {
    expect({
      calls: countsOf(calls),
      spreads: merged(calls, spreadsOf),
      serverColumns: merged(calls, serverColumnsOf),
    }).toEqual({
      calls: Object.fromEntries(
        Object.entries(CREATE_IMAGE_CALLER_LEDGER).map(([k, v]) => [k, v.calls])
      ),
      spreads: Object.fromEntries(
        Object.entries(CREATE_IMAGE_CALLER_LEDGER).map(([k, v]) => [k, v.spreads])
      ),
      serverColumns: Object.fromEntries(
        Object.entries(CREATE_IMAGE_CALLER_LEDGER).map(([k, v]) => [k, v.serverColumns])
      ),
    });
  });

  it('addPostImage checks the post before it calls createImage', () => {
    const [site] = calls.filter((s) => s.key.endsWith('#addPostImage'));
    expect(collapse(site.body)).toContain(
      'if (post.userId !== user.id) throw throwAuthorizationError();'
    );
  });

  // The multi-image handlers share one post-owner check per request through addPostImage; if it
  // stopped forwarding it, every image would fall back to its own lookup.
  it('addPostImage forwards its post-owner check to createImage', () => {
    const [site] = calls.filter((s) => s.key.endsWith('#addPostImage'));
    expect(site.region).toMatch(/[{,]\s*assertPostOwnedBy\s*,/);
  });
});

describe('existing-image references', () => {
  it('every resolveCoverImageId caller has its ownership decision', () => {
    const calls = collect(COVER_RESOLVER_CALL).filter(
      (s) => !s.key.startsWith('src/server/services/cover-image.service.ts#')
    );
    const decided = Object.fromEntries(
      keysOf(calls).map((k) => {
        const regions = calls.filter((s) => s.key === k).map((s) => s.region);
        return [
          k,
          {
            calls: regions.length,
            // Only the absence of `assertOwnership` falls back to the recorded decision, so a
            // caller recorded as passing one goes red the moment it stops.
            decision: regions.every((r) => /\bassertOwnership\s*:/.test(r))
              ? 'assertOwnership'
              : COVER_RESOLVER_CALLER_LEDGER[k]?.decision === 'assertOwnership'
              ? 'MISSING assertOwnership'
              : COVER_RESOLVER_CALLER_LEDGER[k]?.decision ?? 'UNCLASSIFIED',
          },
        ];
      })
    );
    expect(decided).toEqual(COVER_RESOLVER_CALLER_LEDGER);
  });

  it('every write pointing an Image relation at an existing row is classified, and guarded', () => {
    const sites = collect(CONNECT_EXISTING);
    expect(countsOf(sites)).toEqual(
      Object.fromEntries(Object.entries(CONNECT_EXISTING_LEDGER).map(([k, v]) => [k, v.sites]))
    );
    const missing = sites
      .filter((site) => {
        const { guard, guardFollows } = CONNECT_EXISTING_LEDGER[site.key];
        const text = guardFollows ? site.after : site.body;
        return !normalized(text).includes(normalized(guard));
      })
      .map((site) => site.key);
    expect(missing).toEqual([]);
  });

  it('only the two collection cover writes decide on the collection manager alone', () => {
    expect(
      Object.entries(CONNECT_EXISTING_LEDGER)
        .filter(([, v]) => v.decides === 'collection-manager')
        .map(([k]) => k)
        .sort()
    ).toEqual([
      'src/server/services/collection.service.ts#updateCollectionCoverImage',
      'src/server/services/collection.service.ts#upsertCollection',
    ]);
  });

  it('the moderator-route resolver callers are reached only from moderator procedures', () => {
    const routerFile = 'src/server/routers/challenge.router.ts';
    const router = scan.code.get(routerFile)!;
    const procedures = [
      ...router.matchAll(/\n  (\w+): (\w+)\b([\s\S]*?)(?=\n  \w+: \w+\b|\n\}\);)/g),
    ];
    const moderatorOnly = Object.entries(COVER_RESOLVER_CALLER_LEDGER)
      .filter(([, v]) => v.decision === 'moderator-route')
      .map(([k]) => k.split('#')[1]);
    expect(moderatorOnly.sort()).toEqual(['upsertChallenge', 'upsertChallengeEvent']);
    for (const fn of moderatorOnly) {
      const call = new RegExp(String.raw`\b${fn}\s*\(`);
      const home = 'src/server/services/challenge.service.ts';
      const callers = files.filter((f) => f !== home && call.test(scan.code.get(f)!));
      expect(callers, fn).toEqual([routerFile]);
      expect(scan.code.get(home)!.match(new RegExp(call, 'g')), fn).toHaveLength(1);
      const via = procedures.filter(([, , , rest]) => call.test(rest)).map(([, , kind]) => kind);
      expect(via, fn).toEqual(['moderatorProcedure']);
    }
  });

  it('the resolver callers recorded as taking no id take a schema without one', () => {
    expect(
      Object.entries(COVER_RESOLVER_CALLER_LEDGER)
        .filter(([, v]) => v.decision === 'input-has-no-id')
        .map(([k]) => k.split('#')[0])
    ).toEqual([
      'src/server/services/crucible.service.ts',
      'src/server/services/crucible.service.ts',
    ]);
    for (const [name, schema] of [
      ['create coverImage', createCrucibleInputBaseSchema.shape.coverImage],
      ['create heroImage', createCrucibleInputBaseSchema.shape.heroImage],
      ['update coverImage', updateCrucibleSchema.shape.coverImage],
      ['update heroImage', updateCrucibleSchema.shape.heroImage],
    ] as const) {
      const parsed = (schema as z.ZodType).parse({ url: URL_UUID, width: 1, height: 2, id: 7 });
      expect(parsed, name).not.toHaveProperty('id');
    }
  });
});

describe('detector controls', () => {
  const at = (src: string, re: RegExp) => sitesIn('x.ts', stripComments(src), re);

  it('finds an Image relation pointed at an existing row in every spelling', () => {
    const src = [
      'async function a(i) { await db.x.update({ data: { image: { connect: { id: i } } } }); }',
      'async function b(id) { await db.x.update({ data: { coverImage: { connect: { id } } } }); }',
      'async function c(i) { await db.x.update({ data: { image: { connectOrCreate: { where: { id: i }, create: {} } } } }); }',
      'async function d(i) { await db.x.update({ data: { modelVersions: { connect: { id: i } } } }); }',
    ].join('\n');
    expect(keysOf(at(src, CONNECT_EXISTING))).toEqual(['x.ts#a', 'x.ts#b', 'x.ts#c']);
  });

  it('reads the spreads and server columns of a write call', () => {
    const [site] = at(
      'async function add(input) {\n  await db.image.create({ data: { ...input, ...pickClientImageColumns(input), postId: input.postId, index: 2 }, select: { id: true } });\n}',
      WRITE_CALL
    );
    expect(site.key).toBe('x.ts#add');
    expect(spreadsOf(site.region)).toEqual(['input', 'pickClientImageColumns(input)']);
    expect(serverColumnsOf(site.region)).toEqual(['postId: input.postId', 'index: 2']);
  });

  it('finds a nested Image relation create behind a conditional', () => {
    const [site] = at(
      'async function save(p) {\n  await db.user.update({ data: { coverImage: p\n ? { connectOrCreate: { where: { id: p.id }, create: { ...p } } } : undefined } });\n}',
      NESTED_CREATE
    );
    expect(site.key).toBe('x.ts#save');
    expect(spreadsOf(site.region)).toEqual(['p']);
    expect(serverColumnsOf(site.region)).toEqual(['id: p.id']);
  });

  it('reads shorthand and quoted server columns, and parenthesised spreads', () => {
    const [site] = at(
      "async function add(i, postId, index) {\n  await db.image.create({ data: { ...(i as X), postId, index, 'id': 5 } });\n}",
      WRITE_CALL
    );
    expect(spreadsOf(site.region)).toEqual(['(i as X)']);
    expect(serverColumnsOf(site.region).sort()).toEqual(['id: 5', 'index', 'postId']);
  });

  it('ignores a write call in a comment', () => {
    expect(at('// db.image.create({ data: { ...x } })\nconst a = 1;', WRITE_CALL)).toEqual([]);
  });

  it('finds createImage and deps.createImage calls, but not another method of that name', () => {
    const sites = at(
      'async function f(i) { await createImage({ ...i, postId: 1 }); await deps.createImage({ url }); await other.createImage({ url }); }',
      CREATE_IMAGE_CALL
    );
    expect(sites).toHaveLength(2);
    expect(spreadsOf(sites[0].region)).toEqual(['i']);
    expect(serverColumnsOf(sites[0].region)).toEqual(['postId: 1']);
  });

  it('finds a raw insert', () => {
    expect(
      at(
        'async function dup() { await q(`INSERT INTO "Image" (url) VALUES (1)`); }',
        RAW_INSERT
      ).map((s) => s.key)
    ).toEqual(['x.ts#dup']);
  });
});
