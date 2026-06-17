import { describe, it, expect } from 'vitest';
import { buildHubLoginRedirect } from '../login-redirect';

const HUB = 'https://auth.civitai.com';

describe('buildHubLoginRedirect', () => {
  it('targets the hub /login with the landing as returnUrl', () => {
    const url = new URL(buildHubLoginRedirect({ origin: 'https://civitai.com', hubIssuer: HUB, dest: '/models' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.civitai.com/login');
  });

  it('same-site (.com): lands directly on post-login, no sync wrapper', () => {
    const url = new URL(buildHubLoginRedirect({ origin: 'https://civitai.com', hubIssuer: HUB, dest: '/models' }));
    expect(url.searchParams.get('returnUrl')).toBe(
      'https://civitai.com/api/auth/post-login?dest=%2Fmodels'
    );
  });

  it('cross-site (.red): wraps the landing in /api/auth/sync on the request origin', () => {
    const url = new URL(buildHubLoginRedirect({ origin: 'https://civitai.red', hubIssuer: HUB, dest: '/models' }));
    const landing = new URL(url.searchParams.get('returnUrl') as string);
    expect(landing.origin).toBe('https://civitai.red');
    expect(landing.pathname).toBe('/api/auth/sync');
    // the sync wrapper forwards to post-login
    expect(landing.searchParams.get('returnUrl')).toBe('/api/auth/post-login?dest=%2Fmodels');
  });

  it('treats a sibling subdomain as same-site (advertising.civitai.com → hub)', () => {
    const returnUrl = new URL(
      buildHubLoginRedirect({ origin: 'https://advertising.civitai.com', hubIssuer: HUB, dest: '/' })
    ).searchParams.get('returnUrl') as string;
    expect(returnUrl.includes('/api/auth/sync')).toBe(false);
    expect(returnUrl.startsWith('https://advertising.civitai.com/api/auth/post-login')).toBe(true);
  });

  it('threads reason onto the hub URL and the post-login dest', () => {
    const url = new URL(
      buildHubLoginRedirect({ origin: 'https://civitai.com', hubIssuer: HUB, dest: '/gen', reason: 'image-gen' })
    );
    expect(url.searchParams.get('reason')).toBe('image-gen');
    expect(url.searchParams.get('returnUrl')).toContain('reason=image-gen');
  });

  it('threads error and the add-account prompt', () => {
    const url = new URL(
      buildHubLoginRedirect({
        origin: 'https://civitai.com',
        hubIssuer: HUB,
        dest: '/',
        error: 'OAuthAccountNotLinked',
        selectAccount: true,
      })
    );
    expect(url.searchParams.get('error')).toBe('OAuthAccountNotLinked');
    expect(url.searchParams.get('prompt')).toBe('select_account');
  });

  it('omits reason / error / prompt when unset', () => {
    const url = new URL(buildHubLoginRedirect({ origin: 'https://civitai.com', hubIssuer: HUB, dest: '/' }));
    expect(url.searchParams.has('reason')).toBe(false);
    expect(url.searchParams.has('error')).toBe(false);
    expect(url.searchParams.has('prompt')).toBe(false);
  });
});
