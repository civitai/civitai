import { describe, it, expect } from 'vitest';
import { buildAuthorizeUrl } from '../providers';

// buildAuthorizeUrl assembles the upstream OAuth authorize URL (PKCE + per-provider scope + the optional OIDC
// `prompt` that the add-account flow forwards). ProviderDef isn't exported, so we derive its type from the
// function signature and fixture a minimal provider — keeps the test off real env/client credentials.
type ProviderDef = Parameters<typeof buildAuthorizeUrl>[0];

const def = (overrides: Partial<ProviderDef> = {}): ProviderDef => ({
  id: 'discord',
  name: 'Discord',
  authorizeUrl: 'https://discord.com/oauth2/authorize',
  tokenUrl: 'https://discord.com/api/oauth2/token',
  userinfoUrl: 'https://discord.com/api/users/@me',
  scope: 'identify email role_connections.write',
  clientId: () => 'client-123',
  clientSecret: () => 'secret',
  mapProfile: () => ({ providerAccountId: 'x' }),
  ...overrides,
});

const baseOpts = {
  redirectUri: 'https://auth.civitai.com/login/discord/callback',
  state: 'state-abc',
  codeChallenge: 'challenge-xyz',
};

describe('buildAuthorizeUrl', () => {
  it('assembles the standard PKCE authorize params', () => {
    const url = new URL(buildAuthorizeUrl(def(), baseOpts));
    expect(`${url.origin}${url.pathname}`).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(baseOpts.redirectUri);
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('carries the provider scope (Discord role_connections.write for linked-roles)', () => {
    expect(new URL(buildAuthorizeUrl(def(), baseOpts)).searchParams.get('scope')).toBe(
      'identify email role_connections.write'
    );
  });

  it('forwards a prompt (select_account) when set; omits it when absent/null', () => {
    expect(
      new URL(buildAuthorizeUrl(def(), { ...baseOpts, prompt: 'select_account' })).searchParams.get('prompt')
    ).toBe('select_account');
    expect(new URL(buildAuthorizeUrl(def(), baseOpts)).searchParams.has('prompt')).toBe(false);
    expect(
      new URL(buildAuthorizeUrl(def(), { ...baseOpts, prompt: null })).searchParams.has('prompt')
    ).toBe(false);
  });

  it('adds duration=temporary only for reddit', () => {
    const reddit = new URL(
      buildAuthorizeUrl(
        def({ id: 'reddit', authorizeUrl: 'https://www.reddit.com/api/v1/authorize', scope: 'identity' }),
        baseOpts
      )
    );
    expect(reddit.searchParams.get('duration')).toBe('temporary');
    expect(new URL(buildAuthorizeUrl(def(), baseOpts)).searchParams.has('duration')).toBe(false);
  });
});
