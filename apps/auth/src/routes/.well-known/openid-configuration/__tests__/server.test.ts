import { describe, it, expect } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';
import { GET } from '../+server';

// The only test of the discovery document. It pins the two fields a client uses to FIND
// introspection without being told the URL, plus the fact that scopes_supported is derived from
// tokenScopeLabels (so a new scope bit appears here with no edit to this route).

async function discovery(): Promise<Record<string, unknown>> {
  const url = new URL('https://auth.civitai.com/.well-known/openid-configuration');
  const res = await GET({ url } as never);
  return (await res.json()) as Record<string, unknown>;
}

describe('openid-configuration', () => {
  it('advertises the introspection endpoint and its client-auth methods', async () => {
    const doc = await discovery();
    expect(doc.introspection_endpoint).toMatch(/\/api\/auth\/oauth\/introspect$/);
    expect(doc.introspection_endpoint_auth_methods_supported).toEqual([
      'client_secret_basic',
      'client_secret_post',
    ]);
  });

  it('lists LinkConnect in scopes_supported', async () => {
    const doc = await discovery();
    expect(doc.scopes_supported).toContain(String(TokenScope.LinkConnect));
    // Negative control on the line above: a scopes_supported built from something other than
    // tokenScopeLabels would not carry the older opt-in bits either.
    expect(doc.scopes_supported).toContain(String(TokenScope.AppBlocksDevTunnel));
  });

  it('still advertises the endpoints that existed before introspection', async () => {
    const doc = await discovery();
    expect(doc.token_endpoint).toMatch(/\/api\/auth\/oauth\/token$/);
    expect(doc.revocation_endpoint).toMatch(/\/api\/auth\/oauth\/revoke$/);
    expect(doc.device_authorization_endpoint).toMatch(/\/api\/auth\/oauth\/device$/);
  });
});
