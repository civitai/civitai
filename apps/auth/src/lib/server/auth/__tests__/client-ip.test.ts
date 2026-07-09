import { describe, it, expect } from 'vitest';
import { getClientIp } from '../request';

// Build a Request with the given headers — getClientIp only reads headers, never the socket.
const req = (headers: Record<string, string>) =>
  new Request('https://auth.civitai.com/login', { headers });

describe('getClientIp', () => {
  it('prefers cf-connecting-ip (Cloudflare overwrites it, so it is trustworthy)', () => {
    expect(
      getClientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }))
    ).toBe('203.0.113.7');
  });

  it('falls back to the LEFTMOST x-forwarded-for hop (the original client)', () => {
    // client, ingress — leftmost is the real client; later hops are proxies.
    expect(getClientIp(req({ 'x-forwarded-for': '198.51.100.1, 10.0.0.5' }))).toBe('198.51.100.1');
  });

  it('trims surrounding whitespace', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '  198.51.100.1  , 10.0.0.5' }))).toBe(
      '198.51.100.1'
    );
  });

  it('returns null when NO proxy header is present — caller then skips the limit, never buckets on the socket peer', () => {
    expect(getClientIp(req({}))).toBeNull();
  });

  it('returns null for an empty/whitespace x-forwarded-for rather than a blank identifier', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '   ' }))).toBeNull();
  });
});
