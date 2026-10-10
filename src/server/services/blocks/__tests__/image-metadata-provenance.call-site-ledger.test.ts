import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { scanSource } from '../../../../../test/source-scan';
import { stripComments } from '../../../../../test/strip-comments';

/**
 * Seam guard for the server-owned `Image.metadata` provenance keys
 * (`~/shared/utils/block-provenance-metadata`).
 *
 * The behaviour suite (`image-block-provenance-metadata.test.ts`) proves `createImage`,
 * the entity writers and the input schemas drop the keys. This pins the POPULATION: every
 * production site that inserts an `Image` row, what it does about `metadata`, and the
 * closed set of sites allowed to write a provenance key. Each table fails when it grows
 * or shrinks, so a new writer has to be classified here before it ships.
 *
 * Population, under `src/` with test files excluded: every
 * `.image.(create|createMany|createManyAndReturn|upsert)(` call, every raw
 * `INSERT INTO "Image"`, and every nested `create`/`createMany`/`connectOrCreate`/`upsert`
 * that follows the key of a relation field typed `Image` in the Prisma schema within 300
 * characters of the same statement. A nested create built in a helper is found only when
 * that key (or a parameter named like one) sits within that window.
 *
 * The ledgers count sites per enclosing function, which is the nearest `function` or
 * `const x = async` declaration before the site; a site in a plain arrow is counted under
 * the declaration above it.
 */

const ROOT = process.cwd();

type Decision =
  /** `createImage` itself: strips client keys, writes only `blockProvenance`. */
  | 'createImage-strip'
  /** Spreads caller input, and overrides `metadata` with a stripped copy. */
  | 'in-function-strip'
  /** Writes no `metadata` column and spreads nothing into the row. */
  | 'no-metadata'
  /** Builds `metadata` from server values only; no provenance key. */
  | 'server-literal'
  /** `INSERT … SELECT` copying an existing row's stored metadata. */
  | 'copied-from-stored-row'
  /** Nested relation create; `metadata` after the last spread is a stripped copy. */
  | 'nested-strip'
  /** Nested relation create; `metadata` after the last spread is a server-built literal. */
  | 'nested-server-literal';

/** Every insert site, keyed by enclosing function, with its decision and its site count. */
const WRITE_SITE_LEDGER: Record<string, { decision: Decision; sites: number }> = {
  'src/server/services/image.service.ts#createImage': { decision: 'createImage-strip', sites: 1 },
  'src/server/services/image.service.ts#createEntityImages': {
    decision: 'in-function-strip',
    sites: 1,
  },
  'src/server/services/image.service.ts#updateEntityImages': {
    decision: 'in-function-strip',
    sites: 1,
  },
  'src/server/services/article.service.ts#linkArticleContentImages': {
    decision: 'no-metadata',
    sites: 1,
  },
  'src/pages/api/admin/temp/migrate-article-images.ts#processBatch': {
    decision: 'no-metadata',
    sites: 1,
  },
  'src/server/services/blocks/app-listing-assets.service.ts#createStoredImage': {
    decision: 'server-literal',
    sites: 1,
  },
  // The source row's metadata was itself written through one of the sites above.
  'src/server/jobs/daily-challenge-processing.ts#duplicateImage': {
    decision: 'copied-from-stored-row',
    sites: 1,
  },
  'src/server/controllers/user.controller.ts#updateUserHandler': {
    decision: 'nested-strip',
    sites: 1,
  },
  'src/server/services/collection.service.ts#upsertCollection': {
    decision: 'nested-strip',
    sites: 1,
  },
  'src/server/services/user-profile.service.ts#updateUserProfile': {
    decision: 'nested-server-literal',
    sites: 1,
  },
};

/**
 * Every function that names `blockProvenance`: `createImage`, which declares it, and the
 * callers that pass it — the only legitimate stampers.
 */
const STAMPER_LEDGER: Record<string, number> = {
  'src/server/services/image.service.ts#createImage': 8,
  'src/server/services/blocks/block-image-upload.service.ts#persistBlockWorkflowOutputImage': 1,
};

