import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { UploadType } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import { handleLogError, throwBadRequestError } from '~/server/utils/errorHandling';

/**
 * Which url a client may give a model file it creates, or put behind one it replaces. A file's url
 * is what downloads, scans and training all read, so a client may only name an object it uploaded
 * or one already on a model it owns:
 *
 *   1. its own upload prefix, `<uploadType>/<callerId>/...`, in an upload bucket;
 *   2. `modelVersion/<id>/...` in an upload bucket, where `<id>` is a version of the same model
 *      (where a training checkpoint is copied to);
 *   3. exactly the url of a live file on a model the caller owns now (re-using a file, e.g. a
 *      dataset for further training, or a file on a model transferred to them).
 *
 * Moderators are exempt. Server-side creates (Training Studio publish, the Hugging Face transfer job)
 * choose their own url and do not come through here. A file copied from an awarded bounty entry is
 * held to rule 1 for the entry's author (`assertBountyEntryFileUrlAllowed`).
 */

export type StorageObjectUrlMiss =
  | 'malformed'
  | 'non-canonical'
  | 'unknown-host'
  | 'not-upload-bucket';
export type ClientFileUrlMiss =
  | StorageObjectUrlMiss
  | 'other-user-prefix'
  | 'other-model-version'
  | 'unrecognised-key';

type ParsedStorageUrl =
  | { ok: true; bucket: string; key: string }
  | { ok: false; reason: StorageObjectUrlMiss };

// `new URL` silently drops tabs and newlines, turns `\` into `/` and resolves `.`/`..` (also when
// written `%2e`), so a raw url can name a different object than its parsed form appears to. Such a
// url is refused outright rather than matched on what it normalises to.
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const DOT_SEGMENT = /^\.{1,2}$/;
const B2_PATH_STYLE_HOST = /^s3\.[a-z0-9-]+\.backblazeb2\.com$/;
const B2_VIRTUAL_HOST = /^([a-z0-9][a-z0-9-]*)\.(s3\.[a-z0-9-]+\.backblazeb2\.com)$/;

function hostOf(endpoint: string | undefined) {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return { protocol: url.protocol, host: url.host };
  } catch {
    return null;
  }
}

/** The buckets a new upload, or a checkpoint copied into storage, can land in. */
function uploadBuckets() {
  return [env.S3_UPLOAD_BUCKET, env.S3_UPLOAD_B2_BUCKET ?? 'civitai-modelfiles'].filter(
    (b): b is string => !!b
  );
}

/**
 * Parse a url naming an object in one of our upload buckets into its (bucket, key). Path-style
 * (`host/bucket/key`) and virtual-host (`bucket.host/key`) forms of the same object parse the same.
 */
export function parseUploadObjectUrl(raw: string): ParsedStorageUrl {
  if (CONTROL_OR_SPACE.test(raw) || raw.includes('\\') || raw.includes('?') || raw.includes('#'))
    return { ok: false, reason: 'non-canonical' };

  const rawPath = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)$/i.exec(raw)?.[1];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!rawPath) return { ok: false, reason: 'malformed' };
  if (url.username || url.password) return { ok: false, reason: 'non-canonical' };

  const segments = decodePathOnce(rawPath);
  if (!segments) return { ok: false, reason: 'non-canonical' };

  // Storage reads a path-style bucket from the raw path, so it must not need decoding to be found.
  const rawBucket = rawPath.slice(1).split('/')[0];
  const located = locateBucket(url, segments, !rawBucket.includes('%'));
  if (!located) return { ok: false, reason: 'unknown-host' };
  if (!uploadBuckets().includes(located.bucket)) return { ok: false, reason: 'not-upload-bucket' };
  if (!located.key) return { ok: false, reason: 'malformed' };
  return { ok: true, ...located };
}

/**
 * The path's segments as storage reads them. A large R2 upload's url carries its whole key as one
 * segment with the slashes encoded (`/<bucket>/default%2F<userId>%2F<name>`), so each segment is
 * decoded once and every check runs on the result: anything still encoded after that (`%252F`), and
 * any `\`, dot or empty segment it produces, is refused.
 */
function decodePathOnce(rawPath: string): string[] | null {
  let decoded: string;
  try {
    decoded = rawPath.slice(1).split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  if (CONTROL.test(decoded) || decoded.includes('\\') || decoded.includes('%')) return null;
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '' || DOT_SEGMENT.test(segment))) return null;
  return segments;
}

function locateBucket(
  url: URL,
  segments: string[],
  plainFirstSegment: boolean
): { bucket: string; key: string } | null {
  const pathStyle = () =>
    plainFirstSegment ? { bucket: segments[0], key: segments.slice(1).join('/') } : null;
  const virtualHost = (bucket: string) => ({ bucket, key: segments.join('/') });

  for (const endpoint of [hostOf(env.S3_UPLOAD_ENDPOINT), hostOf(env.S3_UPLOAD_B2_ENDPOINT)]) {
    if (!endpoint || url.protocol !== endpoint.protocol) continue;
    if (url.host === endpoint.host) return pathStyle();
    const suffix = '.' + endpoint.host;
    if (url.host.endsWith(suffix)) {
      const bucket = url.host.slice(0, -suffix.length);
      if (bucket && !bucket.includes('.')) return virtualHost(bucket);
    }
  }

  // B2's own S3 hosts, recognised without the endpoint env, as `parseB2Url` does.
  if (url.protocol !== 'https:' || url.port) return null;
  if (B2_PATH_STYLE_HOST.test(url.hostname)) return pathStyle();
  const virtual = B2_VIRTUAL_HOST.exec(url.hostname);
  if (virtual) return virtualHost(virtual[1]);
  return null;
}

