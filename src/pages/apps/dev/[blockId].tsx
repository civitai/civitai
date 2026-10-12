import { Alert, Box, Code, Stack, Text, Title } from '@mantine/core';
import { DevTunnelBlockHost } from '~/components/AppBlocks/DevTunnelBlockHost';
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

type DevTunnelProps = DevTunnelFrame;

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
    // SAME notFound (no oracle). A fresh entry token is signed on every render, so
    // the live iframe never serves a stale one.
    const { resolveDevTunnelFrame } = await import(
      '~/server/services/blocks/dev-tunnel-frame.service'
    );
    const frame = await resolveDevTunnelFrame(user, blockId);
    if (!frame) return { notFound: true };
    const { host } = frame;

    if (host) {
      // ROUTE-SCOPED CSP (T7). `setHeader` REPLACES — next.config's `headers()`
      // sets a CSP on `/gift-cards` alone, which this route never matches, so
      // there is nothing to merge with today. 🔴 The coupling runs the
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

export default function DevTunnelPage({ iframeSrc, host: _host, ...app }: DevTunnelProps) {
  const { appName, blockId } = app;
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
          <DevTunnelBlockHost
            {...app}
            iframeSrc={iframeSrc}
            fit="viewport"
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
                <Text size="sm">Restart your tunnel and reload if the problem persists:</Text>
                <Code block>civitai app dev:tunnel</Code>
              </Stack>
            }
          />
        )}
      </Box>
    </>
  );
}