/**
 * Every site that writes a provenance key as an object key. `createImage` is the one
 * `Image` writer; the other entry stamps `Post.metadata`, a different column.
 */
const PROVENANCE_KEY_WRITE_LEDGER: Record<string, number> = {
  'src/server/services/image.service.ts#createImage': 1,
  'src/server/services/blocks/block-post.service.ts#writeBlockPost': 1,
};

const WRITE_CALL = /\.image\s*\.\s*(?:create|createMany|createManyAndReturn|upsert)\s*\(/g;
const RAW_INSERT = /INSERT\s+INTO\s+(?:"?public"?\.)?"Image"/gi;

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
const STAMPER = /\bblockProvenance\b/g;
const PROVENANCE_KEY_WRITE = new RegExp(
  [
    // `{ [KEY]: v }` and `m[KEY] = v`
    String.raw`\[\s*(?:BLOCK_\w*APP_ID_META_KEY|blockProvenance\.key)\s*\]\s*(?::|=(?!=))`,
    // `{ ['blockXAppId']: v }` and `m['blockXAppId'] = v`
    String.raw`\[\s*['"]block[A-Z]\w*AppId['"]\s*\]\s*(?::|=(?!=))`,
    // `{ blockXAppId: v }`, `{ 'blockXAppId': v }`
    String.raw`(?:^|[{,\s])['"]?block[A-Z]\w*AppId['"]?\s*:`,
    // shorthand `{ ...m, blockXAppId }` (a destructuring `{ blockXAppId } =` is a read)
    String.raw`[{,]\s*block[A-Z]\w*AppId\s*(?=,|\}(?!\s*=))`,
    // `m.blockXAppId = v`
    String.raw`\.block[A-Z]\w*AppId\s*=(?!=)`,
    // SQL `jsonb_build_object(…, 'blockXAppId', …)` and `jsonb_set(…, '{blockXAppId}', …)`
    String.raw`jsonb_build_object\([\s\S]{0,300}?'block[A-Z]\w*AppId'`,
    String.raw`'\{block[A-Z]\w*AppId\}'`,
  ].join('|'),
  'gm'
);
const PROVENANCE_TOKEN = /BLOCK_\w*APP_ID_META_KEY|\bblock[A-Z]\w*AppId\b|blockProvenance/;

const DECLARATION =
  /(?:\bfunction\s*\*?\s*(\w+)\s*[<(])|(?:\b(?:const|let)\s+(\w+)\s*=\s*async\b)/g;

/** The closest function declaration before `offset`. */
function enclosingFunction(text: string, offset: number): { name: string; start: number } {
  let found = { name: '<module>', start: 0 };
  for (const m of text.matchAll(DECLARATION)) {
    if (m.index === undefined || m.index >= offset) break;
    found = { name: m[1] ?? m[2], start: m.index };
  }
  return found;
}

/** Index of the backtick closing the template whose body contains `i`. */
function templateEnd(text: string, i: number): number {
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '`') return i;
    else if (text[i] === '$' && text[i + 1] === '{') i = interpolationEnd(text, i + 2);
    else i++;
  }
  return text.length;
}

function interpolationEnd(text: string, i: number): number {
  let depth = 1;
  while (i < text.length) {
    if (text[i] === '`') i = templateEnd(text, i + 1) + 1;
    else if (text[i] === '{' && ++depth) i++;
    else if (text[i] === '}' && --depth === 0) return i + 1;
    else i++;
  }
  return text.length;
}

/** The raw statement from `offset` to the end of the template literal it sits in. */
function rawStatement(text: string, offset: number): string {
  return text.slice(offset, templateEnd(text, offset));
}

