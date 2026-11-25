import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * SEAM LEDGER for content levels (`doc-levels.ts`): every statement in the document store that
 * reads a document's body (`d.data`, or `docColumns`, which selects it) is either a READ PATH that
 * returns shared documents to someone other than their author — and then has a `_LEVELS` twin
 * that applies `sharedDocLevelVisible` — or is EXEMPT for a stated reason. The cases fail when a
 * statement that reads documents is added, removed or renamed without this ledger being changed,
 * when a twin stops applying the predicate, or when the store's body reads move outside
 * `doc-store.ts`. Static: it reads the source. The behaviour of each gated path is pinned by
 * `doc-store.levels.pglite.test.ts`.
 */

const SRC_ROOT = path.resolve(__dirname, '../../../..');
const STORE = path.resolve(__dirname, '../doc-store.ts');
const source = readFileSync(STORE, 'utf8');

/** `const SQL_X = …` up to the next top-level declaration, by name. */
function sqlConstants(text: string): Map<string, string> {
  const tops = [...text.matchAll(/^(?:const|function|export|async|type|let|class|interface)\b/gm)]
    .map((m) => m.index ?? 0)
    .sort((a, b) => a - b);
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^const (SQL_\w+)\s*=/gm)) {
    const start = m.index ?? 0;
    const end = tops.find((t) => t > start) ?? text.length;
    out.set(m[1], text.slice(start, end));
  }
  return out;
}

/** The body of `async function <name>(` up to the next function at the same indentation. */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`  async function ${name}(`);
  if (start < 0) return '';
  const next = text.slice(start + 1).search(/\n {2}(?:async )?function /);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

