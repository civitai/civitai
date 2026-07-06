import { Alert, Box, Code, Stack, Text, Title, useComputedColorScheme } from '@mantine/core';
import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Meta } from '~/components/Meta/Meta';
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
import { useBlockToken } from '~/components/AppBlocks/useBlockToken';
import type { BlockInstall, PageContext } from '~/components/AppBlocks/types';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * APP DEV TUNNEL — dedicated author-only dev route: `/apps/dev/<blockId>`.
 *
 * NEVER the public `/apps/run/<slug>` path. Renders the caller's OWN app (at ANY
 * status) inside the REAL production `PageBlockHost`, but with the iframe pointing
 * at their LOCAL dev server via the ephemeral `dev-<16hex>.<APPS_DOMAIN>` tunnel
 * host — a prod-fidelity inner-dev-loop.
 *
 * DARK / FLAG-GATED: requires `features.appBlocks` AND `features.appBlocksAuthor`
 * AND the `app-blocks-dev-tunnel` kill-switch (base off). When any is missing the
 * SSR returns notFound (fail-closed) — the route is invisible/un-enumerable until
 * the flag widens.
 *
 * SECURITY:
 *   - unauthenticated → redirect to login.
 *   - non-owner of `blockId` → notFound (no ownership/existence oracle).
 *   - `iframeSrc` is SERVER-DERIVED from the assigned tunnel host ONLY, validated
 *     against `^dev-[a-f0-9]{16}\.<APPS_DOMAIN>$` — never reflected from client
 *     input (T6). It can never be a `<slug>.civit.ai` deployed bundle host.
 *   - a ROUTE-SCOPED CSP (`frame-src https://<dev-host>`) is set on THIS response
 *     only — it never widens the global CSP (T7).
 */

interface DevTunnelProps {
  appBlockId: string;
  blockId: string;
  appId: string;
  appName: string;
  pageTitle: string;
  status: string;
  trustTier: 'unverified' | 'verified' | 'internal';
  sandbox: string;
  scopes: string[];
  /** Set ONLY when an active tunnel exists — `https://<dev-host>/?dev=<token>`. */
  iframeSrc: string | null;
  /** The assigned dev host (for the "no active tunnel" copy). */
  host: string | null;
}

export const getServerSideProps = createServerSideProps<DevTunnelProps>({
  useSession: true,
  resolver: async ({ features, ctx, session }) => {
    // GATE FIRST, fail-closed. Author capability + the dev-tunnel kill-switch.
    if (!features?.appBlocks || !features?.appBlocksAuthor) {
      return { notFound: true };
    }
    const user = session?.user;
    if (!user) {
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(ctx.resolvedUrl)}`,
          permanent: false,
        },
      };
    }
    const { isAppBlocksDevTunnelEnabled } = await import('~/server/services/app-blocks-flag');
    if (!(await isAppBlocksDevTunnelEnabled({ user }))) {
      return { notFound: true };
    }

    const rawBlockId = ctx.params?.blockId;
    const blockId =
      typeof rawBlockId === 'string' ? rawBlockId : Array.isArray(rawBlockId) ? rawBlockId[0] : '';
    if (!blockId) return { notFound: true };

    // Ownership-scoped resolve (any status). null for a foreign/absent app → the
    // SAME notFound (no oracle). This can NEVER resolve a deployed bundle host.
    const app = await BlockRegistry.resolveDevPageBlockForAuthor(blockId, user.id);
    if (!app) return { notFound: true };

    // Resolve the caller's active tunnel for this block (started by the CLI).
    const { getActiveDevTunnel } = await import('~/server/services/blocks/dev-tunnel.service');
    const { signDevTunnelAccessToken, isValidDevHost } = await import(
      '~/server/services/blocks/dev-tunnel-session'
    );
    const { env } = await import('~/env/server');

    const tunnel = await getActiveDevTunnel(user.id, blockId);

    let iframeSrc: string | null = null;
    let host: string | null = null;
    if (tunnel && isValidDevHost(tunnel.host, env.APPS_DOMAIN)) {
      host = tunnel.host;
      // Mint a FRESH short-TTL, author-bound entry token and inject it into the
      // iframe src. The `*.civit.ai` edge forwardAuth verifies it on the ENTRY
      // document (T3). A fresh token is minted on every SSR render so the live
      // iframe never serves a stale one.
      const token = signDevTunnelAccessToken({ userId: user.id, host });
      iframeSrc = `https://${host}/?dev=${encodeURIComponent(token)}`;

      // ROUTE-SCOPED CSP (T7). Constrain THIS response's frame-src to exactly the
      // assigned dev host — a tightening scoped to this route only; it does NOT
      // touch the global CSP (set in next.config headers()). CSP host-sources do
      // not support a `dev-*` LABEL wildcard (only full `*.civit.ai` subdomain
      // wildcards, which would be far broader), so the EXACT host is used — the
      // tightest valid form.
      ctx.res.setHeader('Content-Security-Policy', `frame-src https://${host}`);
    }

    return {
      props: {
        appBlockId: app.appBlockId,
        blockId: app.blockId,
        appId: app.appId,
        appName: app.name,
        pageTitle: app.pageTitle,
        status: app.status,
        trustTier: app.trustTier,
        sandbox: app.sandbox,
        scopes: app.scopes,
        iframeSrc,
        host,
      },
    };
  },
});

