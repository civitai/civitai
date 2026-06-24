import { describe, it, expect } from 'vitest';
import { hubLoginUrl } from '../providers';

const HUB = 'https://auth.civitai.com';

describe('hubLoginUrl', () => {
  it('defaults to the login picker (no provider segment)', () => {
    expect(hubLoginUrl(HUB)).toBe('https://auth.civitai.com/login');
  });

  it('deep-links to a provider', () => {
    expect(hubLoginUrl(HUB, { provider: 'discord' })).toBe(
      'https://auth.civitai.com/login/discord'
    );
  });

  it('encodes returnUrl', () => {
    const url = new URL(hubLoginUrl(HUB, { returnUrl: '/api/auth/post-login?dest=/models' }));
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('returnUrl')).toBe('/api/auth/post-login?dest=/models');
  });

  it('threads link / prompt / reason', () => {
    const url = new URL(
      hubLoginUrl(HUB, {
        provider: 'google',
        link: true,
        prompt: 'select_account',
        reason: 'image-gen',
      })
    );
    expect(url.pathname).toBe('/login/google');
    expect(url.searchParams.get('link')).toBe('true');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('reason')).toBe('image-gen');
  });

  it('sets roles=true for the linked-roles intent (incremental Discord scope), paired with link', () => {
    const url = new URL(hubLoginUrl(HUB, { provider: 'discord', link: true, linkRoles: true }));
    expect(url.searchParams.get('link')).toBe('true');
    expect(url.searchParams.get('roles')).toBe('true');
  });

  it('omits unset params', () => {
    const url = new URL(hubLoginUrl(HUB, { provider: 'github' }));
    expect(url.searchParams.has('link')).toBe(false);
    expect(url.searchParams.has('roles')).toBe(false);
    expect(url.searchParams.has('prompt')).toBe(false);
    expect(url.searchParams.has('reason')).toBe(false);
    expect(url.searchParams.has('returnUrl')).toBe(false);
  });

  it('does not set link when false', () => {
    const url = new URL(hubLoginUrl(HUB, { provider: 'reddit', link: false }));
    expect(url.searchParams.has('link')).toBe(false);
  });
});