/** The `{ … }` object literal that starts at the first `{` at or after `from`. */
function objectAfter(text: string, from: number): string {
  const open = text.indexOf('{', from);
  // `create: data` is not a literal this file can read; an empty region fails every nested check.
  if (open === -1 || text.slice(from, open).trim() !== '') return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/**
 * The value assigned to `metadata:` after the last spread in `region` (a spread of
 * `stripBlockProvenanceMetadata(…)` is part of that value, not a competing one), or
 * null when a later spread could replace it.
 */
function metadataAfterLastSpread(region: string): string | null {
  const spreads = [...region.matchAll(/\.\.\.(?!stripBlockProvenanceMetadata\()[\w(]/g)];
  const lastSpread = spreads.length ? spreads[spreads.length - 1].index! : -1;
  const assignments = [...region.matchAll(/\bmetadata:\s*/g)].filter((m) => m.index! > lastSpread);
  const last = assignments[assignments.length - 1];
  return last ? region.slice(last.index! + last[0].length) : null;
}

/** The text between the `(` at `open` and its matching `)`. */
function argumentRegion(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`unbalanced call at ${open}`);
}

type Site = { key: string; region: string; body: string };

/** Sites in one file's comment-stripped text matching `re`, keyed by enclosing function. */
function sitesIn(file: string, text: string, re: RegExp): Site[] {
  return [...text.matchAll(re)].map((m) => {
    const offset = m.index ?? 0;
    const fn = enclosingFunction(text, offset);
    const open = text.indexOf('(', offset + m[0].length - 1);
    return {
      key: `${file}#${fn.name}`,
      region:
        re === WRITE_CALL
          ? argumentRegion(text, open)
          : re === RAW_INSERT
          ? rawStatement(text, offset)
          : re === NESTED_CREATE
          ? objectAfter(text, offset + m[0].length)
          : text.slice(offset, offset + 600),
      body: text.slice(fn.start, offset + 2000),
    };
  });
}

/** Any spread other than `...(cond ? { … } : {})`, whose branches are object literals. */
const UNSAFE_SPREAD = /\.\.\.(?!\(\s*[\w.!]+\s*\?\s*\{[^}]*\}\s*:\s*\{\s*\}\s*\))/;

/** Does this write site's shape match its recorded decision? Returns a reason when not. */
function checkDecision(decision: Decision, site: Site): string | null {
  const { region, body } = site;
  switch (decision) {
    case 'createImage-strip':
      if (!/const metadata = stripBlockProvenanceMetadata\(image\.metadata\)/.test(body))
        return 'createImage no longer strips image.metadata';
      if (
        !/\.\.\.image,\s*metadata:\s*blockProvenance\s*\?\s*\{\s*\.\.\.metadata,\s*\[blockProvenance\.key\]:\s*blockProvenance\.appId\s*\}\s*:\s*metadata,/.test(
          region
        )
      )
        return 'createImage no longer writes the stripped metadata plus blockProvenance';
      return null;
    case 'in-function-strip':
      if (
        !/^stripBlockProvenanceMetadata\(image\.metadata\)/.test(
          metadataAfterLastSpread(region) ?? ''
        )
      )
        return 'spreads input without overriding metadata with a stripped copy';
      return null;
    case 'no-metadata':
      if (/\bmetadata\b/.test(region)) return 'now writes metadata';
      if (UNSAFE_SPREAD.test(region)) return 'now spreads a value into the row';
      return null;
    case 'server-literal':
      if (PROVENANCE_TOKEN.test(region)) return 'writes a provenance key';
      if (!/\bmetadata:\s*\{/.test(region)) return 'metadata is not an object literal';
      if (UNSAFE_SPREAD.test(region)) return 'spreads a value into the row';
      return null;
    case 'copied-from-stored-row':
      if (!/^INSERT INTO "Image"[\s\S]*SELECT[\s\S]*FROM "Image" i\s+WHERE i\.id = /.test(region))
        return 'is no longer an INSERT … SELECT from an existing Image row';
      return null;
    case 'nested-strip': {
      const value = metadataAfterLastSpread(region);
      if (!value || !/^(?:\{\s*\.\.\.)?stripBlockProvenanceMetadata\(/.test(value))
        return 'nested create no longer strips the input metadata';
      return null;
    }
    case 'nested-server-literal': {
      const value = metadataAfterLastSpread(region);
      if (!value || !value.startsWith('{')) return 'metadata is not a literal after the spreads';
      const literal = objectAfter(value, 0);
      if (PROVENANCE_TOKEN.test(literal)) return 'metadata literal names a provenance key';
      return null;
    }
  }
}

const scan = scanSource(ROOT);
const files = scan.files;
const commentless = new Map(
  files.map((f) => [f, stripComments(readFileSync(join(ROOT, f), 'utf8'))] as const)
);

function collect(re: RegExp): Site[] {
  return files.flatMap((f) => sitesIn(f, commentless.get(f)!, re));
}

const keysOf = (sites: Site[]) => [...new Set(sites.map((s) => s.key))].sort();
const countsOf = (sites: Site[]) =>
  Object.fromEntries(keysOf(sites).map((k) => [k, sites.filter((s) => s.key === k).length]));

describe('Image metadata provenance — write-site ledger', () => {
  const writeSites = [...collect(WRITE_CALL), ...collect(RAW_INSERT), ...collect(NESTED_CREATE)];

  it('scans a real population', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('src/server/services/image.service.ts');
    expect(IMAGE_RELATION_FIELDS).toEqual([
      'avatar',
      'cover',
      'coverImage',
      'headerImage',
      'heroImage',
      'icon',
      'image',
      'images',
      'pendingImage',
      'profilePicture',
      'sfwCoverImage',
      'sourceImage',
      'thumbnailImage',
    ]);
  });

  it('every Image insert site is classified, and no classified site has gone', () => {
    expect(countsOf(writeSites)).toEqual(
      Object.fromEntries(Object.entries(WRITE_SITE_LEDGER).map(([k, v]) => [k, v.sites]))
    );
  });

  it('no write call was matched inside a string literal', () => {
    const inCode = files.reduce(
      (n, f) => n + [...scan.code.get(f)!.matchAll(WRITE_CALL)].length,
      0
    );
    expect(collect(WRITE_CALL)).toHaveLength(inCode);
  });

  it('every site still has the shape its decision records', () => {
    const mismatches = writeSites
      .map((site) => {
        const reason = checkDecision(WRITE_SITE_LEDGER[site.key].decision, site);
        return reason && `${site.key}: ${reason}`;
      })
      .filter(Boolean);
    expect(mismatches).toEqual([]);
  });
});

describe('Image metadata provenance — stamper ledger', () => {
  it('only the recorded functions name blockProvenance', () => {
    expect(countsOf(collect(STAMPER))).toEqual(STAMPER_LEDGER);
  });

  it('only the recorded sites write a provenance key as an object key', () => {
    expect(countsOf(collect(PROVENANCE_KEY_WRITE))).toEqual(PROVENANCE_KEY_WRITE_LEDGER);
  });
});

describe('detector controls', () => {
  const fixture = (src: string) => stripComments(src);

  it('finds a write call and names its function', () => {
    const text = fixture(
      'async function addThing(input) {\n  await dbWrite.image.create({ data: { ...input } });\n}'
    );
    const [site] = sitesIn('x.ts', text, WRITE_CALL);
    expect(site.key).toBe('x.ts#addThing');
    expect(site.region).toBe('{ data: { ...input } }');
  });

  it('ignores a write call that only appears in a comment', () => {
    const text = fixture('// dbWrite.image.create(x)\nconst a = 1;');
    expect(sitesIn('x.ts', text, WRITE_CALL)).toEqual([]);
  });

  it('finds a raw insert', () => {
    const text = fixture('async function dup() { await q(`INSERT INTO "Image" (url) SELECT 1`); }');
    expect(sitesIn('x.ts', text, RAW_INSERT).map((s) => s.key)).toEqual(['x.ts#dup']);
  });

  it.each([
    [
      'const persist = async (appId) => ({ metadata: { [BLOCK_UPLOADED_APP_ID_META_KEY]: appId } })',
    ],
    ['const persist = async (appId) => ({ metadata: { blockForkedAppId: appId } })'],
    ["const persist = async (appId) => ({ metadata: { 'blockPublishedAppId': appId } })"],
    ['const persist = async (m, appId) => { m.blockPublishedAppId = appId; }'],
    ['const persist = async (m, blockPublishedAppId) => ({ ...m, blockPublishedAppId })'],
    ["const persist = async (appId) => ({ ['blockPublishedAppId']: appId })"],
    ["const persist = async (m, appId) => { m['blockPublishedAppId'] = appId; }"],
    [
      "const persist = async (id) => q(`SET metadata = jsonb_set(metadata, '{blockPublishedAppId}', ${id})`)",
    ],
    [
      "const persist = async (id) => q(`jsonb_build_object('a', lower('x'), 'blockPublishedAppId', ${id})`)",
    ],
    ['const persist = async (m, appId) => { m[BLOCK_PUBLISHED_APP_ID_META_KEY] = appId; }'],
    [
      "const persist = async (id) => q(`SET metadata = jsonb_build_object('blockPublishedAppId', ${id})`)",
    ],
  ])('flags a provenance key write: %s', (src) => {
    expect(sitesIn('x.ts', fixture(src), PROVENANCE_KEY_WRITE).map((s) => s.key)).toEqual([
      'x.ts#persist',
    ]);
  });

  it('finds a nested Image relation create behind a conditional', () => {
    const text = fixture(
      'async function save(p) {\n  await db.user.update({ data: { avatar: p\n ? { create: { ...p } } : undefined } });\n}'
    );
    const [site] = sitesIn('x.ts', text, NESTED_CREATE);
    expect(site.key).toBe('x.ts#save');
    expect(checkDecision('nested-strip', site)).toBe(
      'nested create no longer strips the input metadata'
    );
  });

  it('does not flag a provenance key read or comparison', () => {
    const text = fixture(
      'function read(m) { const { blockPublishedAppId } = m; return m[BLOCK_PUBLISHED_APP_ID_META_KEY] === m.blockPublishedAppId; }'
    );
    expect(sitesIn('x.ts', text, PROVENANCE_KEY_WRITE)).toEqual([]);
  });

  it('finds a blockProvenance passed as shorthand', () => {
    const text = fixture(
      'async function stamp(blockProvenance) { await createImage({ url, blockProvenance }); }'
    );
    expect(keysOf(sitesIn('x.ts', text, STAMPER))).toEqual(['x.ts#stamp']);
  });

  it('counts a second write site in an already-listed function', () => {
    const text = fixture(
      'async function f(a, b) { await db.image.create({ data: a }); await db.image.create({ data: b }); }'
    );
    expect(countsOf(sitesIn('x.ts', text, WRITE_CALL))).toEqual({ 'x.ts#f': 2 });
  });

  it('ends a raw insert at its own template, not at a later statement', () => {
    const text = fixture(
      'async function add(u) { await db.$queryRaw`INSERT INTO "Image" (url) VALUES (${u})`; }\n' +
        'async function dup(id) { await db.$queryRawUnsafe(`SELECT 1 FROM "Image" i WHERE i.id = ${id}`); }'
    );
    const [site] = sitesIn('x.ts', text, RAW_INSERT);
    expect(site.region).toBe('INSERT INTO "Image" (url) VALUES (${u})');
    expect(checkDecision('copied-from-stored-row', site)).toContain('no longer an INSERT … SELECT');
  });

  it('accepts the stripped and server-literal nested shapes', () => {
    expect(
      checkDecision('nested-strip', {
        key: 'x',
        region: '{ ...p, metadata: { ...stripBlockProvenanceMetadata(p.metadata), a: 1 }, userId }',
        body: '',
      })
    ).toBeNull();
    expect(
      checkDecision('nested-server-literal', {
        key: 'x',
        region: '{ where: { id }, create: { ...image, metadata: { coverImage: true, userId } } }',
        body: '',
      })
    ).toBeNull();
  });

  it('reads no region from a nested create whose value is not a literal', () => {
    const text = fixture(
      'async function save(a) {\n  await db.user.update({ data: { avatar: { create: a } } });\n  const other = { metadata: { x: 1 } };\n}'
    );
    const [site] = sitesIn('x.ts', text, NESTED_CREATE);
    expect(site.region).toBe('');
    expect(checkDecision('nested-server-literal', site)).not.toBeNull();
  });

  it('counts a provenance key write added under an already-listed function', () => {
    const text = fixture(
      'async function createImage(m, blockProvenance) { return { ...m, [blockProvenance.key]: 1 }; }\n' +
        'export const tagAppImage = (m, id) => ({ ...m, [BLOCK_PUBLISHED_APP_ID_META_KEY]: id });\n' +
        'export const stampIt = (blockProvenance) => doThing({ blockProvenance });'
    );
    expect(countsOf(sitesIn('x.ts', text, PROVENANCE_KEY_WRITE))).toEqual({
      'x.ts#createImage': 2,
    });
    expect(countsOf(sitesIn('x.ts', text, STAMPER))).toEqual({ 'x.ts#createImage': 4 });
  });

  it('accepts a conditional spread of object literals in a server-literal site', () => {
    const region = '{ data: { metadata: { size: 1, ...(auto ? { autogenerated: true } : {}) } } }';
    expect(checkDecision('server-literal', { key: 'x', region, body: '' })).toBeNull();
  });

  it.each<[Decision, string, string]>([
    ['no-metadata', '{ data: { url, metadata: input.metadata } }', 'now writes metadata'],
    ['no-metadata', '{ data: { ...input } }', 'now spreads a value into the row'],
    ['no-metadata', '{ data: { ...(input) } }', 'now spreads a value into the row'],
    ['server-literal', '{ data: { metadata: args.metadata } }', 'not an object literal'],
    ['server-literal', '{ data: { metadata: { ...(args.metadata) } } }', 'spreads a value'],
    [
      'copied-from-stored-row',
      'INSERT INTO "Image" (url) VALUES (${url})',
      'no longer an INSERT … SELECT',
    ],
    [
      'createImage-strip',
      'const metadata = stripBlockProvenanceMetadata(image.metadata); { data: { ...image, metadata: blockProvenance ? { ...image.metadata } : metadata, meta } }',
      'createImage no longer writes',
    ],
    ['in-function-strip', '{ data: { ...image, meta } }', 'spreads input without overriding'],
    [
      'nested-strip',
      '{ ...p, metadata: { ...stripBlockProvenanceMetadata(p.metadata), ...p.metadata } }',
      'nested create no longer strips',
    ],
    [
      'nested-strip',
      '{ metadata: { ...stripBlockProvenanceMetadata(p.metadata) }, ...p }',
      'nested create no longer strips',
    ],
    [
      'in-function-strip',
      '{ data: { metadata: stripBlockProvenanceMetadata(image.metadata), ...image } }',
      'spreads input without overriding',
    ],
    [
      'nested-server-literal',
      '{ create: { ...image, metadata: { coverImage: true, ...image.metadata } } }',
      'not a literal after the spreads',
    ],
    [
      'nested-server-literal',
      '{ create: { ...image, metadata: { [BLOCK_PUBLISHED_APP_ID_META_KEY]: id } } }',
      'names a provenance key',
    ],
    [
      'nested-server-literal',
      '{ create: { ...image, metadata: image.metadata } }',
      'not a literal',
    ],
    [
      'server-literal',
      '{ data: { metadata: { [BLOCK_PUBLISHED_APP_ID_META_KEY]: id } } }',
      'provenance',
    ],
  ])('rejects a %s site that drifted: %s', (decision, region, reason) => {
    expect(checkDecision(decision, { key: 'x', region, body: region })).toContain(reason);
  });
});
