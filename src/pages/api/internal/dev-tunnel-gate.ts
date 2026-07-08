import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyDevTunnelAccessToken } from '~/server/services/blocks/dev-tunnel-session';

/**
 * GET/ANY /api/internal/dev-tunnel-gate  (APP DEV TUNNEL — edge forwardAuth)
 *
 * A Traefik `forwardAuth` target guarding the ephemeral dev-tunnel hosts
 * (`dev-<16hex>.<APPS_DOMAIN>`). This is the author-bound sibling of the mod
 * review-sandbox gate (`/api/internal/mod-gate`): the dev-tunnel host is a
 * CROSS-ORIGIN iframe embedded inside the authenticated `civitai.com/apps/dev`
 * page, so the civitai session cookie is NOT sent to `*.civit.ai`. The already-
 * authenticated parent mints a signed, short-TTL, AUTHOR-bound ENTRY token (see
 * `dev-tunnel-session.ts`) and injects it into the iframe `src` as `?dev=<token>`.
 *
 * ── WHAT THE ENTRY TOKEN ACTUALLY GATES (T3, stated honestly) ──
 * The entry token gates the ENTRY DOCUMENT ONLY. A NAKED ENTRY request (no /
 * expired / wrong-user / host-mismatched token) is denied 401 — so a visitor who
 * knows the host cannot LOAD the dev page. But NON-ENTRY subresources
 * (Sec-Fetch-Dest empty/script/style/fetch/xhr/image/…) pass through with NO
 * token. So anyone who LEARNS the `dev-<16hex>` host can reach the dev's
 * localhost UNAUTHENTICATED for the session TTL by issuing subresource-shaped
 * requests. Those subresources are protected by HOST-SECRECY only — the
 * unguessable ~64-bit `dev-<16hex>` host — NOT by the token. This is the
 * IDENTICAL accepted tradeoff as `mod-gate.ts` (Traefik does not forward a 2xx
 * auth response's Set-Cookie, so a per-subresource cookie gate can't be set), and
 * the victim of a leaked host is the AUTHOR'S OWN machine (author-only sessions).
 *
 * ── ENTRY-GATE-ONLY (mirrors mod-gate exactly) ──
 * Authorizes ONLY the ENTRY document/iframe request (the one that can carry the
 * `dev` token) and ALLOWS subresources through, per the tradeoff above.
 *
 *   - WEBSOCKET HANDSHAKE (e.g. the Vite HMR socket `wss://dev-<hex>/?token=…`):
 *     200 (allow). A ws handshake is structurally a subresource — it can NEVER be
 *     a top-level document navigation — so allowing it does not weaken the naked-
 *     entry-document 401 property (the ws still only reaches the AUTHOR'S OWN
 *     localhost, host-secrecy protected — same tradeoff as every other
 *     subresource, no token required). Keyed PRIMARILY on `Sec-WebSocket-Key`, the
 *     RFC-6455-MANDATORY handshake request header: the browser ALWAYS sends it on
 *     a ws upgrade AND Traefik FORWARDS it to the forwardAuth subrequest (it is
 *     NOT hop-by-hop, and this middleware sets no `authRequestHeaders` allowlist,
 *     so every non-hop-by-hop header passes). `Upgrade` — the other definitional
 *     handshake header (RFC 6455) — is a hop-by-hop header (RFC 7230 §6.1) that
 *     Traefik STRIPS from the auth subrequest, so it can NOT be the sole signal
 *     and the `upgrade === 'websocket'` branch never fires in production; it is
 *     kept only as belt-and-suspenders for any path that DOES preserve it. We do
 *     NOT rely on `Sec-Fetch-Dest: websocket` either — a real Chrome HMR handshake
 *     arrives with NO usable `Sec-Fetch-Dest`, so it would fall into the ENTRY
 *     branch and 401 the socket. A request bearing `Sec-WebSocket-Key` can never
 *     be a top-level document navigation, so allowing it keeps the IDENTICAL
 *     security posture (host-secrecy, no token) as every other subresource.
 *     Deterministic + structural, not heuristic.
 *   - ENTRY (Sec-Fetch-Dest document/iframe/frame/nested-document, OR ABSENT →
 *     treated as entry, fail-safe): require a valid `dev` token bound to
 *     X-Forwarded-Host → 200 + X-Dev-User-Id, else 401.
 *   - SUBRESOURCE (any other Sec-Fetch-Dest): 200 (allow).
 *   - Missing X-Forwarded-Host → 401 (fail-closed).
 */

