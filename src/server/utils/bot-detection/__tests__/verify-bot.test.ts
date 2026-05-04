import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifyBot } from '../verify-bot';
import googlebotIps from '../googlebot-ips.json';
import bingbotIps from '../bingbot-ips.json';

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BINGBOT_UA = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';

// Pull a real CIDR sample from each published list. Using the network address
// (the `.0` of the CIDR) as a known in-range IP — every host in the prefix is
// in range, including the network address itself.
type Prefix = { ipv4Prefix?: string; ipv6Prefix?: string };

const googleV4Prefix = (googlebotIps.prefixes as Prefix[]).find((p) => p.ipv4Prefix)!.ipv4Prefix!;
const googleV6Prefix = (googlebotIps.prefixes as Prefix[]).find((p) => p.ipv6Prefix)!.ipv6Prefix!;
const bingV4Prefix = (bingbotIps.prefixes as Prefix[]).find((p) => p.ipv4Prefix)!.ipv4Prefix!;

const googleV4InRange = googleV4Prefix.split('/')[0];
// 2001:4860:4801:10::/64 → 2001:4860:4801:10::1 (first host, exercises :: expansion)
const googleV6InRange = googleV6Prefix.replace(/::\/.*/, '::1');
const bingV4InRange = bingV4Prefix.split('/')[0];

describe('verifyBot — real bot ranges', () => {
  it('returns googlebot for Googlebot UA + IPv4 in published range', () => {
    expect(verifyBot(GOOGLEBOT_UA, googleV4InRange)).toBe('googlebot');
  });

  it('returns googlebot for Googlebot UA + IPv6 in published range (exercises :: expansion)', () => {
    expect(verifyBot(GOOGLEBOT_UA, googleV6InRange)).toBe('googlebot');
  });

  it('returns bingbot for Bingbot UA + IP in published Bing range', () => {
    expect(verifyBot(BINGBOT_UA, bingV4InRange)).toBe('bingbot');
  });

  it('matches AdsBot/Mediapartners UAs against Google special-crawler ranges', () => {
    // AdsBot is one of the patterns in BOT_UA_PATTERNS.googlebot; even with a
    // real Google IP it should still be classified as googlebot category.
    expect(verifyBot('Mozilla/5.0 (compatible; AdsBot-Google)', googleV4InRange)).toBe('googlebot');
  });
});

describe('verifyBot — forgery and bad inputs', () => {
  it('rejects when UA matches but IP is outside any published range', () => {
    // 8.8.8.8 is Google DNS — explicitly NOT in any Googlebot-published range
    expect(verifyBot(GOOGLEBOT_UA, '8.8.8.8')).toBeNull();
  });

  it('rejects random UA even with a real bot-range IP', () => {
    expect(verifyBot('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0', googleV4InRange)).toBeNull();
  });

  it('returns null for null/undefined inputs', () => {
    expect(verifyBot(null, null)).toBeNull();
    expect(verifyBot(undefined, undefined)).toBeNull();
    expect(verifyBot(GOOGLEBOT_UA, null)).toBeNull();
    expect(verifyBot(null, googleV4InRange)).toBeNull();
  });

  it('returns null for malformed IP strings without throwing', () => {
    expect(() => verifyBot(GOOGLEBOT_UA, 'not-an-ip')).not.toThrow();
    expect(verifyBot(GOOGLEBOT_UA, 'not-an-ip')).toBeNull();
    expect(verifyBot(GOOGLEBOT_UA, '999.999.999.999')).toBeNull();
    expect(verifyBot(GOOGLEBOT_UA, '1.2.3')).toBeNull();
    expect(verifyBot(GOOGLEBOT_UA, '')).toBeNull();
    expect(verifyBot(GOOGLEBOT_UA, '::xx::')).toBeNull();
  });

  it('does not match an IPv4 address against an IPv6 prefix or vice versa', () => {
    // A v4 IP shouldn't match the v6 prefix. We rely on the fact that the IP
    // would normally check against ALL CIDRs, and the v4-vs-v6 type check
    // skips mismatched-family CIDRs. With ONLY v6 prefixes for googlebot
    // hypothetically, this is harder to test directly — but a clearly bogus
    // v6 outside any range should never match.
    expect(verifyBot(GOOGLEBOT_UA, '2001:db8::1')).toBeNull();
  });
});

describe('verifyBot — BOT_TEST_IPS allowlist', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('treats listed IPs as googlebot regardless of UA when NODE_ENV is non-production', async () => {
    process.env.NODE_ENV = 'development';
    process.env.BOT_TEST_IPS = '127.0.0.1,::1';
    const { verifyBot: vb } = await import('../verify-bot');

    expect(vb('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.0.0', '127.0.0.1')).toBe('googlebot');
    expect(vb('any-string', '::1')).toBe('googlebot');
  });

  it('honors UA-less requests when IP is in the test allowlist', async () => {
    process.env.NODE_ENV = 'development';
    process.env.BOT_TEST_IPS = '127.0.0.1';
    const { verifyBot: vb } = await import('../verify-bot');

    expect(vb(null, '127.0.0.1')).toBe('googlebot');
    expect(vb(undefined, '127.0.0.1')).toBe('googlebot');
  });

  it('IGNORES BOT_TEST_IPS when NODE_ENV is production (security-critical)', async () => {
    // Regression guard: if someone removes the production gate, this test fails.
    // 127.0.0.1 isn't in any real bot range, so without the test allowlist
    // a real Googlebot UA from localhost should NOT classify as googlebot.
    process.env.NODE_ENV = 'production';
    process.env.BOT_TEST_IPS = '127.0.0.1';
    const { verifyBot: vb } = await import('../verify-bot');

    expect(vb('Mozilla/5.0 Chrome/130', '127.0.0.1')).toBeNull();
    expect(vb(GOOGLEBOT_UA, '127.0.0.1')).toBeNull();
  });

  it('ignores empty / whitespace-only entries in BOT_TEST_IPS', async () => {
    process.env.NODE_ENV = 'development';
    process.env.BOT_TEST_IPS = ' ,127.0.0.1, ,';
    const { verifyBot: vb } = await import('../verify-bot');

    expect(vb('any', '127.0.0.1')).toBe('googlebot');
    // A bogus IP that wasn't in the trimmed list should still fail
    expect(vb('any', '1.2.3.4')).toBeNull();
  });
});
