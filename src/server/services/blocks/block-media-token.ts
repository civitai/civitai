import { openToken, sealToken } from '~/server/utils/sealed-token';

/**
 * `bm1` tokens: how App Block workflow media leaves the host. Sealed, so an app
 * sees opaque bytes and never the orchestrator blob key, which is a bearer
 * capability on its own.
 *
 * A `ticket` is viewer-bound and short-lived: the media route opens it and
 * redirects. A `ref` is what an app may store and replay; it carries no viewer,
 * and only `GET_WORKFLOW_MEDIA` opens it, re-checking for whoever replays it.
 * The kind is bound into the AAD, so neither opens as the other.
 */

export type BlockMediaType = 'image' | 'video' | 'audio' | 'model3d' | 'archive';

export const BLOCK_MEDIA_TICKET_TTL_SECONDS = 2 * 60;
export const BLOCK_MEDIA_REF_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 30;

const DOMAIN = 'block-media:v1';
const PREFIX = 'bm1';

export type BlockMediaClaims = {
  blobId: string;
  workflowId: string;
  ownerId: number;
  appBlockId: string;
  mediaType: BlockMediaType;
  privateGen: boolean;
  /** `isNeverRatedVideoStep` for the producing step, which a blob HEAD cannot tell. */
  neverRatedVideoStep: boolean;
};

export type BlockMediaRef = BlockMediaClaims & { exp: number };
export type BlockMediaTicket = BlockMediaClaims & {
  /** The viewer the ticket was minted for; null for an anonymous viewer. */
  viewerId: number | null;
  /** Browsing level the fetch is judged against: the minting viewer's. */
  viewerBrowsingLevel: number;
  exp: number;
};

type Kind = 'ticket' | 'ref';
const sealOptions = (kind: Kind) => ({ domain: DOMAIN, prefix: PREFIX, aad: `${PREFIX}:${kind}` });

const nowSeconds = () => Math.floor(Date.now() / 1000);

const MEDIA_TYPES = new Set<string>(['image', 'video', 'audio', 'model3d', 'archive']);

function readBlockMediaClaims(raw: Record<string, unknown>): BlockMediaClaims | null {
  const { blobId, workflowId, ownerId, appBlockId, mediaType, privateGen, neverRatedVideoStep } =
    raw;
  if (typeof blobId !== 'string' || !blobId) return null;
  if (typeof workflowId !== 'string' || !workflowId) return null;
  if (typeof ownerId !== 'number' || !Number.isInteger(ownerId)) return null;
  if (typeof appBlockId !== 'string' || !appBlockId) return null;
  if (typeof mediaType !== 'string' || !MEDIA_TYPES.has(mediaType)) return null;
  if (typeof privateGen !== 'boolean') return null;
  if (typeof neverRatedVideoStep !== 'boolean') return null;
  return {
    blobId,
    workflowId,
    ownerId,
    appBlockId,
    mediaType: mediaType as BlockMediaType,
    privateGen,
    neverRatedVideoStep,
  };
}

/** Rejects an expired token, and one whose `exp` lies further out than its kind can mint. */
function expiryHolds(exp: unknown, ttlSeconds: number): exp is number {
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
  const now = nowSeconds();
  return exp >= now && exp <= now + ttlSeconds + MAX_CLOCK_SKEW_SECONDS;
}

function openKind(token: unknown, kind: Kind): Record<string, unknown> | null {
  const raw = openToken(token, sealOptions(kind));
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

export function sealBlockMediaRef(claims: BlockMediaClaims): string | undefined {
  const ref: BlockMediaRef = { ...claims, exp: nowSeconds() + BLOCK_MEDIA_REF_TTL_SECONDS };
  return sealToken(ref, sealOptions('ref'));
}

export function openBlockMediaRef(token: unknown): BlockMediaRef | null {
  const raw = openKind(token, 'ref');
  if (!raw) return null;
  const claims = readBlockMediaClaims(raw);
  if (!claims || !expiryHolds(raw.exp, BLOCK_MEDIA_REF_TTL_SECONDS)) return null;
  return { ...claims, exp: raw.exp as number };
}

export function sealBlockMediaTicket(
  claims: BlockMediaClaims & { viewerId: number | null; viewerBrowsingLevel: number }
): string | undefined {
  const ticket: BlockMediaTicket = {
    ...claims,
    exp: nowSeconds() + BLOCK_MEDIA_TICKET_TTL_SECONDS,
  };
  return sealToken(ticket, sealOptions('ticket'));
}

export function openBlockMediaTicket(token: unknown): BlockMediaTicket | null {
  const raw = openKind(token, 'ticket');
  if (!raw) return null;
  const claims = readBlockMediaClaims(raw);
  if (!claims || !expiryHolds(raw.exp, BLOCK_MEDIA_TICKET_TTL_SECONDS)) return null;
  const { viewerId, viewerBrowsingLevel } = raw;
  if (viewerId !== null && (typeof viewerId !== 'number' || !Number.isInteger(viewerId)))
    return null;
  if (
    typeof viewerBrowsingLevel !== 'number' ||
    !Number.isInteger(viewerBrowsingLevel) ||
    viewerBrowsingLevel < 0
  )
    return null;
  return { ...claims, viewerId, viewerBrowsingLevel, exp: raw.exp as number };
}

export function blockMediaUrl(ticket: string) {
  return `/api/v1/blocks/media/${ticket}`;
}
