import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcQuery } from './preview-trpc';

/**
 * Preview-e2e (F / Phase 3 git-push self-service): App Blocks `getMyAppRepo`
 * OWNER-GATE + endpoint wiring. Proves the SECURITY-CRITICAL property — a
 * logged-in NON-OWNER cannot mint a push credential for someone else's app — and
 * that the proc is reachable, WITHOUT polluting the SHARED Forgejo.
 *
 * Runs as the `mod` fixture (id 2000000001, ci-smoke-mod): `getMyAppRepo` is a
 * `protectedProcedure` gated by `features.appBlocks` (the Flipt mod segment), so
 * a non-mod tester would be UNAUTHORIZED/FORBIDDEN before the owner check even
 * runs and the gate under test would be untestable. mod is also rate-limit-exempt
 * and clears the flag. Crucially, the `mod` fixture is NOT the owner of the apps
 * `listAvailable` surfaces (those are real prod-clone apps owned by other users),
 * so calling getMyAppRepo on one exercises the NON-OWNER path → FORBIDDEN.
 *
 * --- THE PROVISIONING HAPPY-PATH IS INTENTIONALLY NOT E2E'd HERE -------------
 * The OWNER happy-path (status='approved' + caller IS the owner) is deliberately
 * NOT covered, for the same reason the publish spec defers approve→build→render
 * and the install spec defers generate/buzz: a successful getMyAppRepo call
 * `ensureForgejoIdentity(userId)` — it CREATES a real `dev-<userId>` user on the
 * SHARED Forgejo instance and grants it `write` collaborator on the app repo
 * (blocks.router.ts getMyAppRepo → dev-git-access.service + forgejo.service). That
 * is durable, side-effecting state on shared infra with NO cheap teardown (needs
 * Forgejo admin), so an automated preview run must never trigger it. The full
 * provisioning path (real Forgejo user + scoped token + git push → parked review
 * request, never auto-deploying) is verified by the UNIT suite (dev-git-access /
 * forgejo / git-push gate tests) + a MANUAL preview check — exactly the Phase-1
 * approve→render exclusion and the publish spec's approve exclusion.
 *
 * This spec therefore covers what IS safely automatable: the owner-gate (a
 * non-owner is rejected BEFORE any Forgejo side effect — the owner check throws
 * first) + the NOT_FOUND wiring for a bogus id. Both reject before
 * ensureForgejoIdentity is ever reached, so neither touches Forgejo.
 *
 * Verified shapes (against the worktree's blocks.router.ts, paths rel. to civitai/src):
 *  - blocks.listAvailable (publicProcedure + flag + 60/60 rateLimit; input
 *    listAvailableSchema, `{}` valid) → `{ items: AvailableBlock[]; nextCursor? }`
 *    (NOT a bare array). Each item's `id` is the appBlockId. Used to discover an
 *    id the mod does NOT own (skip-if-empty, annotated). The returned apps are
 *    `status='approved'` (the registry filters), which is also what drives
 *    getMyAppRepo PAST the not-yet-available short-circuit and INTO the owner gate.
 *  - blocks.getMyAppRepo (blocks.router.ts getMyAppRepo, protectedProcedure +
 *    enforceAppBlocksFlag; input { appBlockId: string (1..64) }):
 *      • caller is NOT the app owner → throws TRPCError FORBIDDEN ('Not the app
 *        owner'). The owner check (block.app.userId !== ctx.user.id) runs BEFORE
 *        ensureForgejoIdentity, so NO Forgejo user/collaborator is created.
 *      • unknown appBlockId → throws NOT_FOUND ('App block not found') via
 *        throwNotFoundError, before any owner/Forgejo logic.
 *      • (owner + approved → { notYetAvailable:false, cloneUrl, httpUrl,
 *        forgejoUsername, instructions, firstVersionIsZip:false } — NOT asserted
 *        here; see the exclusion note above.)
 */

const ROLE = 'mod' as const;

type AvailableBlock = { id: string };
type ListAvailableResult = { items: AvailableBlock[]; nextCursor?: string };

