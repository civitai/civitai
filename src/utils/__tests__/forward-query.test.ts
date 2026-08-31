import { describe, expect, it } from 'vitest';
import { forwardQuery } from '~/utils/forward-query';

describe('forwardQuery', () => {
  it('returns nothing when there is no query, so the destination is unchanged', () => {
    expect(forwardQuery({})).toBe('');
    expect(forwardQuery({ entryId: '9' }, ['entryId'])).toBe('');
  });

  it('forwards the params a redirect destination would otherwise drop', () => {
    expect(forwardQuery({ entryId: '9', highlight: '42' }, ['entryId'])).toBe('?highlight=42');
  });

  it('drops the omitted route param even when the caller also passes it in the query', () => {
    // Next merges route params into ctx.query, and a user can supply ?entryId= as well.
    expect(forwardQuery({ entryId: ['9', '10'], highlight: '42' }, ['entryId'])).toBe(
      '?highlight=42'
    );
  });

  it('fans an array-valued param out to repeated keys', () => {
    expect(forwardQuery({ tag: ['a', 'b'] })).toBe('?tag=a&tag=b');
  });

  it('cannot escape the path or reach the Location header', () => {
    // The destination is a relative path built from trusted values; these are the characters that
    // would break out of it if they survived unencoded.
    const escaped = forwardQuery({ a: 'b#@evil.com', b: '../../x', c: 'x\r\nX-Injected: 1' });
    expect(escaped).not.toMatch(/[#\r\n]/);
    expect(escaped).toContain('b%23%40evil.com');
    expect(escaped).toContain('..%2F..%2Fx');
    expect(escaped).toContain('%0D%0A');
  });

  it('encodes rather than trusting already-encoded input', () => {
    // Next hands back DECODED values, so re-encoding is correct, not double-encoding.
    expect(forwardQuery({ q: 'a b' })).toBe('?q=a+b');
    expect(forwardQuery({ q: '100%' })).toBe('?q=100%25');
  });
});
