import { env } from '~/env/server';

/**
 * The blob hosts stored epoch URLs actually use. Kept alongside `ORCHESTRATOR_ENDPOINT` rather than
 * derived from it: that variable may name an internal API host that never appears in a blob URL.
 */
const KNOWN_ORCHESTRATOR_HOSTS = [
  'orchestration.civitai.com',
  'orchestration-new.civitai.com',
  'orchestration-stage.civitai.com',
  'orchestration-dev.civitai.com',
  'image-generation.civitai.com',
];

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
