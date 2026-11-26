/**
 * Staff ON-BEHALF SUBMIT of a platform update, the PURE half: which bundle a staff submit files,
 * which version it carries, and the refusals a moderator reads. No I/O here. The I/O half is
 * `app-platform-update-submit.service.ts`.
 *
 * THE BUNDLE is the app's APPROVED build with the update's recorded commit applied on top, path
 * by path. Not the source repo's `main`: that can hold the owner's own unsubmitted work, and a
 * staff submit must never ship code the owner has not sent for review themselves.
 *
 * A path the update changes is applied only when the approved build still holds exactly what the
 * update was written against (the file at the update's base commit, or its absence). Otherwise
 * the approved file and the update's base differ, so applying the update's whole file would also
 * ship whatever made them differ: that path is a conflict and the submit is refused.
 */

import semver from 'semver';
import { gitBlobSha, type BlobTree } from '~/server/services/blocks/app-source-repo.plan';

export const MANIFEST_PATH = 'block.manifest.json';

/** The refusal when the app already has a pending publish request (one per app). */
export const OWNER_PENDING_REFUSAL =
  'The owner has a pending publish request for this app. The update stays on its branch and ' +
  'merges on their next submit, or retry after that request is reviewed.';

/** The refusal when a staff submit of this app is already waiting for review. */
export const STAFF_PENDING_REFUSAL =
  'A staff submission for this app is already waiting for review; retry after it is reviewed.';

export type UpdatePath = { path: string; operation: 'create' | 'update' | 'delete' };

export class OnBehalfPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnBehalfPlanError';
  }
}

/**
 * The files the on-behalf bundle holds: `approved` with every path of the update applied.
 *
 * @param approved the approved build's files, path → bytes.
 * @param baseTree the source repo's tree at the update's base commit (path → blob sha).
 * @param updateFiles the bytes of every created or updated path at the update's commit.
 */
export function planOnBehalfFiles(args: {
  approved: ReadonlyMap<string, Buffer>;
  baseTree: BlobTree;
  paths: readonly UpdatePath[];
  updateFiles: ReadonlyMap<string, Buffer>;
}): Map<string, Buffer> {
  const conflicts: string[] = [];
  for (const { path } of args.paths) {
    const approved = args.approved.get(path);
    const approvedSha = approved ? gitBlobSha(approved) : null;
    if (approvedSha !== (args.baseTree[path] ?? null)) conflicts.push(path);
  }
  if (conflicts.length)
    throw new OnBehalfPlanError(
      `The approved version differs from what the update was written against in ${conflicts
        .sort()
        .join(', ')}; the owner has to merge this update and submit it themselves`
    );

  const out = new Map(args.approved);
  for (const { path, operation } of args.paths) {
    if (operation === 'delete') {
      out.delete(path);
      continue;
    }
    const content = args.updateFiles.get(path);
    if (!content)
      throw new OnBehalfPlanError(`The update's commit does not hold ${path}; it cannot be built`);
    out.set(path, content);
  }
  return out;
}

/**
 * The version an on-behalf submit carries: the bundle manifest's own version when it is above
 * every approved version, else the patch after the highest approved one. The same rule a manifest
 * edit enforces (a new version must be above the current one), applied for the moderator rather
 * than refused, because the moderator did not choose a version.
 */
export function onBehalfVersion(manifestVersion: unknown, approvedVersions: readonly string[]) {
  const highest = approvedVersions.filter((v) => semver.valid(v)).sort(semver.rcompare)[0];
  const own = typeof manifestVersion === 'string' && semver.valid(manifestVersion);
  if (!highest) {
    if (own) return manifestVersion as string;
    throw new OnBehalfPlanError('The app has no approved version to submit an update to');
  }
  if (own && semver.gt(manifestVersion as string, highest)) return manifestVersion as string;
  return semver.inc(highest, 'patch')!;
}

/**
 * Refuses unless `version` is strictly above every valid approved version. A staff submit must
 * never file a version at or below one already approved: approving it would roll the app back.
 * `onBehalfVersion` picks such a version by construction; this checks the version actually filed.
 */
export function assertAboveApproved(version: string, approvedVersions: readonly string[]): void {
  if (!semver.valid(version))
    throw new OnBehalfPlanError(`The version ${version} is not a valid version number`);
  const highest = approvedVersions.filter((v) => semver.valid(v)).sort(semver.rcompare)[0];
  if (highest && !semver.gt(version, highest))
    throw new OnBehalfPlanError(
      `The version ${version} is not above the approved version ${highest}; reload and retry`
    );
}

/**
 * The bundle's manifest with `version` set, as the file the bundle holds. Unchanged bytes when
 * the version already matches, so a manifest the update did not touch is only rewritten when its
 * version has to move.
 */
export function withManifestVersion(manifestFile: Buffer, version: string): Buffer {
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestFile.toString('utf8'));
  } catch {
    throw new OnBehalfPlanError(`${MANIFEST_PATH} is not valid JSON; it cannot be built`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new OnBehalfPlanError(`${MANIFEST_PATH} must contain a JSON object`);
  if ((manifest as { version?: unknown }).version === version) return manifestFile;
  return Buffer.from(`${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
}
