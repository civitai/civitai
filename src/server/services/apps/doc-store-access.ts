// Resolves who is calling the document-store routes, and in which app and namespace,
// from the VERIFIED block token only. Nothing here reads request input: the token's
// claims arrive already verified, revocation-checked and consent-stripped by
// `withBlockScope` (`block-scope.middleware.ts`), and everything below derives from them
// and from the app's own reviewed manifest.
//
//   token kind                          app id                   ns
//   ordinary (approved app)             the approved AppBlock.id `prod`
//   `dev` (approved app)                the approved AppBlock.id `dev:<viewer uid>`
//   `reviewRunForReal` (pending review) the publish request id   `rev:<publish request id>:<viewer uid>`
//
// The approved-row read is `resolveStrictAppBlockApproval`, the storage resolvers' one
// strict predicate: a token for an app that is not approved (including the owner dev
// tunnel and private-run exemptions `withBlockScope` admits) gets no storage. The
// declared collections come from the APPROVED manifest (the PENDING one for a review
// token), parsed by the same `parseManifestStorage` the submit validator runs but with every
// phased feature on: the store refuses a collection that uses a deferred feature at use, and
// a manifest that does not parse at all answers a retryable 503, never "nothing declared".
//
// The review branch is reached by the run-for-real review mint
// (`REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST`). Its namespace is per MODERATOR as well as per
// request, so a moderator's shared collections, marks and counters are shared only with
// themselves, and the request's review data is deleted when it leaves `pending`
// (`teardownReviewStorageForRequest` in `publish-request.service.ts`, and the sweep in
// `jobs/sweep-review-storage.ts`).
import { TRPCError } from '@trpc/server';
import { sessionClient } from '~/server/auth/session-client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { recordStorageManifestUnparseable } from '~/server/metrics/app-block-runtime.metrics';
import {
  parseSubjectUserId,
  type BlockTokenClaims,
} from '~/server/middleware/block-scope.middleware';
import { isAppBlocksAuthorEnabled } from '~/server/services/app-blocks-flag';
import { resolveStrictAppBlockApproval } from '~/server/services/blocks/block-approval.service';
import { assertAppBlocksEnabledForTokenUser } from '~/server/services/blocks/block-token-access.service';
import { PUBLISHED_NS, reviewNamespace } from '~/server/services/apps/doc-store';
import type { DocStoreContext } from '~/server/services/apps/doc-store.types';
import {
  docStoreDependency,
  docStoreUnavailable,
  DocStoreError,
} from '~/server/services/apps/doc-store.types';
import type { SessionUser } from '~/types/session';
import {
  APP_STORAGE_ENABLED_FEATURES,
  parseManifestStorage,
  type AppStorageFeature,
  type DeclaredStorageCollections,
} from '~/shared/constants/block-storage.constants';

export type StorageAccess = {
  ctx: DocStoreContext;
  /** The token's scopes AFTER the middleware's consent strip. */
  scopes: readonly string[];
  /** The consent marker was unreadable, so every consent-gated scope was stripped. */
  consentUnavailable: boolean;
  collections: DeclaredStorageCollections;
};

const notEligible = (reason: string, message: string) =>
  new DocStoreError('not_eligible', message, { reason });

const unavailable = docStoreUnavailable;
const dependency = docStoreDependency;

/**
 * Every phased feature ON: a reviewed manifest is parsed for SHAPE only, so what was approved
 * stays declared even when a feature it uses is switched off today. The store and the route
 * refuse an unsupported collection per collection, at use, and the others keep working.
 */
const ALL_FEATURES = Object.fromEntries(
  Object.keys(APP_STORAGE_ENABLED_FEATURES).map((f) => [f, true])
) as Record<AppStorageFeature, boolean>;

const loggedUnparseable = new Set<string>();

/** The declared collections, or a retryable 503 (logged once per app, counted every time). */
export function declaredCollections(appId: string, manifest: unknown): DeclaredStorageCollections {
  const parsed = parseManifestStorage(manifest, ALL_FEATURES);
  if (parsed.errors.length === 0) return parsed.collections;
  recordStorageManifestUnparseable();
  if (!loggedUnparseable.has(appId)) {
    loggedUnparseable.add(appId);
    logToAxiom(
      {
        name: 'app-blocks-doc-store-manifest-unparseable',
        type: 'error',
        appBlockId: appId,
        errors: parsed.errors.slice(0, 5),
      },
      'app-blocks'
    ).catch(() => undefined);
  }
  throw new DocStoreError('service_unavailable', 'storage is temporarily unavailable', {
    retryAfter: 30,
  });
}

/** The verified subject as a user id, or null for an anonymous token. */
function viewerOf(claims: BlockTokenClaims): number | null {
  try {
    return parseSubjectUserId(claims.sub);
  } catch {
    throw new DocStoreError('unauthenticated', 'invalid token subject');
  }
}

/** The App Blocks RUN gate on the token subject — the same one every block runtime proc uses. */
async function assertRunEnabled(uid: number): Promise<void> {
  try {
    await assertAppBlocksEnabledForTokenUser(uid);
  } catch (err) {
    if (err instanceof TRPCError) throw notEligible('apps_disabled', 'apps are not enabled');
    throw unavailable();
  }
}

export async function resolveStorageAccess(
  claims: BlockTokenClaims,
  opts: { consentUnavailable: boolean }
): Promise<StorageAccess> {
  const viewerUid = viewerOf(claims);
  const base = { scopes: claims.scopes, consentUnavailable: opts.consentUnavailable };

  // A moderator running a PENDING app for real: a disposable namespace per (publish request,
  // moderator), live only while the request is pending (read from the primary, so a
  // just-landed decision is not missed), declared by the pending manifest.
  if (claims.reviewRunForReal === true) {
    if (viewerUid === null) throw new DocStoreError('sign_in_required', 'sign in required');
    const publishRequestId = claims.appBlockId;
    const pr = await dependency(
      dbWrite.appBlockPublishRequest.findUnique({
        where: { id: publishRequestId },
        select: { status: true, manifest: true },
      })
    );
    if (!pr || pr.status !== 'pending') {
      throw notEligible('review_inactive', 'review preview is no longer active for this request');
    }
    const user = (await dependency(
      sessionClient.getSessionUserById(viewerUid)
    )) as SessionUser | null;
    if (!user || !(await dependency(isAppBlocksAuthorEnabled({ user })))) {
      throw notEligible('author_required', 'apps authoring is not enabled for this account');
    }
    return {
      ...base,
      ctx: {
        appId: publishRequestId,
        ns: reviewNamespace(publishRequestId, viewerUid),
        viewerUid,
      },
      collections: declaredCollections(publishRequestId, pr.manifest),
    };
  }

  const approval = await dependency(resolveStrictAppBlockApproval(claims));
  if (approval.verdict !== 'approved') {
    throw notEligible('app_not_approved', 'app block is not approved');
  }
  if (viewerUid !== null) await assertRunEnabled(viewerUid);

  let ns = PUBLISHED_NS;
  if (claims.dev === true) {
    // The dev namespace is per developer, so it needs one.
    if (viewerUid === null) throw new DocStoreError('sign_in_required', 'sign in required');
    ns = `dev:${viewerUid}`;
  }
  const row = await dependency(
    dbRead.appBlock.findUnique({
      where: { id: approval.appBlockId },
      select: { manifest: true },
    })
  );
  return {
    ...base,
    ctx: { appId: approval.appBlockId, ns, viewerUid },
    collections: declaredCollections(approval.appBlockId, row?.manifest),
  };
}
