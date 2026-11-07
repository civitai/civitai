import { describe, it, expect } from 'vitest';
import {
  ALL_SCOPES,
  CLIENT_CREDENTIALS_MAX_SCOPE,
  CLIENT_CREDENTIALS_ONLY_SCOPES,
  consentableScopes,
  NON_USER_SCOPES,
  TokenScope,
  TokenScopePresets,
  tokenScopeLabels,
  getScopeLabel,
} from '../token-scope';

describe('TokenScope bitmask (shared contract — must not drift)', () => {
  it('keeps the canonical bit values', () => {
    expect(TokenScope.UserRead).toBe(1);
    expect(TokenScope.AIServicesWrite).toBe(1 << 15);
    expect(TokenScope.VaultWrite).toBe(1 << 24);
    expect(TokenScope.Full).toBe((1 << 25) - 1);
  });

  it('presets compose via OR and round-trip through getScopeLabel', () => {
    expect(getScopeLabel(TokenScope.Full)).toBe('Full Access');
    expect(getScopeLabel(TokenScopePresets.ReadOnly)).toBe('Read Only');
    expect(getScopeLabel(TokenScopePresets.Creator)).toBe('Creator');
    expect(getScopeLabel(TokenScopePresets.AIServices)).toBe('AI Services');
    expect(getScopeLabel(null)).toBe('Legacy');
    expect(getScopeLabel(TokenScope.UserRead | TokenScope.VaultWrite)).toBe('Custom');
  });

  it('every read/write scope has a UI label', () => {
    expect(tokenScopeLabels[TokenScope.UserRead]).toBeTruthy();
    expect(tokenScopeLabels[TokenScope.AIServicesWrite]).toBeTruthy();
  });
});

describe('AppBlocksDevTunnel (opt-in scope — NOT part of Full)', () => {
  it('is bit 26 = 67108864', () => {
    expect(TokenScope.AppBlocksDevTunnel).toBe(1 << 26);
    expect(TokenScope.AppBlocksDevTunnel).toBe(67108864);
  });

  it('is EXCLUDED from Full (Full stays frozen at (1<<25)-1)', () => {
    expect(TokenScope.Full).toBe(33554431);
    // hasFlag-style subset test: the bit must NOT be present in Full.
    expect(TokenScope.Full & TokenScope.AppBlocksDevTunnel).toBe(0);
  });

  it('IS included in ALL_SCOPES (the computed upper bound)', () => {
    expect(ALL_SCOPES & TokenScope.AppBlocksDevTunnel).toBe(TokenScope.AppBlocksDevTunnel);
    // Full is exactly ALL_SCOPES minus the five opt-in bits.
    expect(ALL_SCOPES).toBe(
      TokenScope.Full |
        TokenScope.AppBlocksSubmit |
        TokenScope.AppBlocksDevTunnel |
        TokenScope.LinkConnect |
        TokenScope.AppStoreCatalogWrite |
        TokenScope.WorkerRegister |
        TokenScope.DownloadLink
    );
  });

  it('has a consent-screen label', () => {
    expect(tokenScopeLabels[TokenScope.AppBlocksDevTunnel]).toBeTruthy();
  });

  it('is NOT folded into any TokenScopePreset (opt-in, like AppBlocksSubmit)', () => {
    for (const [name, preset] of Object.entries(TokenScopePresets)) {
      // Full is a preset alias for TokenScope.Full, which itself excludes the bit.
      expect(
        (preset & TokenScope.AppBlocksDevTunnel) === 0,
        `preset ${name} must not carry AppBlocksDevTunnel`
      ).toBe(true);
    }
  });
});

describe('LinkConnect (opt-in scope — NOT part of Full)', () => {
  it('is bit 27 = 134217728', () => {
    expect(TokenScope.LinkConnect).toBe(1 << 27);
    expect(TokenScope.LinkConnect).toBe(134217728);
  });

  it('is EXCLUDED from Full and from every preset', () => {
    expect(TokenScope.Full).toBe(33554431);
    expect(TokenScope.Full & TokenScope.LinkConnect).toBe(0);
    for (const [name, preset] of Object.entries(TokenScopePresets)) {
      expect(
        (preset & TokenScope.LinkConnect) === 0,
        `preset ${name} must not carry LinkConnect`
      ).toBe(true);
    }
  });

  it('IS included in ALL_SCOPES', () => {
    expect(ALL_SCOPES & TokenScope.LinkConnect).toBe(TokenScope.LinkConnect);
  });

  it('has a consent-screen label', () => {
    expect(tokenScopeLabels[TokenScope.LinkConnect]).toBe(
      'Connect the Civitai Link app to your account'
    );
  });
});

