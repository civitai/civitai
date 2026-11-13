import { describe, it, expect } from 'vitest';
import { buildAuthorizeUrl, usesPkce } from '../providers';

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
  scope: 'identify email',
  incrementalScope: 'role_connections.write',
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

  it('carries the base provider scope (no incremental scope at plain login)', () => {
    expect(new URL(buildAuthorizeUrl(def(), baseOpts)).searchParams.get('scope')).toBe(
      'identify email'
    );
  });

  it('appends the incrementalScope ONLY when incremental=true (Discord Linked Roles on demand)', () => {
    // On demand → base + incremental (the full legacy Discord scope), so /discord/link-role still works.
    expect(
      new URL(buildAuthorizeUrl(def(), { ...baseOpts, incremental: true })).searchParams.get(
        'scope'
      )
    ).toBe('identify email role_connections.write');
    // incremental=true but no incrementalScope defined → just the base scope (no trailing space/garbage).
    expect(
      new URL(
        buildAuthorizeUrl(def({ incrementalScope: undefined }), { ...baseOpts, incremental: true })
      ).searchParams.get('scope')
    ).toBe('identify email');
  });

  it('forwards a prompt (select_account) when set; omits it when absent/null', () => {
    expect(
      new URL(buildAuthorizeUrl(def(), { ...baseOpts, prompt: 'select_account' })).searchParams.get(
        'prompt'
      )
    ).toBe('select_account');
    expect(new URL(buildAuthorizeUrl(def(), baseOpts)).searchParams.has('prompt')).toBe(false);
    expect(
      new URL(buildAuthorizeUrl(def(), { ...baseOpts, prompt: null })).searchParams.has('prompt')
    ).toBe(false);
  });

  it('omits PKCE params when no code challenge is given', () => {
    const roles = new URL(
      buildAuthorizeUrl(def(), { ...baseOpts, codeChallenge: null, incremental: true })
    );
    expect(roles.searchParams.get('scope')).toBe('identify email role_connections.write');
    expect(roles.searchParams.has('code_challenge')).toBe(false);
    expect(roles.searchParams.has('code_challenge_method')).toBe(false);
    expect(roles.searchParams.get('state')).toBe('state-abc');
  });

  it('usesPkce is false only for the incremental LINK leg of a flagged provider', () => {
    const discord = def({ incrementalSkipsPkce: true });
    expect(usesPkce(discord, { incremental: true, link: true })).toBe(false);
    expect(usesPkce(discord, { incremental: true, link: false })).toBe(true);
    expect(usesPkce(discord, { incremental: false, link: true })).toBe(true);
    expect(usesPkce(discord, {})).toBe(true);
    expect(usesPkce(def(), { incremental: true, link: true })).toBe(true);
    expect(
      usesPkce(def({ incrementalSkipsPkce: true, incrementalScope: undefined }), {
        incremental: true,
        link: true,
      })
    ).toBe(true);
  });

  it('adds duration=temporary only for reddit', () => {
    const reddit = new URL(
      buildAuthorizeUrl(
        def({
          id: 'reddit',
          authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
          scope: 'identity',
        }),
        baseOpts
      )
    );
    expect(reddit.searchParams.get('duration')).toBe('temporary');
    expect(new URL(buildAuthorizeUrl(def(), baseOpts)).searchParams.has('duration')).toBe(false);
  });
});
