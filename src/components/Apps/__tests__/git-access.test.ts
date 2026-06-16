import { describe, expect, it } from 'vitest';
import { maskCloneUrlCredential } from '../git-access';

describe('maskCloneUrlCredential', () => {
  it('masks the token (password) but keeps the username + host + path', () => {
    const url = 'https://dev-42:abc123secrettoken@forgejo.example.com/civitai-apps/my-slug.git';
    const masked = maskCloneUrlCredential(url);
    expect(masked).toBe('https://dev-42:••••••••@forgejo.example.com/civitai-apps/my-slug.git');
    // The real token must NOT survive into the masked display string.
    expect(masked).not.toContain('abc123secrettoken');
  });

  it('preserves a url-encoded username', () => {
    const url = 'https://dev%2Buser:tok@host.tld/org/slug.git';
    expect(maskCloneUrlCredential(url)).toBe('https://dev%2Buser:••••••••@host.tld/org/slug.git');
  });

  it('returns the url unchanged when there is no embedded credential', () => {
    const url = 'https://forgejo.example.com/civitai-apps/my-slug.git';
    expect(maskCloneUrlCredential(url)).toBe(url);
  });

  it('does not mistake a host:port for a credential (no @)', () => {
    const url = 'https://host.tld:8443/org/slug.git';
    expect(maskCloneUrlCredential(url)).toBe(url);
  });

  it('handles a token that itself contains colons', () => {
    const url = 'https://dev-7:a:b:c@host.tld/org/slug.git';
    expect(maskCloneUrlCredential(url)).toBe('https://dev-7:••••••••@host.tld/org/slug.git');
  });
});
