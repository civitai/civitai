/**
 * A release entity's body: one approved publish request, published through an ALLOWLIST of
 * manifest fields. Anything not named here never leaves, including fields added to the
 * manifest later; the bundle source, goods and build configuration are among those left out.
 */
import { createHash } from 'node:crypto';
import { registryUrn } from '~/server/registry-adapter/urn';

/** Manifest fields a release publishes, each with the only shape it is copied in. */
const STRING_FIELDS = [
  'blockId',
  'version',
  'name',
  'tagline',
  'repository',
  'contentRating',
  'category',
  'renderMode',
  'minApiVersion',
] as const;
const STRING_ARRAY_FIELDS = ['scopes'] as const;

export const RELEASE_MANIFEST_FIELDS: readonly string[] = [
  ...STRING_FIELDS,
  ...STRING_ARRAY_FIELDS,
];

export function publishedManifest(manifest: unknown): Record<string, unknown> {
  const m = (manifest && typeof manifest === 'object' ? manifest : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of STRING_FIELDS) {
    if (typeof m[key] === 'string') out[key] = m[key];
  }
  for (const key of STRING_ARRAY_FIELDS) {
    const v = m[key];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[key] = [...v];
  }
  return out;
}

/**
 * JSON with keys sorted and `undefined` dropped, so a hash names a value, not a layout. Array order
 * is kept (it is meaningful here), unlike `stableStringify`; `canonicalJson` is avoided because its
 * module loads the system Redis client on import.
 */
export function sortedKeyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedKeyJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedKeyJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

export type ApprovedRelease = {
  slug: string;
  version: string;
  manifest: unknown;
  bundleSha256: string | null;
  /** The commit the platform built and approved. */
  commitSha: string | null;
  /** The commit the submitter said the bundle came from (a claim, not verified). */
  sourceCommit: string | null;
  reviewedAt: Date | null;
};

export function releaseBody(args: {
  release: ApprovedRelease;
  runtimeUrn: string;
  sourceRepoUrl: string | null;
  /** Collection → the schema URN this release declared it under. */
  collections: Record<string, string>;
}): Record<string, unknown> {
  const { release } = args;
  const manifest = publishedManifest(release.manifest);
  const source: Record<string, string> = {};
  if (args.sourceRepoUrl) source.repo = args.sourceRepoUrl;
  if (release.commitSha) source.commit = release.commitSha;
  if (release.sourceCommit) source.claimedCommit = release.sourceCommit;
  return {
    app: registryUrn({ kind: 'app', slug: release.slug }),
    version: release.version,
    manifest,
    manifestHash: sha256Hex(sortedKeyJson(manifest)),
    runtime: args.runtimeUrn,
    ...(typeof manifest.contentRating === 'string'
      ? { contentRating: manifest.contentRating }
      : {}),
    ...(release.bundleSha256 ? { bundleSha256: release.bundleSha256 } : {}),
    ...(Object.keys(source).length ? { source } : {}),
    ...(Object.keys(args.collections).length ? { collections: args.collections } : {}),
    ...(release.reviewedAt ? { releasedAt: release.reviewedAt.toISOString() } : {}),
  };
}
