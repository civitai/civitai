import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every tRPC procedure on the host↔block postMessage bridge must carry a RECORDED DECISION about
 * server-side rate limiting — either a bucket, or a stated reason for having none.
 *
 * WHAT THIS GUARD IS FOR, AND WHAT IT IS NOT. It is not "every bridge proc must be rate limited".
 * That would be the wrong rule and the card that produced this file (clawgate #569) says so in its
 * own non-goals: a rate limit on a generation poll loop that is sized too tight breaks generation
 * for honest blocks, and `submitWorkflow` is bounded by a per-app generation VELOCITY ceiling
 * instead (tighter than a request limit on the `standard` tier every app has today — the tier
 * qualifier is load-bearing and is argued at the procedure). The rule is
 * that the DECISION exists and is written down where the next reader will find it. The realistic
 * regression is not someone deleting a limiter — it is the eighteenth bridge proc, written by
 * copying the seventeenth's opening lines, whose author never considered the question at all.
 *
 * A RELATIONSHIP, NOT A COUNT, and not one ledger but a ledger checked against TWO derivations.
 *
 *   `RATE_LIMIT_DECISION_LEDGER` — the decision per procedure: which bucket it charges, or `none`
 *     plus what bounds it instead. Compared as a SET against the derived population in BOTH
 *     directions, so a proc that appears without a decision fails, and a decision that outlives
 *     its procedure fails too. A bare count would satisfy both halves of a swap and pin nothing.
 *
 *   THE BUCKET CLAIM — each entry's declared bucket is checked against what the procedure
 *     ACTUALLY calls. A ledger that merely lists names is a list of names; this is what makes it a
 *     claim about the code. An entry saying `catalog` whose procedure calls nothing goes RED, and
 *     so does an entry saying `none` whose procedure quietly gained a limiter.
 *
 * 🔴 WHY THE DERIVATION IS AN AST WALK AND NOT A TEXT SCAN. Its sibling
 * `no-unguarded-block-bridge-token.test.ts` carries ~400 lines of normalisation whose entire job is
 * to stop a COMMENT or a STRING LITERAL satisfying a spelling check — a hazard that file has found
 * SIX separate times, every one of them fail-OPEN. Walking the TypeScript AST removes the class
 * rather than defending against it: a comment is trivia and a string is a literal, so neither is
 * ever a `CallExpression` and neither can be mistaken for one. The controls below measure that
 * rather than asserting it.
 *
 * 🔴 TWO DERIVATIONS OVER DIFFERENT SURFACES, BECAUSE EITHER ALONE IS A SINGLE POINT OF FAILURE.
 *   1. REACHABILITY (this file): a procedure is a bridge procedure if it reaches
 *      `authorizeBlockBridgeToken`, directly or through a router-local helper.
 *   2. INPUT SHAPE (the sibling's `BRIDGE_INPUT_LEDGER`, read from its source): a procedure is a
 *      bridge procedure if its `.input(...)` carries a `blockToken` field.
 * They answer the same question from opposite ends and are asserted EQUAL. A defect in either
 * derivation shows up as a disagreement rather than as a silently smaller population — which is
 * the failure mode a single derivation cannot report, because "not in the set" and "could not be
 * parsed" look identical from inside it.
 *
 * 🔴 WHAT IS STILL OUT OF REACH — every entry is a limit that is OPEN, stated because it is open.
 *   - Whether a limiter is AWAITED ON EVERY PATH. The call graph answers "this procedure's body
 *     names the limiter"; a call behind an `if (someFlag)` reads as charging it. What covers the
 *     paths is the behavioural suite, `blocks.router.bridgeRateLimits.test.ts`, which drives the
 *     real procedures with the bucket refused — including a `customComfy` body specifically
 *     because `estimateWorkflow` returns early for two of its three `kind` branches.
 *   - Whether the CEILING is right. No test can tell a generous limit from a useless one; the
 *     numbers and how they were chosen are argued at the constants in
 *     `src/server/utils/block-catalog-rate-limit.ts`, and every one of them is a starting value.
 *   - Verification or limiting performed in a module this file does not read. The call graph is
 *     computed inside `blocks.router.ts` only, one helper level deep. A procedure delegating to an
 *     imported service that limits reads as UNLIMITED here and fails — deliberately fail-closed,
 *     but it means the answer is "charges a bucket from within the router", not "is bounded".
 *   - A bridge procedure carrying its token under some other input field name, inherited from the
 *     sibling's cross-check. Reachability would still see it; the equality assertion would then go
 *     RED on the sibling's half, which is the correct outcome but reports the wrong half.
 *   - 🔴 A bridge procedure introduced into `blocksRouter` by OBJECT SPREAD (`...moreProcs`).
 *     `routerProcedures` iterates `PropertyAssignment`s, so a spread member is invisible to THIS
 *     file's derivation — measured: such a proc, unledgered and unlimited, leaves this file at
 *     14/14. What catches it is the sibling (2 failed) and then, once its author updates the
 *     sibling's ledger as they must, the `agrees with the INPUT-SHAPE derivation` assertion here
 *     (1 failed). So the two-derivation design holds, but for THIS shape the protection is
 *     entirely the sibling's — stated because a reader would otherwise credit it to the AST walk.
 *     A spread proc missing from BOTH ledgers is green in both.
 *   - Procedures in ANOTHER router file. Both guards hard-code one `ROUTER` path, so a bridge
 *     proc that moves or is added elsewhere leaves the population silently. Related and recorded
 *     in the ledger's trailing note: `apps.router.ts` and `apps-shared.router.ts` carry
 *     block-JWT procedures that neither guard has ever seen.
 *   - The REST `withBlockScope` routes. They are a different surface with a different guard and
 *     their own sibling (`no-unguarded-block-rest-token.test.ts`); #569 puts them out of scope
 *     explicitly. Two of them are known-unlimited and are named in the ledger's trailing note so
 *     the exclusion is recorded rather than silent.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROUTER = 'src/server/routers/blocks.router.ts';
/** The sibling whose population is derived from `.input(...)` shapes rather than reachability. */
const SIBLING = 'src/server/services/__tests__/no-unguarded-block-bridge-token.test.ts';

/** The guard every bridge procedure must reach. Its own ledger lives in the sibling. */
const GUARD = 'authorizeBlockBridgeToken';

/**
 * The rate-limit primitives, mapped to the bucket name the ledger speaks in. Sub-namespaced Redis
 * keys, so no two of these ever contend — see `src/server/utils/block-catalog-rate-limit.ts`.
 */
const BUCKET_BY_FN: Readonly<Record<string, string>> = Object.freeze({
  checkBlockCatalogRateLimit: 'catalog',
  checkBlockPublishRateLimit: 'publish',
  checkBlockPostRateLimit: 'post',
  checkBlockPostAppRateLimit: 'post-app',
  checkBlockPollRateLimit: 'poll',
});

type Decision = {
  /** The buckets this procedure charges, sorted. Empty = a deliberate, argued `none`. */
  buckets: string[];
  /** One line, for the reader of THIS file. The full argument lives at the procedure. */
  why: string;
};

/**
 * THE DECISION LEDGER — clawgate #569, acceptance criterion 1. One entry per bridge procedure.
 *
 * `buckets` is a CLAIM ABOUT THE CODE and is checked against it below, not documentation. `why` is
 * for whoever reads this file; the argument that actually has to convince someone lives at the
 * procedure in `blocks.router.ts`, which is where a person changing it will be standing.
 *
 * ⚠️ THE LIMITS HERE FAIL OPEN, ALL OF THEM, BY THE CONVENTION EVERY BLOCKS LIMITER FOLLOWS: a
 * Redis error returns `allowed: true`. So an entry with a bucket means "this bounds abuse", never
 * "this guarantees a ceiling". They are cost ceilings, not security controls; what bounds AUTHORITY
 * on these procedures is the guard, the viewer/app scope assertions and the consent scopes.
 *
 * ⚠️ AND `weight` IS 1 EVERYWHERE EXCEPT PUBLISH. `checkBlockPublishRateLimit` is charged by IMAGE
 * COUNT because its cost is per-image (fetch + S3 upload + scan); everything else charges one token
 * per call because the call is the unit. `createPostFromApp` charges BOTH — `post`/`post-app` by
 * the post, `publish` by the images it adopts — so a post cannot be used to bypass the image
 * ceiling.
 */
const RATE_LIMIT_DECISION_LEDGER: Readonly<Record<string, Decision>> = Object.freeze({
  cancelAppWorkflow: {
    buckets: ['catalog'],
    why: 'Orchestrator read + DELETE + a DB lookup per call; pre-existing, and the comment there is what argued cancelWorkflow into the same bucket.',
  },
  cancelWorkflow: {
    buckets: ['catalog'],
    why: '#569 criterion 3 — the asymmetry with cancelAppWorkflow, resolved toward limiting. GET + PATCH + GET plus an inline moderation scan: the heavier of the two. Like pollWorkflow it RETURNS a non-terminal refusal rather than throwing — both cancel hosts convert a throw into failureSnapshot status:failed, which would tell the block a still-running paid workflow had finished AND that a cancel it never issued had succeeded.',
  },
  createPostFromApp: {
    buckets: ['post', 'post-app', 'publish'],
    why: 'Public-feed write with reward exposure. Per-instance AND per-app post buckets, plus the image-weighted publish bucket for the images it adopts. Not catalog — unlike its previewPostFromApp sibling, this one materialises rows.',
  },
  estimateWorkflow: {
    buckets: ['catalog'],
    why: 'An orchestrator whatif submit plus version/checkpoint/entitlement reads, with no spend attached to bound it. Charged ABOVE the kind branch so all three branches are covered.',
  },
  getImagesByIds: {
    buckets: ['catalog'],
    why: 'A bounded by-id image read that forces no-store, so the origin absorbs every call; pre-existing.',
  },
  getMyBuzzAccounts: {
    buckets: ['catalog'],
    why: 'Reaches the bucket through authorizeBlockBuzzRead; pre-existing.',
  },
  getMyBuzzBalance: {
    buckets: ['catalog'],
    why: '#569 — the one Buzz read that does NOT go through authorizeBlockBuzzRead, so it was the only unlimited one. Charged inline (the helper’s error copy differs).',
  },
  getMyBuzzTransactions: {
    buckets: ['catalog'],
    why: 'Reaches the bucket through authorizeBlockBuzzRead; pre-existing.',
  },
  getMyDailyCompensation: {
    buckets: ['catalog'],
    why: 'Reaches the bucket through authorizeBlockBuzzRead; pre-existing. The ClickHouse read behind it is the expensive half.',
  },
  getMyViewer: {
    buckets: ['catalog'],
    why: 'The per-call viewer identity read every block makes on load; a session-user resolve per call, so it is bounded; pre-existing.',
  },
  listMyWorkflows: {
    buckets: [],
    why: 'DELIBERATELY NONE. #569 gave it a catalog limit; the round-0 audit took it back out and was right. Its own justification conceded a 10³–10⁴ margin — a limit whose rationale is its own margin bounds nothing, while adding a throw path that spends an app-wide shared allowance. Bounded instead by shape: one indexed keyset query, ≤50 rows by schema, server-scoped to (viewer, appBlockId).',
  },
  pollWorkflow: {
    buckets: ['poll'],
    why: '#569 criterion 2 — its OWN bucket (1200/60 s), keyed on the install AND the viewer because blockInstanceId is page_<appBlockId> for a page app. Previously bounded only by the SDK’s sequential loop, a client-side pacing assumption and not a bound. A refusal RETURNS a non-terminal snapshot rather than throwing: both hosts convert a throw into status:failed, which the SDK treats as terminal, so a thrown 429 would end the watch loop on a paid generation.',
  },
  previewPostFromApp: {
    buckets: ['catalog'],
    why: 'The dry-run half of the post bridge — it materialises nothing, so it charges the read bucket rather than the post one; pre-existing.',
  },
  publishGenerationOutputs: {
    buckets: ['publish'],
    why: 'Image-WEIGHTED: each image is a fetch + S3 upload + scan, so the cost is per image, not per call; pre-existing.',
  },
  queryAppWorkflows: {
    buckets: ['catalog'],
    why: 'Up to 50 projections per call off an orchestrator LIST; pre-existing.',
  },
  submitWorkflow: {
    buckets: [],
    why: 'DELIBERATELY NONE. Bounded by the per-app generation VELOCITY ceiling in reserveAppSpend (120 gens/60 s aggregate on the standard tier — and that tier qualifier is load-bearing: trusted is 600 and platform 3,000) plus the per-user and per-app daily Buzz caps, which unlike every limiter here fail CLOSED. Three stated holes (a pre-reserve rejection loop; the dev-token skip; the velocity counter is app-wide and never refunded) are written out at the procedure.',
  },
  updateUserSettings: {
    buckets: [],
    why: 'DELIBERATELY NONE, same reversal as listMyWorkflows. Bounded instead by being developer-only (assertViewerIsAppDeveloper), a 4KB JSON-safe settingsSchema cap, a single upsert on a resolved install, and manifest-filtered fields — a block cannot make the call do more work by calling it differently.',
  },
});

/**
 * 🔴 KNOWN-UNLIMITED AND OUT OF SCOPE, RECORDED SO THE EXCLUSION IS A FACT RATHER THAN AN OVERSIGHT.
 * The ledger above is every bridge procedure in `blocks.router.ts`. That is the population clawgate
 * #569 scoped itself to, and the number it produces — 10 limited of 17 at the time — is correct for
 * that file. It is NOT every block-JWT procedure on the platform, and the difference is recorded
 * here rather than left for someone to rediscover:
 *
 *   REST, on the `withBlockScope` path — out of scope by the card's explicit non-goal:
 *     - `src/pages/api/v1/blocks/collections/[id]/follow.ts` — the only block-JWT REST WRITE with
 *       no limiter; every sibling write has one.
 *     - `src/pages/api/v1/blocks/tools.ts` — unmetered per its own comment, though it still spends
 *       a Redis revocation read and a `BlockScopeInvocation` insert per call.
 *
 *   tRPC, in SIBLING ROUTERS — same bridge, same block JWT, same sandboxed caller, and neither
 *   this guard nor its sibling has ever looked at them (both hard-code one `ROUTER` path):
 *     - `src/server/routers/apps.router.ts` — `get`, `set`, `delete`, `list`, `getQuota`. The file
 *       contains no limiter call at all. `set` and `delete` are block-JWT WRITES; `set` has a
 *       per-write BYTE cap, which bounds size, not rate.
 *     - `src/server/routers/apps-shared.router.ts` — `list`, `get`, `getCount`, `getCounts`,
 *       `withdraw` are unlimited (`withdraw` is a write); its `append`, `update`, `vote`, `unvote`
 *       and `report` do carry their own bucket family.
 *
 * Stated the honest way: across every block-JWT tRPC procedure the figure is ~11 still unlimited,
 * not 1. These are named, not fixed — extending this guard across routers is a larger change than
 * #569 asked for. **Closing condition: a PR that either limits them or adds them to a ledger like
 * this one; until then this paragraph is the record that they were seen.**
 */

/** Every procedure name declared on the `blocksRouter` object literal, with its initializer node. */
function routerProcedures(source: ts.SourceFile): Map<string, ts.Node> {
  const procs = new Map<string, ts.Node>();
  let found: ts.ObjectLiteralExpression | null = null;

  const findRouter = (node: ts.Node): void => {
    if (
      found == null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'blocksRouter' &&
      node.initializer != null &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.initializer.arguments[0])
    ) {
      found = node.initializer.arguments[0] as ts.ObjectLiteralExpression;
      return;
    }
    ts.forEachChild(node, findRouter);
  };
  findRouter(source);

  // 🔴 A THROW, NOT A SILENT EMPTY MAP. An unparseable router is the one outcome that would make
  // every assertion below vacuously true, so it has to be a different result from "no procedures
  // matched" — the "not in the set vs could not be parsed" distinction this file's header names.
  if (found == null)
    throw new Error(`could not locate the blocksRouter object literal in ${ROUTER}`);

  for (const prop of (found as ts.ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
      ? prop.name.text
      : null;
    if (name == null) continue;
    procs.set(name, prop.initializer);
  }
  return procs;
}

/**
 * The set of function names CALLED anywhere under `node`.
 *
 * Reads `CallExpression` nodes off the AST, so a comment or a string literal naming a function can
 * never enter this set — the whole class the sibling spends 400 lines of normalisation defending
 * against. Both access forms are covered: `f(...)` and `obj.f(...)`.
 */
function callees(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const target = n.expression;
      if (ts.isIdentifier(target)) names.add(target.text);
      else if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name)) {
        names.add(target.name.text);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

/** Module-scope function declarations in the router, by name — the router-local helper layer. */
function routerHelpers(source: ts.SourceFile): Map<string, ts.Node> {
  const helpers = new Map<string, ts.Node>();
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name != null) {
      helpers.set(stmt.name.text, stmt);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer != null &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          helpers.set(decl.name.text, decl.initializer);
        }
      }
    }
  }
  return helpers;
}

