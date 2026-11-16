import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every App Blocks limiter refusal must be COUNTED, per app, by the one recorder
 * (`services/blocks/rate-limit-refusal.service.ts` → `civitai_app_block_rate_limit_refusals_total`).
 *
 * THE POPULATION IS DERIVED, NOT LISTED. The limiter primitives are the `check*RateLimit` /
 * `reserveSharedWrite` exports of the four App Blocks limiter modules, read from their source and
 * pinned as a SET (`PRIMITIVE_BUCKETS`), so a new primitive fails here until someone decides its
 * bucket. Every CALL of a primitive anywhere in `src` (tests excluded) is then found by an AST
 * walk — a comment or a string is never a `CallExpression`, so neither can satisfy it.
 *
 * THE RULE, PER CALL SITE (`classify`): the call's result is bound to a variable `v`, and an
 * `if (!v.allowed)` in the same function calls a recorder whose arguments NAME the primitive's
 * bucket (a string literal from `PRIMITIVE_BUCKETS`). Each recorder call satisfies one site only,
 * so two limiter calls in one function need two recorders. The two other accepted shapes:
 *   - `viewer-middleware`: the primitive is returned by a `check:` arrow beside a literal `bucket:`
 *     in the options object `authorizeBlockBridgeViewer` takes; that middleware records on its
 *     refusal branch (asserted below).
 *   - `UNRECORDED`: a call site this file names, with the reason it is not attributed per app.
 * Anything else is a FAILURE that names the file, function and primitive.
 *
 * WHAT IT CANNOT SEE: a limiter that is not one of these primitives (a new limiter module, or an
 * inline Redis counter) — the primitive set is the boundary; and whether a recorder runs on every
 * path to the refusal's `throw`/`return` (it checks the recorder is inside the refusal `if`, not
 * that nothing before it returns early). The behavioural suites cover the paths for each surface.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const parse = (rel: string, text = read(rel)) =>
  ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

const LIMITER_MODULES = [
  'src/server/utils/block-catalog-rate-limit.ts',
  'src/server/utils/shared-storage-rate-limit.ts',
  'src/server/utils/block-tip-rate-limit.ts',
  'src/server/utils/block-goods-rate-limit.ts',
];
const PRIMITIVE_NAME = /^(check\w*RateLimit|reserveSharedWrite)$/;

/** `checkDocStoreRateLimit` is charged with `charge()`'s own `bucket` parameter. */
const BUCKET_PARAM = '<bucket parameter>';

/** Each primitive → the bucket label(s) its recorder must name. */
const PRIMITIVE_BUCKETS: Readonly<Record<string, readonly string[]>> = {
  checkBlockCatalogRateLimit: ['catalog'],
  checkBlockPublishRateLimit: ['publish'],
  checkBlockPostRateLimit: ['post'],
  checkBlockPostAppRateLimit: ['post-app'],
  checkBlockPollRateLimit: ['poll'],
  checkBlockUploadAppRateLimit: ['upload-app'],
  checkBlockGenerationSourceUserRateLimit: ['gen-source-user'],
  checkBlockUploadedGenerationSourceUserRateLimit: ['uploaded-gen-source-user'],
  checkBlockEstimateCellsRateLimit: ['estimate-cells'],
  checkBlockLLMRateLimit: ['llm'],
  checkBlockSubmitRateLimit: ['submit'],
  checkBlockSubmitUserRateLimit: ['submit-user'],
  checkDocStoreRateLimit: [BUCKET_PARAM],
  checkSubListingWriteRateLimit: ['sub-listing-write'],
  checkSubListingSyncRateLimit: ['sub-listing-sync'],
  // The document store's two budgets (its legacy shared-KV caller is in UNRECORDED).
  reserveSharedWrite: ['shared-write', 'publish'],
  checkBlockTipRateLimit: ['tip'],
  checkBlockGoodRateLimit: ['goods'],
  checkBlockGoodReadRateLimit: ['goods-read'],
};

/** The functions that count a refusal (or build the error a choke point counts). */
const RECORDERS = new Set([
  'recordBridgeRateLimitRefusal',
  'recordBlockClaimsRateLimitRefusal',
  'recordAppBlockRateLimitRefusal',
  // doc-store-api.ts: build the refusal whose bucket `sendError` records (asserted below).
  'rateLimited',
]);

