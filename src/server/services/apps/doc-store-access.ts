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
import {
  parseSubjectUserId,
  type BlockTokenClaims,
} from '~/server/middleware/block-scope.middleware';
import { isHubTokenClaims } from '~/server/services/block-token-subject';
import { isMatureContentRating } from '~/server/utils/server-domain';
import { allowMatureContentForCeiling } from '~/shared/constants/browsingLevel.constants';
import { isAppBlocksAuthorEnabled } from '~/server/services/app-blocks-flag';
import { resolveStrictAppBlockApproval } from '~/server/services/blocks/block-approval.service';
import { assertAppBlocksEnabledForTokenUser } from '~/server/services/blocks/block-token-access.service';
import { PUBLISHED_NS, reviewNamespace } from '~/server/services/apps/doc-store';
import type { DocStoreContext } from '~/server/services/apps/doc-store.types';
import {
  enforcedManifestOf,
  type EnforcedManifest,
} from '~/server/services/apps/doc-store-schema-major';
import {
  docStoreDependency,
  docStoreUnavailable,
  DocStoreError,
} from '~/server/services/apps/doc-store.types';
import type { SessionUser } from '~/types/session';
import {
  decideCollectionRead,
  type CollectionReadRefusal,
} from '~/server/services/apps/data-read-grant';
import { declaredStorage } from '~/server/services/apps/doc-store-declared';
import { getGrantedScopes } from '~/server/services/blocks/scope-grant.service';
import {
  APP_STORAGE_BASE_SCOPE,
  APP_STORAGE_IMPORT_FROM_RE,
  APP_STORAGE_IMPORT_SCOPE,
  APP_STORAGE_PUBLISH_SCOPE,
  type DeclaredStorageCollections,
  type DeclaredStorageImports,
} from '~/shared/constants/block-storage.constants';

// Declared here first; moved so `data-read-grant.ts` can read it without importing this module.
export { declaredCollections, declaredStorage } from '~/server/services/apps/doc-store-declared';

export type StorageAccess = {
  ctx: DocStoreContext;
  /**
   * The blockId of the app whose storage this is (`ctx.appId` is its internal id): the source
   * app's, through an import. What a permission hook is told the app is (`doc-store-hook.ts`).
   */
  blockId: string;
  /** The token's scopes AFTER the middleware's consent strip. */
  scopes: readonly string[];
  /** The consent marker was unreadable, so every consent-gated scope was stripped. */
  consentUnavailable: boolean;
  collections: DeclaredStorageCollections;
  /** The imports this app's reviewed manifest declares (source blockId → import). */
  imports: DeclaredStorageImports;
  /**
   * Which kind of token this is: only an ordinary `app` token may import (`resolveImportAccess`).
   * `hub` is a hub-issued OAuth bearer of an approved app; `dev` any token carrying `dev: true`
   * (the dev-token route, the tunnels — including a tunnel's hub bearer); `review` the
   * run-for-real review mint.
   */
  tokenKind: 'app' | 'dev' | 'hub' | 'review';
  /** The token's maturity ceiling (`maxBrowsingLevel` claim): which sources' ratings it may reach. */
  maxBrowsingLevel?: number;
  /** Set when this access was resolved through an import: the source app's blockId. */
  importedFrom?: string;
  /**
   * With `importedFrom`: the CONSUMER's blockId, the app the call came through. A permission
   * hook sees it as `from`. Never the consumer's internal id.
   */
  importer?: string;
  /** With `importedFrom`: the import's access. A `read` import refuses every write. */
  importAccess?: 'read' | 'readwrite';
  /**
   * The approved app's enforced manifest (`app_blocks.manifest`) that `collections` were parsed
   * from, with its row's revision — the source app's, through an import. What a production
   * write's schema major is derived against (`doc-store-schema-major.ts`). Unset for a review
   * token.
   */
  enforcedManifest?: EnforcedManifest;
};

const notEligible = (reason: string, message: string) =>
  new DocStoreError('not_eligible', message, { reason });

const unavailable = docStoreUnavailable;
const dependency = docStoreDependency;

/**
 * Whether a token with this `maxBrowsingLevel` claim may reach an app rated `rating`: the mint's
 * rule (`isMatureContentRating`, refused off a red-capable host) read from the ceiling the mint
 * derived from that host (`allowMatureContentForCeiling`). An absent claim is the SFW ceiling.
 */
function ratingAllowedForCeiling(rating: unknown, maxBrowsingLevel: number | undefined): boolean {
  if (!isMatureContentRating(typeof rating === 'string' ? rating : null)) return true;
  if (typeof maxBrowsingLevel !== 'number' || !Number.isFinite(maxBrowsingLevel)) return false;
  return allowMatureContentForCeiling(maxBrowsingLevel) !== false;
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
  const base = {
    scopes: claims.scopes,
    consentUnavailable: opts.consentUnavailable,
    maxBrowsingLevel: claims.maxBrowsingLevel,
  };

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
      blockId: claims.blockId,
      tokenKind: 'review',
      ctx: {
        appId: publishRequestId,
        ns: reviewNamespace(publishRequestId, viewerUid),
        viewerUid,
      },
      ...declaredStorage(publishRequestId, pr.manifest),
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
      select: { manifest: true, updatedAt: true },
    })
  );
  return {
    ...base,
    blockId: claims.blockId,
    tokenKind: claims.dev === true ? 'dev' : isHubTokenClaims(claims) ? 'hub' : 'app',
    ctx: { appId: approval.appBlockId, ns, viewerUid },
    ...declaredStorage(approval.appBlockId, row?.manifest),
    enforcedManifest: enforcedManifestOf(row),
  };
}

