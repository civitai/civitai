// The `/api/trpc-go/<procedure>` rewrites in `next.config.mjs` (plain .mjs so the config can import
// it without a build step).
//
// One exact source per procedure in `GO_TRANSPORT_PROCEDURES` (src/utils/trpc-go-transport.ts), never
// a wildcard: a wildcard would make `/api/trpc-go/*` an alias of the whole tRPC API.
// src/utils/__tests__/trpc-go-transport.test.ts pins that this list and that set agree.
export const FEED_GO_REWRITE_PROCEDURES = [
  'image.getImagesAsPostsInfinite',
  'model.getAll',
  'image.getInfinite',
];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The origin `FEED_GO_LOCAL_URL` names, or null when it must be ignored. Only the local dev launcher
 * (scripts/dev-feed-go/launcher.mjs) sets it, to its own loopback proxy in front of a local feed-go.
 * It is ignored unless it is a bare `http://<loopback>:<port>` origin and NODE_ENV is not production,
 * so a stray value can never send a deployed app's requests anywhere (`next build` runs with
 * NODE_ENV=production, so a built app's rewrites never carry it).
 */
export function localFeedGoOrigin(localUrl, nodeEnv) {
  if (!localUrl || nodeEnv === 'production') return null;
  let u;
  try {
    u = new URL(localUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname) || !u.port) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) {
    return null;
  }
  return `http://${u.hostname}:${u.port}`;
}

/**
 * The rewrites. Without a usable local origin each `/api/trpc-go/<procedure>` is an alias of
 * `/api/trpc/<procedure>`, served by this app: a Go-transport flag can never strand a request. With
 * one (local dev, `pnpm dev` with feed-go running), it goes to `<origin>/api/trpc/<procedure>`, the
 * path feed-go serves; the launcher's proxy there hands it to Next's own `/api/trpc/<procedure>`
 * whenever feed-go is not healthy.
 */
export function feedGoRewrites({ localUrl, nodeEnv } = {}) {
  const origin = localFeedGoOrigin(localUrl, nodeEnv);
  return FEED_GO_REWRITE_PROCEDURES.map((procedure) => ({
    source: `/api/trpc-go/${procedure}`,
    destination: origin ? `${origin}/api/trpc/${procedure}` : `/api/trpc/${procedure}`,
  }));
}
