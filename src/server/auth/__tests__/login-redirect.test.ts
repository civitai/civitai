import { describe, it, expect } from 'vitest';
import { buildHubLoginRedirect } from '../login-redirect';

const HUB = 'https://auth.civitai.com';

describe('buildHubLoginRedirect', () => {
  it('targets the hub /login with the landing as returnUrl', () => {
    const url = new URL(buildHubLoginRedirect({ origin: 'https://civitai.com', hubIssuer: HUB, dest: '/models' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.civitai.com/login');
  });

  it('lands on this origin /api/auth/authorize, forwarding to post-login (same-site)', () => {
    const url = new URL(buildHubLoginRedirect({ origin: 'https://civitai.com', hubIssuer: HUB, dest: '/models' }));
    const landing = new URL(url.searchParams.get('returnUrl') as string);
    expect(landing.origin).toBe('https://civitai.com');
    expect(landing.pathname).toBe('/api/auth/authorize');
    expect(landing.searchParams.get('returnUrl')).toBe('/api/auth/post-login?dest=%2Fmodels');
  });

  it('cross-site (.red): same /api/auth/authorize path on the request origin (unified)', () => {
    const url = new URL(buildHubLoginRedirect({ origin: 'https://civitai.red', hubIssuer: HUB, dest: '/models' }));
    const landing = new URL(url.searchParams.get('returnUrl') as string);
    expect(landing.origin).toBe('https://civitai.red');
    expect(landing.pathname).toBe('/api/auth/authorize');
    expect(landing.searchParams.get('returnUrl')).toBe('/api/auth/post-login?dest=%2Fmodels');
  });

  it('uses the request origin for the authorize landing on any host (no /api/auth/sync)', () => {
    const returnUrl = new URL(
      buildHubLoginRedirect({ origin: 'https://advertising.civitai.com', hubIssuer: HUB, dest: '/' })
    ).searchParams.get('returnUrl') as string;
    expect(returnUrl.includes('/api/auth/sync')).toBe(false);
    expect(returnUrl.startsWith('https://advertising.civitai.com/api/auth/authorize')).toBe(true);
  });

  it('threads reason onto the hub URL and the post-login dest', () => {
    const url = new URL(
      buildHubLoginRedirect({ origin: 'https://civitai.com', hubIssuer: HUB, dest: '/gen', reason: 'image-gen' })
    );
    expect(url.searchParams.get('reason')).toBe('image-gen');
    // reason rides the post-login path nested inside the authorize landing.
    const landing = new URL(url.searchParams.get('returnUrl') as string);
    expect(landing.searchParams.get('returnUrl')).toContain('reason=image-gen');
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
