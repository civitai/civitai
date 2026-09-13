import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every tRPC procedure on the host↔block postMessage bridge must resolve its claims
 * through `authorizeBlockBridgeToken`, never through `verifyBlockToken` directly.
 *
 * `verifyBlockToken` answers one question — is this a token we signed, not yet expired.
 * It cannot see an uninstall, a toggle-off, a publisher ban or a suspended app. The
 * bridge procs each called it directly and checked none of those, so a revoked install
 * kept driving the bridge — orchestrator polls, workflow cancels, and
 * `publishGenerationOutputs`, which persists public `Image` rows — until the token
 * expired on its own. The REST `withBlockScope` wrapper never had this gap.
 *
 * WHY A GUARD AND NOT A TYPE. Nothing in the type system can require a check that
 * happens INSIDE a resolver. And the realistic regression is not someone deleting the
 * helper — it is the fourteenth bridge proc, written by copying the thirteenth's opening
 * lines, whose reviewer has no reason to know that `await verifyBlockToken(...)` is the
 * one shape that must not appear in this file.
 *
 * A RELATIONSHIP, NOT A COUNT. The ledger below names the call sites by the procedure (or
 * helper) that owns them, and is compared as a SET. It fails in both directions on
 * purpose:
 *   - a site DISAPPEARS — a proc deleted, renamed, or quietly moved back onto a bare
 *     `verifyBlockToken` — and the set shrinks;
 *   - a site APPEARS and is not in the ledger, so a new bridge proc has to be looked at
 *     by whoever adds it rather than inheriting coverage silently.
 * A bare count would satisfy both halves of a swap (one proc unguarded, one added) and
 * pin nothing.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROUTER = 'src/server/routers/blocks.router.ts';
const GUARD = 'src/server/services/blocks/block-bridge-auth.service.ts';

/**
 * The bridge call sites, by owning procedure. `authorizeBlockBuzzRead` is the router's
 * own buzz self-read helper — it is a call SITE like any other (the procs behind it,
 * `getMyBuzzTransactions` and friends, reach the guard through it).
 */
const LEDGER = [
  'authorizeBlockBuzzRead',
  'cancelAppWorkflow',
  'cancelWorkflow',
  'estimateWorkflow',
  'getImagesByIds',
  'getMyBuzzBalance',
  'getMyViewer',
  'listMyWorkflows',
  'pollWorkflow',
  'publishGenerationOutputs',
  'queryAppWorkflows',
  'submitWorkflow',
  'updateUserSettings',
].sort();

/** `  someProc: publicProcedure` — the router's procedure definitions. */
const PROC_RE = /^ {2}([A-Za-z0-9_]+):\s*[A-Za-z0-9_]*[Pp]rocedure\b/;
/** `async function someHelper(` at module scope. */
const FN_RE = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/;

