import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Code, Stack, Text, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { DevTunnelBlockHost } from '~/components/AppBlocks/DevTunnelBlockHost';
import { DevTunnelDnsGate } from '~/components/AppBlocks/DevTunnelDnsGate';
import { Meta } from '~/components/Meta/Meta';
import type { DevTunnelFrame } from '~/server/services/blocks/dev-tunnel-frame.service';
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
 *   - a ROUTE-SCOPED CSP is set on THIS response only — it constrains what this
 *     document may frame AND who may frame this document, and applies to no other
 *     route (T7). The directives are at the `setHeader` call — not restated
 *     here, or this summary goes stale on the first edit that adds one.
 */

export const getServerSideProps = createServerSideProps<DevTunnelFrame>({
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

    // null (foreign or absent app) → the same notFound, no oracle.
    const { resolveDevTunnelFrame } = await import(
      '~/server/services/blocks/dev-tunnel-frame.service'
    );
    const frame = await resolveDevTunnelFrame(user, blockId);
    if (!frame) return { notFound: true };
    const { host } = frame;

    if (host) {
      // ROUTE-SCOPED CSP (T7). `setHeader` REPLACES, and this is the only
      // `Content-Security-Policy`-setting site in `src/` — next.config's
      // `headers()` sets a CSP on `/gift-cards` alone, which this route never
      // matches, so there is nothing to merge with today. 🔴 The coupling runs the
      // other way, though: if a GLOBAL CSP is ever added to `headers()`, THIS
      // RESPONSE drops every directive of it — only on this branch, since the
      // no-tunnel and invalid-host paths never reach `setHeader` and so keep it.
      // Fold those directives in here if that lands. (`headers()` already has a
      // `/:path*` source for a dev-only header, so that is one line away.)
      //
      //   frame-src https://<host>  — what THIS document may frame: exactly the
      //     assigned dev host. CSP host-sources do not support a `dev-*` LABEL
      //     wildcard (only full `*.civit.ai` subdomain wildcards, which would be
      //     far broader), so the EXACT host is used — the tightest valid form.
      //
      //   frame-ancestors 'none'  — who may frame THIS document: nobody.
      //     next.config's `headers()` already sends `X-Frame-Options: DENY` here
      //     (`source: '/((?!gift-cards).*)'` matches this route), but CSP says
      //     that on a response carrying BOTH, frame-ancestors SHOULD be enforced
      //     and X-Frame-Options SHOULD be ignored — a SHOULD, so a weaker value's
      //     effect would be browser-dependent. Hence this value must be no weaker
      //     than that DENY, which `'none'` is under either reading.
      //     🔴 `'self'` is NOT interchangeable here — it is the equivalent of
      //     SAMEORIGIN, so swapping it in would widen this route rather than
      //     restate it.
      //
      // 🔴 This header reaches a DOCUMENT only on a hard navigation. On a
      // client-side Next transition into this route, `getServerSideProps` runs for
      // the `/_next/data/<buildId>/…json` fetch, so the directives land on a JSON
      // response and the live document keeps whatever framing headers it was
      // loaded with — not these. So this route is NOT self-sufficient on framing
      // and the blanket `X-Frame-Options` rule in next.config is still doing work:
      // do not retire or except that rule on the strength of the directives below.
      // (No in-app link into this route exists today, but that does not make the
      // case unreachable — a Back traversal is an inbound client-side navigation
      // and needs no link.)
      ctx.res.setHeader(
        'Content-Security-Policy',
        `frame-src https://${host}; frame-ancestors 'none'`
      );
    }

    return { props: frame };
  },
});

/**
 * The host this document's CSP lets it frame. It is fixed when the document is loaded, so it is
 * read from the document's own data, never from props, which client-side navigation replaces.
 */
