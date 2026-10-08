import { describe, expect, it } from 'vitest';
import {
  greenBlockedReason,
  parseBlobHeaderVerdict,
} from '~/components/ImageGeneration/utils/blobHeaderVerdict';

// Header names and values as served by the orchestrator blob endpoint.
const response = (status: number, headers: Record<string, string>) =>
  ({ ok: status >= 200 && status < 300, headers: new Headers(headers) } as Response);

describe('parseBlobHeaderVerdict', () => {
  it('lowercases the rating to match the workflow-data NsfwLevel', () => {
    expect(parseBlobHeaderVerdict(response(200, { 'X-NSFW-Level': 'PG13' }))).toEqual({
      nsfwLevel: 'pg13',
    });
  });

  it('reads the blur reason on a served mature image', () => {
    expect(
      parseBlobHeaderVerdict(
        response(200, { 'X-NSFW-Level': 'X', 'X-Blocked-Reason': 'MatureContent' })
      )
    ).toEqual({ nsfwLevel: 'x', blockedReason: 'MatureContent' });
  });

  it('reads the reason on a hard-blocked 403', () => {
    const reason = 'Potentially ToS violating content detected';
    expect(
      parseBlobHeaderVerdict(response(403, { 'X-NSFW-Level': 'R', 'X-Blocked-Reason': reason }))
    ).toEqual({ nsfwLevel: 'r', blockedReason: reason });
  });

  it('settles nothing on a failed response without a reason', () => {
    expect(parseBlobHeaderVerdict(response(500, {}))).toBeNull();
  });

  it('settles nothing on a 200 without a rating', () => {
    expect(parseBlobHeaderVerdict(response(200, {}))).toBeNull();
    expect(parseBlobHeaderVerdict(response(200, { 'X-Scan-Status': 'Pending' }))).toBeNull();
  });

  it('accepts an unrated image the orchestrator says needs no scan', () => {
    expect(parseBlobHeaderVerdict(response(200, { 'X-Scan-Status': 'NotRequired' }))).toEqual({});
  });
});

describe('greenBlockedReason', () => {
  it('maps the blur reason to the civitai.red card', () => {
    expect(greenBlockedReason({ nsfwLevel: 'x', blockedReason: 'MatureContent' }, false)).toBe(
      'siteRestricted'
    );
  });

  it('maps a mature rating without a blur reason to the civitai.red card', () => {
    // allowMatureContent: true workflows serve R/X unblurred, so no reason header is sent.
    expect(greenBlockedReason({ nsfwLevel: 'r' }, false)).toBe('siteRestricted');
  });

  it('passes other block reasons through', () => {
    const reason = 'Potentially ToS violating content detected';
    expect(greenBlockedReason({ nsfwLevel: 'pg', blockedReason: reason }, false)).toBe(reason);
  });

  it('blocks a private generation above PG13, as BlobData does', () => {
    expect(greenBlockedReason({ nsfwLevel: 'na' }, true)).toBe('privateGen');
    expect(greenBlockedReason({ nsfwLevel: 'r' }, true)).toBe('privateGen');
    expect(greenBlockedReason({ nsfwLevel: 'pg13' }, true)).toBeUndefined();
  });

  it('does not block a safe rating', () => {
    expect(greenBlockedReason({ nsfwLevel: 'pg13' }, false)).toBeUndefined();
  });
});
