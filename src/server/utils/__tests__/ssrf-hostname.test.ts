import { describe, expect, it } from 'vitest';

import { isPrivateIp, isPublicHttpsUrl } from '~/server/utils/ssrf-hostname';

/**
 * The PURE lexical + IP SSRF guards shared by the manifest validator and the
 * fetch-time `safeFetch`. `isPublicHttpsUrl` gates the URL SHAPE (https-only,
 * no literal/encoded-IP hosts); `isPrivateIp` gates a DNS-RESOLVED address (the
 * DNS-rebinding complement). Both fail CLOSED.
 */

describe('isPublicHttpsUrl (lexical URL-shape guard)', () => {
  it('accepts a normal public https URL', () => {
    expect(isPublicHttpsUrl('https://example.com/app').ok).toBe(true);
    expect(isPublicHttpsUrl('https://sub.example.co.uk:8443/x?y=1').ok).toBe(true);
  });

  it('REJECTS non-https schemes', () => {
    for (const u of ['http://example.com', 'ftp://example.com', 'file:///etc/passwd']) {
      expect(isPublicHttpsUrl(u).ok, u).toBe(false);
    }
  });

  it('REJECTS localhost / reserved internal names', () => {
    for (const u of [
      'https://localhost',
      'https://foo.internal',
      'https://bar.local',
      'https://metadata.google.internal',
    ]) {
      expect(isPublicHttpsUrl(u).ok, u).toBe(false);
    }
  });

  it('REJECTS dotted private/loopback/link-local IPv4 literals', () => {
    for (const u of [
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://172.16.0.1',
      'https://192.168.1.1',
      'https://169.254.169.254', // cloud metadata
      'https://0.0.0.0',
    ]) {
      expect(isPublicHttpsUrl(u).ok, u).toBe(false);
    }
  });

  it('REJECTS obfuscated IPv4 (hex / integer / octal / dotless) and IPv4-mapped IPv6', () => {
    for (const u of [
      'https://0x7f000001', // hex int 127.0.0.1
      'https://2130706433', // decimal int 127.0.0.1
      'https://0177.0.0.1', // octal
      'https://[::ffff:127.0.0.1]', // IPv4-mapped IPv6
    ]) {
      expect(isPublicHttpsUrl(u).ok, u).toBe(false);
    }
  });

  it('REJECTS a dot-less hostname', () => {
    expect(isPublicHttpsUrl('https://intranet').ok).toBe(false);
  });
});

describe('isPrivateIp (DNS-resolved-address guard)', () => {
  it('treats public IPv4 as public', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('flags private / loopback / link-local / CGNAT / reserved IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1', // multicast
      '255.255.255.255',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('does NOT over-flag 172.15/172.32 (outside the /12)', () => {
    expect(isPrivateIp('172.15.0.1')).toBe(false);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
  });

  it('flags loopback / ULA / link-local / mapped IPv6', () => {
    for (const ip of [
      '::1', // loopback
      '::', // unspecified
      'fc00::1', // ULA
      'fd12:3456:789a::1', // ULA
      'fe80::1', // link-local
      'ff02::1', // multicast
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:10.0.0.1', // IPv4-mapped private
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('treats a public IPv6 as public', () => {
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false); // Google DNS
  });

  it('flags an IPv6 with a zone id and fails closed on garbage', () => {
    expect(isPrivateIp('fe80::1%eth0')).toBe(true);
    expect(isPrivateIp('not-an-ip')).toBe(true); // unparseable → fail closed
    expect(isPrivateIp('999.999.999.999')).toBe(true);
  });
});