/** A CALL, not a type position — `ReturnType<typeof verifyBlockToken>` must not count. */
const DIRECT_CALL_RE = /\bverifyBlockToken\s*\(/;

/** The owner of each `authorizeBlockBridgeToken(` call in `source`, plus every direct call. */
function scan(source: string): { guarded: string[]; direct: number[] } {
  const lines = source.split('\n');
  const guarded: string[] = [];
  const direct: number[] = [];

  lines.forEach((line, i) => {
    if (DIRECT_CALL_RE.test(line)) direct.push(i + 1);
    if (!/\bauthorizeBlockBridgeToken\s*\(/.test(line)) return;
    for (let j = i; j >= 0; j--) {
      const owner = PROC_RE.exec(lines[j]) ?? FN_RE.exec(lines[j]);
      if (owner) {
        guarded.push(owner[1]);
        return;
      }
    }
    guarded.push(`<no owner resolved at line ${i + 1}>`);
  });

  return { guarded, direct };
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('the bridge scan can actually see what it claims to', () => {
  /**
   * A ledger test that silently matches nothing passes forever. These two run the real
   * `scan` over a synthetic source whose answers are known, so a regex that stops
   * matching — or one that starts matching a type position — is caught here rather than
   * showing up as a reassuring empty result below.
   */
  it('finds a guarded site and attributes it to its procedure', () => {
    const { guarded, direct } = scan(
      [
        'export const r = router({',
        '  somethingElse: publicProcedure.query(async () => 1),',
        '  myBridgeProc: publicProcedure',
        '    .mutation(async ({ input }) => {',
        '      const claims = await authorizeBlockBridgeToken(input.blockToken);',
        '      return claims;',
        '    }),',
        '});',
      ].join('\n')
    );
    expect(guarded).toEqual(['myBridgeProc']);
    expect(direct).toEqual([]);
  });

  it('flags a direct call and ignores a type position', () => {
    const { direct } = scan(
      [
        'type C = NonNullable<Awaited<ReturnType<typeof verifyBlockToken>>>;',
        'const claims = await verifyBlockToken(input.blockToken);',
      ].join('\n')
    );
    expect(direct).toEqual([2]);
  });
});

describe('no unguarded block-bridge token verification', () => {
  it('routes every bridge call site through the guard, and exactly the ledgered ones', () => {
    const { guarded } = scan(read(ROUTER));

    expect(
      [...guarded].sort(),
      'The set of bridge procedures resolving claims through authorizeBlockBridgeToken ' +
        'changed. If you ADDED a bridge proc, add it to LEDGER in this file. If one ' +
        'DISAPPEARED, it was deleted, renamed, or put back on a bare verifyBlockToken — ' +
        'the last of those is the defect this guard exists for. This fails in both ' +
        'directions on purpose.'
    ).toEqual(LEDGER);
  });

  it('names each site once — a duplicate would hide a shrink behind a growth', () => {
    const { guarded } = scan(read(ROUTER));
    expect([...new Set(guarded)].length).toBe(guarded.length);
  });

  it('leaves no direct verifyBlockToken call in the router', () => {
    const { direct } = scan(read(ROUTER));

    expect(
      direct,
      `${ROUTER} must not call verifyBlockToken directly — a bare verify checks the ` +
        'signature and expiry and nothing else, so it honours a revoked install and a ' +
        'suspended app for a whole token lifetime. Call authorizeBlockBridgeToken instead ' +
        '(lines listed are 1-based).'
    ).toEqual([]);
  });

  it('keeps the verification in ONE place — the guard calls it exactly once', () => {
    const { direct } = scan(read(GUARD));
    expect(
      direct.length,
      `${GUARD} is the single place the bridge may call verifyBlockToken. A second call ` +
        'there is a second predicate, which is how the thirteen open-coded copies this ' +
        'replaced came to disagree with each other.'
    ).toBe(1);
  });

  it('still SPELLS the two checks the guard exists for', () => {
    const guard = read(GUARD);
    // 🔴 THIS IS A SPELLING CHECK, NOT A BEHAVIOURAL ONE — it asserts these three strings
    // are still present, and that is ALL it can see. It is walkable in both directions: a
    // semantically identical rewrite (`status === 'approved' ? … : throw`) FAILS it while
    // the behaviour is intact, and a comparison against the WRONG value spelled this way
    // PASSES it. So it cannot certify either check is correct — it only catches one
    // dropped wholesale while everything still type-checks.
    //
    // What actually pins the behaviour is `blocks.router.bridgeTokenGuard.test.ts` (a
    // different vitest project, which is why this cheap presence check exists at all). If
    // you are tempted to read this test as coverage, read that file instead.
    expect(guard).toMatch(/BlockRevocation\.isRevoked\(\s*claims\.blockInstanceId\s*\)/);
    expect(guard).toMatch(/appBlock\.findUnique/);
    expect(guard).toMatch(/status !== 'approved'/);
  });
});
