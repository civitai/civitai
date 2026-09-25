// Setup-order import: installs the ~/env/server mock with the real test RSA keypair
// BEFORE block-token.service / the middleware evaluate env at module load (same posture as
// block-scope.anytoken-mode.test.ts).
import '~/__tests__/setup';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { verifyBlockToken } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';

/**
 * THE SEAM `BlockManifestValidator` now refuses at submit time, pinned so the refusal is
 * not the only place the reason is written down.
 *
 * `withBlockScope` accepts BOTH token kinds — a block JWS goes to `verifyBlockToken`, an
 * opaque bearer to `resolveHubTokenClaims` — and stashes the resolved claims on
 * `req.blockClaims`. Every block REST route then reads `req.blockClaims` and is kind-
 * agnostic, EXCEPT the eleven `/api/v1/blocks/shared-storage/*` routes, which check
 * `req.blockClaims` for presence and then hand the RAW bearer back down to
 * `resolveSharedContext`, where `verifyBlockToken` runs a SECOND time. That second
 * verification understands one kind only, so the middleware admits an OAuth token and the
 * router refuses it: 401 on every shared-storage read and write.
 *
 * The failure shape is the worst available one, which is why the manifest guard exists.
 * `/api/v1/block-tokens` mints an OAuth access token only when `userId != null`, so an
 * ANONYMOUS viewer of an `auth: "oauth"` app still gets a block JWT and the whole storage
 * surface works — and then breaks completely the moment anyone signs in.
 *
 * ⚠️ HONEST LABEL: suites 1 and 2 are INVARIANT guards, not regression tests — the
 * behaviour they pin is the CURRENT behaviour and this commit does not change it. They
 * exist so the manifest guard's premise is machine-checked rather than asserted in prose,
 * and so the fix direction (teach the resolvers to take middleware-resolved claims) cannot
 * land half-way without something going red. The commit's actual red→green test is in
 * `src/server/services/__tests__/block-manifest-validator.service.test.ts`.
 *
 * 🔴 Nothing here has been exercised against a live civitai host.
 */

const REPO_SRC = path.resolve(__dirname, '../../..');
const SHARED_STORAGE_DIR = path.join(REPO_SRC, 'pages/api/v1/blocks/shared-storage');

/**
 * Realistic OAuth-access-token shapes. `@civitai/auth`'s `mintAppToken` returns the auth
 * service's opaque `access_token`, stored as a hashed `ApiKey` row — so the wire value is
 * an opaque secret, NOT a JWS. Hex is what this repo's own `generateKey`
 * (`packages/civitai-auth/src/secret-hash.ts`) produces.
 *
 * 🔴 The dotted entries are the adversarial half, not padding: `isBlockJwt` exists
 * precisely to stop the middleware trying to RS256-verify "an opaque API key that happens
 * to contain two dots", so a fixture set of dot-free strings would leave the interesting
 * branch untested.
 */
const OPAQUE_OAUTH_BEARERS: ReadonlyArray<[label: string, token: string]> = [
  ['64-char hex, the shape generateKey emits', 'a'.repeat(32) + 'b'.repeat(32)],
  ['base64url-ish opaque secret', 'v2_7SdQ0xZk-LmN3pR8tYuI1oP4aS6dF9gH2jK5lZxCvBnM'],
  ['opaque secret carrying two dots (the isBlockJwt trap)', 'oauth.access.token-9f2c4e'],
  ['three dotted segments that are not base64url JSON', 'aaaa.bbbb.cccc'],
];

/**
 * Strips `/* … *␐/` and `// …` so the ledger below counts CALLS, not PROSE. This repo
 * documents its own seams heavily — `block-scope.constants.ts` names `verifyBlockToken` in
 * a docblock, and without this the ledger reported a fifth "call site" that is a comment.
 * Regex-crude on purpose: it can mis-handle a `//` inside a string literal, which is
 * harmless for identifier-plus-paren needles and is the only thing this helper is used for.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every production `.ts`/`.tsx` under `src/` whose text contains `needle`, as paths relative
 * to `src/`, sorted. Tests, `src/tests/` and `__tests__/` are excluded — a mocked
 * `verifyBlockToken` in a test file is not a call site, and counting them would make the
 * ledger churn on unrelated test work.
 *
 * Walks the tree with `node:fs` rather than shelling out to grep: this repo's interactive
 * `grep` is a ugrep wrapper that honours `.gitignore`, so a shell-out could return a
 * confident short list for a generated or ignored path.
 */
