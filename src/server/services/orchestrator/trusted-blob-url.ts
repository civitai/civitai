import { env } from '~/env/server';

/**
 * The blob hosts stored epoch URLs actually use. Kept alongside `ORCHESTRATOR_ENDPOINT` rather than
 * derived from it: that variable may name an internal API host that never appears in a blob URL.
 */
const KNOWN_ORCHESTRATOR_HOSTS = [
  'orchestration.civitai.com',
  'orchestration-new.civitai.com',
  // The "next" orchestrator's public origin. A PR preview can be opted onto that
  // orchestrator, and it mints asset URLs on this host; without it here, training
  // epoch/asset downloads from such a preview are refused as `Invalid asset URL`.
  // The server-side endpoint those previews use is an internal address, so it can
  // never widen this list via the `configured` entry below — it has to be listed.
  'orchestration-next.civitai.com',
];
// Removed 2026-09-15: orchestration-stage, orchestration-dev and image-generation.
// All three are NXDOMAIN — measured against the authoritative resolver (1.1.1.1) AND
// from inside the cluster, where this predicate actually runs, with the two surviving
// hosts as the positive control in the same command. A name that resolves nowhere
// cannot serve a blob, so removing it cannot break a download that works today; it
// only changes the failure from a connection error to `Invalid asset URL`.
//
// They were listed because stored epoch rows carry them, but pre-trusting a
// non-existent name in a zone we control is a standing subdomain-takeover foothold:
// anything that later points one of these at a third party inherits trust here
// without review. The guard below pins their removal.

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
