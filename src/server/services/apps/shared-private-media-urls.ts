import { env as clientEnv } from '~/env/client';
import { env } from '~/env/server';
import { ORCHESTRATOR_HOSTNAME_PATTERN } from '~/server/common/constants';
import { ORCHESTRATOR_PROXY_HOST } from '~/server/orchestrator/region-proxy';
import { KNOWN_ORCHESTRATOR_HOSTS } from '~/server/services/orchestrator/trusted-blob-url';
import { stripInvisible } from '~/server/utils/confusable-fold';
import { isConsumerBlobUrl, parseJobAssetUrl } from '~/shared/orchestrator/blob-url';

function configuredHostname(value: string | undefined) {
  if (!value) return undefined;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    // A bare name (`localhost`) or an IP would refuse ordinary text that mentions it.
    if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[')) return undefined;
    return host;
  } catch {
    return undefined;
  }
}

function orchestratorHostnames(): string[] {
  const configured = [env.ORCHESTRATOR_ENDPOINT, clientEnv.NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT]
    .map(configuredHostname)
    .filter((h): h is string => !!h);
  return [...new Set([...configured, ...KNOWN_ORCHESTRATOR_HOSTS, ORCHESTRATOR_PROXY_HOST])];
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Decodes each valid `%XX` on its own, so one stray `%` elsewhere cannot stop the decode. */
const decodePercents = (s: string) =>
  s.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** What a URL parser makes of the text: compatibility forms folded, dot segments resolved. */
function asParserReadsIt(s: string) {
  let out = s
    // URL parsers drop ASCII tab and newlines anywhere in a URL.
    .replace(/[\t\n\r]/g, '')
    .normalize('NFKC')
    .replace(/[。．｡]/g, '.')
    .toLowerCase();
  for (let i = 0; i < 16; i++) {
    const next = out.replace(/\/\.(?=\/)/g, '').replace(/\/(?!\.\.\/)[^/\s]+\/\.\.(?=\/)/, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

function namesOrchestratorMedia(text: string, hosts: RegExp[]) {
  return isConsumerBlobUrl(text) || !!parseJobAssetUrl(text) || hosts.some((h) => h.test(text));
}

function hostPatterns(): RegExp[] {
  return [...orchestratorHostnames().map(escapeRegex), ORCHESTRATOR_HOSTNAME_PATTERN].map(
    (h) => new RegExp(`(^|[^a-z0-9-])${h}($|[^a-z0-9-])`)
  );
}

function matches(raw: string, hosts: RegExp[]): boolean {
  let current = stripInvisible(raw);
  for (let pass = 0; pass < 8; pass++) {
    if (namesOrchestratorMedia(asParserReadsIt(current), hosts)) return true;
    const next = decodePercents(current);
    if (next === current) return false;
    current = next;
  }
  return false;
}

/**
 * Whether `text` carries a link to orchestrator media: a consumer-blob or job-asset path, or any
 * orchestrator host. That media belongs to the viewer who uploaded or generated it and is not
 * for other viewers of an app's shared data. Public image CDN urls do not match.
 */
export function containsPrivateMediaUrl(raw: string): boolean {
  return matches(raw, hostPatterns());
}

/**
 * {@link containsPrivateMediaUrl} over every string and object key in a JSON value, each read as
 * stored. Never matches serialised JSON, whose escapes (`\n` for a newline) hide what a URL
 * parser would see. No walk cap: the caller's own size limit bounds the value.
 */
export function valueContainsPrivateMediaUrl(value: unknown): boolean {
  const hosts = hostPatterns();
  const stack: unknown[] = [value];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node === 'string') {
      if (matches(node, hosts)) return true;
    } else if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (matches(key, hosts)) return true;
        stack.push(child);
      }
    }
  }
  return false;
}
