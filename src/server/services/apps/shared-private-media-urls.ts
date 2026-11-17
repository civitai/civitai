import { env as clientEnv } from '~/env/client';
import { env } from '~/env/server';
import { ORCHESTRATOR_PROXY_HOST } from '~/server/orchestrator/region-proxy';
import { KNOWN_ORCHESTRATOR_HOSTS } from '~/server/services/orchestrator/trusted-blob-url';
import { stripInvisible } from '~/server/utils/confusable-fold';
import { isConsumerBlobUrl, parseJobAssetUrl } from '~/shared/orchestrator/blob-url';

function hostnameOf(value: string | undefined) {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

function orchestratorHostnames(): string[] {
  const configured = [env.ORCHESTRATOR_ENDPOINT, clientEnv.NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT]
    .map(hostnameOf)
    .filter((h): h is string => !!h);
  return [...new Set([...configured, ...KNOWN_ORCHESTRATOR_HOSTS, ORCHESTRATOR_PROXY_HOST])];
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesOrchestratorMedia(text: string, hosts: RegExp[]) {
  return isConsumerBlobUrl(text) || !!parseJobAssetUrl(text) || hosts.some((h) => h.test(text));
}

/**
 * Whether `text` carries a link to orchestrator media: a consumer-blob or job-asset path, or any
 * orchestrator host. Such media is the uploader's own and has not been rated, so it must not
 * reach other viewers through an app's shared data. Public image CDN urls do not match.
 * Percent-encoded forms are decoded before matching.
 */
export function containsPrivateMediaUrl(raw: string): boolean {
  const hosts = orchestratorHostnames().map(
    (h) => new RegExp(`(^|[^a-z0-9-])${escapeRegex(h)}($|[^a-z0-9-])`)
  );
  let current = stripInvisible(raw).toLowerCase();
  for (let pass = 0; pass < 8; pass++) {
    if (namesOrchestratorMedia(current, hosts)) return true;
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return false;
    }
    if (next === current) return false;
    current = next;
  }
  return false;
}
