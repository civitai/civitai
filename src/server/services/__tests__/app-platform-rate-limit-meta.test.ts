import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every App Platform 429 carries the house `rateLimit` meta.
 *
 * THE POPULATION is every non-test source file under `APP_PLATFORM_PATHS` (path prefixes; widen
 * the list to widen the check, down to `'src/'`). In those files an AST walk finds every place
 * that SPELLS a rate-limited refusal: the number `429` or the string `'TOO_MANY_REQUESTS'`. A
 * comment or a string that merely contains those characters is not such a node, so neither counts.
 *
 * THE RULE, PER SPELLING: it is not an emission (a comparison `=== 429`, a `case`, a type, or a
 * field of the refusal recorder's own call); or it is METERED — the 429 and its meta are built in
 * ONE expression: the spelling is a property of an object literal, or an argument of a call, and
 * a sibling property or argument holds the meta (a call of one of `META_BUILDERS`, or a property
 * named `rateLimit`); or it is a reviewed exemption in `EXEMPT` with its reason. Every refusal
 * outside the helper module goes through a helper call (`throwAppRateLimited`,
 * `sendAppRateLimited`, …), which spells no 429 at all. Anything else fails, naming the file, the
 * function and the spelling. Also failing: a call of a helper that builds a meta with no
 * `id`/`kind` (`ID_LESS_BUILDERS`), and a `withInFlightLimit` call whose options carry no
 * `refusalMeta`.
 *
 * WHAT IT CANNOT SEE: a 429 whose status or code arrives in a variable from outside these files
 * (a shared helper that throws its own bare TOO_MANY_REQUESTS, or a status forwarded from
 * upstream), and whether a sibling's meta names the right id. The behavioural suites pin the meta
 * per surface.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** The App Platform: every file whose path starts with one of these. */
export const APP_PLATFORM_PATHS = [
  'src/server/routers/blocks.router.ts',
  'src/server/routers/app-',
  'src/server/routers/apps',
  'src/server/routers/block-image-',
  'src/server/routers/remix-app.router.ts',
  'src/server/services/blocks/',
  'src/server/services/apps/',
  'src/server/services/app-',
  'src/server/services/block-',
  'src/server/utils/block-',
  'src/server/utils/blocks-',
  'src/server/utils/app-',
  'src/server/utils/apps-',
  'src/server/utils/shared-storage-rate-limit.ts',
  'src/server/middleware/block-scope.middleware.ts',
  'src/pages/api/v1/blocks/',
  'src/pages/api/v1/block-tokens/',
  'src/pages/api/v1/apps/',
  'src/pages/api/v1/catalog/',
  'src/pages/api/blocks/',
  'src/pages/api/apps/',
  'src/pages/api/internal/blocks/',
  'src/pages/api/internal/app-',
];

/** The helper module itself: it is where the meta and the 429 are put together. */
const HELPER_MODULE = 'src/server/utils/app-rate-limit.ts';

/** A function that calls one of these builds the refusal's meta. */
const META_BUILDERS = new Set([
  'appRateLimitMeta',
  'throwAppRateLimited',
  'sendAppRateLimited',
  'appRateLimitBody',
  'rateLimitedTrpcError',
  'throwRateLimited',
]);

/** Build a meta with no `id` or `kind`; an App Platform refusal uses `appRateLimitMeta`. */
const ID_LESS_BUILDERS = new Set(['throwSharedRateLimited', 'rateLimitMetaFor']);

/** The refusal recorder: a `status: 429` among its arguments is a metric field, not a reply. */
const RECORDERS = new Set([
  'recordAppBlockRateLimitRefusal',
  'recordBlockClaimsRateLimitRefusal',
  'recordBridgeRateLimitRefusal',
]);

/**
 * Reviewed spellings that are not a 429 without meta, keyed `file :: function :: spelling`.
 * Closing condition for each: the PR that removes the spelling (the entry then fails as stale).
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'src/server/services/apps/doc-store-api.ts :: <module> :: 429':
    "The document store's code-to-status table. `sendError` attaches the meta to every `rate_limited` reply (pinned by the doc-store REST tests).",
  'src/server/services/blocks/dev-tunnel-access.service.ts :: <module> :: 429':
    "The dev-tunnel refusal code-to-status table. A TOO_MANY_REQUESTS refusal's type requires its meta, which `devTunnelRefusalAnswer` sends.",
  'src/server/services/blocks/pass-through-quote-failure.ts :: <module> :: 429':
    "Classifies an UPSTREAM provider's status (which failures are the viewer's); it never answers one.",
  'src/server/services/blocks/rate-limit-refusal.service.ts :: recordBridgeRateLimitRefusal :: 429':
    'The refusal recorder: the status it logs when a caller names none (a parameter default).',
  'src/pages/api/v1/blocks/images.ts :: handler :: 429':
    "A paging bound, not a rate limit: a page past 1000 items is refused whatever the wait, mirroring the public images endpoint's status. No retry can succeed, so it names no retry time.",
};

function appPlatformFiles(): string[] {
  const out: string[] = [];
  const walkDir = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walkDir(rel);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        if (APP_PLATFORM_PATHS.some((p) => rel.startsWith(p)) && rel !== HELPER_MODULE)
          out.push(rel);
      }
    }
  };
  walkDir('src');
  return out.sort();
}

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

function calleeName(call: ts.CallExpression): string | null {
  const t = call.expression;
  if (ts.isIdentifier(t)) return t.text;
  if (ts.isPropertyAccessExpression(t)) return t.name.text;
  return null;
}

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n);

function enclosingFunction(n: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
  return null;
}

/** The function's own name, its variable's, or its property's; `<module>` at the top level. */
function functionName(fn: ts.FunctionLikeDeclaration | null): string {
  if (!fn) return '<module>';
  for (let n: ts.Node | undefined = fn; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name)
      return n.name.getText();
    if (ts.isFunctionExpression(n) && n.name) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (ts.isPropertyAssignment(n)) return n.name.getText();
  }
  return '<anonymous>';
}

