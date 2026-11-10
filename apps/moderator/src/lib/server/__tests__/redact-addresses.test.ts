import { describe, expect, it } from 'vitest';
import { redactAddresses } from '../redact-addresses';

/**
 * Text the assistant wrote can quote the addresses its moderator was shown; a viewer without User
 * Lookup gets it with every address replaced and nothing else touched.
 */
describe('redactAddresses', () => {
  it('replaces IPv4, IPv6 and /64 clusters, in any spelling', () => {
    expect(
      redactAddresses(
        'on 192.0.2.16 and 2001:db8:abc:0:1:2:3:4, also 2001:db8::7 and 2001:db8:aaaa:bbbb::/64.'
      )
    ).toBe('on [address] and [address], also [address] and [address].');
  });

  // The assistant may quote an address as the moderator typed it, padding and all.
  it('replaces a zero-padded IPv4 address too', () => {
    expect(redactAddresses('seen on 203.0.113.07 and 010.1.1.1')).toBe(
      'seen on [address] and [address]'
    );
  });

  it('leaves times, ids, versions and citations alone', () => {
    const text = 'At 12:30:45 [user:123] posted v1.2.3 (report 1234), 999.1.1.1 is no address.';
    expect(redactAddresses(text)).toBe(text);
  });
});
