import { describe, it, expect } from 'vitest';
import {
  ALL_SCOPES,
  hasScope,
  toggleGridScope,
  TokenScope,
  tokenScopeLabel,
} from '~/shared/constants/token-scope.constants';

describe('TokenScope constants', () => {
  it('AppBlocksSubmit is bit 25 (1 << 25 = 33554432)', () => {
    expect(TokenScope.AppBlocksSubmit).toBe(1n << 25n);
    expect(TokenScope.AppBlocksSubmit).toBe(33554432n);
  });

  it('Full is UNCHANGED at 33554431 and EXCLUDES AppBlocksSubmit', () => {
    // Critical backward-compat invariant: existing personal keys persist
    // tokenScope = 33554431. Changing Full would silently re-interpret them.
    expect(TokenScope.Full).toBe(33554431n);
    expect(TokenScope.Full).toBe((1n << 25n) - 1n);
    // AppBlocksSubmit is opt-in and NOT folded into Full.
    expect(hasScope(TokenScope.Full, TokenScope.AppBlocksSubmit)).toBe(false);
  });

  it('ALL_SCOPES includes every defined bit, including the opt-in scopes', () => {
    expect(hasScope(ALL_SCOPES, TokenScope.AppBlocksSubmit)).toBe(true);
    expect(hasScope(ALL_SCOPES, TokenScope.AppBlocksDevTunnel)).toBe(true);
    expect(hasScope(ALL_SCOPES, TokenScope.LinkConnect)).toBe(true);
    expect(hasScope(ALL_SCOPES, TokenScope.AppStoreCatalogWrite)).toBe(true);
    expect(hasScope(ALL_SCOPES, TokenScope.WorkerRegister)).toBe(true);
    expect(hasScope(ALL_SCOPES, TokenScope.DownloadLink)).toBe(true);
    expect(hasScope(ALL_SCOPES, TokenScope.UserRead)).toBe(true);
    expect(hasScope(ALL_SCOPES, TokenScope.VaultWrite)).toBe(true);
    expect(hasScope(ALL_SCOPES, TokenScope.AppsRead)).toBe(true);
    expect(hasScope(ALL_SCOPES, TokenScope.AppDataRead)).toBe(true);
    // ALL_SCOPES = Full | the opt-in bits NOT folded into Full: AppBlocksSubmit (25),
    // AppBlocksDevTunnel (26), LinkConnect (27), AppStoreCatalogWrite (28), WorkerRegister (29),
    // DownloadLink (30), AppsRead (31) and AppDataRead (32).
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
    expect(ALL_SCOPES).toBe(8589934591n); // 2 ** 33 - 1, positive: no sign bit to overflow into
  });

  it('the Civitai Link desktop grant is UserRead|VaultRead|VaultWrite|LinkConnect = 159383553', () => {
    const linkScope =
      TokenScope.UserRead | TokenScope.VaultRead | TokenScope.VaultWrite | TokenScope.LinkConnect;
    expect(linkScope).toBe(159383553n);
    // Exceeds Full, so the OAuth bound checks must use ALL_SCOPES — same reason as the CLI grant.
    expect(linkScope > TokenScope.Full).toBe(true);
    expect(linkScope <= ALL_SCOPES).toBe(true);
    expect(hasScope(TokenScope.Full, TokenScope.LinkConnect)).toBe(false);
  });

  it('a UserRead|AppBlocksSubmit token (the civitai-cli scope) is within ALL_SCOPES but exceeds Full', () => {
    const cliScope = TokenScope.UserRead | TokenScope.AppBlocksSubmit;
    expect(cliScope).toBe(33554433n);
    // Exceeds Full — this is why the OAuth bound checks use ALL_SCOPES, not Full.
    expect(cliScope > TokenScope.Full).toBe(true);
    expect(cliScope <= ALL_SCOPES).toBe(true);
  });

  it('hasFlag detects the AppBlocksSubmit bit precisely', () => {
    const scoped = TokenScope.UserRead | TokenScope.AppBlocksSubmit;
    expect(hasScope(scoped, TokenScope.AppBlocksSubmit)).toBe(true);
    // A Full token (no AppBlocksSubmit) must NOT report the bit.
    expect(hasScope(TokenScope.Full, TokenScope.AppBlocksSubmit)).toBe(false);
    // A bare UserRead token must NOT report the bit.
    expect(hasScope(TokenScope.UserRead, TokenScope.AppBlocksSubmit)).toBe(false);
  });

  it('Full is still 33554431 and excludes AppsRead (bit 31) and AppDataRead (bit 32)', () => {
    expect(TokenScope.Full).toBe(33554431n);
    expect(TokenScope.AppsRead).toBe(2147483648n);
    expect(TokenScope.AppDataRead).toBe(4294967296n);
    expect(hasScope(TokenScope.Full, TokenScope.AppsRead)).toBe(false);
    expect(hasScope(TokenScope.Full, TokenScope.AppDataRead)).toBe(false);
  });

  it('a grid toggle never adds or keeps a bit past 30 (they have no checkbox)', () => {
    expect(toggleGridScope(TokenScope.Full | TokenScope.AppsRead, TokenScope.ModelsRead)).toBe(
      32505851n
    );
  });

  it('AppBlocksSubmit has a human-readable consent label', () => {
    expect(tokenScopeLabel(TokenScope.AppBlocksSubmit)).toBe(
      'Manage your Apps: submit versions, pull source, test locally, edit listings, view analytics and respond to user feedback'
    );
  });
});