/** Whether `node` holds a meta: a meta builder's call, or a `rateLimit` property. */
function holdsMeta(node: ts.Node): boolean {
  let found = false;
  walk(node, (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && META_BUILDERS.has(calleeName(n) ?? '')) found = true;
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      n.name.getText() === 'rateLimit'
    )
      found = true;
  });
  return found;
}

/** Whether the spelling's own object literal or argument list holds its meta beside it. */
function isMetered(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const object = parent.parent;
    return (
      ts.isObjectLiteralExpression(object) &&
      object.properties.some((p) => p !== parent && holdsMeta(p))
    );
  }
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments) {
    const args = parent.arguments;
    return args.includes(node as ts.Expression) && args.some((a) => a !== node && holdsMeta(a));
  }
  return false;
}

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** A spelling that reads or types a 429 rather than answering one. */
function isNotAnEmission(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return true;
  if (ts.isCaseClause(parent) && parent.expression === node) return true;
  for (let p: ts.Node | undefined = parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return true;
    if (ts.isCallExpression(p) && RECORDERS.has(calleeName(p) ?? '')) return true;
    if (isFunctionLike(p) || ts.isSourceFile(p)) break;
  }
  return false;
}

export type Violation = { file: string; fn: string; what: string; line: number };

/** Every unmetered 429 spelling, id-less meta builder and meta-less in-flight limit in a file. */
export function classifyFile(file: string, text: string): Violation[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const out: Violation[] = [];
  const at = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  walk(source, (n) => {
    const spelling =
      ts.isNumericLiteral(n) && n.text === '429'
        ? '429'
        : ts.isStringLiteralLike(n) && n.text === 'TOO_MANY_REQUESTS'
        ? 'TOO_MANY_REQUESTS'
        : null;
    if (spelling) {
      if (isNotAnEmission(n) || isMetered(n)) return;
      out.push({ file, fn: functionName(enclosingFunction(n)), what: spelling, line: at(n) });
      return;
    }
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n) ?? '';
    if (ID_LESS_BUILDERS.has(name)) {
      out.push({ file, fn: functionName(enclosingFunction(n)), what: name, line: at(n) });
    }
    if (name === 'withInFlightLimit') {
      const options = n.arguments[0];
      const hasMeta =
        !!options &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (p) =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            p.name.getText() === 'refusalMeta'
        );
      if (!hasMeta) {
        out.push({
          file,
          fn: functionName(enclosingFunction(n)),
          what: 'withInFlightLimit without refusalMeta',
          line: at(n),
        });
      }
    }
  });
  return out;
}

const keyOf = (v: Violation) => `${v.file} :: ${v.fn} :: ${v.what}`;

function allViolations(override?: { file: string; text: string }): Violation[] {
  return appPlatformFiles().flatMap((f) =>
    classifyFile(f, override && override.file === f ? override.text : read(f))
  );
}

const FILES = appPlatformFiles();
const VIOLATIONS = allViolations();

describe('the App Platform population', () => {
  it('MAGNITUDE CONTROL — the walk reads the files it claims to cover', () => {
    expect(FILES.length).toBeGreaterThan(300);
    for (const f of [
      'src/server/routers/blocks.router.ts',
      'src/server/routers/app-listings.router.ts',
      'src/pages/api/v1/block-tokens/index.ts',
      'src/pages/api/v1/blocks/tip.ts',
      'src/pages/api/v1/blocks/goods/purchase.ts',
      'src/server/services/apps/doc-store-api.ts',
      'src/server/services/blocks/app-fork-start.service.ts',
    ]) {
      expect(FILES, f).toContain(f);
    }
  });

  it('every path prefix still names a file (a prefix that outlived its files fails)', () => {
    for (const prefix of APP_PLATFORM_PATHS) {
      expect(
        FILES.some((f) => f.startsWith(prefix)),
        prefix
      ).toBe(true);
    }
  });
});

