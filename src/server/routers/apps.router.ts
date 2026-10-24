import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { appsSharedRouter, appsModRouter } from '~/server/routers/apps-shared.router';
import {
  appStorageKeyInput,
  appStorageListInput,
  appStorageSetInput,
  deleteAppStorageValue,
  getAppStorageQuota,
  getAppStorageValue,
  listAppStorageKeys,
  setAppStorageValue,
} from '~/server/services/apps/app-storage.service';
import { middleware, publicProcedure, router } from '~/server/trpc';

/**
 * The postMessage-BRIDGE adapter for per-viewer app storage.
 *
 * 🔴 THIS FILE HOLDS NO IMPLEMENTATION, DELIBERATELY. Every control — the token
 * verification, the approved-block check, the per-op scope assertion, the
 * per-subject kill-switch, the byte and row ceilings, the stored-vs-wire unit
 * handling, the activity rows — lives in
 * `~/server/services/apps/app-storage.service`, and BOTH transports call it:
 * these five procedures for the bridge, and `/api/v1/blocks/app-storage/*` for
 * REST. See that module's `APP STORAGE: ONE BODY, TWO TRANSPORTS` header for why
 * the REST twins call the functions directly rather than going through a tRPC
 * caller the way the workflow routes do.
 *
 * WHY THE IMPLEMENTATION MOVED OUT. It used to live in this file, which made
 * `apps.router.ts` the only way to reach it — and importing this module
 * module-evaluates `appsRouter`, i.e. `appsSharedRouter` AND the moderator
 * router `appsModRouter` and their whole transitive service graph. A REST route
 * that imported its own implementation from here would drag all of that into its
 * cold start for no reason, and would make the route unimportable by the
 * lightweight wiring tests that evaluate every scoped route purely to capture
 * its options literal (`scoped-endpoints-cors-wiring.test.ts` — MEASURED: it
 * failed on a missing `appsSharedRouter` export the moment a route imported this
 * file). The split is what keeps the route graph honest; it is the same concern
 * `block-workflow-rest.ts` records for narrowing its caller to `blocksRouter`.
 */

/**
 * The SESSION-user capability gate: `app-blocks-enabled` evaluated against `ctx.user` — the
 * browser session on the host page — BEFORE the resolver, so before any block-token
 * verification and before any `AppBlock` lookup.
 *
 * 🔴 ITS MESSAGE IS DELIBERATELY UNIQUE AND MUST STAY UNIQUE. The storage path has a SECOND
 * capability gate — `assertAppBlocksEnabledForTokenUser` in
 * `~/server/services/apps/app-storage.service`, on the block token's SUBJECT — and the two
 * used to throw a byte-identical `UNAUTHORIZED: 'Apps are not enabled'` with no `cause`.
 * `~/server/trpc/error-formatter` surfaces nothing else at 401 (`getClientSafeError` fires
 * only at `status >= 500 && status !== 503`), so a 401 on this path could not be attributed
 * to either gate. The message is now the discriminator, per this repo's own convention for
 * the shape — `~/server/services/blocks/user-settings.service`: "If you add another refusal
 * of this shape, give it text no other one uses".
 *
 * 🔴 PATH-LOCAL, NOT APP-WIDE. This string is unique app-wide; the one it was separated FROM
 * is not — `'Apps are not enabled'` is still thrown by the two same-named middlewares in
 * `blocks.router.ts` and `app-listings.router.ts`, by `block-token-access.service.ts`, and
 * served by a dozen REST handlers. So a 401 carrying the OTHER string is attributable only
 * within the storage path.
 *
 * It reaches the BLOCK too, not just an operator — both hosts forward a storage error's
 * message verbatim into the `APP_STORAGE_*_RESULT` postMessage. Hence the sentence-case
 * capability register of `'Apps authoring is not enabled for this account'`, and hence a
 * wording that does not assert a session user EXISTS: on the anon branch below there is none.
 *
 * Queries AND mutations refuse: anything else gives the block a misleading-success path. The
 * block already gates its own UI on host signals, so a clean UNAUTHORIZED is fine.
 *
 * NOT fail-closed on an anon viewer, deliberately: these are `publicProcedure`s, so
 * `ctx.user` may be undefined and `isAppBlocksEnabled` then performs a GLOBAL eval. Flipt
 * answers an unmatched rollout with the flag's own base `enabled` value, so that branch
 * refuses today only because `app-blocks-enabled` is base-`false`, and would ADMIT at a
 * base-`enabled: true` flip. Measured against the real wasm engine in
 * `~/server/services/__tests__/app-blocks-flag.base-enabled-flip.test.ts`; the service's
 * subject gate null-checks explicitly for exactly this reason.
 */
const enforceAppBlocksFlag = middleware(async ({ ctx, next }) => {
  if (await isAppBlocksEnabled({ user: ctx.user })) return next();
  throw new TRPCError({
    code: 'UNAUTHORIZED',
    message: 'Apps access is not enabled for this browser session',
  });
});