const uploadTypes: string[] = Object.values(UploadType);
const isCanonicalId = (segment: string | undefined) =>
  !!segment && /^[1-9][0-9]*$/.test(segment) && Number.isSafeInteger(Number(segment));

/** Rules 1 and 2 on a parsed key. Rule 2 still needs the version lookup. */
export function classifyUploadKey(
  key: string,
  callerId: number
):
  | { kind: 'own-upload' }
  | { kind: 'model-version'; modelVersionId: number }
  | { kind: 'miss'; reason: 'other-user-prefix' | 'unrecognised-key' } {
  const [prefix, owner, ...rest] = key.split('/');
  if (!rest.length || !rest[rest.length - 1]) return { kind: 'miss', reason: 'unrecognised-key' };
  if (prefix === 'modelVersion' && isCanonicalId(owner))
    return { kind: 'model-version', modelVersionId: Number(owner) };
  if (uploadTypes.includes(prefix) && isCanonicalId(owner))
    return owner === String(callerId)
      ? { kind: 'own-upload' }
      : { kind: 'miss', reason: 'other-user-prefix' };
  return { kind: 'miss', reason: 'unrecognised-key' };
}

// Scoped to the caller's own models, so the answer says nothing about versions they cannot edit.
async function isVersionOfSameOwnedModel(
  keyVersionId: number,
  targetVersionId: number,
  userId: number
) {
  if (keyVersionId === targetVersionId) return true;
  const version = await dbWrite.modelVersion.findFirst({
    where: {
      id: keyVersionId,
      model: { userId, modelVersions: { some: { id: targetVersionId } } },
    },
    select: { id: true },
  });
  return !!version;
}

// Ownership is the model's CURRENT owner, not whoever created the file, so a model transferred away
// stops qualifying its files' urls.
async function isUrlOfOwnedLiveFile(url: string, userId: number) {
  const file = await dbWrite.modelFile.findFirst({
    where: { url, replacedAt: null, modelVersion: { model: { userId } } },
    select: { id: true },
  });
  return !!file;
}

/**
 * Why `url` may not be set by `userId` on a file of `modelVersionId`, or null when it may.
 * Moderators are not checked here; see `assertClientFileUrlAllowed`.
 */
export async function findClientFileUrlMiss({
  url,
  userId,
  modelVersionId,
}: {
  url: string;
  userId: number;
  modelVersionId: number;
}): Promise<ClientFileUrlMiss | null> {
  let miss: ClientFileUrlMiss;
  const parsed = parseUploadObjectUrl(url);
  if (!parsed.ok) miss = parsed.reason;
  else {
    const key = classifyUploadKey(parsed.key, userId);
    if (key.kind === 'own-upload') return null;
    if (key.kind === 'model-version') {
      if (await isVersionOfSameOwnedModel(key.modelVersionId, modelVersionId, userId)) return null;
      miss = 'other-model-version';
    } else miss = key.reason;
  }

  if (await isUrlOfOwnedLiveFile(url, userId)) return null;
  return miss;
}

/** Rule 1 for the entry's author. No moderator exemption: the author chose the url, not the caller. */
export function assertBountyEntryFileUrlAllowed({
  url,
  authorId,
  userId,
  bountyEntryId,
}: {
  url: string;
  authorId: number | null;
  userId: number;
  bountyEntryId: number;
}) {
  const parsed = parseUploadObjectUrl(url);
  let reason: ClientFileUrlMiss;
  if (!parsed.ok) reason = parsed.reason;
  else if (authorId == null) reason = 'other-user-prefix';
  else {
    const key = classifyUploadKey(parsed.key, authorId);
    if (key.kind === 'own-upload') return;
    reason = key.kind === 'miss' ? key.reason : 'other-model-version';
  }

  logToAxiom({
    type: 'warning',
    name: 'model-file-url-refused',
    op: 'bounty-award',
    userId,
    authorId,
    bountyEntryId,
    reason,
    url,
  }).catch(handleLogError);
  throw throwBadRequestError(
    "This bounty entry's files can't be copied into a model version. Upload the files to the version instead."
  );
}

export async function assertClientFileUrlAllowed({
  url,
  userId,
  isModerator,
  modelVersionId,
  op,
}: {
  url: string;
  userId: number;
  isModerator: boolean;
  modelVersionId: number;
  op: 'create' | 'replace';
}) {
  if (isModerator) return;
  const miss = await findClientFileUrlMiss({ url, userId, modelVersionId });
  if (!miss) return;

  logToAxiom({
    type: 'warning',
    name: 'model-file-url-refused',
    op,
    userId,
    modelVersionId,
    reason: miss,
    url,
  }).catch(handleLogError);
  throw throwBadRequestError(
    "This file's upload could not be matched to your account. Upload the file again."
  );
}