/**
 * Primitives of the limiter modules that are OUT of the population, with why. They belong to the
 * legacy shared-KV store (apps-shared.router.ts), which is removed: fail-closed, and gated ahead
 * of these limiters, so none of them can refuse a request. Closing condition: the PR that deletes
 * them from shared-storage-rate-limit.ts (this list then names a primitive that no longer exists,
 * and the pinned-set assertion fails until the entry is removed).
 */
const EXCLUDED_PRIMITIVES: Readonly<Record<string, string>> = {
  checkSharedVoteRateLimit: 'legacy shared-KV store, removed and gated before its limiter',
  checkSharedWithdrawRateLimit: 'legacy shared-KV store, removed and gated before its limiter',
  checkSharedReportRateLimit: 'legacy shared-KV store, removed and gated before its limiter',
};

/**
 * Call sites deliberately NOT attributed per app, keyed `file :: function :: primitive`.
 * Closing condition for each: a PR that records it (this entry then fails as stale) or deletes it.
 */
const UNRECORDED: Readonly<Record<string, string>> = {
  'src/server/routers/apps-shared.router.ts :: withSharedWriteBudget :: reserveSharedWrite':
    'The legacy shared-KV write budget: that store is removed (fail-closed, gated before this limiter), so it cannot refuse a request.',
  'src/server/services/blocks/app-sub-listing.service.ts :: upsertCatalogSubListing :: checkSubListingSyncRateLimit':
    'An OFF-SITE parent platform syncing its catalog through /api/v1/catalog/items: no App Block and no app_block_id, keyed per parent listing. Not an App Blocks runtime limit.',
  'src/server/services/blocks/app-sub-listing.service.ts :: withdrawCatalogSubListing :: checkSubListingSyncRateLimit':
    'The same off-site catalog sync bucket, on the platform DELETE.',
  'src/server/services/blocks/app-sub-listing.service.ts :: withdrawMyCatalogSubListing :: checkSubListingWriteRateLimit':
    'A creator withdrawing their OFF-SITE catalog item: keyed per off-site parent listing, which has no app_block_id.',
};

/** Every non-test source file under `src`. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || rel === 'src/tests') {
          continue;
        }
        walk(rel);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  walk('src');
  return out;
}

function calleeName(call: ts.CallExpression): string | null {
  const t = call.expression;
  if (ts.isIdentifier(t)) return t.text;
  if (ts.isPropertyAccessExpression(t)) return t.name.text;
  return null;
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n)
  );
}

function enclosingFunction(n: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
  return null;
}

/** A readable name for a function: its own, its variable's, or its property's; else `<anonymous>`. */
function functionName(fn: ts.FunctionLikeDeclaration | null): string {
  for (let n: ts.Node | undefined = fn ?? undefined; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      return n.name.getText();
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (ts.isPropertyAssignment(n) && n !== fn?.parent) {
      // A procedure in a router object literal: `name: publicProcedure…mutation(async () => …)`.
      return n.name.getText();
    }
  }
  return '<anonymous>';
}

/** The variable a primitive's awaited result is bound to (`const v = await primitive(…)`). */
function boundVariable(call: ts.CallExpression): string | null {
  let n: ts.Node = call.parent;
  if (ts.isAwaitExpression(n)) n = n.parent;
  if (ts.isParenthesizedExpression(n)) n = n.parent;
  return ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) ? n.name.text : null;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

/** `!v.allowed` */
function isRefusalTest(expr: ts.Expression, v: string): boolean {
  return (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPropertyAccessExpression(expr.operand) &&
    expr.operand.name.text === 'allowed' &&
    ts.isIdentifier(expr.operand.expression) &&
    expr.operand.expression.text === v
  );
}

/** Whether a recorder call's arguments name one of `buckets`. */
function namesBucket(call: ts.CallExpression, buckets: readonly string[]): boolean {
  let hit = false;
  for (const arg of call.arguments) {
    walk(arg, (n) => {
      if (ts.isStringLiteralLike(n) && buckets.includes(n.text)) hit = true;
      if (buckets.includes(BUCKET_PARAM) && ts.isIdentifier(n) && n.text === 'bucket') hit = true;
    });
  }
  return hit;
}

