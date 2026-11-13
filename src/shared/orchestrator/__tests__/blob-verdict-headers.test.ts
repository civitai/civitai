import { describe, expect, it } from 'vitest';
import { parseBlobVerdictHeaders } from '~/shared/orchestrator/blob-verdict-headers';

const parse = (status: number, headers: Record<string, string> = {}) =>
  parseBlobVerdictHeaders(new Headers(headers), status);

describe('parseBlobVerdictHeaders', () => {
  it('CONTROL: a clean verdict reads as rated, with its level and location', () => {
    expect(parse(204, { 'X-NSFW-Level': 'PG13', Location: 'https://cdn/x' })).toEqual({
      status: 'rated',
      nsfwLevel: 'pg13',
      blockedReason: null,
      location: 'https://cdn/x',
    });
  });

  it('keeps NA as a verdict, distinct from no verdict', () => {
    expect(parse(204, { 'X-NSFW-Level': 'NA' })).toMatchObject({
      status: 'rated',
      nsfwLevel: 'na',
    });
    expect(parse(204)).toEqual({ status: 'pending' });
  });

  it('a 503 is pending, whatever else it carries', () => {
    expect(parse(503, { 'Retry-After': '5', 'X-Scan-Status': 'Pending' })).toEqual({
      status: 'pending',
    });
  });

  it('a stored blob with no level reads as pending even when the scan status says no scan was needed', () => {
    // A scan that failed open stores the blob with no level and reports NotRequired.
    expect(parse(204, { 'X-Scan-Status': 'NotRequired', Location: 'https://cdn/content' })).toEqual(
      { status: 'pending' }
    );
  });

  it('reads a block from the header, and from a Location to the blocked placeholder', () => {
    expect(parse(204, { 'X-NSFW-Level': 'PG', 'X-Blocked-Reason': 'Csam' })).toMatchObject({
      status: 'rated',
      blockedReason: 'Csam',
    });
    expect(
      parse(204, { 'X-NSFW-Level': 'PG', Location: 'https://orchestrator/blocked/abc.jpg' })
    ).toMatchObject({ status: 'rated', blockedReason: 'blocked' });
  });

  it('any other failure is unavailable, not pending and not rated', () => {
    expect(parse(404, { 'X-NSFW-Level': 'PG' })).toEqual({
      status: 'unavailable',
      httpStatus: 404,
    });
    expect(parse(500)).toEqual({ status: 'unavailable', httpStatus: 500 });
  });
});