describe('AppStoreCatalogWrite (opt-in, client_credentials-only — NOT part of Full)', () => {
  it('is bit 28 = 268435456', () => {
    expect(TokenScope.AppStoreCatalogWrite).toBe(1 << 28);
    expect(TokenScope.AppStoreCatalogWrite).toBe(268435456);
  });

  it('is EXCLUDED from Full and from every preset', () => {
    expect(TokenScope.Full).toBe(33554431);
    expect(TokenScope.Full & TokenScope.AppStoreCatalogWrite).toBe(0);
    for (const [name, preset] of Object.entries(TokenScopePresets)) {
      expect(
        (preset & TokenScope.AppStoreCatalogWrite) === 0,
        `preset ${name} must not carry AppStoreCatalogWrite`
      ).toBe(true);
    }
  });

  it('IS included in ALL_SCOPES', () => {
    expect(ALL_SCOPES & TokenScope.AppStoreCatalogWrite).toBe(TokenScope.AppStoreCatalogWrite);
  });

  it('is client_credentials-only, and the client_credentials cap adds only UserRead', () => {
    expect(CLIENT_CREDENTIALS_ONLY_SCOPES & TokenScope.AppStoreCatalogWrite).toBe(268435456);
    // The whole client_credentials-only set, pinned: a new bit here must be added on purpose.
    expect(CLIENT_CREDENTIALS_ONLY_SCOPES).toBe(
      TokenScope.AppStoreCatalogWrite | TokenScope.DownloadLink
    );
    expect(CLIENT_CREDENTIALS_MAX_SCOPE).toBe(
      TokenScope.UserRead | TokenScope.AppStoreCatalogWrite | TokenScope.DownloadLink
    );
  });

  it('is stripped from the consentable part of a client ceiling, and nothing else is', () => {
    const ceiling =
      TokenScope.UserRead | TokenScope.AIServicesWrite | TokenScope.AppStoreCatalogWrite;
    expect(consentableScopes(ceiling)).toBe(TokenScope.UserRead | TokenScope.AIServicesWrite);
    expect(consentableScopes(TokenScope.Full | TokenScope.LinkConnect)).toBe(
      TokenScope.Full | TokenScope.LinkConnect
    );
  });

  it('has a label', () => {
    expect(tokenScopeLabels[TokenScope.AppStoreCatalogWrite]).toBe(
      "Publish items to the app's App Store listing"
    );
  });
});

describe('WorkerRegister (opt-in, worker token-exchange only — NOT part of Full)', () => {
  it('is bit 29 = 536870912', () => {
    expect(TokenScope.WorkerRegister).toBe(1 << 29);
    expect(TokenScope.WorkerRegister).toBe(536870912);
  });

  it('is NOT part of Full', () => {
    expect(TokenScope.Full & TokenScope.WorkerRegister).toBe(0);
  });

  it('IS included in ALL_SCOPES', () => {
    expect(ALL_SCOPES & TokenScope.WorkerRegister).toBe(TokenScope.WorkerRegister);
  });

  it('is never consentable, and leaves the client_credentials cap alone', () => {
    expect(NON_USER_SCOPES & TokenScope.WorkerRegister).toBe(TokenScope.WorkerRegister);
    expect(consentableScopes(TokenScope.UserRead | TokenScope.WorkerRegister)).toBe(
      TokenScope.UserRead
    );
    expect(CLIENT_CREDENTIALS_MAX_SCOPE & TokenScope.WorkerRegister).toBe(0);
  });

  it('has a label', () => {
    expect(tokenScopeLabels[TokenScope.WorkerRegister]).toBe(
      'Register a worker machine with the orchestrator'
    );
  });
});

describe('DownloadLink (opt-in, client_credentials-only — NOT part of Full)', () => {
  // Bit 30 is the last one a signed int4 column (ApiKey.tokenScope, OauthClient.allowedScopes) holds.
  it('raises ALL_SCOPES to (1 << 31) - 1, the int4 maximum', () => {
    expect(ALL_SCOPES).toBe(2 ** 31 - 1);
    expect(ALL_SCOPES).toBe(2147483647);
  });

  it('is excluded from Full and from every preset', () => {
    expect(TokenScope.Full & TokenScope.DownloadLink).toBe(0);
    for (const [name, preset] of Object.entries(TokenScopePresets)) {
      expect((preset & TokenScope.DownloadLink) === 0, `preset ${name}`).toBe(true);
    }
  });

  it('is minted only through client_credentials, and never consented to', () => {
    expect(CLIENT_CREDENTIALS_ONLY_SCOPES & TokenScope.DownloadLink).toBe(TokenScope.DownloadLink);
    expect(CLIENT_CREDENTIALS_MAX_SCOPE & TokenScope.DownloadLink).toBe(TokenScope.DownloadLink);
    expect(consentableScopes(TokenScope.UserRead | TokenScope.DownloadLink)).toBe(
      TokenScope.UserRead
    );
  });
});
