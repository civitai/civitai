export type CivitaiEntityRef =
  | { type: 'user'; username: string }
  | { type: 'model'; modelId: number; modelVersionId?: number }
  | { type: 'modelVersion'; modelVersionId: number }
  | { type: 'collection'; collectionId: number };

// Hosts we recognise without being told. The domain env vars are optional, so a
// bare dev environment supplies no runtime host list and this backstop is what
// keeps the parser working there.
const STATIC_HOST_PATTERN = /(^|\.)civitai\.(com|red|green|blue)$/;

// `new URL` needs an origin for relative input. Anything coming back with this
// host was host-relative, so the host check is skipped.
const RELATIVE_ORIGIN = 'https://url-had-no-host.invalid';

const INT = /^\d+$/;

function toInt(segment: string | null | undefined) {
  if (!segment || !INT.test(segment)) return undefined;
  const value = Number(segment);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function hostIsOurs(host: string, extraHosts: string[]) {
  const normalized = host.toLowerCase().replace(/^www\./, '');
  // A CDN host serves assets, never entity pages, and `image.civitai.com/...`
  // would otherwise satisfy the suffix match below.
  if (normalized.startsWith('image.')) return false;
  if (STATIC_HOST_PATTERN.test(normalized.split(':')[0])) return true;
  return extraHosts.some((candidate) => {
    const other = candidate.toLowerCase().replace(/^www\./, '');
    return other === normalized || other === normalized.split(':')[0];
  });
}

/**
 * Resolve a Civitai URL to the entity it points at. Returns null for anything
 * unrecognised — including a bare id, which callers handle themselves so that
 * "123" does not silently become a model.
 *
 * Deliberately ignores everything after the id segment. `/models/123/some-slug`,
 * `/models/123/reviews` and `/collections/123/join` all identify the base entity,
 * and stale slugs are rewritten by the model page on arrival, so validating one
 * would only reject links that work.
 */
export function parseCivitaiUrlSafe(
  input: string,
  opts?: { hosts?: string[] }
): CivitaiEntityRef | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;

  // A bare `civitai.com/models/123` has neither scheme nor leading slash. Treat
  // it as a host only when the first segment looks like one, so that a pasted
  // `models/123` stays a path rather than becoming the host "models".
  const looksHostFirst = !/^[a-z]+:\/\//i.test(trimmed) && !trimmed.startsWith('/');
  const firstSegment = trimmed.split('/')[0];
  const candidate = looksHostFirst && firstSegment.includes('.') ? `https://${trimmed}` : trimmed;

  let url: URL;
  try {
    url = new URL(candidate, RELATIVE_ORIGIN);
  } catch {
    return null;
  }

  const wasRelative = url.origin === RELATIVE_ORIGIN;
  if (!wasRelative && !hostIsOurs(url.host, opts?.hosts ?? [])) return null;

  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    // A malformed percent-escape throws rather than returning a bad string.
    return null;
  }
  if (!segments.length) return null;

  const [head, second] = segments;

  if (head === 'model-versions') {
    const modelVersionId = toInt(second);
    return modelVersionId ? { type: 'modelVersion', modelVersionId } : null;
  }

  if (head === 'models') {
    const modelId = toInt(second);
    if (!modelId) return null;
    // Junk in the query degrades to the model rather than failing the whole
    // parse — the link still identifies a model.
    const modelVersionId = toInt(url.searchParams.get('modelVersionId'));
    return modelVersionId ? { type: 'model', modelId, modelVersionId } : { type: 'model', modelId };
  }

  if (head === 'collections') {
    const collectionId = toInt(second);
    return collectionId ? { type: 'collection', collectionId } : null;
  }

  if (head === 'user') {
    const username = second?.trim();
    return username ? { type: 'user', username } : null;
  }

  return null;
}

export function isCivitaiUrl(input: string, opts?: { hosts?: string[] }) {
  return parseCivitaiUrlSafe(input, opts) !== null;
}