function documentFrameHost(propsHost: string | null): string | null {
  if (typeof window === 'undefined') return propsHost;
  const doc = (window as { __NEXT_DATA__?: { page?: string; props?: { pageProps?: unknown } } })
    .__NEXT_DATA__;
  // Loaded as another page, the document carries no route-scoped CSP to conflict with.
  if (doc?.page !== '/apps/dev/[blockId]') return null;
  const host = (doc.props?.pageProps as { host?: unknown } | undefined)?.host;
  return typeof host === 'string' ? host : null;
}

/**
 * The scaffold's `dev:tunnel` script serves on the port `civitai app dev-tunnel` tunnels by default,
 * and sends the headers this page needs to frame the app.
 */
const DEV_TUNNEL_COMMANDS = 'npm run dev:tunnel\ncivitai app dev-tunnel';

export default function DevTunnelPage({ iframeSrc, host, dnsPending, ...app }: DevTunnelFrame) {
  const { appName, blockId } = app;
  const router = useRouter();
  // Props naming a host other than the one this document may frame (the tunnel restarted, or
  // this page was reached client-side) need a fresh document to frame it.
  const [servedHost] = useState(() => documentFrameHost(host));
  const hostChanged = !!servedHost && !!host && host !== servedHost;
  const routerRef = useRef(router);
  routerRef.current = router;
  useEffect(() => {
    if (hostChanged) routerRef.current.reload();
  }, [hostChanged]);

  return (
    <>
      <Meta title={`${appName} — Dev tunnel — Civitai Apps`} deIndex />
      <Box style={{ width: '100%' }}>
        {hostChanged ? null : dnsPending ? (
          <Box style={{ height: '60vh' }}>
            <DevTunnelDnsGate
              key={blockId}
              blockId={blockId}
              // Re-runs the server props, which sign the entry URL once the host resolves.
              onSettled={() => router.replace(router.asPath, undefined, { scroll: false })}
            />
          </Box>
        ) : !iframeSrc ? (
          <Stack p="md" gap="sm" style={{ maxWidth: 720, margin: '0 auto' }}>
            <Title order={3}>No active dev tunnel</Title>
            <Text size="sm">
              In your app&apos;s folder, start the dev server in one terminal and open a tunnel for{' '}
              <Code>{blockId}</Code> in another, then reload this page:
            </Text>
            <Code block>{DEV_TUNNEL_COMMANDS}</Code>
            <Text size="sm">
              Use <Code>npm run dev:tunnel</Code>, not <Code>npm run dev</Code>: it serves on the
              port the tunnel uses and sends the headers this page needs to show your app.
            </Text>
            <Alert color="yellow" variant="light">
              This page renders your LOCAL app inside the real Civitai host. Only you can see it —
              the tunnel is bound to your account.
            </Alert>
          </Stack>
        ) : (
          <DevTunnelBlockHost
            // A freshly signed entry URL is a fresh mount, so the host re-runs its handshake.
            key={iframeSrc}
            {...app}
            iframeSrc={iframeSrc}
            fit="viewport"
            // The app reloaded itself (Vite live reload): re-run the server props in place,
            // as the DNS gate does, for a freshly signed entry URL.
            onGuestReloaded={() => void router.replace(router.asPath, undefined, { scroll: false })}
            tokenErrorFallback={
              // Owner-specific copy: the public host's generic "Couldn't authenticate
              // this app" would mislead here.
              <Stack p="md" gap="sm" style={{ maxWidth: 720, margin: '0 auto' }}>
                <Title order={3}>Can’t run this app in the dev tunnel</Title>
                <Alert color="red" variant="light">
                  We couldn’t mint a dev token for <Code>{blockId}</Code>. This app isn’t runnable
                  in the dev tunnel — it may be suspended, pending review, or not owned by your
                  account. If you just started the tunnel, reload the page.
                </Alert>
                <Text size="sm">
                  Restart your tunnel (Ctrl-C, then run it again) and reload if the problem
                  persists:
                </Text>
                <Code block>civitai app dev-tunnel</Code>
              </Stack>
            }
          />
        )}
      </Box>
    </>
  );
}
