import type { UnmatchedResource } from '~/server/schema/image.schema';

export type DetectedResource = {
  modelversionid: number | null;
  name?: string | null;
  hash: string | null;
  detected: boolean;
};

export type MetaResource = { type?: string; name?: string; hash?: string };

// get_image_resources() surfaces every value in meta.hashes, which is user-writable and holds
// junk alongside real hashes ('false', ' ', '' and 1-5 char values in a day's prod sample).
const HASH_SHAPE = /^[0-9a-f]{8,}$/;

// The SQL strips these prefixes from meta.hashes keys before returning them, but only some of them.
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
 * Derived from get_image_resources() rather than from meta.resources: that function unions four
 * detection sources, so a resource present only in meta.hashes has no meta.resources entry to
 * carry a flag. Those are the ones users report as missing from the upload warning.
 *
 * Hashless detections are deliberately excluded. They can never be matched by definition, and
 * every prompt-referenced embedding is one — surfacing them would bury the actionable cases.
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
      // Total by construction so no consumer has to handle a missing label
      name: cleanName(fromMeta?.name) ?? cleanName(resource.name) ?? hash.slice(0, 12),
      // Omitted rather than set undefined: jsonb drops an undefined key, so carrying one would
      // make this value unequal to its own stored form and rewrite Image.meta on every run.
      ...(fromMeta?.type ? { type: fromMeta.type } : {}),
    });
  }

  // get_image_resources() has no ORDER BY, so detection order is not stable between calls. Sort
  // before returning: the caller diffs this against the stored value to decide whether to write.
  return unmatched.sort((a, b) => a.name.localeCompare(b.name) || a.hash.localeCompare(b.hash));
}
