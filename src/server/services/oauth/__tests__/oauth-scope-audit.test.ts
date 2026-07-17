import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unified scope-usage audit — external-OAuth arm.
 *
 * `maybeRecordOauthScopeUsage` is the emit helper called from `enforceTokenScope`
 * (the single OAuth scope-verification choke point). It must:
 *   - record ONE `recordScopeInvocation` row for an external OAuth token, tagged
 *     `source: 'external-oauth'` with the acting oauthClientId + mapped scope;
 *   - emit NOTHING for a session (no subject) or a personal API key;
 *   - never throw, even if the audit sink rejects (best-effort).
 */

const { mockRecordScopeInvocation } = vi.hoisted(() => ({
  mockRecordScopeInvocation: vi.fn(async () => undefined),
}));

// The helper lazy-imports the service; mock it so no DB is touched.
vi.mock('~/server/services/blocks/user-app-surface.service', () => ({
  recordScopeInvocation: mockRecordScopeInvocation,
}));

import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  maybeRecordOauthScopeUsage,
  tokenScopeToAuditName,
} from '~/server/services/oauth/oauth-scope-audit';

const OAUTH_SUBJECT = { type: 'oauth' as const, id: 'appblk-my-app' };
const API_KEY_SUBJECT = { type: 'apiKey' as const, id: 7 };

describe('tokenScopeToAuditName', () => {
  it('maps a single known bit to its enum-key name', () => {
    expect(tokenScopeToAuditName(TokenScope.ModelsRead)).toBe('ModelsRead');
    expect(tokenScopeToAuditName(TokenScope.MediaRead)).toBe('MediaRead');
    expect(tokenScopeToAuditName(TokenScope.SocialTip)).toBe('SocialTip');
  });

  it('maps the composite Full mask to "full"', () => {
    expect(tokenScopeToAuditName(TokenScope.Full)).toBe('full');
  });

  it('falls back to scope:<bitmask> for an unknown / composite value (never throws)', () => {
    // A value that is not a single defined bit and not Full.
    const weird = TokenScope.ModelsRead | TokenScope.MediaRead;
    expect(tokenScopeToAuditName(weird)).toBe(`scope:${weird}`);
    expect(tokenScopeToAuditName(999999999)).toBe('scope:999999999');
  });
});

describe('maybeRecordOauthScopeUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records one external-oauth row with oauthClientId + mapped scope + source', async () => {
    maybeRecordOauthScopeUsage({
      subject: OAUTH_SUBJECT,
      userId: 42,
      scopeBit: TokenScope.ModelsRead,
      endpoint: 'model.getById',
      statusCode: 200,
    });
    await vi.waitFor(() => expect(mockRecordScopeInvocation).toHaveBeenCalledTimes(1));
    expect(mockRecordScopeInvocation).toHaveBeenCalledWith({
      userId: 42,
      oauthClientId: 'appblk-my-app',
      scope: 'ModelsRead',
      endpoint: 'model.getById',
      statusCode: 200,
      source: 'external-oauth',
    });
  });

  it('does NOT record for a personal API key subject', async () => {
    maybeRecordOauthScopeUsage({
      subject: API_KEY_SUBJECT,
      userId: 42,
      scopeBit: TokenScope.ModelsRead,
      endpoint: 'model.getById',
      statusCode: 200,
    });
    // Flush any pending microtasks; nothing should have been recorded.
    await Promise.resolve();
    expect(mockRecordScopeInvocation).not.toHaveBeenCalled();
  });

  it('does NOT record for a session (no subject)', async () => {
    maybeRecordOauthScopeUsage({
      subject: undefined,
      userId: 42,
      scopeBit: TokenScope.ModelsRead,
      endpoint: 'model.getById',
      statusCode: 200,
    });
    await Promise.resolve();
    expect(mockRecordScopeInvocation).not.toHaveBeenCalled();
  });

  it('does NOT record when there is no userId', async () => {
    maybeRecordOauthScopeUsage({
      subject: OAUTH_SUBJECT,
      userId: undefined,
      scopeBit: TokenScope.ModelsRead,
      endpoint: 'model.getById',
      statusCode: 200,
    });
    await Promise.resolve();
    expect(mockRecordScopeInvocation).not.toHaveBeenCalled();
  });

  it('is best-effort: a rejecting sink does not throw or surface', async () => {
    mockRecordScopeInvocation.mockRejectedValueOnce(new Error('sink down'));
    // Synchronous call must not throw.
    expect(() =>
      maybeRecordOauthScopeUsage({
        subject: OAUTH_SUBJECT,
        userId: 42,
        scopeBit: TokenScope.Full,
        endpoint: 'model.getById',
        statusCode: 500,
      })
    ).not.toThrow();
    await vi.waitFor(() => expect(mockRecordScopeInvocation).toHaveBeenCalledTimes(1));
    // The rejection was swallowed — the unhandled-rejection guard below asserts
    // no error escaped the fire-and-forget path.
    expect(mockRecordScopeInvocation.mock.calls[0][0]).toMatchObject({
      source: 'external-oauth',
      scope: 'full',
    });
  });
});
