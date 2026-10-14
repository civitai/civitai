// Resolves who is calling the document-store routes, and in which app and namespace,
// from the VERIFIED block token only. Nothing here reads request input: the token's
// claims arrive already verified, revocation-checked and consent-stripped by
// `withBlockScope` (`block-scope.middleware.ts`), and everything below derives from them
// and from the app's own reviewed manifest.
//
//   token kind                          app id                   ns
//   ordinary (approved app)             the approved AppBlock.id `prod`
//   `dev` (approved app)                the approved AppBlock.id `dev:<viewer uid>`
//   `reviewRunForReal` (pending review) the publish request id   `rev:<publish request id>`
//
// The approved-row read is `resolveStrictAppBlockApproval`, the storage resolvers' one
// strict predicate: a token for an app that is not approved (including the owner dev
// tunnel and private-run exemptions `withBlockScope` admits) gets no storage. The
// declared collections come from the APPROVED manifest (the PENDING one for a review
// token), parsed by the same `parseManifestStorage` the submit validator runs.
import { TRPCError } from '@trpc/server';
import { sessionClient } from '~/server/auth/session-client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  parseSubjectUserId,
  type BlockTokenClaims,
} from '~/server/middleware/block-scope.middleware';
import { isAppBlocksAuthorEnabled } from '~/server/services/app-blocks-flag';
import { resolveStrictAppBlockApproval } from '~/server/services/blocks/block-approval.service';
import { assertAppBlocksEnabledForTokenUser } from '~/server/services/blocks/block-token-access.service';
import type { DocStoreContext } from '~/server/services/apps/doc-store.types';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import type { SessionUser } from '~/types/session';
import {
  parseManifestStorage,
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
    throw err;
  }
}

export async function resolveStorageAccess(
  claims: BlockTokenClaims,
  opts: { consentUnavailable: boolean }
): Promise<StorageAccess> {
  const viewerUid = viewerOf(claims);
  const base = { scopes: claims.scopes, consentUnavailable: opts.consentUnavailable };

  // A moderator running a PENDING app for real: a disposable namespace per publish request,
  // live only while the request is pending (read from the primary, so a just-landed decision
  // is not missed), declared by the pending manifest.
  if (claims.reviewRunForReal === true) {
    if (viewerUid === null) throw new DocStoreError('sign_in_required', 'sign in required');
    const publishRequestId = claims.appBlockId;
    const pr = await dbWrite.appBlockPublishRequest.findUnique({
      where: { id: publishRequestId },
      select: { status: true, manifest: true },
    });
    if (!pr || pr.status !== 'pending') {
      throw notEligible('review_inactive', 'review preview is no longer active for this request');
    }
    const user = (await sessionClient.getSessionUserById(viewerUid)) as SessionUser | null;
    if (!user || !(await isAppBlocksAuthorEnabled({ user }))) {
      throw notEligible('author_required', 'apps authoring is not enabled for this account');
    }
    return {
      ...base,
      ctx: { appId: publishRequestId, ns: `rev:${publishRequestId}`, viewerUid },
      collections: parseManifestStorage(pr.manifest).collections,
    };
  }

  const approval = await resolveStrictAppBlockApproval(claims);
  if (approval.verdict !== 'approved') {
    throw notEligible('app_not_approved', 'app block is not approved');
  }
  if (viewerUid !== null) await assertRunEnabled(viewerUid);

  let ns = 'prod';
  if (claims.dev === true) {
    // The dev namespace is per developer, so it needs one.
    if (viewerUid === null) throw new DocStoreError('sign_in_required', 'sign in required');
    ns = `dev:${viewerUid}`;
  }
  const row = await dbRead.appBlock.findUnique({
    where: { id: approval.appBlockId },
    select: { manifest: true },
  });
  return {
    ...base,
    ctx: { appId: approval.appBlockId, ns, viewerUid },
    collections: parseManifestStorage(row?.manifest).collections,
  };
}