export default function DevTunnelPage(props: DevTunnelProps) {
  const { appBlockId, blockId, appId, appName, iframeSrc, sandbox, trustTier, scopes, host } = props;
  const currentUser = useCurrentUser();
  const colorScheme = useComputedColorScheme('dark');
  const theme: 'light' | 'dark' = colorScheme === 'dark' ? 'dark' : 'light';

  // Synthetic page instance id — same shape as the prod page mint path.
  const blockInstanceId = `page_${appBlockId}`;

  const install = useMemo<BlockInstall>(
    () => ({
      blockInstanceId,
      blockId,
      appId,
      appBlockId,
      manifest: {
        name: appName,
        scopes,
        iframe: {
          src: iframeSrc ?? '',
          minHeight: 200,
          maxHeight: null,
          resizable: true,
          sandbox,
        },
      },
      publisherSettings: {},
      enabled: true,
      renderMode: 'iframe',
      trustTier,
    }),
    [appBlockId, appId, appName, blockId, blockInstanceId, iframeSrc, sandbox, scopes, trustTier]
  );

  const context = useMemo<PageContext>(
    () => ({
      slotId: 'app.page',
      entityType: 'none',
      slug: blockId,
      subPath: '',
      viewerUserId: currentUser?.id ?? null,
      viewerUsername: currentUser?.username ?? null,
      theme,
    }),
    [blockId, currentUser, theme]
  );

  const { token, expiresAt, needsConsent, missingScopes, domain, maxBrowsingLevel, error, refresh } =
    useBlockToken(install, context);

  const viewer = currentUser
    ? { id: currentUser.id, username: currentUser.username ?? null }
    : null;

  return (
    <>
      <Meta title={`${appName} — Dev tunnel — Civitai Apps`} deIndex />
      <Box style={{ width: '100%' }}>
        {!iframeSrc ? (
          <Stack p="md" gap="sm" style={{ maxWidth: 720, margin: '0 auto' }}>
            <Title order={3}>No active dev tunnel</Title>
            <Text size="sm">
              Start your local dev server and open a tunnel for <Code>{blockId}</Code>, then reload
              this page:
            </Text>
            <Code block>civitai app dev:tunnel</Code>
            <Alert color="yellow" variant="light">
              This page renders your LOCAL app inside the real Civitai host. Only you can see it —
              the tunnel is bound to your account.
            </Alert>
          </Stack>
        ) : (
          <PageBlockHost
            appBlockId={appBlockId}
            blockId={blockId}
            appId={appId}
            blockInstanceId={blockInstanceId}
            appName={appName}
            iframeSrc={iframeSrc}
            sandbox={sandbox}
            trustTier={trustTier}
            slug={blockId}
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
        )}
      </Box>
    </>
  );
}