type Site = { file: string; fn: string; primitive: string; verdict: string };

/** Classify every primitive call in one file's text. */
function classifyFile(file: string, text: string, primitives: ReadonlySet<string>): Site[] {
  const source = parse(file, text);
  const sites: Site[] = [];
  const usedRecorders = new Set<ts.CallExpression>();
  walk(source, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n);
    if (!name || !primitives.has(name)) return;
    const fn = enclosingFunction(n);
    const site = { file, fn: functionName(fn), primitive: name };
    const buckets = PRIMITIVE_BUCKETS[name] ?? [];

    // viewer-middleware: `check: (…) => primitive(…)` beside `bucket: '<literal>'`.
    if (fn && ts.isArrowFunction(fn) && ts.isPropertyAssignment(fn.parent)) {
      const prop = fn.parent;
      const obj = prop.parent;
      if (prop.name.getText() === 'check' && ts.isObjectLiteralExpression(obj)) {
        const bucket = obj.properties.find(
          (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) && p.name.getText() === 'bucket'
        );
        if (
          bucket &&
          ts.isStringLiteralLike(bucket.initializer) &&
          buckets.includes(bucket.initializer.text)
        ) {
          sites.push({ ...site, verdict: 'viewer-middleware' });
          return;
        }
      }
    }

    const v = boundVariable(n);
    let recorded = false;
    if (v && fn) {
      walk(fn, (m) => {
        if (recorded || !ts.isIfStatement(m) || !isRefusalTest(m.expression, v)) return;
        walk(m.thenStatement, (r) => {
          if (
            !recorded &&
            ts.isCallExpression(r) &&
            RECORDERS.has(calleeName(r) ?? '') &&
            !usedRecorders.has(r) &&
            namesBucket(r, buckets)
          ) {
            usedRecorders.add(r);
            recorded = true;
          }
        });
      });
    }
    sites.push({ ...site, verdict: recorded ? 'recorded' : 'UNRECORDED' });
  });
  return sites;
}

function derivePrimitives(): string[] {
  const names: string[] = [];
  for (const rel of LIMITER_MODULES) {
    for (const stmt of parse(rel).statements) {
      if (
        ts.isFunctionDeclaration(stmt) &&
        stmt.name &&
        PRIMITIVE_NAME.test(stmt.name.text) &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        names.push(stmt.name.text);
      }
    }
  }
  return names.sort();
}

const ALL_PRIMITIVES = derivePrimitives();
const PRIMITIVES = new Set(ALL_PRIMITIVES.filter((n) => !(n in EXCLUDED_PRIMITIVES)));
/**
 * A cheap TEXT prefilter before the AST walk: a file that does not spell any primitive name cannot
 * call one. It only skips files; every file it keeps is classified by the AST.
 */
const MENTIONS_PRIMITIVE = new RegExp(`\\b(${[...PRIMITIVES].join('|')})\\b`);
const keyOf = (s: Site) => `${s.file} :: ${s.fn} :: ${s.primitive}`;

function allSites(override?: { file: string; text: string }): Site[] {
  return sourceFiles()
    .filter((f) => !LIMITER_MODULES.includes(f))
    .flatMap((f) => {
      const text = override && override.file === f ? override.text : read(f);
      return MENTIONS_PRIMITIVE.test(text) ? classifyFile(f, text, PRIMITIVES) : [];
    });
}

const SITES = allSites();

describe('the App Blocks limiter population', () => {
  it('the primitive set is pinned: a new limiter primitive needs a bucket decision here', () => {
    expect(ALL_PRIMITIVES).toEqual(
      [...Object.keys(PRIMITIVE_BUCKETS), ...Object.keys(EXCLUDED_PRIMITIVES)].sort()
    );
    expect([...PRIMITIVES]).toEqual(Object.keys(PRIMITIVE_BUCKETS).sort());
  });

  it('MAGNITUDE CONTROL — the walk finds the call sites it claims to cover', () => {
    expect(SITES.length).toBeGreaterThan(45);
    const files = new Set(SITES.map((s) => s.file));
    for (const f of [
      'src/server/routers/blocks.router.ts',
      'src/server/routers/apps-shared.router.ts',
      'src/server/services/apps/doc-store-api.ts',
      'src/server/services/blocks/app-sub-listing.service.ts',
      'src/pages/api/v1/blocks/models.ts',
      'src/pages/api/v1/blocks/goods/purchase.ts',
    ]) {
      expect(files.has(f), `${f} has no limiter call the walk can see`).toBe(true);
    }
  });
});