// The tRPC v11 (superjson) error envelope for a batched GET:
//   [{ error: { json: { message, code (numeric), data: { code: string,
//      httpStatus } } } }]
// We read the human-readable `data.code` ('FORBIDDEN' / 'NOT_FOUND').
type TrpcErrorEnvelope = {
  error?: { json?: { message?: string; data?: { code?: string; httpStatus?: number } } };
};

/**
 * Raw batched-GET call to a tRPC query that we EXPECT to error, returning the
 * parsed error code + message. The shared `trpcQuery` helper throws on a tRPC
 * error (good for happy-path), but to assert the ERROR CODE deterministically we
 * inspect the envelope ourselves. Mirrors preview-trpc's batched wire format +
 * CSRF (Origin/Referer) stamping.
 */
async function trpcQueryExpectError(
  request: APIRequestContext,
  proc: string,
  input: unknown,
  previewUrl: string
): Promise<{ code: string | undefined; message: string | undefined; httpStatus: number }> {
  const enc = encodeURIComponent(JSON.stringify({ '0': { json: input } }));
  const res = await request.get(`/api/trpc/${proc}?batch=1&input=${enc}`, {
    headers: { origin: previewUrl, referer: `${previewUrl}/` },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  const entry = (Array.isArray(body) ? body[0] : body) as TrpcErrorEnvelope;
  return {
    code: entry?.error?.json?.data?.code,
    message: entry?.error?.json?.message,
    httpStatus: res.status(),
  };
}

test.describe('App Blocks getMyAppRepo owner-gate + wiring (mod, no Forgejo side effects)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('non-owner → FORBIDDEN; unknown id → NOT_FOUND (no credential minted)', async ({
    page,
  }) => {
    const previewUrl = process.env.PREVIEW_URL ?? '';

    // Warm the request context against the preview origin so page.request shares
    // the mod auth cookie + a navigated origin (the CSRF gate needs Origin/Referer
    // host allowlisted; NEXTAUTH_URL == the preview URL). domcontentloaded ONLY —
    // never networkidle.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const request = page.request;

    // DISCOVER an approved appBlockId the mod does NOT own (never hardcode — the
    // weekly prod clone's approved set varies, and could be empty → skip).
    const listing = await trpcQuery<ListAvailableResult>(request, 'blocks.listAvailable', {});
    const blocks = listing?.items ?? [];
    test.skip(
      blocks.length === 0,
      'No approved app blocks in this dev-DB clone — nothing to probe the owner-gate against (the weekly prod clone can have zero). Skipping rather than hard-failing.'
    );
    const appBlockId = blocks[0].id;
    expect(typeof appBlockId, 'discovered appBlockId should be a string').toBe('string');

    // OWNER-GATE: the mod fixture is NOT the owner of this prod-clone app, so
    // getMyAppRepo must reject with FORBIDDEN. This is the security-critical
    // assertion: a logged-in non-owner is denied a push credential. The owner
    // check throws BEFORE ensureForgejoIdentity, so this creates NO Forgejo user
    // and grants NO collaborator — safe to run automated against shared infra.
    const forbidden = await trpcQueryExpectError(
      request,
      'blocks.getMyAppRepo',
      { appBlockId },
      previewUrl
    );
    expect(
      forbidden.code,
      `getMyAppRepo on an app the mod does not own should be FORBIDDEN (was: ${forbidden.code} / "${forbidden.message}")`
    ).toBe('FORBIDDEN');

    // WIRING: an unknown appBlockId resolves to no AppBlock row → NOT_FOUND,
    // thrown before any owner/Forgejo logic. A non-existent-but-charset-valid id.
    const bogusId = `ci-smoke-nope-${Date.now()}`.slice(0, 64);
    const notFound = await trpcQueryExpectError(
      request,
      'blocks.getMyAppRepo',
      { appBlockId: bogusId },
      previewUrl
    );
    expect(
      notFound.code,
      `getMyAppRepo on a non-existent appBlockId should be NOT_FOUND (was: ${notFound.code} / "${notFound.message}")`
    ).toBe('NOT_FOUND');
  });
});
