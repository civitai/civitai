import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCK_MEDIA_REF_TTL_SECONDS,
  BLOCK_MEDIA_TICKET_TTL_SECONDS,
  openBlockMediaRef,
  openBlockMediaTicket,
  sealBlockMediaRef,
  sealBlockMediaTicket,
} from '~/server/services/blocks/block-media-token';
import { openToken, sealToken } from '~/server/utils/sealed-token';

const claims = {
  blobId: 'BLOBKEY123',
  workflowId: 'wf-1',
  ownerId: 7,
  appBlockId: 'apb_1',
  mediaType: 'video' as const,
  privateGen: false,
  neverRatedVideoStep: false,
};
const viewer = { viewerId: 99, viewerBrowsingLevel: 1 };

afterEach(() => vi.useRealTimers());

describe('bm1 media tokens', () => {
  it('CONTROL: a ticket and a ref each open as their own kind', () => {
    expect(openBlockMediaTicket(sealBlockMediaTicket({ ...claims, ...viewer }))).toMatchObject({
      ...claims,
      ...viewer,
    });
    expect(openBlockMediaRef(sealBlockMediaRef(claims))).toMatchObject(claims);
  });

  it('a ref never opens as a ticket, and a ticket never opens as a ref', () => {
    expect(openBlockMediaTicket(sealBlockMediaRef(claims))).toBeNull();
    expect(openBlockMediaRef(sealBlockMediaTicket({ ...claims, ...viewer }))).toBeNull();
  });

  it('keeps the blob key out of the wire form', () => {
    const ticket = sealBlockMediaTicket({ ...claims, ...viewer })!;
    expect(ticket.startsWith('bm1.')).toBe(true);
    expect(ticket).not.toContain(claims.blobId);
    expect(Buffer.from(ticket.split('.')[2], 'base64url').toString('latin1')).not.toContain(
      claims.blobId
    );
  });

  it('a ticket expires after two minutes', () => {
    vi.useFakeTimers();
    const ticket = sealBlockMediaTicket({ ...claims, ...viewer });
    vi.advanceTimersByTime((BLOCK_MEDIA_TICKET_TTL_SECONDS - 1) * 1000);
    expect(openBlockMediaTicket(ticket)).not.toBeNull();
    vi.advanceTimersByTime(2000);
    expect(openBlockMediaTicket(ticket)).toBeNull();
  });

  it('a ref expires after its TTL', () => {
    vi.useFakeTimers();
    const ref = sealBlockMediaRef(claims);
    vi.advanceTimersByTime((BLOCK_MEDIA_REF_TTL_SECONDS - 1) * 1000);
    expect(openBlockMediaRef(ref)).not.toBeNull();
    vi.advanceTimersByTime(2000);
    expect(openBlockMediaRef(ref)).toBeNull();
  });

  // Sealed with the real key and options, so only the claim checks stand between it and opening.
  const sealRaw = (kind: 'ticket' | 'ref', payload: Record<string, unknown>) =>
    sealToken(payload, { domain: 'block-media:v1', prefix: 'bm1', aad: `bm1:${kind}` });
  const now = () => Math.floor(Date.now() / 1000);

  it('CONTROL: a well-formed raw ticket opens', () => {
    expect(
      openBlockMediaTicket(sealRaw('ticket', { ...claims, ...viewer, exp: now() + 60 }))
    ).not.toBeNull();
  });

  it('🔴 refuses a token whose expiry is beyond its TTL', () => {
    expect(
      openBlockMediaTicket(sealRaw('ticket', { ...claims, ...viewer, exp: now() + 3600 }))
    ).toBeNull();
    expect(
      openBlockMediaRef(
        sealRaw('ref', { ...claims, exp: now() + BLOCK_MEDIA_REF_TTL_SECONDS + 3600 })
      )
    ).toBeNull();
  });

  it.each([
    ['privateGen as a string', { privateGen: 'false' }],
    ['a fractional ownerId', { ownerId: 7.5 }],
    ['an unknown mediaType', { mediaType: 'html' }],
    ['a negative viewer level', { viewerBrowsingLevel: -1 }],
    ['a string viewer level', { viewerBrowsingLevel: '31' }],
    ['a missing viewer level', { viewerBrowsingLevel: undefined }],
    ['a fractional viewer level', { viewerBrowsingLevel: 1.5 }],
    ['a missing neverRatedVideoStep', { neverRatedVideoStep: undefined }],
    ['a string viewerId', { viewerId: '99' }],
    ['a fractional viewerId', { viewerId: 99.5 }],
  ])('🔴 refuses a ticket with %s', (_label, over) => {
    expect(
      openBlockMediaTicket(sealRaw('ticket', { ...claims, ...viewer, exp: now() + 60, ...over }))
    ).toBeNull();
  });

  it('refuses a tampered or truncated token', () => {
    const ticket = sealBlockMediaTicket({ ...claims, ...viewer })!;
    const [prefix, iv, ct, tag] = ticket.split('.');
    const shortTag = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
    expect(openBlockMediaTicket([prefix, iv, ct, shortTag].join('.'))).toBeNull();
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 1;
    expect(
      openBlockMediaTicket([prefix, iv, flipped.toString('base64url'), tag].join('.'))
    ).toBeNull();
  });
});

describe('sealToken / openToken', () => {
  const opts = { domain: 'test:v1', prefix: 't1', aad: 'a' };

  it('CONTROL: opens with the same domain and AAD', () => {
    expect(openToken(sealToken({ x: 1 }, opts), opts)).toEqual({ x: 1 });
  });

  it('refuses another domain or another AAD', () => {
    const token = sealToken({ x: 1 }, opts);
    expect(openToken(token, { ...opts, domain: 'test:v2' })).toBeNull();
    expect(openToken(token, { ...opts, aad: 'b' })).toBeNull();
    expect(openToken(token, { ...opts, aad: undefined })).toBeNull();
  });

  it('refuses a token whose auth tag was cut short', () => {
    const [prefix, iv, ct, tag] = sealToken({ x: 1 }, opts)!.split('.');
    for (const bytes of [4, 8, 12, 15]) {
      const cut = Buffer.from(tag, 'base64url').subarray(0, bytes).toString('base64url');
      expect(openToken([prefix, iv, ct, cut].join('.'), opts)).toBeNull();
    }
  });
});
