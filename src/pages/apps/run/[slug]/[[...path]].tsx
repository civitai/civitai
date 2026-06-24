import { Box, useComputedColorScheme } from '@mantine/core';
import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Meta } from '~/components/Meta/Meta';
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
import { useBlockToken } from '~/components/AppBlocks/useBlockToken';
import type { BlockInstall, PageContext } from '~/components/AppBlocks/types';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * W10 — full-page App Block route: `/apps/run/<slug>` (+ optional sub-path).
 *
 * Route is `[slug]/[[...path]]` (NOT `[appBlockId]`) to avoid colliding with
 * the sibling `/apps/[appBlockId]` detail route under `/apps`. `<slug>` is the
 * app's `block_id` (the same value that builds `<slug>.civit.ai`).
 *
 * DARK / FLAG-GATED: the page requires BOTH `features.appBlocks` AND
 * `features.appBlocksPages` (the W10 flag). When either is off for the viewer,
 * SSR returns a Next 404 (fail-closed) — merging this changes nothing
 * user-visible. The token mint enforces the same two-flag gate independently.
 *
 * STATELESS (Decision 2): no `block_user_subscriptions` row, no migration. The
 * page resolves the approved AppBlock by slug; the token is minted from a
 * synthetic `page_<appBlockId>` id. The page is pure viewer-scoped (entity=none)
 * and carries NO money scopes.
 */

interface PageProps {
  appBlockId: string;
  blockId: string;
  appId: string;
  appName: string;
  pageTitle: string;
  iframeSrc: string;
  sandbox: string;
  trustTier: 'unverified' | 'verified' | 'internal';
  slug: string;
  /** #3/#6: the page manifest's declared scopes, used to compute the actual
   *  granted set (declared − missingScopes) for BLOCK_INIT. */
  scopes: string[];
}

export const getServerSideProps = createServerSideProps<PageProps>({
  useSession: true,
  resolver: async ({ features, ctx }) => {
    // GATE FIRST, fail-closed. Both flags required. A viewer without them gets
    // a 404 — the page is invisible/un-enumerable until W10 launch widens the
    // `app-blocks-pages-enabled` segment.
    if (!features?.appBlocks || !features?.appBlocksPages) {
      return { notFound: true };
    }
    const rawSlug = ctx.params?.slug;
    const slug = typeof rawSlug === 'string' ? rawSlug : Array.isArray(rawSlug) ? rawSlug[0] : '';
    if (!slug) return { notFound: true };

    // Resolve the approved page app by slug (== block_id). Returns null for a
    // missing / non-approved / non-page app → 404 (never leaks which).
    const page = await BlockRegistry.resolvePageBlockBySlug(slug, { db: 'read' });
    if (!page || !page.iframeSrc) return { notFound: true };

    return {
      props: {
        appBlockId: page.appBlockId,
        blockId: page.blockId,
        appId: page.appId,
        appName: page.name,
        pageTitle: page.pageTitle,
        iframeSrc: page.iframeSrc,
        sandbox: page.sandbox,
        trustTier: page.trustTier,
        slug: page.blockId,
        scopes: page.scopes,
      },
    };
  },
});

export default function AppPage(props: PageProps) {
  const { appBlockId, blockId, appId, appName, iframeSrc, sandbox, trustTier, slug, scopes } =
    props;
  const currentUser = useCurrentUser();
  const colorScheme = useComputedColorScheme('dark');
  const theme: 'light' | 'dark' = colorScheme === 'dark' ? 'dark' : 'light';

  // Synthetic page instance id — the mint resolves `page_<appBlockId>` directly
  // from the approved AppBlock (no install row).
  const blockInstanceId = `page_${appBlockId}`;

  // A synthetic BlockInstall so we can reuse useBlockToken (it only reads
  // `install.blockInstanceId` and posts the context through). The manifest /
  // settings fields are unused on the page mint path.
  const install = useMemo<BlockInstall>(
    () => ({
      blockInstanceId,
      blockId,
      appId,
      appBlockId,
      manifest: {
        name: appName,
        scopes,
        iframe: { src: iframeSrc, minHeight: 200, maxHeight: null, resizable: true, sandbox },
      },
      publisherSettings: {},
      enabled: true,
      renderMode: 'iframe',
      trustTier,
    }),
    [appBlockId, appId, appName, blockId, blockInstanceId, iframeSrc, sandbox, scopes, trustTier]
  );

  // The slotContext POSTed to /api/v1/block-tokens. entityType:'none' selects
  // the page mint path server-side.
  const context = useMemo<PageContext>(
    () => ({
      slotId: 'app.page',
      entityType: 'none',
      slug,
      subPath: '',
      viewerUserId: currentUser?.id ?? null,
      viewerUsername: currentUser?.username ?? null,
      theme,
    }),
    [slug, currentUser, theme]
  );

  // #3/#6: take the consent signal + error from the mint, not just token/expiry.
  // `missingScopes` lets PageBlockHost compute the REAL granted set (declared −
  // missing) for BLOCK_INIT; `needsConsent`/`error` let it surface a terminal
  // state instead of hanging at `no_token`.
  // `refresh` re-mints the page token after a consent grant so the new scopes
  // flow to the block via TOKEN_REFRESH (wired to PageBlockHost.onConsentGranted,
  // mirroring how IframeHost re-mints on REQUEST_CONSENT). The rotated token's
  // TOKEN_REFRESH push delivers the granted scopes and the block retries.
  const { token, expiresAt, needsConsent, missingScopes, domain, maxBrowsingLevel, error, refresh } =
    useBlockToken(install, context);

  const viewer = currentUser
    ? { id: currentUser.id, username: currentUser.username ?? null }
    : null;

  return (
    <>
      <Meta title={`${appName} — Civitai Apps`} deIndex />
      <Box style={{ width: '100%' }}>
        <PageBlockHost
          appBlockId={appBlockId}
          blockId={blockId}
          appId={appId}
          blockInstanceId={blockInstanceId}
          appName={appName}
          iframeSrc={iframeSrc}
          sandbox={sandbox}
          trustTier={trustTier}
          slug={slug}
          token={token}
          expiresAt={expiresAt}
          declaredScopes={scopes}
          missingScopes={missingScopes}
          needsConsent={needsConsent}
          domain={domain}
          maxBrowsingLevel={maxBrowsingLevel}
          tokenError={error != null}
          viewer={viewer}
          theme={theme}
          onConsentGranted={refresh}
          onRetryToken={refresh}
        />
      </Box>
    </>
  );
}
