import type { NextApiRequest, NextApiResponse } from 'next';
import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getWorkflow } from '~/server/services/orchestrator/workflows';

/**
 * Provenance for generated media: which on-site images were actually fed to the
 * job that produced it.
 *
 * The resolution runs at submit, server-side, off the validated graph input, and
 * the result travels two ways: on the workflow metadata, and as a signed token
 * baked into the output file via `imageMetadata`. Both are read back at upload
 * time by `resolveVerifiedSourceImageIds` — the client never supplies the value,
 * only a pointer to something the server already wrote.
 *
 * What a verified link proves: this user really ran a job with that image as an
 * input. What it does not prove: that the uploaded bytes are that job's output.
 * Closing that would take the server owning the copy from the orchestrator blob,
 * which the generator→post path doesn't do today.
 *
 * Absence always means unknown. An off-site remix — download, edit elsewhere,
 * upload — can never carry this, and must never be treated as not a remix.
 */

const VERSION = 1;

/** A job with more inputs than this is a collage, not a derivation worth tracking. */
const MAX_SOURCE_IMAGES = 8;

type ProvenancePayload = {
  v: number;
  /** Issued to this user; a token replayed by anyone else fails verification. */
  u: number;
  s: number[];
  t: number;
};

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cloudflare image ids are what `Image.url` stores, and `getEdgeUrl` keeps them
 * as a path segment, so an edge URL maps back to the row it came from. Anything
 * else — orchestrator blobs, freshly uploaded inputs, external URLs — has no
 * segment that matches and resolves to nothing.
 */
function extractImageUuid(url: string): string | undefined {
  if (UUID_SEGMENT.test(url)) return url;
  const withoutQuery = url.split('?')[0];
  return withoutQuery.split('/').find((segment) => UUID_SEGMENT.test(segment));
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', env.NEXTAUTH_SECRET).update(payload).digest('base64url');
}

/**
 * Maps input image URLs to the `Image` rows they came from.
 *
 * Duplicate uploads of the same file share a `url`, so a uuid can match several
 * rows; the oldest wins — it's the one the later copies were made from.
 */
export async function resolveSourceImageIds(urls?: string[]): Promise<number[]> {
  if (!urls?.length) return [];

  const uuids = [...new Set(urls.map(extractImageUuid).filter((x): x is string => !!x))];
  if (!uuids.length) return [];

  const rows = await dbRead.image.findMany({
    where: { url: { in: uuids } },
    select: { id: true, url: true },
    orderBy: { id: 'asc' },
  });

  const oldestByUrl = new Map<string, number>();
  for (const row of rows) if (!oldestByUrl.has(row.url)) oldestByUrl.set(row.url, row.id);

  return [...oldestByUrl.values()].slice(0, MAX_SOURCE_IMAGES);
}

export function signProvenance({
  userId,
  sourceImageIds,
}: {
  userId: number;
  sourceImageIds: number[];
}): string | undefined {
  if (!userId || !sourceImageIds.length) return undefined;

  const payload: ProvenancePayload = {
    v: VERSION,
    u: userId,
    s: sourceImageIds.slice(0, MAX_SOURCE_IMAGES),
    t: Math.floor(Date.now() / 1000),
  };
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Returns the source image ids a token vouches for, or null for anything that
 * doesn't verify against this user. Never throws — an unreadable token is an
 * absent signal, not a failed upload.
 */
export function verifyProvenance(token: unknown, userId: number): number[] | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  const expected = Buffer.from(sign(encoded));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as ProvenancePayload;
    if (payload.v !== VERSION || payload.u !== userId) return null;
    if (!Array.isArray(payload.s)) return null;

    const ids = payload.s.filter((id) => Number.isInteger(id) && id > 0);
    return ids.length ? ids.slice(0, MAX_SOURCE_IMAGES) : null;
  } catch {
    return null;
  }
}

function readSourceImageIds(metadata: unknown): number[] | null {
  const value = (metadata as { sourceImageIds?: unknown } | null | undefined)?.sourceImageIds;
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is number => Number.isInteger(id) && (id as number) > 0);
  return ids.length ? ids.slice(0, MAX_SOURCE_IMAGES) : null;
}

/**
 * The fallback for outputs that carry no readable embedded metadata — every
 * video today, since the MP4/WebM readers aren't wired into the upload path.
 *
 * The workflow id comes from the client, and that's fine: the read is scoped to
 * a token minted for the session user, so someone else's workflow 404s, and the
 * ids come off metadata this server wrote at submit rather than off the request.
 */
export async function sourceImageIdsFromWorkflow({
  userId,
  workflowId,
}: {
  userId: number;
  workflowId: string;
}): Promise<number[] | null> {
  try {
    const token = await getOrchestratorToken(
      userId,
      {} as {
        req: NextApiRequest;
        res: NextApiResponse;
      }
    );
    const workflow = await getWorkflow({ token, path: { workflowId } });
    return readSourceImageIds(workflow?.metadata);
  } catch (error) {
    logToAxiom({
      name: 'remix-provenance',
      type: 'warning',
      message: (error as Error).message,
      details: { userId, workflowId },
    }).catch(() => null);
    return null;
  }
}

/**
 * Rewrites `meta.extra` so a stored image's provenance is only ever what the
 * server put there. Applied at the write sinks (`createImage`, `updatePostImage`)
 * rather than at one entry point: every caller that reaches those sinks carries
 * client-authored meta, and a path that skipped this would let a user assert a
 * derivation by editing an image they already own.
 *
 * `verified` is what the caller proved, and the only thing that can put
 * `sourceImageIds` back. Passing nothing strips the claim and writes no link.
 */
export function sanitizeProvenance<T extends Record<string, unknown> | null | undefined>(
  meta: T,
  verified?: number[] | null
): T {
  if (!meta) return meta;

  const extra = meta.extra as Record<string, unknown> | undefined;
  const carriesClaim = !!extra && ('provenance' in extra || 'sourceImageIds' in extra);
  if (!carriesClaim && !verified?.length) return meta;

  const { provenance: _token, sourceImageIds: _claimed, ...rest } = extra ?? {};

  return {
    ...meta,
    extra: { ...rest, ...(verified?.length ? { sourceImageIds: verified } : {}) },
  } as T;
}

/** The ids already verified for a stored image, to carry across an edit of its meta. */
export function storedSourceImageIds(meta: unknown): number[] | null {
  const extra = (meta as { extra?: unknown } | null | undefined)?.extra;
  return readSourceImageIds(extra);
}

/**
 * The single entry point the upload path uses. Signed token first — it needs no
 * network call and survives a download/re-upload round trip — then the workflow
 * read for anything that arrived without one.
 */
export async function resolveVerifiedSourceImageIds({
  userId,
  provenance,
  workflowId,
}: {
  userId: number;
  provenance?: unknown;
  workflowId?: string;
}): Promise<number[] | null> {
  const signed = verifyProvenance(provenance, userId);
  if (signed) return signed;
  if (!workflowId) return null;
  return sourceImageIdsFromWorkflow({ userId, workflowId });
}