/** Sec-Fetch-Dest values that mean "top-level document / iframe being LOADED". An
 *  ABSENT header is treated as entry (fail-safe). */
const ENTRY_DESTS = new Set(['document', 'iframe', 'frame', 'nested-document']);

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Extract the `dev` query param from the forwarded original URI. */
function extractDevToken(forwardedUri: string | undefined): string | undefined {
  if (!forwardedUri) return undefined;
  const q = forwardedUri.indexOf('?');
  if (q < 0) return undefined;
  try {
    const params = new URLSearchParams(forwardedUri.slice(q + 1));
    return params.get('dev') ?? undefined;
  } catch {
    return undefined;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const forwardedHost = firstHeader(req.headers['x-forwarded-host']);
  const forwardedUri = firstHeader(req.headers['x-forwarded-uri']);
  const secFetchDest = firstHeader(req.headers['sec-fetch-dest']);

  // Fail-closed: without the dev host we can't bind/verify anything.
  if (!forwardedHost) {
    res.status(401).json({ error: 'Missing dev host' });
    return;
  }

  // WEBSOCKET HANDSHAKE → allow (e.g. the Vite HMR socket `wss://dev-<hex>/?token=…`
  // so live-reload flows over the tunnel). A ws handshake is structurally a
  // subresource and can never be a top-level document navigation, so this does
  // NOT weaken the naked-entry-document 401 property (and the ws still only
  // reaches the AUTHOR'S OWN localhost, host-secrecy protected — same tradeoff as
  // every other subresource). Keyed PRIMARILY on `Sec-WebSocket-Key`, the RFC-
  // 6455-MANDATORY handshake header the browser ALWAYS sends and — unlike the
  // hop-by-hop `Upgrade` header (RFC 7230 §6.1) which Traefik STRIPS from the auth
  // subrequest — Traefik FORWARDS it (no `authRequestHeaders` allowlist on this
  // middleware). The `Upgrade` check is kept only as belt-and-suspenders for any
  // path that DOES preserve it; in production it never fires. Deterministic +
  // structural (a request bearing `Sec-WebSocket-Key` is definitionally a ws
  // handshake, never a document navigation).
  const wsKey = firstHeader(req.headers['sec-websocket-key']);
  const upgrade = firstHeader(req.headers['upgrade']);
  if (wsKey || (upgrade && upgrade.toLowerCase() === 'websocket')) {
    res.status(200).json({ ok: true, via: 'websocket' });
    return;
  }

  // SUBRESOURCE → allow with NO token (see the header comment). This means a
  // caller who KNOWS the `dev-<16hex>` host reaches the tunnel unauthenticated via
  // subresource-shaped requests — those are protected by HOST-SECRECY only, not
  // the token. Accepted tradeoff, identical to mod-gate.ts.
  const isEntry = secFetchDest == null || ENTRY_DESTS.has(secFetchDest);
  if (!isEntry) {
    res.status(200).json({ ok: true, via: 'subresource' });
    return;
  }

  // ENTRY → require a valid `dev` token bound to this host.
  const token = extractDevToken(forwardedUri);
  const result = verifyDevTunnelAccessToken(token, forwardedHost);
  if (result.ok && result.userId != null) {
    res.setHeader('X-Dev-User-Id', String(result.userId));
    res.status(200).json({ ok: true, via: 'token' });
    // F3 — refresh the session's idle marker on this (successful, browser-driven)
    // ENTRY hit so the server-side idle-reaper measures real activity, not just
    // the 8h hard-TTL. Runs AFTER the auth response is flushed above so a Redis
    // hiccup can NEVER change the gate decision or add user-facing latency
    // (touchDevTunnelActivity swallows all errors; awaited only so tests settle).
    try {
      const { touchDevTunnelActivity } = await import(
        '~/server/services/blocks/dev-tunnel.service'
      );
      await touchDevTunnelActivity(forwardedHost);
    } catch {
      /* idle-refresh is best-effort — the auth decision already stands */
    }
    return;
  }

  // Naked / invalid / expired / wrong-user / host-mismatched ENTRY request → 401.
  // (Gates the ENTRY DOCUMENT only — see the header comment on subresources.)
  res.status(401).json({ error: 'Dev tunnel session required' });
}
