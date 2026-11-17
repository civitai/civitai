import { describe, it, expect } from 'vitest';
import {
  ALL_SCOPES,
  CLIENT_CREDENTIALS_MAX_SCOPE,
  CLIENT_CREDENTIALS_ONLY_SCOPES,
  consentableScopes,
  NON_USER_SCOPES,
  TokenScope,
  TokenScopePresets,
  tokenScopeLabel,
  getScopeLabel,
  apiKeyScopeColumns,
  LEGACY_TOKEN_SCOPE_MASK,
  parseTokenScope,
  readApiKeyScope,
} from '../token-scope';

describe('TokenScope bitmask (shared contract — must not drift)', () => {
  it('keeps the canonical bit values', () => {
    expect(TokenScope.UserRead).toBe(1n);
    expect(TokenScope.AIServicesWrite).toBe(1n << 15n);
    expect(TokenScope.VaultWrite).toBe(1n << 24n);
    expect(TokenScope.Full).toBe((1n << 25n) - 1n);
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
    expect(tokenScopeLabel(TokenScope.UserRead)).toBeTruthy();
    expect(tokenScopeLabel(TokenScope.AIServicesWrite)).toBeTruthy();
  });
});

describe('AppBlocksDevTunnel (opt-in scope — NOT part of Full)', () => {
  it('is bit 26 = 67108864', () => {
    expect(TokenScope.AppBlocksDevTunnel).toBe(1n << 26n);
    expect(TokenScope.AppBlocksDevTunnel).toBe(67108864n);
  });

  it('is EXCLUDED from Full (Full stays frozen at (1<<25)-1)', () => {
    expect(TokenScope.Full).toBe(33554431n);
    // hasFlag-style subset test: the bit must NOT be present in Full.
    expect(TokenScope.Full & TokenScope.AppBlocksDevTunnel).toBe(0n);
  });

  it('IS included in ALL_SCOPES (the computed upper bound)', () => {
    expect(ALL_SCOPES & TokenScope.AppBlocksDevTunnel).toBe(TokenScope.AppBlocksDevTunnel);
    // Full is exactly ALL_SCOPES minus the opt-in bits.
    expect(ALL_SCOPES).toBe(
      TokenScope.Full |
        TokenScope.AppBlocksSubmit |
        TokenScope.AppBlocksDevTunnel |
        TokenScope.LinkConnect |
        TokenScope.AppStoreCatalogWrite |
        TokenScope.WorkerRegister |
        TokenScope.DownloadLink |
        TokenScope.AppsRead |
        TokenScope.AppDataRead
    );
  });

  it('has a consent-screen label', () => {
    expect(tokenScopeLabel(TokenScope.AppBlocksDevTunnel)).toBeTruthy();
  });

  it('is NOT folded into any TokenScopePreset (opt-in, like AppBlocksSubmit)', () => {
    for (const [name, preset] of Object.entries(TokenScopePresets)) {
      // Full is a preset alias for TokenScope.Full, which itself excludes the bit.
      expect(
        (preset & TokenScope.AppBlocksDevTunnel) === 0n,
        `preset ${name} must not carry AppBlocksDevTunnel`
      ).toBe(true);
    }
  });
});

describe('LinkConnect (opt-in scope — NOT part of Full)', () => {
  it('is bit 27 = 134217728', () => {
    expect(TokenScope.LinkConnect).toBe(1n << 27n);
    expect(TokenScope.LinkConnect).toBe(134217728n);
  });

  it('is EXCLUDED from Full and from every preset', () => {
    expect(TokenScope.Full).toBe(33554431n);
    expect(TokenScope.Full & TokenScope.LinkConnect).toBe(0n);
    for (const [name, preset] of Object.entries(TokenScopePresets)) {
      expect(
        (preset & TokenScope.LinkConnect) === 0n,
        `preset ${name} must not carry LinkConnect`
      ).toBe(true);
    }
  });

  it('IS included in ALL_SCOPES', () => {
    expect(ALL_SCOPES & TokenScope.LinkConnect).toBe(TokenScope.LinkConnect);
  });

  it('has a consent-screen label', () => {
    expect(tokenScopeLabel(TokenScope.LinkConnect)).toBe(
      'Connect the Civitai Link app to your account'
    );
  });
});