/**
 * 🔴 GATED BY CONSTRUCTION — attach every storage procedure to THIS, never to a bare
 * `publicProcedure`. The repo idiom (`promotionProcedure` in `promotion.router.ts`,
 * `comicPublicProcedure` in `comics.router.ts`): the gate rides on the procedure rather than
 * being repeated per route, so a procedure added here cannot be ungated by omission. This
 * constant is the file's ONLY use of `publicProcedure`, so a bare one below stands out.
 * Measured before this: dropping the gate from `set` alone was green across every suite that
 * names this router.
 */
const appStorageProcedure = publicProcedure.use(enforceAppBlocksFlag);

/**
 * `blockToken` rides INSIDE the input on this transport; on REST it rides in the
 * `Authorization` header. That is the one field the two transports spell
 * differently, which is why it is merged in here rather than living in the
 * shared per-op shapes.
 */
const blockTokenInput = z.object({ blockToken: z.string().min(1) });

export const appsStorageRouter = router({
  /**
   * Read a key for the (block_instance, user) tuple. Returns null when
   * the key doesn't exist OR when the viewer is anon (no per-anon
   * storage in v0). Treating anon as a clean-null lets blocks render
   * defaults without a 401 round-trip.
   */
  get: appStorageProcedure
    .input(blockTokenInput.merge(appStorageKeyInput))
    .query(async ({ input }) => getAppStorageValue(input.blockToken, input.key)),

  /**
   * Upsert a value. Validates 64KB per-value cap pre-flight, then checks
   * the running quota; the trigger function updates the quota row after
   * the write lands so subsequent calls see fresh used_bytes. Anon
   * writers hit UNAUTHORIZED — anon viewers have no stable identifier
   * to scope writes to.
   */
  set: appStorageProcedure
    .input(blockTokenInput.merge(appStorageSetInput))
    .mutation(async ({ input }) => setAppStorageValue(input.blockToken, input.key, input.value)),

  delete: appStorageProcedure
    .input(blockTokenInput.merge(appStorageKeyInput))
    .mutation(async ({ input }) => deleteAppStorageValue(input.blockToken, input.key)),

  /**
   * Cursor-paginated key list for the (block_instance, user) tuple.
   * Returns key + updated_at only — values are fetched on demand via
   * `get(key)`. `cursor` is the base64 of the last key returned;
   * `nextCursor` is undefined when fewer than `limit` rows came back.
   */
  list: appStorageProcedure
    .input(blockTokenInput.merge(appStorageListInput))
    .query(async ({ input }) => listAppStorageKeys(input.blockToken, input)),

  /**
   * The CALLER'S OWN usage against their own caps, so a settings panel can show
   * "used 12 KB of 2 MB" without hard-coding the cap on the client.
   *
   * Deliberately NOT the app-wide aggregate it used to return. This procedure is
   * reachable by everyone who may RUN the app, and the app aggregate sums other
   * users' rows — a cross-user readout on the one surface whose entire invariant
   * is that a caller only ever sees their own data. It was not actionable either:
   * only the owning user can delete their own rows, so a consumer shown "49 of
   * 50 MB used" cannot free any of it.
   *
   * `AppStorageProvisioner.getQuota` still computes the app aggregate, and this
   * used to say it was "retained for the moderator surface". That was wrong on
   * the facts: it has NO production caller at all — verified 2026-09-09, the only
   * references anywhere are its own definition and its unit tests, and
   * `appsModRouter` exposes no storage-usage readout. Why it is still here is not
   * recorded anywhere, so no reason is asserted for it; it is simply unreferenced.
   *
   * The consequence is worth stating rather than implying: after this change
   * NOTHING reports how close an app is to its 50MB / 1M-row ceiling, so the app
   * ceilings are observable only through
   * `civitai_app_block_storage_quota_exceeded_total` (`ceiling="app"`) firing
   * after the fact. That is the exposed Prometheus name, not the declared one —
   * the declaration in `@civitai/telemetry` is prefix-relative.
   *
   * Field names are unchanged, so the host bridge and the SDK's
   * APP_STORAGE_QUOTA_RESULT contract carry through untouched; what moved is the
   * scope each number describes.
   */
  getQuota: appStorageProcedure
    .input(blockTokenInput)
    .query(async ({ input }) => getAppStorageQuota(input.blockToken)),
});

export const appsRouter = router({
  storage: appsStorageRouter,
  // SHARED (app-global / cross-user) storage — the public-write surface (voting +
  // community lists). Block-token authed with its OWN resolver (resolveSharedContext:
  // trust gate, NOT the app-author gate) + dedicated fail-closed flag. See
  // apps-shared.router.ts.
  shared: appsSharedRouter,
  // Cross-app moderator surface for shared storage (session moderatorProcedure —
  // NOT block-token reachable). Purge/hide any shared row + file a report.
  mod: appsModRouter,
});