describe('every App Platform 429 carries the rateLimit meta', () => {
  it('nothing spells a 429 without the meta except what EXEMPT names (and every one of those exists)', () => {
    const found = VIOLATIONS.map(keyOf);
    const unexempt = VIOLATIONS.filter((v) => !(keyOf(v) in EXEMPT)).map(
      (v) => `${keyOf(v)} (line ${v.line})`
    );
    expect(unexempt).toEqual([]);
    expect([...new Set(found)].sort()).toEqual(Object.keys(EXEMPT).sort());
  });
});

describe('the classifier can go red', () => {
  const FIXTURE = 'src/server/routers/fixture.router.ts';
  const verdict = (body: string) => classifyFile(FIXTURE, body).map((v) => v.what);

  it('POSITIVE CONTROL — a bare TOO_MANY_REQUESTS throw is caught', () => {
    expect(
      verdict(`function refuse() {
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'slow down' });
      }`)
    ).toEqual(['TOO_MANY_REQUESTS']);
  });

  it('POSITIVE CONTROL — a bare REST 429 is caught', () => {
    expect(
      verdict(`const handler = (res) => {
        res.setHeader('Retry-After', '5');
        res.status(429).json({ error: 'Rate limit exceeded' });
      };`)
    ).toEqual(['429']);
  });

  it('POSITIVE CONTROL — a meta with no id, and an in-flight limit with no meta, are caught', () => {
    expect(
      verdict(`async function a(rl) { throwSharedRateLimited(rl, 'x'); }
        async function b(user) { return withInFlightLimit({ ...POOL, userId: user.id }, run); }`)
    ).toEqual(['throwSharedRateLimited', 'withInFlightLimit without refusalMeta']);
  });

  it('NEGATIVE CONTROL — the same refusals through the helpers, and reads of a 429, pass', () => {
    expect(
      verdict(`function refuse(rate) {
        throwAppRateLimited('apps.catalog', rate.retryAfterSeconds);
      }
      function send(res, rate) {
        const meta = appRateLimitMeta('apps.tip-rate', rate.retryAfterSeconds);
        return { status: 429, body: appRateLimitBody(meta, 'Too many tips') };
      }
      function read(err) {
        if (err.status === 429) return true;
        switch (err.code) { case 'TOO_MANY_REQUESTS': return true; }
        recordBridgeRateLimitRefusal('p', 'catalog', claims, 5, 429);
      }
      type Code = 'TOO_MANY_REQUESTS';
      async function b(user) {
        return withInFlightLimit({ ...POOL, userId: user.id, refusalMeta: () => meta }, run);
      }`)
    ).toEqual([]);
  });

  it('POSITIVE CONTROL — a meta built elsewhere in the function does not meter a bare 429', () => {
    expect(
      verdict(`function handler(res, rate) {
        sendAppRateLimited(res, appRateLimitMeta('apps.catalog', rate.retryAfterSeconds), 'x');
        res.status(429).json({ error: 'too many pages' });
      }`)
    ).toEqual(['429']);
  });

  it('NEGATIVE CONTROL — a comment or a string containing the characters is not a spelling', () => {
    expect(
      verdict(`// throw new TRPCError({ code: 'TOO_MANY_REQUESTS' }) answers 429
        const note = 'a 429 TOO_MANY_REQUESTS here';`)
    ).toEqual([]);
  });

  it('POSITIVE CONTROL ON THE REAL TREE — reverting one bridge refusal to a bare throw fails', () => {
    const file = 'src/server/routers/blocks.router.ts';
    const text = read(file);
    const site =
      /recordBridgeRateLimitRefusal\('getImagesByIds', 'catalog', claims, rate\.retryAfterSeconds\);\s*throwAppRateLimited\('apps\.catalog', rate\.retryAfterSeconds\);/;
    expect(site.test(text), 'getImagesByIds no longer refuses the way this control expects').toBe(
      true
    );
    const reverted = text.replace(
      site,
      `recordBridgeRateLimitRefusal('getImagesByIds', 'catalog', claims, rate.retryAfterSeconds);
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded' });`
    );
    const keys = allViolations({ file, text: reverted }).map(keyOf);
    expect(keys).toContain(`${file} :: getImagesByIds :: TOO_MANY_REQUESTS`);
  });
});