describe('AppStoreCatalogWrite (opt-in, client_credentials-only — NOT part of Full)', () => {
  it('is bit 28 = 268435456', () => {
    expect(TokenScope.AppStoreCatalogWrite).toBe(1n << 28n);
    expect(TokenScope.AppStoreCatalogWrite).toBe(268435456n);
  });

  it('is EXCLUDED from Full and from every preset', () => {
    expect(TokenScope.Full).toBe(33554431n);
    expect(TokenScope.Full & TokenScope.AppStoreCatalogWrite).toBe(0n);
    for (const [name, preset] of Object.entries(TokenScopePresets)) {
      expect(
        (preset & TokenScope.AppStoreCatalogWrite) === 0n,
        `preset ${name} must not carry AppStoreCatalogWrite`
      ).toBe(true);
    }
  });

  it('IS included in ALL_SCOPES', () => {
    expect(ALL_SCOPES & TokenScope.AppStoreCatalogWrite).toBe(TokenScope.AppStoreCatalogWrite);
  });

  it('is client_credentials-only, and the client_credentials cap adds only UserRead', () => {
    expect(CLIENT_CREDENTIALS_ONLY_SCOPES & TokenScope.AppStoreCatalogWrite).toBe(268435456n);
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
    expect(tokenScopeLabel(TokenScope.AppStoreCatalogWrite)).toBe(
      "Publish items to the app's App Store listing"
    );
  });
});

describe('WorkerRegister (opt-in, worker token-exchange only — NOT part of Full)', () => {
  it('is bit 29 = 536870912', () => {
    expect(TokenScope.WorkerRegister).toBe(1n << 29n);
    expect(TokenScope.WorkerRegister).toBe(536870912n);
  });

  it('is NOT part of Full', () => {
    expect(TokenScope.Full & TokenScope.WorkerRegister).toBe(0n);
  });

  it('IS included in ALL_SCOPES', () => {
    expect(ALL_SCOPES & TokenScope.WorkerRegister).toBe(TokenScope.WorkerRegister);
  });

  it('is never consentable, and leaves the client_credentials cap alone', () => {
    expect(NON_USER_SCOPES & TokenScope.WorkerRegister).toBe(TokenScope.WorkerRegister);
    expect(consentableScopes(TokenScope.UserRead | TokenScope.WorkerRegister)).toBe(
      TokenScope.UserRead
    );
    expect(CLIENT_CREDENTIALS_MAX_SCOPE & TokenScope.WorkerRegister).toBe(0n);
  });

  it('has a label', () => {
    expect(tokenScopeLabel(TokenScope.WorkerRegister)).toBe(
      'Register a worker machine with the orchestrator'
    );
  });
});