/**
 * `withInFlightLimit` (`src/server/utils/in-flight-limit.ts`) is a limiter of a different shape:
 * it THROWS its own TOO_MANY_REQUESTS when a per-user pool is full, so there is no `allowed`
 * result to branch on. Its refusal is recorded through its `onFull` argument instead: every call
 * outside `IN_FLIGHT_EXCLUDED` must pass a third argument whose body calls a recorder naming the
 * `in-flight` bucket.
 */
const IN_FLIGHT_EXCLUDED: Readonly<Record<string, string>> = {
  'src/server/middleware.trpc.ts':
    'The site-wide tRPC `inFlightLimit` middleware: any procedure, keyed on the session user, no block token and no app. Not an App Blocks limiter.',
};

function inFlightSites(file: string, text: string): { file: string; recorded: boolean }[] {
  const out: { file: string; recorded: boolean }[] = [];
  walk(parse(file, text), (n) => {
    if (!ts.isCallExpression(n) || calleeName(n) !== 'withInFlightLimit') return;
    const onFull = n.arguments[2];
    let recorded = false;
    if (onFull) {
      walk(onFull, (r) => {
        if (
          ts.isCallExpression(r) &&
          RECORDERS.has(calleeName(r) ?? '') &&
          namesBucket(r, ['in-flight'])
        ) {
          recorded = true;
        }
      });
    }
    out.push({ file, recorded });
  });
  return out;
}

function allInFlightSites(override?: { file: string; text: string }) {
  return sourceFiles()
    .filter((f) => f !== 'src/server/utils/in-flight-limit.ts' && !(f in IN_FLIGHT_EXCLUDED))
    .flatMap((f) => {
      const text = override && override.file === f ? override.text : read(f);
      return text.includes('withInFlightLimit(') ? inFlightSites(f, text) : [];
    });
}

describe('withInFlightLimit refusals are recorded per app', () => {
  it('every App Blocks call passes an onFull that records the in-flight bucket', () => {
    const sites = allInFlightSites();
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.filter((s) => !s.recorded)).toEqual([]);
  });

  it('every excluded file still calls it (an exclusion that outlived its caller fails)', () => {
    for (const f of Object.keys(IN_FLIGHT_EXCLUDED)) {
      expect(read(f).includes('withInFlightLimit('), f).toBe(true);
    }
  });

  it('POSITIVE CONTROL — a call without onFull is caught', () => {
    const file = 'src/server/routers/blocks.router.ts';
    const text = read(file);
    const re =
      /,\s*\(\) => recordBridgeRateLimitRefusal\(who\.procedure, 'in-flight', who\.claims\)/;
    expect(
      re.test(text),
      'withSourceSaveBounds no longer passes onFull the way this control expects'
    ).toBe(true);
    const mutated = text.replace(re, '');
    expect(allInFlightSites({ file, text: mutated }).filter((s) => !s.recorded)).toHaveLength(1);
  });
});

