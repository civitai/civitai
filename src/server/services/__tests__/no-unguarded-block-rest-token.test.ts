import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The REST counterpart of `no-unguarded-block-bridge-token.test.ts`.
 *
 * `withBlockScope` is the ONE place a Next.js page route may authenticate a block JWT,
 * and since the approved-status gate landed it is also the one place the "is this app
 * still allowed to run" decision is taken for the REST surface. Two regressions would
 * undo that, and neither is something a type can catch:
 *
 *   1. A NEW block REST route that verifies a token ITSELF instead of being wrapped.
 *      That is exactly the shape the bridge bug had — thirteen procedures each calling
 *      `verifyBlockToken` directly and checking nothing else — and a route written by
 *      copying an existing one's *body* rather than its *export* lands there naturally.
 *   2. An EXISTING route quietly exporting its bare `baseHandler`. Eight of the thirteen
 *      routes export `baseHandler` separately for their own unit tests, so the
 *      unwrapped value is right there, in scope, one word away from the export.
 *
 * WHAT THIS FILE IS NOT. It does not verify that the gate WORKS — that is
 * `block-scope.approved-gate.test.ts` (the predicate and the four verdicts) and
 * `suspended-app-rest-refusal.test.ts` (two real routes, a real JWT, a suspended app,
 * and the money/write call that must not happen). Read those if you are asking whether
 * a suspended app is refused. This file only pins the POPULATION and the wrapping
 * relationship, and it is written that way on purpose: a structural check that claims
 * behavioural coverage is worse than none, because it stops anyone looking.
 *
 * A RELATIONSHIP, NOT A COUNT, in both ledgers below:
 *
 *   `REST_ROUTE_RATIONALE` — every wrapped route, each with a one-line statement of what
 *     it reaches. The KEY SET must equal the DERIVED set, in both directions, so a new
 *     `withBlockScope` route cannot be added without its author writing down what a
 *     suspended app would otherwise have been able to do through it. That sentence is
 *     the point of the ledger; the test cannot check that it is TRUE, only that someone
 *     had to write one.
 *
 *   `wraps its default export` — the derived population is routes that MENTION
 *     `withBlockScope`; the relationship asserted is that each one's `export default` is
 *     a `withBlockScope(` call. Those are different sets by construction, which is what
 *     makes the check non-vacuous: a route can import the wrapper and still export the
 *     bare handler, and that is the second regression above.
 *
 * 🔴 KNOWN LIMITS, stated because they are open:
 *   - Text, not a call graph. A route that reaches a block token through an imported
 *     helper which verifies it there is invisible here (the bridge file has the same
 *     limit, for the same reason: the alternative is importing the server graph).
 *   - `export default withBlockScope(...)` is matched as a call at the export site. A
 *     route that assigned the wrapped value to a const first and exported the const
 *     would read as UNWRAPPED and fail. That is the fail-closed direction, and no route
 *     is written that way today.
 *   - The population is Next PAGE routes under `src/pages/api`. A block-JWT surface
 *     added somewhere else entirely (an app-router handler, a rewrite) is outside it.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const API_DIR = 'src/pages/api';
const MIDDLEWARE = 'src/server/middleware/block-scope.middleware.ts';

/**
 * Every page route wrapped by `withBlockScope`, with what a SUSPENDED app would reach
 * through it if the gate in `withBlockScope` were not there. Derived set must match these
 * keys exactly.
 *
 * ⚠️ The two `shared-storage` entries are the interesting ones and the reason the
 * rationale is a sentence rather than a checkbox: they were ALREADY refused before the
 * gate existed — not by anything on the REST path, but incidentally, because they
 * delegate to `resolveSharedContext`, which reads `app_blocks.status` itself. They now
 * refuse one step earlier and for the stated reason. Losing that distinction is how a
 * reader concludes the REST surface was already covered.
 */