describe('DownloadLink (opt-in, client_credentials-only — NOT part of Full)', () => {
  // Bit 30 is the last one the signed 32-bit ApiKey.tokenScope column holds.
  it('is bit 30 = 1073741824', () => {
    expect(TokenScope.DownloadLink).toBe(1073741824n);
  });

  it('is excluded from Full and from every preset', () => {
    expect(TokenScope.Full & TokenScope.DownloadLink).toBe(0n);
    for (const [name, preset] of Object.entries(TokenScopePresets)) {
      expect((preset & TokenScope.DownloadLink) === 0n, `preset ${name}`).toBe(true);
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

describe('AppsRead and AppDataRead (opt-in user scopes past bit 30 — NOT part of Full)', () => {
  it('are bits 31 and 32', () => {
    expect(TokenScope.AppsRead).toBe(2147483648n);
    expect(TokenScope.AppDataRead).toBe(4294967296n);
  });

  it('leave Full at 33554431, the value stored keys hold, and are excluded from it', () => {
    expect(TokenScope.Full).toBe(33554431n);
    expect(TokenScope.Full & TokenScope.AppsRead).toBe(0n);
    expect(TokenScope.Full & TokenScope.AppDataRead).toBe(0n);
    for (const [name, preset] of Object.entries(TokenScopePresets)) {
      expect((preset & 6442450944n) === 0n, `preset ${name}`).toBe(true);
    }
  });

  it('raise ALL_SCOPES to 2^33 - 1, positive', () => {
    expect(ALL_SCOPES).toBe(8589934591n);
  });

  it('are user scopes: consentable, and not client-only or worker-only', () => {
    expect(NON_USER_SCOPES & 6442450944n).toBe(0n);
    expect(CLIENT_CREDENTIALS_MAX_SCOPE & 6442450944n).toBe(0n);
    expect(consentableScopes(6442450945n)).toBe(6442450945n);
  });

  it('have consent labels', () => {
    expect(tokenScopeLabel(TokenScope.AppsRead)).toBe('See the Apps available to you');
    expect(tokenScopeLabel(TokenScope.AppDataRead)).toBe('See your own data in Apps');
  });
});

describe('parseTokenScope (untrusted wire values)', () => {
  it('reads a number, a bigint and a decimal string, bits 31 and 32 included', () => {
    expect(parseTokenScope(6442450945)).toBe(6442450945n);
    expect(parseTokenScope(6442450945n)).toBe(6442450945n);
    expect(parseTokenScope('6442450945')).toBe(6442450945n);
    expect(parseTokenScope(0)).toBe(0n);
  });

  it('accepts exactly ALL_SCOPES (2^33 - 1) and refuses one more', () => {
    expect(parseTokenScope(8589934591)).toBe(8589934591n);
    expect(parseTokenScope(8589934591n)).toBe(8589934591n);
    expect(parseTokenScope('8589934591')).toBe(8589934591n);
    expect(parseTokenScope(8589934592n)).toBeNull();
  });

  it('refuses a value above ALL_SCOPES, a negative, a fraction and anything else', () => {
    expect(parseTokenScope(8589934592)).toBeNull();
    expect(parseTokenScope('8589934592')).toBeNull();
    expect(parseTokenScope(-1)).toBeNull();
    expect(parseTokenScope('-1')).toBeNull();
    expect(parseTokenScope(1.5)).toBeNull();
    expect(parseTokenScope('1e3')).toBeNull();
    expect(parseTokenScope(null)).toBeNull();
    expect(parseTokenScope(undefined)).toBeNull();
    expect(parseTokenScope('')).toBeNull();
  });
});

describe('ApiKey scope columns', () => {
  it('splits a write: the whole scope to tokenScopeWide, the low 31 bits to tokenScope', () => {
    // AppDataRead (2^32) | AppsRead (2^31) | VaultWrite (2^24) | UserRead (1).
    expect(apiKeyScopeColumns(6459228161n)).toEqual({
      tokenScope: 16777217,
      tokenScopeWide: 6459228161n,
    });
    expect(apiKeyScopeColumns(2147483648n)).toEqual({ tokenScope: 0, tokenScopeWide: 2147483648n });
    expect(apiKeyScopeColumns(33554431n)).toEqual({
      tokenScope: 33554431,
      tokenScopeWide: 33554431n,
    });
  });

  it('keeps bits 25..30 in tokenScope: the low column is every bit up to 30, not Full', () => {
    // Every defined bit (ALL_SCOPES, 2^33 - 1): the low column holds all 31 bits it can.
    expect(apiKeyScopeColumns(8589934591n)).toEqual({
      tokenScope: 2147483647,
      tokenScopeWide: 8589934591n,
    });
    // LinkConnect (2^27) | AppsRead (2^31): bit 27 is above Full and stays in the low column.
    expect(apiKeyScopeColumns(2281701376n)).toEqual({
      tokenScope: 134217728,
      tokenScopeWide: 2281701376n,
    });
    // DownloadLink (2^30) | AppsRead (2^31): bit 30 is the top bit the low column holds.
    expect(apiKeyScopeColumns(3221225472n)).toEqual({
      tokenScope: 1073741824,
      tokenScopeWide: 3221225472n,
    });
  });

  it('pins the low-column mask to 2^31 - 1', () => {
    expect(LEGACY_TOKEN_SCOPE_MASK).toBe(2147483647n);
  });

  it('reads tokenScopeWide when set, whatever the 32-bit column holds', () => {
    expect(readApiKeyScope({ tokenScope: 1, tokenScopeWide: 6442450945n })).toBe(6442450945n);
    // pg parses an int8 to a number, and Kysely's types call it a string: both read the same.
    expect(readApiKeyScope({ tokenScope: 1, tokenScopeWide: 6442450945 })).toBe(6442450945n);
    expect(readApiKeyScope({ tokenScope: 1, tokenScopeWide: '6442450945' })).toBe(6442450945n);
  });

  it('falls back to tokenScope for a row written before tokenScopeWide existed', () => {
    expect(readApiKeyScope({ tokenScope: 33554431, tokenScopeWide: null })).toBe(33554431n);
    expect(readApiKeyScope({ tokenScope: 5 })).toBe(5n);
  });
});