describe('every App Blocks limiter refusal is recorded per app', () => {
  it('no call site is unrecorded except the ones UNRECORDED names (and every one of those exists)', () => {
    const unrecorded = SITES.filter((s) => s.verdict === 'UNRECORDED')
      .map(keyOf)
      .sort();
    expect(unrecorded).toEqual(Object.keys(UNRECORDED).sort());
  });

  it('the bridge viewer middleware records the refusal its `check` options declare', () => {
    const text = read('src/server/routers/blocks.router.ts');
    const source = parse('src/server/routers/blocks.router.ts', text);
    let recordsOnRefusal = false;
    walk(source, (n) => {
      if (!ts.isFunctionDeclaration(n) || n.name?.text !== 'authorizeBlockBridgeViewer') return;
      walk(n, (m) => {
        if (!ts.isIfStatement(m) || !isRefusalTest(m.expression, 'rate')) return;
        walk(m.thenStatement, (r) => {
          if (ts.isCallExpression(r) && calleeName(r) === 'recordBridgeRateLimitRefusal') {
            recordsOnRefusal = true;
          }
        });
      });
    });
    expect(recordsOnRefusal).toBe(true);
    expect(SITES.filter((s) => s.verdict === 'viewer-middleware').length).toBeGreaterThan(0);
  });

  it('the document store builds every rate_limited refusal through `rateLimited`, and sendError records it', () => {
    const file = 'src/server/services/apps/doc-store-api.ts';
    const source = parse(file);
    const builders: string[] = [];
    let sendErrorRecords = false;
    walk(source, (n) => {
      if (
        ts.isNewExpression(n) &&
        n.expression.getText() === 'DocStoreError' &&
        n.arguments?.[0] &&
        ts.isStringLiteralLike(n.arguments[0]) &&
        n.arguments[0].text === 'rate_limited'
      ) {
        builders.push(functionName(enclosingFunction(n)));
      }
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'sendError') {
        walk(n, (m) => {
          if (ts.isCallExpression(m) && calleeName(m) === 'recordRefusal') sendErrorRecords = true;
        });
      }
    });
    expect(builders).toEqual(['rateLimited']);
    expect(sendErrorRecords).toBe(true);
  });
});

describe('the derivation can go red', () => {
  const ROUTER = 'src/server/routers/blocks.router.ts';
  const RECORDER_RE = /recordBridgeRateLimitRefusal\(\s*'queryAppWorkflows',\s*'catalog',[^;]*\);/;
  const recorder = () => {
    const m = RECORDER_RE.exec(read(ROUTER));
    expect(m, 'queryAppWorkflows no longer records the way this control expects').not.toBeNull();
    return (m as RegExpExecArray)[0];
  };
  const verdictOf = (text: string) =>
    classifyFile(ROUTER, text, PRIMITIVES).find(
      (s) => s.fn === 'queryAppWorkflows' && s.primitive === 'checkBlockCatalogRateLimit'
    )?.verdict;

  it('CONTROL — on the real router the site is recorded', () => {
    expect(verdictOf(read(ROUTER))).toBe('recorded');
  });

  it('POSITIVE CONTROL — deleting the recorder makes the site UNRECORDED, repo-wide too', () => {
    const mutated = read(ROUTER).replace(recorder(), '');
    expect(mutated).not.toEqual(read(ROUTER));
    expect(verdictOf(mutated)).toBe('UNRECORDED');
    const unrecorded = allSites({ file: ROUTER, text: mutated })
      .filter((s) => s.verdict === 'UNRECORDED')
      .map(keyOf);
    expect(unrecorded).toContain(`${ROUTER} :: queryAppWorkflows :: checkBlockCatalogRateLimit`);
  });

  it('NEGATIVE CONTROL — a commented-out recorder is not a recorder', () => {
    const rec = recorder();
    const commented = read(ROUTER).replace(rec, `/* ${rec} */`);
    expect(verdictOf(commented)).toBe('UNRECORDED');
  });

  it('NEGATIVE CONTROL — a recorder naming the WRONG bucket does not count', () => {
    const rec = recorder();
    const wrong = read(ROUTER).replace(rec, rec.replace("'catalog'", "'poll'"));
    expect(verdictOf(wrong)).toBe('UNRECORDED');
  });

  it('NEGATIVE CONTROL — a recorder OUTSIDE the refusal branch does not count', () => {
    const rec = recorder();
    const without = read(ROUTER).replace(rec, '');
    const procAt = without.indexOf('\n  queryAppWorkflows: publicProcedure');
    const ifAt = without.indexOf('if (!rate.allowed) {', procAt);
    expect(procAt).toBeGreaterThan(-1);
    expect(ifAt).toBeGreaterThan(procAt);
    const moved = `${without.slice(0, ifAt)}${rec}\n      ${without.slice(ifAt)}`;
    expect(verdictOf(moved)).toBe('UNRECORDED');
  });
});
