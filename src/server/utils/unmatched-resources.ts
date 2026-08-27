import type { UnmatchedResource } from '~/server/schema/image.schema';

export type DetectedResource = {
  modelversionid: number | null;
  name?: string | null;
  hash: string | null;
  detected: boolean;
};

export type MetaResource = { type?: string; name?: string; hash?: string };

// meta.hashes is user-writable and get_image_resources() surfaces every value in it, including
// 'false', whitespace and truncated non-hex junk.
const HASH_SHAPE = /^[0-9a-f]{8,}$/;

// get_image_resources() strips only lora:/embed:/hypernet:, so lycoris:/checkpoint:/model: arrive intact.
const NAME_PREFIX = /^(lora|lycoris|embed|hypernet|model|checkpoint):/i;

function cleanName(name?: string | null) {
  const stripped = name
    ?.replace(NAME_PREFIX, '')
    .replace(/.*[/\\]/, '')
    .replace(/\.[^/.]+$/, '');
  return stripped?.trim() || undefined;
}

/**
 * Resources the image reported that resolved to no model version.
 *
 * Derived from get_image_resources(), not meta.resources: a resource present only in meta.hashes
 * has no meta.resources entry to carry a flag.
 *
 * Hashless detections are excluded deliberately — they can never be matched, and every
 * prompt-referenced embedding is one, so surfacing them buries the actionable cases.
 */
export function deriveUnmatchedResources(
  detected: DetectedResource[],
  metaResources: MetaResource[] = []
): UnmatchedResource[] {
  const byHash = new Map<string, MetaResource>();
  for (const resource of metaResources) {
    const hash = resource.hash?.toLowerCase().trim();
    if (hash && !byHash.has(hash)) byHash.set(hash, resource);
  }

  const unmatched: UnmatchedResource[] = [];
  const seen = new Set<string>();

  for (const resource of detected) {
    if (!resource.detected || resource.modelversionid) continue;

    const hash = resource.hash?.toLowerCase().trim();
    if (!hash || !HASH_SHAPE.test(hash) || seen.has(hash)) continue;
    seen.add(hash);

    const fromMeta = byHash.get(hash);
    unmatched.push({
      hash,
      name: cleanName(fromMeta?.name) ?? cleanName(resource.name) ?? hash.slice(0, 12),
      // Omitted, not undefined: jsonb drops an undefined key, so carrying one makes this unequal
      // to its own stored form and rewrites Image.meta every run.
      ...(fromMeta?.type ? { type: fromMeta.type } : {}),
    });
  }

  // get_image_resources() has no ORDER BY; the caller diffs this against the stored value, so the
  // order must be stable.
  return unmatched.sort((a, b) => a.name.localeCompare(b.name) || a.hash.localeCompare(b.hash));
}
