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
// IMPORTS. A collection call that names another app (`from`, a blockId) is re-resolved by
// `resolveImportAccess` into that SOURCE app's access, so everything downstream — the namespace,
// the collection declaration, visibility, write policy, indexes, ceilings, rate limits and
// moderation mode — is the source's, for the same viewer. It refuses unless the consumer's
// approved manifest declares the import (`import_not_declared`), the source collection is
// exportable (`not_exportable`) and the viewer granted it (`consent_required`). Only an ordinary
// production token imports: a review, dev or hub token reaches no other app (`not_eligible`),
// so a consumer reaches the source's production data and nothing else.
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
import { isHubTokenClaims } from '~/server/services/block-token-subject';
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
  getStorageImportGrant,
  importGrantCovers,
} from '~/server/services/apps/storage-import-grant.service';
import { getGrantedScopes } from '~/server/services/blocks/scope-grant.service';
import {
  APP_STORAGE_BASE_SCOPE,
  APP_STORAGE_ENABLED_FEATURES,
  APP_STORAGE_IMPORT_FROM_RE,
  APP_STORAGE_IMPORT_SCOPE,
  APP_STORAGE_PUBLISH_SCOPE,
  isCollectionExportable,
  parseManifestStorage,
  type AppStorageFeature,
  type DeclaredStorageCollections,
  type DeclaredStorageImports,
} from '~/shared/constants/block-storage.constants';

export type StorageAccess = {
  ctx: DocStoreContext;
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
  /** Set when this access was resolved through an import: the source app's blockId. */
  importedFrom?: string;
  /** With `importedFrom`: the import's access. A `read` import refuses every write. */
  importAccess?: 'read' | 'readwrite';
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

/** The declared storage, or a retryable 503 (logged once per app, counted every time). */
export function declaredStorage(
  appId: string,
  manifest: unknown
): { collections: DeclaredStorageCollections; imports: DeclaredStorageImports } {
  const parsed = parseManifestStorage(manifest, ALL_FEATURES);
  if (parsed.errors.length === 0) {
    return { collections: parsed.collections, imports: parsed.imports };
  }
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

/** The declared collections, or a retryable 503 (see {@link declaredStorage}). */
export function declaredCollections(appId: string, manifest: unknown): DeclaredStorageCollections {
  return declaredStorage(appId, manifest).collections;
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
      select: { manifest: true },
    })
  );
  return {
    ...base,
    tokenKind: claims.dev === true ? 'dev' : isHubTokenClaims(claims) ? 'hub' : 'app',
    ctx: { appId: approval.appBlockId, ns, viewerUid },
    ...declaredStorage(approval.appBlockId, row?.manifest),
  };
}

/**
 * What one call through an import does: `read`; `delete`; or `author` (create, put, a counter or
 * a mark). A `read` import refuses everything but `read`; only `author` can need the viewer's
 * publish consent in the source, so only it reads that consent.
 */
export type ImportOp = 'read' | 'delete' | 'author';

/**
 * The SOURCE app's access for one collection call through an import, for the same viewer — or a
 * refusal. `consumer` is the caller's own resolved access; `from` the source blockId from the
 * request. Checked in this order, each before any read the next one needs:
 *
 *   1. only an ordinary production token reaches another app: a review, dev or hub token is
 *      refused (`not_eligible`, `import_in_review` / `import_dev_token` / `import_hub_token`);
 *   2. the consumer's approved manifest declares an import from `from` naming `collection`
 *      (`import_not_declared`); writes through a `read` import are refused (`write_policy`);
 *   3. a signed-in viewer (`sign_in_required`: a grant is per viewer);
 *   4. the source is an approved app (`not_eligible`, `source_not_approved`), declares the
 *      collection (`collection_not_declared`) and has not opted it out (`not_exportable`);
 *   5. the token carries `apps:storage:import` and the viewer's grant for (consumer, source)
 *      covers the consumer's CURRENT import of the source — every collection it names, at its
 *      access (`importGrantCovers`); otherwise `consent_required`, naming the scope and the
 *      source, so a version that widens the import is prompted for before it reaches anything.
 *
 * The returned access carries the source's collections only and `apps:storage`. It carries
 * `apps:storage:publish` only for an authoring call (create, put, a counter or a mark) through a
 * `readwrite` import by a viewer who granted that scope to the SOURCE app themselves: an import
 * consent is not publish consent there, so a write, counter or mark in one of the source's
 * shared collections without it is refused by the route (`consent_required` naming
 * `apps:storage:publish` and the source). A private source collection needs only the import
 * grant. The consumer's own publish grant is never consulted.
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
  const declared = consumer.imports.get(from);
  if (!declared || !declared.collections.has(collection)) {
    throw new DocStoreError(
      'import_not_declared',
      `this app does not declare an import of ${collection} from ${from}`,
      { from, collection }
    );
  }
  if (op !== 'read' && declared.access === 'read') {
    throw new DocStoreError('write_policy', `the import from ${from} is read-only`, {
      from,
      reason: 'import_read_only',
    });
  }
  const viewerUid = consumer.ctx.viewerUid;
  if (viewerUid === null) throw new DocStoreError('sign_in_required', 'sign in required');

  const source = await dependency(
    dbRead.appBlock.findUnique({
      where: { blockId: from },
      select: { id: true, status: true, manifest: true },
    })
  );
  if (!source || source.status !== 'approved') {
    throw notEligible('source_not_approved', `the app ${from} is not available`);
  }
  if (source.id === consumer.ctx.appId) {
    throw new DocStoreError('import_not_declared', 'an app cannot import from itself', { from });
  }
  const sourceStorage = declaredStorage(source.id, source.manifest);
  const decl = sourceStorage.collections.get(collection);
  if (!decl) {
    throw new DocStoreError(
      'collection_not_declared',
      `collection ${collection} is not declared by ${from}`,
      { collection, from }
    );
  }
  if (!isCollectionExportable(decl)) {
    throw new DocStoreError(
      'not_exportable',
      `${from} does not share ${collection} with other apps`,
      {
        collection,
        from,
      }
    );
  }

  const consentRequired = () =>
    new DocStoreError('consent_required', `${APP_STORAGE_IMPORT_SCOPE} has not been granted`, {
      scope: APP_STORAGE_IMPORT_SCOPE,
      from,
    });
  if (!consumer.scopes.includes(APP_STORAGE_IMPORT_SCOPE)) {
    if (consumer.consentUnavailable) {
      throw new DocStoreError(
        'consent_unavailable',
        'permission state is temporarily unavailable',
        {
          retryAfter: 1,
        }
      );
    }
    throw consentRequired();
  }
  const grant = await dependency(
    getStorageImportGrant({
      userId: viewerUid,
      consumerAppBlockId: consumer.ctx.appId,
      sourceAppBlockId: source.id,
    })
  );
  if (!importGrantCovers(grant, declared)) throw consentRequired();

  // Production data only: every other namespace was refused with its token above.
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
    scopes: publishes
      ? [APP_STORAGE_BASE_SCOPE, APP_STORAGE_PUBLISH_SCOPE]
      : [APP_STORAGE_BASE_SCOPE],
    consentUnavailable: false,
    collections: sourceStorage.collections,
    // An import is one hop: a source's own imports are never followed.
    imports: new Map(),
    tokenKind: consumer.tokenKind,
    importedFrom: from,
    importAccess: declared.access,
  };
}
