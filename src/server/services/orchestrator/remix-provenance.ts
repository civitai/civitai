import type { NextApiRequest, NextApiResponse } from 'next';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { env as clientEnv } from '~/env/client';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getWorkflow } from '~/server/services/orchestrator/workflows';

/**
 * Provenance for generated media: which on-site images were actually fed to the
 * job that produced it.
 *
 * Resolved at submit, server-side, off the validated graph input, then carried as
 * an encrypted, authenticated token — baked into the output file via
 * `imageMetadata`, and set on the workflow metadata for outputs whose file
 * carries nothing (every video, today). At upload the client points at one of
 * those; it never supplies a value.
 *
 * 🔴 The token, never plain ids, and the workflow metadata is why that is not
 * optional: `orchestrator.updateWorkflow` and `orchestrator.patch` both take
 * free-form metadata on a workflow the caller owns, so ids written there would be
 * a field the user authors and we read back as proof. A token they cannot mint is
 * inert in their hands.
 *
 * What a verified link proves: this user really ran a job with that image as an
 * input. What it does not prove: that the uploaded bytes are that job's output —
 * one real generation lets them attach the same token to other files, which is
 * why it expires. Closing that properly would take the server owning the copy
 * from the orchestrator blob, which the generator→post path doesn't do.
 *
 * Absence always means unknown. An off-site remix — download, edit elsewhere,
 * upload — can never carry this, and must never be treated as not a remix.
 */

const VERSION = 1;

/** A job with more inputs than this is a collage, not a derivation worth tracking. */
const MAX_SOURCE_IMAGES = 8;

/**
 * How long a token stays usable. Long enough for the ordinary path — generate,
 * come back later, post — and short enough that one generation isn't a permanent
 * licence to assert derivation from that source on anything the user uploads.
 */
const MAX_TOKEN_AGE_SECONDS = 60 * 60 * 24 * 30;

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
 *
 * The host is checked, not just the shape: generation input URLs are a bare
 * `z.string()`, so `https://attacker.example/<someone-elses-uuid>/x.png` would
 * otherwise resolve to an image the job never touched.
 */
function extractImageUuid(url: string): string | undefined {
  if (UUID_SEGMENT.test(url)) return url;
  const imageHost = clientEnv.NEXT_PUBLIC_IMAGE_LOCATION;
  if (!imageHost || !url.startsWith(`${imageHost}/`)) return undefined;

  const withoutQuery = url.split('?')[0];
  return withoutQuery.split('/').find((segment) => UUID_SEGMENT.test(segment));
}

/**
 * Its own key, derived rather than using `NEXTAUTH_SECRET` raw, so a token can
 * never be confused with anything else signed by the same secret.
 */
function provenanceKey(): Buffer {
  return createHash('sha256')
    .update(`${env.NEXTAUTH_SECRET}:remix-provenance:v${VERSION}`)
    .digest();
}

const TOKEN_PREFIX = `p${VERSION}`;

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

/**
 * Encrypted, not merely signed. The token is baked into every generated file and
 * those files are public, so a readable payload would publish the generating
 * user's id and the ids of their source images — including sources that are
 * private or unpublished. AES-GCM also authenticates, so this is strictly more
 * than a signature.
 */
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

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', provenanceKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);

  return [
    TOKEN_PREFIX,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

/**
 * Returns the source image ids a token vouches for, or null for anything that
 * doesn't verify against this user. Never throws — an unreadable token is an
 * absent signal, not a failed upload.
 */
export function verifyProvenance(token: unknown, userId: number): number[] | null {
  if (typeof token !== 'string') return null;

  const [prefix, iv, ciphertext, tag] = token.split('.');
  if (prefix !== TOKEN_PREFIX || !iv || !ciphertext || !tag) return null;

  try {
    const decipher = createDecipheriv('aes-256-gcm', provenanceKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    // Throws on any tampering — caught below and read as "no signal".
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');

    const payload = JSON.parse(decrypted) as ProvenancePayload;
    if (payload.v !== VERSION || payload.u !== userId) return null;
    if (!Array.isArray(payload.s)) return null;

    // A token is a bearer credential for its user: it says a job of theirs used
    // these sources, and nothing ties it to a particular file. Expiry is what
    // stops one generation from being reusable against that source forever.
    const age = Math.floor(Date.now() / 1000) - payload.t;
    if (!Number.isFinite(age) || age < 0 || age > MAX_TOKEN_AGE_SECONDS) return null;

    const ids = payload.s.filter((id) => Number.isInteger(id) && id > 0);
    return ids.length ? ids.slice(0, MAX_SOURCE_IMAGES) : null;
  } catch {
    return null;
  }
}

/**
 * The fallback for outputs that carry no readable embedded metadata — every
 * video today, since the MP4/WebM readers aren't wired into the upload path.
 *
 * Two independent checks, because the workflow id comes from the client: the read
 * is scoped to an orchestrator token minted for the session user, so someone
 * else's workflow 404s; and the metadata holds a signed token rather than plain
 * ids, so a user who overwrites their own workflow's metadata — which our own
 * `updateWorkflow`/`patch` mutations let them do — writes something that fails
 * verification instead of something we believe.
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
    const claimed = (workflow?.metadata as { provenance?: unknown } | null | undefined)?.provenance;
    return verifyProvenance(claimed, userId);
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

  // `in` throws on a primitive, and this now runs on every image-creation path
  // in the app — including ones whose meta never went through a zod object.
  const rawExtra = meta.extra;
  const extra =
    typeof rawExtra === 'object' && rawExtra !== null
      ? (rawExtra as Record<string, unknown>)
      : undefined;
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
  const value = (extra as { sourceImageIds?: unknown } | null | undefined)?.sourceImageIds;
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is number => Number.isInteger(id) && (id as number) > 0);
  return ids.length ? ids.slice(0, MAX_SOURCE_IMAGES) : null;
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