function productionFilesCalling(needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        if (abs === path.join(REPO_SRC, 'tests')) continue;
        walk(abs);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.(test|spec|browser\.test)\.tsx?$/.test(entry.name)) continue;
      if (stripComments(readFileSync(abs, 'utf8')).includes(needle)) {
        hits.push(path.relative(REPO_SRC, abs));
      }
    }
  };
  walk(REPO_SRC);
  return hits.sort();
}

async function mintRealBlockJwt(scopes: string[]): Promise<string> {
  const r = await BlockTokenService.sign({
    userId: 42,
    blockId: 'blk_test',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    scopes,
    ctx: { modelId: 1 },
    maxBrowsingLevel: 3,
    domain: 'green',
  });
  return r.token;
}

describe('block-token kind × app storage — the seam the manifest guard closes', () => {
  /**
   * 1. THE MECHANISM. `verifyBlockToken` requires a JWS whose header it can pin to a `kid`,
   *    deliberately and strictly (L-VERIFY). An opaque OAuth access token is not a JWS, so
   *    it can only ever be `null` here.
   *
   *    🔴 POSITIVE CONTROL FIRST. A verifier that returned `null` for everything — a wrong
   *    env keypair, a module that failed to load its signer — would make every rejection
   *    below pass while observing nothing. The control proves this instrument can say YES
   *    before any assertion reads a NO from it.
   */
  describe('1. verifyBlockToken is JWS-only (and must stay that way)', () => {
    it('POSITIVE CONTROL: accepts a REAL minted block JWT', async () => {
      const claims = await verifyBlockToken(await mintRealBlockJwt(['apps:storage:shared:read']));
      expect(claims).not.toBeNull();
      expect(claims?.blockId).toBe('blk_test');
      expect(claims?.scopes).toContain('apps:storage:shared:read');
    });

    it.each(OPAQUE_OAUTH_BEARERS)('rejects an opaque OAuth bearer (%s)', async (_label, token) => {
      await expect(verifyBlockToken(token)).resolves.toBeNull();
    });

    // 🔴 DO NOT "fix" the seam by loosening this. The JWT path's verification is the only
    // thing standing behind every block token in the fleet; the fix direction is to stop
    // re-verifying the bearer on these routes, never to widen what counts as verifiable.
    it('rejects a JWS-shaped token signed by nobody', async () => {
      const real = await mintRealBlockJwt([]);
      const [header, payload] = real.split('.');
      await expect(verifyBlockToken(`${header}.${payload}.not-a-signature`)).resolves.toBeNull();
    });
  });

  /**
   * 2. THE LEDGER — the relationship, not a component. Each side of this seam is fine
   *    alone: `withBlockScope` resolves both kinds correctly, and `verifyBlockToken`
   *    correctly refuses a non-JWS. The defect lives only in the COMBINATION, so the guard
   *    has to pin the combination.
   *
   *    Enforced on GROWTH AND SHRINK:
   *      - a TWELFTH route that re-passes the raw bearer fails this (the defect spreading),
   *      - a route DROPPING it fails this too (the fix landing part-way, which is when the
   *        manifest guard's premise stops being true and it should be reconsidered).
   *
   *    When the fix lands, this ledger is what tells you whether the manifest guard can be
   *    lifted: an empty set means no app-storage route re-verifies the bearer any more.
   */
  describe('2. the routes that re-verify the RAW bearer — an exact ledger', () => {
    const EXPECTED_REVERIFYING_ROUTES = [
      'append.ts',
      'counts.ts',
      'increment.ts',
      'item.ts',
      'list.ts',
      'report.ts',
      'top.ts',
      'unvote.ts',
      'update.ts',
      'vote.ts',
      'withdraw.ts',
    ];

    // Reads the directory rather than the expected list, so a NEW file is seen. Matches the
    // CALL `bearer(req)` — passing the raw token onward — not the helper's declaration,
    // which every one of these files also contains.
    const routesPassingRawBearer = (): string[] =>
      readdirSync(SHARED_STORAGE_DIR)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .filter((f) =>
          stripComments(readFileSync(path.join(SHARED_STORAGE_DIR, f), 'utf8')).includes(
            '(bearer(req)'
          )
        )
        .sort();

    it('is EXACTLY these eleven shared-storage routes', () => {
      expect(routesPassingRawBearer()).toEqual([...EXPECTED_REVERIFYING_ROUTES].sort());
    });

    // POSITIVE CONTROL for the scanner: `blocks/me.ts` is a block REST route that reads
    // `req.blockClaims` and never re-passes the bearer — the kind-agnostic shape every
    // other block route already has. If the matcher were wired to nothing, or matched the
    // `function bearer(req: NextApiRequest)` DECLARATION instead of the call, this pair
    // would not discriminate.
    it('DISCRIMINATES: blocks/me.ts (claims-only) is not in the set', () => {
      const me = stripComments(readFileSync(path.join(REPO_SRC, 'pages/api/v1/blocks/me.ts'), 'utf8'));
      expect(me).toContain('blockClaims');
      expect(me.includes('(bearer(req)')).toBe(false);
      // And the eleven DO carry the pattern the scanner looks for — the non-zero half of
      // the pair, so "0 matches" can never be read as "clean".
      expect(routesPassingRawBearer().length).toBe(EXPECTED_REVERIFYING_ROUTES.length);
    });

    /**
     * The four `verifyBlockToken` call sites, because THREE of them are the seam and one is
     * the legitimate kind-aware read. Named so a fifth cannot appear unnoticed:
     *   - `block-scope.middleware.ts`   — the ONE correct site: branches on token kind.
     *   - `apps-shared.router.ts`       — `resolveSharedContext`: shared storage, all 11
     *                                      REST routes + the tRPC bridge.
     *   - `apps/app-storage.service.ts` — `resolveStorageContext`: per-user storage. NOTE
     *                                      there is no REST route for it at all, so an
     *                                      `auth: "oauth"` app has no path to it by any
     *                                      surface — the second half of why the manifest
     *                                      guard covers `apps:storage:read/write` too.
     *   - `blocks/block-bridge-auth.service.ts` — the tRPC bridge gate for every OTHER
     *                                      bridge procedure. Out of scope for the manifest
     *                                      guard (it is not scope-specific), and recorded
     *                                      here because an `auth: "oauth"` app is expected
     *                                      to use REST, not the postMessage bridge.
     */
    it('pins the verifyBlockToken call sites — EXACTLY these four, production code only', () => {
      const EXPECTED_CALL_SITES = [
        'server/middleware/block-scope.middleware.ts',
        'server/routers/apps-shared.router.ts',
        'server/services/apps/app-storage.service.ts',
        'server/services/blocks/block-bridge-auth.service.ts',
      ].sort();

      // 🔴 ENUMERATES the tree — it does not check the expected files one by one. A
      // per-file `toContain` would claim to pin "the four call sites" while being blind to
      // a FIFTH, which is the whole failure this ledger exists to catch.
      expect(productionFilesCalling('verifyBlockToken(')).toEqual(EXPECTED_CALL_SITES);
    });

    // POSITIVE CONTROL for the tree walker: a pattern that MUST be found, and one that must
    // not. Without this pair, a walker that silently skipped every file (a wrong root, a
    // filter that excluded `.ts`) would report the empty set and read as "no call sites".
    it('DISCRIMINATES: the tree walker finds a known symbol and misses an absent one', () => {
      expect(productionFilesCalling('export function withBlockScope(')).toEqual([
        'server/middleware/block-scope.middleware.ts',
      ]);
      expect(productionFilesCalling('zzNotASymbolThatExistsAnywhere(')).toEqual([]);
    });
  });
});