/**
 * What one call through an import does: `read`; `delete`; or `author` (create, put, a counter or
 * a mark). A `read` import refuses everything but `read`; only `author` can need the viewer's
 * publish consent in the source, so only it reads that consent.
 */
export type ImportOp = 'read' | 'delete' | 'author';

/** A collection-read refusal through an import, as the document store answers it. */
function importRefusal(
  reason: CollectionReadRefusal,
  from: string,
  collection: string
): DocStoreError {
  switch (reason) {
    case 'source_not_approved':
      return notEligible('source_not_approved', `the app ${from} is not available`);
    case 'import_self':
      return new DocStoreError('import_not_declared', 'an app cannot import from itself', { from });
    case 'import_not_declared':
      return new DocStoreError(
        'import_not_declared',
        `this app does not declare an import of ${collection} from ${from}`,
        { from, collection }
      );
    case 'source_rating':
      return notEligible('import_source_rating', `the app ${from} is not available on this site`);
    case 'collection_not_declared':
      return new DocStoreError(
        'collection_not_declared',
        `collection ${collection} is not declared by ${from}`,
        { collection, from }
      );
    case 'not_exportable':
      return new DocStoreError(
        'not_exportable',
        `${from} does not share ${collection} with other apps`,
        {
          collection,
          from,
        }
      );
    case 'import_scope_unavailable':
      return new DocStoreError(
        'consent_unavailable',
        'permission state is temporarily unavailable',
        {
          retryAfter: 1,
        }
      );
    case 'import_scope_missing':
    case 'import_not_granted':
      return new DocStoreError(
        'consent_required',
        `${APP_STORAGE_IMPORT_SCOPE} has not been granted`,
        {
          scope: APP_STORAGE_IMPORT_SCOPE,
          from,
        }
      );
    default:
      // Reached only without `via` (the consumer resolved from a client id), never from here.
      return notEligible(reason, 'this app cannot reach another app');
  }
}

/**
 * The SOURCE app's access for one collection call through an import, for the same viewer, or a
 * refusal (each check runs before any read the next one needs). An import grant is not publish
 * consent in the source: the result carries `apps:storage:publish` only when the viewer granted
 * it to the SOURCE app themselves. The consumer's own publish grant is never consulted.
 */
export async function resolveImportAccess(
  consumer: StorageAccess,
  args: { from: string; collection: string; op: ImportOp }
): Promise<StorageAccess> {
  const { from, collection, op } = args;
  if (!APP_STORAGE_IMPORT_FROM_RE.test(from)) {
    throw new DocStoreError('invalid_request', 'from must be an app blockId', { from });
  }
  if (consumer.tokenKind === 'review') {
    throw notEligible('import_in_review', 'a review preview cannot reach another app');
  }
  if (consumer.tokenKind === 'dev') {
    throw notEligible('import_dev_token', 'a development token cannot reach another app');
  }
  if (consumer.tokenKind === 'hub') {
    throw notEligible('import_hub_token', 'a hub token cannot reach another app');
  }
  // The predicate checks this too; it is read here first because the write check below needs the
  // declared access, and both answer before any database read.
  const declared = consumer.imports.get(from);
  if (!declared || !declared.collections.has(collection)) {
    throw importRefusal('import_not_declared', from, collection);
  }
  if (op !== 'read' && declared.access === 'read') {
    throw new DocStoreError('write_policy', `the import from ${from} is read-only`, {
      from,
      reason: 'import_read_only',
    });
  }
  const viewerUid = consumer.ctx.viewerUid;
  if (viewerUid === null) throw new DocStoreError('sign_in_required', 'sign in required');

  // Everything else is the one collection-read rule (`data-read-grant.ts`), with this token's
  // consumer and consent as the middleware verified them.
  const decision = await decideCollectionRead(
    {
      userId: viewerUid,
      // Unused through `via`: the consumer is the token's, and the basis can only be an import.
      clientId: '',
      matureAllowed: (rating) => ratingAllowedForCeiling(rating, consumer.maxBrowsingLevel),
    },
    { sourceBlockId: from, collection },
    {
      appBlockId: consumer.ctx.appId,
      imports: consumer.imports,
      importScope: consumer.scopes.includes(APP_STORAGE_IMPORT_SCOPE)
        ? 'held'
        : consumer.consentUnavailable
        ? 'unavailable'
        : 'missing',
    }
  );
  if (!decision.ok) throw importRefusal(decision.reason, from, collection);
  const source = decision.source;

  if (consumer.ctx.ns !== PUBLISHED_NS) {
    throw notEligible('import_namespace', 'this token cannot reach another app');
  }
  // The viewer's own publish consent in the SOURCE, read only for a call that could use it.
  const publishes =
    op === 'author' &&
    declared.access === 'readwrite' &&
    (
      await dependency(getGrantedScopes({ userId: viewerUid, appBlockId: source.id, db: 'write' }))
    ).has(APP_STORAGE_PUBLISH_SCOPE);
  return {
    ctx: { appId: source.id, ns: PUBLISHED_NS, viewerUid },
    blockId: from,
    scopes: publishes
      ? [APP_STORAGE_BASE_SCOPE, APP_STORAGE_PUBLISH_SCOPE]
      : [APP_STORAGE_BASE_SCOPE],
    consentUnavailable: false,
    collections: source.collections,
    // An import is one hop: a source's own imports are never followed.
    imports: new Map(),
    tokenKind: consumer.tokenKind,
    maxBrowsingLevel: consumer.maxBrowsingLevel,
    importedFrom: from,
    importer: consumer.blockId,
    importAccess: declared.access,
    enforcedManifest: enforcedManifestOf(source),
  };
}
