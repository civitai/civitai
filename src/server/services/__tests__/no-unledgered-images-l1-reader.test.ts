import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Who may read `images-for-model-version-2` (imagesForModelVersionsCache) through this process's
 * L1. A moderation removal, delete or re-rate refreshes the Redis entry, but another process keeps
 * its L1 copy until it expires, so an L1 read can return an image that has been taken down. Reads
 * skip the L1 unless a call passes `allowLocal: true`, and only callers that never show what they
 * read as-is may do that. This pins that set: it fails when a reader is added and when one goes.
 *
 * Scanned as calls in the parse, not as text: every reference to the cache must be a `.fetch`,
 * `.refresh` or `.bust` call on it, every `.fetch` must pass its options as an object literal with
 * `allowLocal` absent or a literal boolean, and the unexported store behind the wrapper may only be
 * referenced by the wrapper. Anything else (an alias, a renamed import or destructure, options
 * passed through a variable) is reported as an escape. A `.svelte` file is not scanned.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'scripts', 'packages', 'apps'];
const CACHE = 'imagesForModelVersionsCache';
const STORE = 'imagesForModelVersionsStore';
const DEFINING_FILE = 'src/server/services/image.service.ts';

/**
 * Each entry is `<file>#<enclosing function>`, and the reason it may read a value up to the L1 TTL
 * old.
 */
const L1_READERS: Record<string, string> = {
  // Prioritised-user gallery: the cached entry supplies candidate ids only, and the image query
  // that follows re-reads each row with the viewer's block, publish and level filters.
  'src/server/services/image.service.ts#getAllImagesUncaptured': 'ids re-filtered by the DB query',
};

type Scan = { readers: string[]; escapes: string[] };

function parse(rel: string, source: string) {
  return ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function ownerOf(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (
      ts.isVariableDeclaration(cur) &&
      ts.isIdentifier(cur.name) &&
      cur.initializer &&
      (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))
    )
      return cur.name.text;
  }
  return '<module>';
}

function isWithinWrapper(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      if (cur.name.text === CACHE) return true;
    }
  }
  return false;
}

/** `allowLocal` of a `.fetch(ids, options)` call: false, true, or null when not decidable. */
function allowLocalOf(call: ts.CallExpression): boolean | null {
  const options = call.arguments[1];
  if (call.arguments.length > 2) return null;
  if (!options) return false;
  if (!ts.isObjectLiteralExpression(options)) return null;
  let allow = false;
  for (const prop of options.properties) {
    if (!ts.isPropertyAssignment(prop)) return null;
    const name =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (name === null) return null;
    if (name !== 'allowLocal') continue;
    if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) allow = true;
    else if (prop.initializer.kind !== ts.SyntaxKind.FalseKeyword) return null;
  }
  return allow;
}

function scanSource(rel: string, source: string): Scan {
  const sf = parse(rel, source);
  const readers: string[] = [];
  const escapes: string[] = [];
  const at = (node: ts.Node) =>
    `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.getText()}`;

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === STORE) {
      const parent = node.parent;
      const isOwnDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
      if (rel !== DEFINING_FILE || !(isOwnDeclaration || isWithinWrapper(node)))
        escapes.push(at(parent));
    } else if (ts.isIdentifier(node) && node.text === CACHE) {
      const parent = node.parent;
      if (ts.isImportSpecifier(parent) || ts.isBindingElement(parent)) {
        if (parent.propertyName) escapes.push(at(parent));
      } else if (ts.isVariableDeclaration(parent) && parent.name === node) {
        if (rel !== DEFINING_FILE) escapes.push(at(parent));
      } else if (ts.isExportSpecifier(parent)) {
        escapes.push(at(parent));
      } else {
        // `ns.imagesForModelVersionsCache` is the cache expression too.
        const expr = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
        const access = expr.parent;
        const call = access?.parent;
        if (
          access &&
          ts.isPropertyAccessExpression(access) &&
          access.expression === expr &&
          ['fetch', 'refresh', 'bust'].includes(access.name.text) &&
          call &&
          ts.isCallExpression(call) &&
          call.expression === access
        ) {
          if (access.name.text === 'fetch') {
            const allow = allowLocalOf(call);
            if (allow === null) escapes.push(at(call));
            else if (allow) readers.push(`${rel}#${ownerOf(call)}`);
          }
        } else {
          escapes.push(at(expr.parent ?? expr));
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return { readers, escapes };
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['__tests__', 'node_modules', 'dist', 'build', '.next'].includes(entry.name))
        walk(full, out);
    } else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function scanRepo() {
  const readers: string[] = [];
  const escapes: string[] = [];
  let swept = 0;
  for (const root of ROOTS) {
    for (const abs of walk(path.join(REPO_ROOT, root))) {
      swept++;
      const source = fs.readFileSync(abs, 'utf8');
      if (!source.includes(CACHE) && !source.includes(STORE)) continue;
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      const scan = scanSource(rel, source);
      readers.push(...scan.readers);
      escapes.push(...scan.escapes);
    }
  }
  return { readers, escapes, swept };
}

describe('no-unledgered-images-l1-reader', () => {
  it('only the ledgered callers read imagesForModelVersionsCache through the L1', () => {
    const { readers, escapes, swept } = scanRepo();
    expect(swept).toBeGreaterThan(1000);
    expect(escapes, 'references the scan cannot classify').toEqual([]);
    expect([...new Set(readers)].sort()).toEqual(Object.keys(L1_READERS).sort());
  });

  describe('POSITIVE CONTROL: the scan sees each shape', () => {
    const scan = (body: string) => scanSource('fixture.ts', body);

    it('an allowLocal: true fetch is a reader, named by its enclosing function', () => {
      expect(
        scan(`async function readFeed(ids: number[]) {
          return imagesForModelVersionsCache.fetch(ids, { allowLocal: true });
        }
        const readArrow = async () => ns.imagesForModelVersionsCache.fetch([1], { allowLocal: true });`)
      ).toEqual({ readers: ['fixture.ts#readFeed', 'fixture.ts#readArrow'], escapes: [] });
    });

    it('a public fetch, refresh and bust are neither readers nor escapes', () => {
      expect(
        scan(`async function f(ids: number[]) {
          await imagesForModelVersionsCache.fetch(ids);
          await imagesForModelVersionsCache.fetch(ids, { allowLocal: false });
          await imagesForModelVersionsCache.refresh(ids);
          await imagesForModelVersionsCache.bust(ids);
        }`)
      ).toEqual({ readers: [], escapes: [] });
    });

    it.each([
      ['a non-literal allowLocal', 'imagesForModelVersionsCache.fetch(ids, { allowLocal: flag })'],
      ['options through a variable', 'imagesForModelVersionsCache.fetch(ids, opts)'],
      ['spread options', 'imagesForModelVersionsCache.fetch(ids, { ...opts })'],
      ['an alias', 'const c = imagesForModelVersionsCache;'],
      ['a detached method', 'const f = imagesForModelVersionsCache.fetch;'],
      ['a renamed import', "import { imagesForModelVersionsCache as c } from 'x';"],
      ['a renamed destructure', "const { imagesForModelVersionsCache: c } = await import('x');"],
      ['the store outside image.service', 'imagesForModelVersionsStore.fetch(ids);'],
    ])('%s is an escape', (_label, body) => {
      expect(scan(body).escapes).toHaveLength(1);
    });
  });
});