const REST_ROUTE_RATIONALE: Record<string, string> = {
  'src/pages/api/v1/blocks/collections/[id]/follow.ts':
    'WRITE — addContributorToCollection / removeContributorFromCollection, i.e. a suspended app mutating the viewer’s follow graph on their behalf.',
  'src/pages/api/v1/blocks/collections/[id]/index.ts':
    'READ — a single collection plus its items; with collections:read:private on the token that includes the viewer’s PRIVATE collections.',
  'src/pages/api/v1/blocks/collections/index.ts':
    'READ — collection discovery and the viewer’s own collection list.',
  'src/pages/api/v1/blocks/generation-resources.ts':
    'READ — public, maturity-clamped resource data. Thinnest gate of the set: no requiredScope, so no scope check and no context binding either.',
  'src/pages/api/v1/blocks/images.ts':
    'READ — the public, maturity-clamped image catalog. No requiredScope.',
  'src/pages/api/v1/blocks/me.ts':
    'READ — viewer identity (id, username, status) and the token’s buzzBudget. Gated on the viewer being a moderator today, which is a GA posture and not a takedown check.',
  'src/pages/api/v1/blocks/models.ts':
    'READ — the public, maturity-clamped model catalog. No requiredScope.',
  'src/pages/api/v1/blocks/shared-storage/increment.ts':
    'WRITE — a shared counter bump. ALREADY refused before this gate, incidentally: it delegates to resolveSharedContext, which reads app_blocks.status itself.',
  'src/pages/api/v1/blocks/shared-storage/top.ts':
    'READ — top-N shared counters. ALREADY refused before this gate, for the same delegation reason as increment.ts.',
  'src/pages/api/v1/blocks/tip-allowance.ts':
    'READ — but of the money counter: it discloses the viewer’s live { cap, spent, remaining } tip allowance.',
  'src/pages/api/v1/blocks/tip.ts':
    'SPEND — createBuzzTipTransactionHandler, a real irreversible Buzz transfer. The highest-value entry in this table and the reason the gate was added.',
  'src/pages/api/v1/blocks/tools.ts':
    'READ — GET returns a static in-process tool registry; POST runs a catalog search on the same clamped path models.ts serves.',
  'src/pages/api/v1/models/[id].ts':
    'READ — dual-auth. With no block JWT this is a plain PublicEndpoint, so the body a block receives here is byte-for-byte what an unauthenticated caller can already fetch: refusing it removes NO exposure. It inherits the gate to keep one rule in one place.',
};

/**
 * 🔴 ROUTES THAT NAME THE WRAPPER IN PROSE ONLY, i.e. that DECIDED NOT TO USE IT. This
 * ledger exists because the first version of this file had no such concept and flagged
 * `src/pages/api/v1/me.ts` as an unwrapped route — a false positive off a substring
 * match, from a file whose comment explains at length why it is deliberately not wrapped.
 *
 * Deleting the entry would have been the cheap fix and the wrong one. `/api/v1/me` is a
 * real dual-auth route that a reader WILL come to expecting this decision to have been
 * made, and "it never appeared in the population" is not a record of anything. So the
 * decision is recorded here and asserted as a SET, both directions: a route cannot leave
 * this list by being wrapped without the ledger noticing, and a new route cannot join it
 * without someone writing down why.
 */
const DELIBERATELY_UNWRAPPED: Record<string, string> = {
  'src/pages/api/v1/me.ts':
    'NOT a block route. AuthedEndpoint (session cookie / API key / OAuth token). Wrapping it would dead-code the block path — the inner session check 401s before block claims do anything — so blocks use the dedicated /api/v1/blocks/me, which IS wrapped. Nothing here reads a block token, so there is no app to approve.',
};

/** The file extensions Next.js dispatches as an API page. */
const PAGE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

function walk(relDir: string, out: string[] = []): string[] {
  const abs = path.join(REPO_ROOT, relDir);
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      walk(rel, out);
      continue;
    }
    if (PAGE_EXTENSIONS.includes(path.extname(entry.name))) out.push(rel);
  }
  return out;
}

