import { env } from '~/env/server';

/**
 * The blob hosts stored epoch URLs actually use. Kept alongside `ORCHESTRATOR_ENDPOINT` rather than
 * derived from it: that variable may name an internal API host that never appears in a blob URL.
 */
// Exported so the test can pin it as an exact set — see the ledger in
// __tests__/trusted-blob-url.test.ts, which fails when this list GROWS as well as when
// it shrinks. That is the guard; a per-name assertion would only catch names someone
// thought to enumerate.
export const KNOWN_ORCHESTRATOR_HOSTS = [
  'orchestration.civitai.com',
  'orchestration-new.civitai.com',
  // The "next" orchestrator's public origin. A PR preview can be opted onto that
  // orchestrator, and it mints asset URLs on this host; without it here, training
  // epoch/asset downloads from such a preview are refused as `Invalid asset URL`.
  // The server-side endpoint those previews use is an internal address, so it can
  // never widen this list via the `configured` entry below — it has to be listed.
  'orchestration-next.civitai.com',
];
// Entries are removed once they stop resolving: a name with no DNS record cannot serve a
// blob, so trusting it buys nothing, and a record created later would inherit that trust
// without review. ⚠ This list is NOT the only place that trust lives — the training-studio
// trace proxy (apps/training-studio/src/routes/api/trace/+server.ts) accepts ANY
// `.civitai.com` subdomain by wildcard, so keeping this list tight does not close the
// class, only this consumer's half of it.

function hostOf(value: string | undefined | null) {
  if (!value) return undefined;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Log line only, never a trust decision; 'unparseable' is itself worth logging. */
export function logHostOf(url: string) {
  return hostOf(url) ?? 'unparseable';
}

/**
 * Whether a stored URL may be fetched with the orchestrator's bearer token.
 *
 * Stored epoch URLs are untrusted input: do not relax this to a path or suffix match. Matching the
 * consumer-blob path (`isConsumerBlobUrl` in `~/shared/orchestrator/blob-url`) says nothing about
 * the host.
 */
export function isTrustedOrchestratorUrl(url: string | undefined | null): boolean {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // fetch() throws on userinfo anyway; rejected here so the answer doesn't depend on the caller's client.
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;

  // `host` rather than `hostname`, so a matching name on an attacker-chosen port is not trusted.
  const configured = hostOf(env.ORCHESTRATOR_ENDPOINT);
  const trusted = configured ? [configured, ...KNOWN_ORCHESTRATOR_HOSTS] : KNOWN_ORCHESTRATOR_HOSTS;
  return trusted.includes(parsed.host.toLowerCase());
}
