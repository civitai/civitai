import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { sourceFiles } from '../../../../../test/source-scan';
import { stripComments, stripCommentsAndStrings } from '../../../../../test/strip-comments';

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
 * Population: every `.image.(create|createMany|createManyAndReturn|upsert)(` call and
 * every raw `INSERT INTO "Image"` under `src/`, test files excluded.
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
  | 'copied-from-stored-row';

const WRITE_SITE_LEDGER: Record<string, Decision> = {
  'src/server/services/image.service.ts#createImage': 'createImage-strip',
  'src/server/services/image.service.ts#createEntityImages': 'in-function-strip',
  'src/server/services/image.service.ts#updateEntityImages': 'in-function-strip',
  'src/server/services/article.service.ts#linkArticleContentImages': 'no-metadata',
  'src/pages/api/admin/temp/migrate-article-images.ts#processBatch': 'no-metadata',
  'src/server/services/blocks/app-listing-assets.service.ts#createStoredImage': 'server-literal',
  // The source row's metadata was itself written through one of the sites above.
  'src/server/jobs/daily-challenge-processing.ts#duplicateImage': 'copied-from-stored-row',
};

/** Sites that pass `blockProvenance` to `createImage` — the only legitimate stampers. */
const STAMPER_LEDGER = [
  'src/server/services/blocks/block-image-upload.service.ts#persistBlockWorkflowOutputImage',
];

/**
 * Every site that writes a provenance key as an object key. `createImage` is the one
 * `Image` writer; the other entry stamps `Post.metadata`, a different column.
 */
const PROVENANCE_KEY_WRITE_LEDGER = [
  'src/server/services/image.service.ts#createImage',
  'src/server/services/blocks/block-post.service.ts#writeBlockPost',
];

const WRITE_CALL = /\.image\s*\.\s*(?:create|createMany|createManyAndReturn|upsert)\s*\(/g;
const RAW_INSERT = /INSERT\s+INTO\s+"Image"/gi;
const STAMPER = /\bblockProvenance\s*:/g;
const PROVENANCE_KEY_WRITE =
  /\[\s*(?:BLOCK_\w*APP_ID_META_KEY|blockProvenance\.key)\s*\]\s*:|(?:^|[{,\s])['"]?block[A-Z]\w*AppId['"]?\s*:/gm;
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
      region: re === WRITE_CALL ? argumentRegion(text, open) : text.slice(offset, offset + 600),
      body: text.slice(fn.start, offset + 2000),
    };
  });
}

/** Does this write site's shape match its recorded decision? Returns a reason when not. */
function checkDecision(decision: Decision, site: Site): string | null {
  const { region, body } = site;
  switch (decision) {
    case 'createImage-strip':
      if (!/const metadata = stripBlockProvenanceMetadata\(image\.metadata\)/.test(body))
        return 'createImage no longer strips image.metadata';
      if (!/\.\.\.image,\s*metadata:\s*blockProvenance\s*\?/.test(region))
        return 'createImage no longer overrides the spread metadata';
      return null;
    case 'in-function-strip':
      if (
        !/\.\.\.image,\s*metadata:\s*stripBlockProvenanceMetadata\(image\.metadata\)/.test(region)
      )
        return 'spreads input without overriding metadata with a stripped copy';
      return null;
    case 'no-metadata':
      if (/\bmetadata\b/.test(region)) return 'now writes metadata';
      if (/\.\.\.(?!\()/.test(region)) return 'now spreads a value into the row';
      return null;
    case 'server-literal':
      if (PROVENANCE_TOKEN.test(region)) return 'writes a provenance key';
      if (/\.\.\.(?!\()/.test(region)) return 'spreads a value into the row';
      return null;
    case 'copied-from-stored-row':
      if (!/SELECT[\s\S]*FROM "Image" i\s+WHERE i\.id = /.test(body))
        return 'is no longer an INSERT … SELECT from an existing Image row';
      return null;
  }
}

const files = sourceFiles(ROOT);
const commentless = new Map(
  files.map((f) => [f, stripComments(readFileSync(join(ROOT, f), 'utf8'))] as const)
);

function collect(re: RegExp): Site[] {
  return files.flatMap((f) => sitesIn(f, commentless.get(f)!, re));
}

const keysOf = (sites: Site[]) => [...new Set(sites.map((s) => s.key))].sort();

describe('Image metadata provenance — write-site ledger', () => {
  const writeSites = [...collect(WRITE_CALL), ...collect(RAW_INSERT)];

  it('scans a real population', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('src/server/services/image.service.ts');
  });

  it('every Image insert site is classified, and no classified site has gone', () => {
    expect(keysOf(writeSites)).toEqual(Object.keys(WRITE_SITE_LEDGER).sort());
  });

  it('no write call was matched inside a string literal', () => {
    const inCode = files.reduce(
      (n, f) =>
        n +
        [...stripCommentsAndStrings(readFileSync(join(ROOT, f), 'utf8')).matchAll(WRITE_CALL)]
          .length,
      0
    );
    expect(collect(WRITE_CALL)).toHaveLength(inCode);
  });

  it('every site still has the shape its decision records', () => {
    const mismatches = writeSites
      .map((site) => {
        const reason = checkDecision(WRITE_SITE_LEDGER[site.key], site);
        return reason && `${site.key}: ${reason}`;
      })
      .filter(Boolean);
    expect(mismatches).toEqual([]);
  });
});

describe('Image metadata provenance — stamper ledger', () => {
  it('only the recorded sites pass blockProvenance to createImage', () => {
    expect(keysOf(collect(STAMPER))).toEqual([...STAMPER_LEDGER].sort());
  });

  it('only the recorded sites write a provenance key as an object key', () => {
    expect(keysOf(collect(PROVENANCE_KEY_WRITE))).toEqual([...PROVENANCE_KEY_WRITE_LEDGER].sort());
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
  ])('flags a provenance key written as an object key: %s', (src) => {
    expect(sitesIn('x.ts', fixture(src), PROVENANCE_KEY_WRITE).map((s) => s.key)).toEqual([
      'x.ts#persist',
    ]);
  });

  it('does not flag a provenance key read', () => {
    const text = fixture('function read(m) { return m[BLOCK_PUBLISHED_APP_ID_META_KEY]; }');
    expect(sitesIn('x.ts', text, PROVENANCE_KEY_WRITE)).toEqual([]);
  });

  it.each<[Decision, string, string]>([
    ['no-metadata', '{ data: { url, metadata: input.metadata } }', 'now writes metadata'],
    ['no-metadata', '{ data: { ...input } }', 'now spreads a value into the row'],
    ['in-function-strip', '{ data: { ...image, meta } }', 'spreads input without overriding'],
    [
      'server-literal',
      '{ data: { metadata: { [BLOCK_PUBLISHED_APP_ID_META_KEY]: id } } }',
      'provenance',
    ],
  ])('rejects a %s site that drifted: %s', (decision, region, reason) => {
    expect(checkDecision(decision, { key: 'x', region, body: '' })).toContain(reason);
  });
});
