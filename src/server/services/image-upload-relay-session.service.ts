import { randomUUID } from 'crypto';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
// Every call is raced against the read deadline, writes included: the part route holds a
// buffering slot across `recordRelaySessionPart`, and a write parked on a half-open sys socket
// would hold it for minutes.
import { withSysReadDeadline } from '~/server/redis/sys-read-deadline';

/**
 * Server-side state of one chunked upload-relay session.
 *
 * 🔴 The storage key and multipart uploadId live ONLY here, never in a client request: the client
 * holds an opaque session id, and every step re-reads the record and checks `userId` against the
 * caller's session. A client-supplied key or uploadId would let a caller write parts into, or
 * complete, someone else's upload.
 */
export type ImageUploadRelaySession = {
  userId: number;
  key: string;
  uploadId: string;
  size: number;
  /** Fixed per session, so a deploy that changes the piece size cannot strand one in flight. */
  pieceSize: number;
  partCount: number;
  /** ETag per part number, for the parts uploaded so far. */
  etags: Map<number, string>;
};

/** Long enough for a slow link to push a 50 MB file through us; refreshed on every part. */
export const RELAY_SESSION_TTL_SECONDS = 60 * 60;

const PART_FIELD_PREFIX = 'part:';
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionKey(sessionId: string) {
  return `${REDIS_SYS_KEYS.IMAGE_UPLOAD.RELAY_SESSION}:${sessionId}` as const;
}

export async function createRelaySession(
  session: Omit<ImageUploadRelaySession, 'etags'>
): Promise<string> {
  const sessionId = randomUUID();
  await withSysReadDeadline(
    sysRedis.hSetMultiWithExpire(
      sessionKey(sessionId),
      [
        'userId',
        String(session.userId),
        'key',
        session.key,
        'uploadId',
        session.uploadId,
        'size',
        String(session.size),
        'pieceSize',
        String(session.pieceSize),
        'partCount',
        String(session.partCount),
      ],
      RELAY_SESSION_TTL_SECONDS
    )
  );
  return sessionId;
}

/**
 * The session, if it exists AND belongs to `userId`; otherwise null.
 *
 * Unknown, expired, malformed and someone-else's all collapse to null on purpose, so the route
 * answers them identically and a caller cannot probe which session ids exist.
 */
export async function getOwnedRelaySession(
  sessionId: unknown,
  userId: number
): Promise<ImageUploadRelaySession | null> {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  const raw = await withSysReadDeadline(sysRedis.hGetAll(sessionKey(sessionId)));
  if (!raw || Number(raw.userId) !== userId) return null;
  const size = Number(raw.size);
  const pieceSize = Number(raw.pieceSize);
  const partCount = Number(raw.partCount);
  if (
    !raw.key ||
    !raw.uploadId ||
    ![size, pieceSize, partCount].every((n) => Number.isInteger(n) && n > 0)
  )
    return null;
  const etags = new Map<number, string>();
  for (const [field, value] of Object.entries(raw)) {
    if (!field.startsWith(PART_FIELD_PREFIX)) continue;
    const partNumber = Number(field.slice(PART_FIELD_PREFIX.length));
    if (Number.isInteger(partNumber)) etags.set(partNumber, value);
  }
  return { userId, key: raw.key, uploadId: raw.uploadId, size, pieceSize, partCount, etags };
}

/** Record a stored part's ETag; a re-sent part overwrites, as S3 does with the part itself. */
export async function recordRelaySessionPart(sessionId: string, partNumber: number, etag: string) {
  await withSysReadDeadline(
    sysRedis.hSetMultiWithExpire(
      sessionKey(sessionId),
      [`${PART_FIELD_PREFIX}${partNumber}`, etag],
      RELAY_SESSION_TTL_SECONDS
    )
  );
}

export async function deleteRelaySession(sessionId: string) {
  await withSysReadDeadline(sysRedis.del(sessionKey(sessionId)));
}