const PREDICATE = 'sharedDocLevelVisible(';
const READS_BODY = /\bd\.data\b|docColumns\(|LEVEL_STREAM_COLUMNS\b/;

/** Read paths to other viewers: each has a `_LEVELS` twin that applies the predicate. */
const GATED = ['SQL_FEED_DOCS_ALL', 'SQL_FEED_DOCS_SINCE', 'SQL_GET_MANY'];
/** Statements that read a body but never return a shared document to another viewer. */
const EXEMPT: Record<string, string> = {
  SQL_STAMP_SEQ: "the write's response: the writer's own document",
  SQL_STAMP_SEQ_MAJOR: "the write's response: the writer's own document",
  SQL_STAMP_SEQ_LEVELS: "the write's response, with its rating: the writer's own document",
  SQL_STAMP_SEQ_MAJOR_LEVELS: "the write's response, with its rating: the writer's own document",
  SQL_UNCHANGED_PROBE:
    "an unchanged put's read: returned only when the caller authored it (classifyPublish)",
  SQL_UNCHANGED_PROBE_LEVELS:
    "an unchanged put's read, with its rating: returned only when the caller authored it",
  SQL_UNCHANGED_PROBE_TAIL:
    "the unchanged put's probe columns (content hashes, index-row comparison), never a body",
  SQL_MIGRATE_LOCK_DOC: 'a schema migration rewriting the body server-side; returns nothing',
  SQL_MOD_GET: 'the moderator tooling: moderators see every document',
  SQL_RATER_UNRATED: 'the rater: read server-side to be rated, never returned to a viewer',
  SQL_RATER_GET: 'the rater: one document read server-side to be rated, never returned to a viewer',
  SQL_PUBLISH_SOURCES:
    "server-side publish: the CALLER'S OWN private documents, copied server-side, never returned",
  SQL_PUBLISH_TARGETS:
    'server-side publish: only a content hash and the author of each shared copy, never a body',
  SQL_PUBLISH_LOCK_OWN_TARGETS:
    "server-side publish: the content hash of the caller's own copies, locked, never a body",
  SQL_VIEWER_RECORDS:
    "the record export: only the CALLER'S OWN documents (private, and visible shared ones they created), returned to that caller",
  SQL_PURGE_LOCK_DOCS:
    "the per-collection purge's dump: moderator maintenance, stored beside the delete, never returned to an app",
  SQL_PRIVATE_FEED_DOCS:
    "the registry private stream: one user's OWN private documents (never a shared one), streamed only to that user's token",
  SQL_VIEWER_FEED_DOCS:
    "the registry per-viewer stream: one user's OWN shared documents, through the predicate's author arm at the token's domain ceiling, streamed only to that user's token",
};

/**
 * The registry LEVEL STREAMS' reads (`registry-adapter/level-feed.ts`), one per selector. A `_BIT`
 * statement serves one level bit and must apply the predicate (through `LEVEL_ON_BIT`); a `_NONE`
 * one is every visible document, which the level feed serves only while content levels are OFF
 * for the app.
 */
const LEVEL_STREAMS = ['SQL_LEVEL_DOCS_SINCE', 'SQL_LEVEL_DOCS_DESC'];
const LEVEL_SELECTORS = ['_BIT', '_NONE'];

describe('content-level seam ledger', () => {
  const consts = sqlConstants(source);

  it('positive control: the scan finds the store’s statements and their bodies', () => {
    expect(consts.size).toBeGreaterThan(40);
    expect(consts.get('SQL_GET_MANY')).toMatch(/FROM appdata\.doc d/);
  });

  it('every statement that reads a document body is gated or exempt, and the set is exactly this', () => {
    const reading = [...consts].filter(([, body]) => READS_BODY.test(body)).map(([name]) => name);
    const twins = GATED.map((n) => `${n}_LEVELS`);
    const levelStreams = LEVEL_STREAMS.flatMap((n) => LEVEL_SELECTORS.map((sel) => `${n}${sel}`));
    expect(reading.sort()).toEqual(
      [...GATED, ...twins, ...levelStreams, ...Object.keys(EXEMPT)].sort()
    );
  });

  it.each(LEVEL_STREAMS)('%s_BIT applies the predicate at its one bit; _NONE does not', (name) => {
    // LEVEL_ON_BIT is the predicate with no viewer, so the author arm never applies.
    const onBit = /^const LEVEL_ON_BIT = [\s\S]*?;$/m.exec(source)?.[0] ?? '';
    expect(onBit).toContain(PREDICATE);
    expect(onBit).toContain("'NULL::int'");
    expect(consts.get(`${name}_BIT`)).toContain('LEVEL_ON_BIT(');
    expect(consts.get(`${name}_NONE`)).not.toContain(PREDICATE);
    expect(consts.get(`${name}_NONE`)).not.toContain('LEVEL_ON_BIT(');
  });

  it.each(GATED)('%s has a _LEVELS twin that applies the predicate', (name) => {
    expect(consts.get(name)).not.toContain(PREDICATE);
    expect(consts.get(`${name}_LEVELS`)).toContain(PREDICATE);
  });

  it('the server key lookup has a twin that returns the rating and stays level-blind', () => {
    // Its callers decide on the rating themselves: App Store publishing refuses an unrated item
    // and copies the level onto the card; spend attribution ignores levels.
    expect(consts.get('SQL_LOOKUP_SHARED_KEY')).not.toContain(PREDICATE);
    expect(consts.get('SQL_LOOKUP_SHARED_KEY_LEVELS')).not.toContain(PREDICATE);
    expect(consts.get('SQL_LOOKUP_SHARED_KEY_LEVELS')).toContain('RATING_COLUMNS');
  });

  it('list, the one statement built at run time, applies the predicate when levels are on', () => {
    const list = functionBody(source, 'list');
    expect(list).toMatch(/docColumns\(viewerParam/);
    expect(list).toMatch(/if \(ctx\.levels\) \{\s*conds\.push\(\s*sharedDocLevelVisible\(/);
  });

  it('every docColumns call is a ledgered statement or list', () => {
    const calls = source.match(/docColumns\(/g) ?? [];
    // The definition, list, and each ledgered statement that selects through it.
    const inConsts = [...consts.values()].reduce(
      (n, body) => n + (body.match(/docColumns\(/g)?.length ?? 0),
      0
    );
    expect(calls.length).toBe(inConsts + 2);
  });

  it('each gated read path sends its twin when the context carries levels', () => {
    const pairs: Array<[fn: string, plain: string]> = [
      ['getMany', 'SQL_GET_MANY'],
      ['feedChanges', 'SQL_FEED_DOCS_SINCE'],
      ['feedDocuments', 'SQL_FEED_DOCS_ALL'],
      ['findSharedByKey', 'SQL_LOOKUP_SHARED_KEY'],
    ];
    for (const [fn, plain] of pairs) {
      const body = functionBody(source, fn);
      expect(body, fn).toContain(`${plain}_LEVELS`);
      expect(body, fn).toMatch(new RegExp(`\\b${plain}\\b(?!_)`));
    }
  });

  it('no file outside the store reads a document body from the doc table', () => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.') || name === '__tests__') continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
          const text = readFileSync(full, 'utf8');
          if (/appdata\.doc\b/.test(text) && /\bd\.data\b/.test(text)) {
            out.push(path.relative(SRC_ROOT, full).split(path.sep).join('/'));
          }
        }
      }
    };
    walk(SRC_ROOT);
    expect(out).toEqual(['server/services/apps/doc-store.ts']);
  });
});
