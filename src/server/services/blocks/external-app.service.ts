import {
  assertNoOnPlatformSurface,
  validateExternalUrl,
} from '~/server/schema/blocks/external-app.schema';
import { isMarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';

/**
 * App Blocks — off-site (external-link) app registration.
 *
 * PURE EXTERNAL LINK product model: registers an `app_blocks` row that the
 * marketplace renders as a listing whose only action opens an external URL in a
 * new tab. NO install, NO scopes, NO block token, NO subscription, NO
 * on-platform iframe/page hosting.
 *
 * This DELIBERATELY does NOT go through the bundle / Forgejo / mod-approve
 * pipeline (`submitVersion` → `approveRequest`): there is nothing on-platform to
 * build, host, or validate. It is a mod-only, single-step register that:
 *   1. validates the URL is a well-formed https:// link,
 *   2. asserts the (optional) manifest declares NO on-platform surface
 *      (page / iframe / target slot) — external-link is mutually exclusive with
 *      on-platform hosting,
 *   3. creates a STRUCTURALLY NON-INTERACTIVE OauthClient (grants:[],
 *      allowedScopes:0, no origins) purely to satisfy the AppBlock.appId FK —
 *      it can never mint a token or drive OAuth, and
 *   4. inserts an `status='approved'` AppBlock row with `external_url` set and
 *      `approved_scopes: []` (external apps never request scopes).
 *
 * Retry-safe: the deterministic `appblk-<slug>` OauthClient id + the
 * `app_blocks_block_id_unique` constraint converge a re-click instead of
 * accumulating orphans.
 */

export type RegisterExternalAppParams = {
  slug: string;
  name: string;
  description?: string;
  externalUrl: string;
  category?: string;
  reviewerUserId: number;
};

export type RegisterExternalAppResult = {
  appBlockId: string;
  slug: string;
  externalUrl: string;
};

export async function registerExternalApp(
  params: RegisterExternalAppParams
): Promise<RegisterExternalAppResult> {
  const [{ dbRead, dbWrite }, { newUlid }] = await Promise.all([
    import('~/server/db/client'),
    import('~/server/utils/app-block-ids'),
  ]);

  const { slug, name, description, category, reviewerUserId } = params;

  // (1) URL validation — single source of truth (the schema helper), so the
  // service + tests can't drift on the https:// rule.
  const urlCheck = validateExternalUrl(params.externalUrl);
  if (!urlCheck.ok) throw new Error(urlCheck.error);
  const externalUrl = urlCheck.url;

  // (2) Mutual exclusivity — an external app must not also declare an
  // on-platform surface. The registration manifest carries display fields only;
  // a page/iframe/targets entry is a contradiction and is rejected (not dropped).
  const manifest: Record<string, unknown> = {
    name,
    ...(description ? { description } : {}),
  };
  const surfaceCheck = assertNoOnPlatformSurface(manifest);
  if (!surfaceCheck.ok) throw new Error(surfaceCheck.error);

  // Category is optional + free-text; if provided, it must be a known taxonomy
  // value (parity with the embedded-app marketplace-meta path).
  if (category !== undefined && !isMarketplaceCategory(category)) {
    throw new Error(`Unknown marketplace category: ${category}`);
  }

  // Reject re-registering a slug that's already taken by ANY app (external or
  // embedded) — one app per slug (mirrors app_blocks_block_id_unique). A clear
  // error beats a raw P2002 at the constraint below.
  const existing = await dbRead.appBlock.findFirst({
    where: { blockId: slug },
    select: { id: true, externalUrl: true },
  });
  if (existing) {
    throw new Error(`slug "${slug}" is already registered`);
  }

  // (3) Structurally non-interactive OauthClient — purely the AppBlock.appId FK
  // target. grants:[] + allowedScopes:0 + no origins means this row can NEVER
  // mint a token or drive OAuth (defense-in-depth on top of the authorize/device
  // endpoints' `appblk-*` hard-reject). Deterministic id for retry safety.
  const oauthClientId = `appblk-${slug}`;
  try {
    await dbWrite.oauthClient.create({
      data: {
        id: oauthClientId,
        name,
        description: description ?? '',
        redirectUris: [],
        // No on-platform origin — an external app hosts nothing on a civit
        // subdomain.
        allowedOrigins: [],
        isConfidential: false,
        userId: reviewerUserId,
        // Structurally non-interactive: no grants, zero scope ceiling.
        grants: [],
        allowedScopes: 0,
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code !== 'P2002') throw err;
    const existingClient = await dbRead.oauthClient.findUnique({
      where: { id: oauthClientId },
      select: { id: true },
    });
    if (!existingClient) throw err;
    // Converge an already-existing client to the safe shape on retry.
    await dbWrite.oauthClient.update({
      where: { id: oauthClientId },
      data: { grants: [], allowedScopes: 0, allowedOrigins: [] },
    });
  }

  // (4) Insert the approved AppBlock row. `external_url` set → the marketplace
  // renders an off-site listing. version is a fixed sentinel (external apps are
  // unversioned — there's no bundle), approvedScopes:[] (never any scopes),
  // renderMode 'external' is informational.
  const appBlockId = `apb_${newUlid()}`;
  try {
    await dbWrite.appBlock.create({
      data: {
        id: appBlockId,
        appId: oauthClientId,
        blockId: slug,
        version: '0.0.0',
        manifest: manifest as object,
        status: 'approved',
        contentRating: 'g',
        renderMode: 'external',
        trustTier: 'unverified',
        approvedScopes: [],
        externalUrl,
        ...(category ? { category } : {}),
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code !== 'P2002') throw err;
    // The slug-uniqueness race: another concurrent register won. Surface the
    // same human message the pre-check would have.
    throw new Error(`slug "${slug}" is already registered`);
  }

  return { appBlockId, slug, externalUrl };
}