/** `withBlockScope` named anywhere in the file, comments included (fail-closed wide). */
const MENTIONS_RE = /\bwithBlockScope\b/;
/** `export default withBlockScope(` — the wrapper applied AT the export site. */
const DEFAULT_EXPORT_WRAPPED_RE = /export\s+default\s+withBlockScope\s*\(/;
/** A CALL, not a type position — `ReturnType<typeof verifyBlockToken>` must not count. */
const DIRECT_VERIFY_RE = /\bverifyBlockToken\s*\(/;

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** True when `source` names `withBlockScope` on at least one line that is not a comment. */
function namesWrapperInCode(source: string): boolean {
  return source
    .split('\n')
    .some((line) => MENTIONS_RE.test(line) && !/^\s*(?:\/\/|\*|\/\*)/.test(line));
}

/** Routes under `src/pages/api` that USE the wrapper in code — the population. */
function blockScopedRoutes(): string[] {
  return walk(API_DIR)
    .filter((rel) => namesWrapperInCode(read(rel)))
    .sort();
}

/**
 * Routes that name the wrapper ONLY in prose — the deliberate non-users. Derived as the
 * complement so the two ledgers partition the same scan rather than being two
 * independent hand-lists that can both drift.
 */
function proseOnlyMentions(): string[] {
  return walk(API_DIR)
    .filter((rel) => {
      const source = read(rel);
      return MENTIONS_RE.test(source) && !namesWrapperInCode(source);
    })
    .sort();
}

describe('the REST route scan can actually see what it claims to', () => {
  /**
   * A derivation that silently matches nothing passes forever. These run the real
   * regexes over synthetic sources whose answers are known, so a pattern that stops
   * matching — or one that starts matching a type position — is caught here instead of
   * showing up as a reassuring empty result below.
   */
  it('POSITIVE CONTROL — the population regex matches a wrapped route', () => {
    expect(
      MENTIONS_RE.test("export default withBlockScope(baseHandler, { endpoint: 'me' });")
    ).toBe(true);
    expect(MENTIONS_RE.test('export default PublicEndpoint(handler);')).toBe(false);
  });

  it('POSITIVE CONTROL — the wrapped-default regex separates a wrapped export from a bare one', () => {
    const wrapped = [
      "import { withBlockScope } from '~/server/middleware/block-scope.middleware';",
      'export const baseHandler = async () => {};',
      "export default withBlockScope(baseHandler, { endpoint: 'tip' });",
    ].join('\n');
    // 🔴 THE NEGATIVE CONTROL THAT MATTERS: this file MENTIONS the wrapper (it imports
    // it, and its own comment names it) and still exports the bare handler. It is the
    // exact regression the relationship assertion exists for, and a check keyed on
    // "does the file mention withBlockScope" would score it as guarded.
    const bare = [
      "import { withBlockScope } from '~/server/middleware/block-scope.middleware';",
      '// withBlockScope is applied by the caller.',
      'export const baseHandler = async () => {};',
      'export default baseHandler;',
    ].join('\n');

    // Both are IN the population — `bare` names the wrapper on its import line, which is
    // code — so the relationship assertion is what has to separate them.
    expect(namesWrapperInCode(wrapped)).toBe(true);
    expect(namesWrapperInCode(bare)).toBe(true);
    expect(DEFAULT_EXPORT_WRAPPED_RE.test(wrapped)).toBe(true);
    expect(DEFAULT_EXPORT_WRAPPED_RE.test(bare)).toBe(false);
  });

  it('POSITIVE CONTROL — a prose-only mention is NOT in the wrapped population', () => {
    // The `/api/v1/me.ts` shape: the wrapper is named only to explain why it is absent.
    // A population keyed on the raw substring scored this as an unwrapped block route.
    const proseOnly = [
      '// Note: App Blocks do NOT call this route directly. Layering withBlockScope over',
      '// AuthedEndpoint would dead-code the block-token path.',
      'export default AuthedEndpoint(handler);',
    ].join('\n');
    expect(MENTIONS_RE.test(proseOnly)).toBe(true);
    expect(namesWrapperInCode(proseOnly)).toBe(false);
  });

  it('POSITIVE CONTROL — the direct-verify regex flags a call and ignores a type position', () => {
    expect(DIRECT_VERIFY_RE.test('type C = Awaited<ReturnType<typeof verifyBlockToken>>;')).toBe(
      false
    );
    expect(DIRECT_VERIFY_RE.test('const claims = await verifyBlockToken(bearer);')).toBe(true);
  });

  it('the walk reaches real files at every depth the routes actually use', () => {
    const files = walk(API_DIR);
    // A positive control on the walk itself: an empty or shallow walk would make every
    // set comparison below trivially satisfiable by an empty derived set.
    expect(files.length).toBeGreaterThan(100);
    // Two and four segments below `src/pages/api` — `blocks/tip.ts` and
    // `blocks/collections/[id]/follow.ts` — so a depth bug cannot hide a nested route.
    expect(files).toContain('src/pages/api/v1/blocks/tip.ts');
    expect(files).toContain('src/pages/api/v1/blocks/collections/[id]/follow.ts');
  });
});

describe('no unguarded block-REST token verification', () => {
  it('ledgers every withBlockScope route — the population, with a rationale each', () => {
    const derived = blockScopedRoutes();

    expect(
      derived,
      'The set of page routes under src/pages/api that use withBlockScope changed. If you ' +
        'ADDED a block REST route, add it to REST_ROUTE_RATIONALE in this file with a ' +
        'one-line statement of what a SUSPENDED app would reach through it — that sentence ' +
        'is the whole point of the ledger. If one DISAPPEARED it was deleted, renamed, or ' +
        'taken off the wrapper; the last of those is the defect this guard exists for. ' +
        'This fails in both directions on purpose.'
    ).toEqual(Object.keys(REST_ROUTE_RATIONALE).sort());
  });

  it('ledgers the routes that name the wrapper and DECIDED not to use it', () => {
    expect(
      proseOnlyMentions(),
      'A page route names withBlockScope in a comment but nowhere in code. That is either ' +
        'a deliberate non-use — record it in DELIBERATELY_UNWRAPPED with the reason, the ' +
        'way /api/v1/me.ts does — or a route that lost its wrapper and kept the comment, ' +
        'which is the defect. The two are indistinguishable from here, which is why the ' +
        'ledger has to be written by hand.'
    ).toEqual(Object.keys(DELIBERATELY_UNWRAPPED).sort());
  });

  it('every rationale says something — an empty string is not a decision', () => {
    const thin = Object.entries({ ...REST_ROUTE_RATIONALE, ...DELIBERATELY_UNWRAPPED })
      .filter(([, why]) => why.trim().length < 40)
      .map(([route]) => route);
    expect(
      thin,
      'These ledger entries carry no usable rationale. Say what the route reaches — a ' +
        'read, a write, a spend — not that it is "fine".'
    ).toEqual([]);
  });

  it('THE RELATIONSHIP — every ledgered route WRAPS its default export', () => {
    const unwrapped = blockScopedRoutes().filter(
      (rel) => !DEFAULT_EXPORT_WRAPPED_RE.test(read(rel))
    );

    expect(
      unwrapped,
      'These routes name withBlockScope but do not apply it to their default export, so ' +
        'Next.js dispatches requests straight to the unwrapped handler: no token ' +
        'verification, no revocation check, and no approved-status gate. Most of these ' +
        'files export `baseHandler` separately for their own tests, which is exactly how ' +
        'the bare value ends up one word away from the export.'
    ).toEqual([]);
  });

  it('no page route verifies a block token itself — the wrapper is the only entry point', () => {
    // 🔴 WIDER THAN A CALL CHECK, and deliberately so — the same reasoning as the bridge
    // file's `only in PROSE` assertion. A static import can be aliased and a dynamic
    // `const { verifyBlockToken: v } = await import(...)` defeats both an alias check and
    // a call regex. Pinning the identifier to comment lines only sees all of them.
    const offenders: string[] = [];
    for (const rel of walk(API_DIR)) {
      read(rel)
        .split('\n')
        .forEach((line, i) => {
          if (!/\bverifyBlockToken\b/.test(line)) return;
          if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }

    expect(
      offenders,
      'A page route under src/pages/api names verifyBlockToken on a line that is not a ' +
        'comment. A bare verify checks the signature and expiry and NOTHING else — not ' +
        'the install, not the app status — which is precisely the shape the tRPC bridge ' +
        'had before authorizeBlockBridgeToken. Wrap the handler in withBlockScope instead.'
    ).toEqual([]);
  });

  it('the middleware takes the approval decision in ONE place', () => {
    // 🔴 A SPELLING CHECK, and that is ALL it can see: a semantically identical rewrite
    // would fail it, and a call to a WRONG predicate spelled this way would pass it. It
    // catches the gate being dropped wholesale while everything still type-checks, and
    // nothing more. What pins the behaviour is block-scope.approved-gate.test.ts.
    const middleware = read(MIDDLEWARE);
    const calls = middleware
      .split('\n')
      .filter((line) => /\bresolveRestApprovalVerdict\s*\(/.test(line));
    expect(
      calls.length,
      `${MIDDLEWARE} must call resolveRestApprovalVerdict exactly once. A second call is ` +
        'a second predicate, which is how the thirteen open-coded copies the bridge guard ' +
        'replaced came to disagree with each other.'
    ).toBe(1);
  });
});