/**
 * Everything a procedure reaches: its own callees, plus the callees of every router-local helper
 * it calls, transitively. Bounded by the helper set, so it terminates on a cycle.
 */
function reachable(start: ts.Node, helpers: Map<string, ts.Node>): Set<string> {
  const seen = new Set<string>(callees(start));
  const queue = [...seen];
  const expanded = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (expanded.has(name)) continue;
    expanded.add(name);
    const helper = helpers.get(name);
    if (helper == null) continue;
    for (const inner of callees(helper)) {
      if (!seen.has(inner)) {
        seen.add(inner);
        queue.push(inner);
      }
    }
  }
  return seen;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function parse(text: string, rel = ROUTER): ts.SourceFile {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** `{ proc name → buckets it charges }` for every procedure that reaches the bridge guard. */
function bridgeProcBuckets(text: string): Map<string, string[]> {
  const source = parse(text);
  const helpers = routerHelpers(source);
  const out = new Map<string, string[]>();
  for (const [name, node] of routerProcedures(source)) {
    const calls = reachable(node, helpers);
    if (!calls.has(GUARD)) continue;
    const buckets = [...calls].flatMap((fn) => (fn in BUCKET_BY_FN ? [BUCKET_BY_FN[fn]] : []));
    out.set(name, [...new Set(buckets)].sort());
  }
  return out;
}

/** The sibling's `BRIDGE_INPUT_LEDGER`, read out of its source — the input-shape derivation. */
function siblingInputLedger(): string[] {
  const text = read(SIBLING);
  const marker = 'const BRIDGE_INPUT_LEDGER = [';
  const start = text.indexOf(marker);
  expect(
    start,
    `${SIBLING} no longer declares BRIDGE_INPUT_LEDGER — this cross-check is blind`
  ).toBeGreaterThan(-1);
  // 🔴 BOUND THE END TO THE FIRST COLUMN-ZERO `]`, NOT TO THE NEXT `].sort()`. Searching for
  // `].sort()` walks PAST this ledger when the sibling stops spelling it that way and lands on
  // some later array hundreds of lines on — the slice then spans unrelated code and the regex
  // below harvests ~90 "names". The carefully-worded failure message never fires, and whoever
  // hits it is told the sibling ledger has 90 entries and goes looking in the wrong file. It
  // still fails closed either way; the point is that it failed closed while REPORTING SOMETHING
  // FALSE, which is worse than a blunt error.
  const end = text.indexOf('\n]', start);
  expect(end, `${SIBLING}'s BRIDGE_INPUT_LEDGER is not a closed array literal`).toBeGreaterThan(
    start
  );
  const body = text.slice(start + marker.length, end);
  // Entry lines only: `  'name',`. A comment line inside the array cannot match, because the
  // pattern requires the quote to open the line's first non-space character.
  const names = [...body.matchAll(/^\s*'([A-Za-z0-9_]+)',/gm)].map((m) => m[1]).sort();
  // A MAGNITUDE CONTROL on the harvest itself, so a slice that ran away is reported as a broken
  // parse rather than compared as a population. The real ledger is 17 today.
  expect(
    names.length,
    `harvested ${names.length} names from ${SIBLING}'s BRIDGE_INPUT_LEDGER — that is not a ledger, it is a runaway slice`
  ).toBeLessThan(40);
  expect(names.length).toBeGreaterThan(5);
  return names;
}

const derived = bridgeProcBuckets(read(ROUTER));

describe('the bridge rate-limit scan can actually see what it claims to', () => {
  it('MAGNITUDE CONTROL — the router parses into a plausible number of procedures', () => {
    const all = routerProcedures(parse(read(ROUTER)));
    // Measured 2026-09-20: 75 procedures on `blocksRouter`. A parse that silently matched a
    // fraction of them would shrink the population without failing anything else here, so the
    // floor is deliberately close to the real number rather than a token `> 0`.
    expect(all.size).toBeGreaterThan(60);
  });

  it('POSITIVE CONTROL — a NEW bridge proc with no decision is detected', () => {
    // 🔴 THE MUTATION THIS FILE EXISTS TO CATCH, run rather than asserted: the eighteenth bridge
    // procedure, copied from the seventeenth, guarded correctly and rate-limited not at all.
    const mutated = read(ROUTER).replace(
      '\n  getMyViewer: publicProcedure',
      `
  brandNewBridgeProc: publicProcedure
    .input(z.object({ blockToken: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const claims = await authorizeBlockBridgeToken(input.blockToken);
      return { appId: claims.appId };
    }),

  getMyViewer: publicProcedure`
    );
    expect(mutated).not.toEqual(read(ROUTER));

    const mutatedProcs = bridgeProcBuckets(mutated);
    expect(mutatedProcs.has('brandNewBridgeProc')).toBe(true);
    expect(mutatedProcs.get('brandNewBridgeProc')).toEqual([]);
    // …and the ledger comparison the real assertion makes would go RED on it.
    expect([...mutatedProcs.keys()].sort()).not.toEqual(
      Object.keys(RATE_LIMIT_DECISION_LEDGER).sort()
    );
  });

  it('POSITIVE CONTROL — a bucket that disappears is detected, not absorbed', () => {
    // The other direction: an entry claiming `catalog` whose limiter call was removed. Without
    // this, `buckets` would be a list nobody checks and the ledger would decay into prose.
    const mutated = read(ROUTER).replace(
      // ⚠️ AN EXACT LITERAL FROM THE ROUTER, AND THE COUPLING IS DELIBERATE. It goes stale the
      // moment that site is edited — which it did, when the refusal counter was added — and the
      // `expect(mutated).not.toEqual(read(ROUTER))` line below turns that into a LOUD failure
      // rather than a mutation that silently applies to nothing and scores the guard GREEN for
      // free. A stale mutation target is the classic way a control stops controlling.
      "const rate = await checkBlockCatalogRateLimit(claims.blockInstanceId);\n      if (!rate.allowed) {\n        recordBlockBridgeRateLimitRefusal('getMyBuzzBalance', 'catalog');\n        throw new TRPCError({\n          code: 'TOO_MANY_REQUESTS',\n          message: 'Rate limit exceeded, please retry shortly.',\n        });\n      }\n      // getUserBuzzAccounts returns every spend type",
      '// getUserBuzzAccounts returns every spend type'
    );
    expect(mutated).not.toEqual(read(ROUTER));

    expect(bridgeProcBuckets(mutated).get('getMyBuzzBalance')).toEqual([]);
    expect(RATE_LIMIT_DECISION_LEDGER.getMyBuzzBalance.buckets).toEqual(['catalog']);
  });

  it('NEGATIVE CONTROL — a COMMENTED-OUT or STRING-QUOTED limiter is not a limiter', () => {
    // 🔴 The fail-OPEN hazard the sibling has hit six times, measured here rather than argued
    // away. Both shapes name the function with an argument list; neither is a call.
    const mutated = read(ROUTER).replace(
      // ⚠️ AN EXACT LITERAL FROM THE ROUTER, AND THE COUPLING IS DELIBERATE. It goes stale the
      // moment that site is edited — which it did, when the refusal counter was added — and the
      // `expect(mutated).not.toEqual(read(ROUTER))` line below turns that into a LOUD failure
      // rather than a mutation that silently applies to nothing and scores the guard GREEN for
      // free. A stale mutation target is the classic way a control stops controlling.
      "const rate = await checkBlockCatalogRateLimit(claims.blockInstanceId);\n      if (!rate.allowed) {\n        recordBlockBridgeRateLimitRefusal('getMyBuzzBalance', 'catalog');\n        throw new TRPCError({\n          code: 'TOO_MANY_REQUESTS',\n          message: 'Rate limit exceeded, please retry shortly.',\n        });\n      }\n      // getUserBuzzAccounts returns every spend type",
      `// const rate = await checkBlockCatalogRateLimit(claims.blockInstanceId);
      const note = 'checkBlockCatalogRateLimit(claims.blockInstanceId)';
      void note;
      // getUserBuzzAccounts returns every spend type`
    );
    expect(mutated).not.toEqual(read(ROUTER));

    expect(bridgeProcBuckets(mutated).get('getMyBuzzBalance')).toEqual([]);
  });

  it('NEGATIVE CONTROL — a non-bridge proc is not pulled into the population', () => {
    // `listForModel` is a `publicProcedure` on the same router that never touches a block token.
    // If it appeared, the population would be "every proc" and the ledger would be meaningless.
    expect(derived.has('listForModel')).toBe(false);
    expect(derived.has('getMyApps')).toBe(false);
  });

  it('sees a bucket reached THROUGH a router-local helper, not only a direct call', () => {
    // The three buzz self-reads charge the catalog bucket via `authorizeBlockBuzzRead` and never
    // name a limiter themselves. A one-level-shallow walk would score all three as unlimited.
    for (const proc of ['getMyBuzzAccounts', 'getMyBuzzTransactions', 'getMyDailyCompensation']) {
      expect(derived.get(proc), `${proc} should reach the catalog bucket via its helper`).toEqual([
        'catalog',
      ]);
    }
  });
});

describe('no unlimited block-bridge procedure without a recorded decision', () => {
  it('ledgers EXACTLY the procedures that reach the bridge guard — both directions', () => {
    // 🔴 A SET, NOT A COUNT. A swap (one proc added, one removed) leaves a count unchanged and is
    // exactly the shape this has to catch.
    expect([...derived.keys()].sort()).toEqual(Object.keys(RATE_LIMIT_DECISION_LEDGER).sort());
  });

  it('agrees with the INPUT-SHAPE derivation in the sibling guard', () => {
    // Two derivations over different surfaces. A disagreement means one of them is wrong, and it
    // is reported as a disagreement rather than as a quietly smaller population.
    expect([...derived.keys()].sort()).toEqual(siblingInputLedger());
  });

  it("each decision's declared bucket is what the procedure actually charges", () => {
    const declared = Object.fromEntries(
      Object.entries(RATE_LIMIT_DECISION_LEDGER).map(([name, d]) => [name, [...d.buckets].sort()])
    );
    expect(Object.fromEntries([...derived.entries()].sort())).toEqual(
      Object.fromEntries(Object.entries(declared).sort())
    );
  });

  it('every declared bucket names a real limiter primitive', () => {
    const real = new Set(Object.values(BUCKET_BY_FN));
    const bogus = Object.entries(RATE_LIMIT_DECISION_LEDGER).flatMap(([name, d]) =>
      d.buckets.filter((b) => !real.has(b)).map((b) => `${name}:${b}`)
    );
    expect(bogus).toEqual([]);
  });

  it('every decision carries a rationale — an empty one is not a decision', () => {
    // 🔴 THE WHOLE POINT OF CRITERION 1 IS THE RATIONALE, so an entry can be added without one
    // only if nothing checks. The floor is deliberately long enough to exclude a placeholder.
    const thin = Object.entries(RATE_LIMIT_DECISION_LEDGER)
      .filter(([, d]) => d.why.trim().length < 40)
      .map(([name]) => name);
    expect(thin).toEqual([]);
  });

  it('the UNLIMITED procedures are exactly the ones argued to be unlimited', () => {
    // 🔴 PINNED AS A LITERAL SET rather than derived from the ledger, so that moving a procedure
    // to `buckets: []` is a change to THIS line and cannot pass as bookkeeping — and it earned its
    // keep immediately: all three members arrived by a DIFFERENT route. `submitWorkflow` was never
    // limited and is argued from the per-app velocity ceiling; `listMyWorkflows` and
    // `updateUserSettings` were limited by #569 and UN-limited by its round-0 audit, because each
    // limit's own written justification conceded a margin of 10³–10⁴. Each argument is at its
    // procedure in `blocks.router.ts`. Removing a limit is as much a decision as adding one, and
    // this line is where both kinds have to be declared.
    const unlimited = Object.entries(RATE_LIMIT_DECISION_LEDGER)
      .filter(([, d]) => d.buckets.length === 0)
      .map(([name]) => name)
      .sort();
    expect(unlimited).toEqual(['listMyWorkflows', 'submitWorkflow', 'updateUserSettings']);
  });

  it('pollWorkflow charges a bucket of its OWN — not the catalog one', () => {
    // 🔴 CRITERION 2, PINNED AS A RELATIONSHIP. The dedicated bucket is the decision; sharing the
    // catalog one would couple a generation's poll cadence to a model picker's allowance, and
    // that coupling is invisible in any assertion that only asks "is it limited at all".
    expect(derived.get('pollWorkflow')).toEqual(['poll']);
    expect(derived.get('pollWorkflow')).not.toContain('catalog');
    // And nothing else may join that bucket without this line moving.
    const pollers = [...derived.entries()]
      .filter(([, buckets]) => buckets.includes('poll'))
      .map(([name]) => name)
      .sort();
    expect(pollers).toEqual(['pollWorkflow']);
  });

  it('the two cancel procedures agree — criterion 3, pinned as a relationship', () => {
    // 🔴 EQUALITY, NOT TWO SEPARATE PRESENCE CHECKS. The defect was that one had a bucket and the
    // other did not; a test asserting each carries `catalog` would pass again the moment someone
    // moved one of them to a different bucket for a reason that did not apply to the other.
    expect(derived.get('cancelWorkflow')).toEqual(derived.get('cancelAppWorkflow'));
    expect(derived.get('cancelWorkflow')).toEqual(['catalog']);
  });
});
