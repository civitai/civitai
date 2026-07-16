import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MOD REVIEW SANDBOX (#2831) — `mintReviewBlockToken` service unit coverage.
 *
 * This is the security crux of the review preview: it mints the block token a mod
 * uses to run UNAPPROVED, untrusted code with their OWN session. We prove the mint
 * is self-bound + render-only scope-stripped + forced-SFW + synthetically-attributed,
 * exercising the REAL clamp belt (clampDevScopes + REVIEW_MINT_SCOPE_ALLOWLIST +
 * signDevScopedPageToken) with only the DB, the JWT signer, and the audit log mocked.
 */

const { mockSign, mockFindUnique, mockLogToAxiom } = vi.hoisted(() => ({
  mockSign: vi.fn(async (input: unknown) => ({
    token: 'review.jwt.signed',
    expiresAt: '2099-01-01T00:00:00Z',
    jti: 'j',
    _input: input,
  })),
  mockFindUnique: vi.fn(),
  mockLogToAxiom: vi.fn(async () => undefined),
}));

// Sign is the real signDevScopedPageToken's downstream — mock it so we can inspect
// the exact claims minted (self-bound sub, forced-SFW, synthetic ids, scopes).
vi.mock('~/server/services/block-token.service', () => ({
  BlockTokenService: { sign: mockSign },
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlockPublishRequest: { findUnique: mockFindUnique } },
  dbWrite: {},
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...a: unknown[]) => mockLogToAxiom(...a),
}));

import { mintReviewBlockToken } from '~/server/services/blocks/publish-request.service';
import { FORCED_SFW_CEILING } from '~/server/services/blocks/dev-scoped-mint.service';

const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';
const MOD_ID = 4242;

// A pending request whose (author-controlled, un-reviewed) manifest declares a
// full malicious scope set + a wide sandbox.
function pendingRow() {
  return {
    id: PUBREQ,
    status: 'pending' as const,
    slug: 'evil-app',
    manifest: {
      name: 'Evil App',
      iframe: { sandbox: 'allow-scripts allow-forms allow-popups' },
      scopes: [
        'models:read:self',
        'media:read:owned',
        'collections:read:self',
        'ai:write:budgeted',
        'apps:storage:read',
        'apps:storage:write',
        'apps:storage:shared:write',
        'collections:read:private',
        'social:tip:self',
        'buzz:read:self',
      ],
    },
  };
}

beforeEach(() => {
  mockSign.mockClear();
  mockFindUnique.mockReset();
  mockLogToAxiom.mockClear();
});

describe('mintReviewBlockToken', () => {
  it('mints a SELF-BOUND, forced-SFW, render-only token with synthetic pubreq_ ids', async () => {
    mockFindUnique.mockResolvedValue(pendingRow());

    const res = await mintReviewBlockToken({ publishRequestId: PUBREQ, modUserId: MOD_ID });

    // Resolved by publishRequestId (never ownership).
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PUBREQ } })
    );

    // The JWT claims (from the captured sign input).
    expect(mockSign).toHaveBeenCalledTimes(1);
    const arg = mockSign.mock.calls[0][0] as Record<string, unknown>;
    // SELF-BOUND to the calling mod — every *:read:self can only return the mod's data.
    expect(arg.userId).toBe(MOD_ID);
    // Forced-SFW ceiling + no color domain.
    expect(arg.maxBrowsingLevel).toBe(FORCED_SFW_CEILING);
    expect(arg.domain).toBeNull();
    // Synthetic, non-resolving ids — appBlockId carries the recognized `pubreq_`
    // SYNTHETIC_APP_BLOCK_ID_PREFIXES prefix; appId is the non-resolving `pending-…`.
    expect(arg.appBlockId).toBe(PUBREQ);
    expect(arg.appId).toBe(`pending-${PUBREQ}`);
    expect(arg.blockInstanceId).toBe(`page_${PUBREQ}`);
    expect(arg.blockId).toBe('evil-app');
    // No spend budget in review, and it is a dev-lifetime page token.
    expect(arg.buzzBudget).toBeUndefined();
    expect(arg.dev).toBe(true);

    // The minted SCOPES contain NONE of the withheld money/private/write scopes —
    // only the render-only survivors (+ force-granted user:read:self).
    const scopes = arg.scopes as string[];
    expect(scopes).toEqual([
      'collections:read:self',
      'media:read:owned',
      'models:read:self',
      'user:read:self',
    ]);
    for (const withheld of [
      'ai:write:budgeted',
      'apps:storage:read',
      'apps:storage:write',
      'apps:storage:shared:write',
      'collections:read:private',
      'social:tip:self',
      'buzz:read:self',
    ]) {
      expect(scopes).not.toContain(withheld);
    }

    // The returned render metadata is server-derived + consistent with the claims.
    expect(res.token).toBe('review.jwt.signed');
    expect(res.scopes).toEqual(scopes);
    expect(res.appBlockId).toBe(PUBREQ);
    expect(res.appId).toBe(`pending-${PUBREQ}`);
    expect(res.blockInstanceId).toBe(`page_${PUBREQ}`);
    expect(res.appName).toBe('Evil App');
    expect(res.sandbox).toBe('allow-scripts allow-forms allow-popups');
    expect(res.domain).toBeNull();
    expect(res.maxBrowsingLevel).toBe(FORCED_SFW_CEILING);

    // A mint-time audit event fired (never the token).
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    const [auditArg] = mockLogToAxiom.mock.calls[0] as [Record<string, unknown>];
    expect(auditArg).toMatchObject({
      name: 'app-blocks.review.mint',
      modUserId: MOD_ID,
      publishRequestId: PUBREQ,
      slug: 'evil-app',
    });
    expect(JSON.stringify(auditArg)).not.toContain('review.jwt.signed');
  });

  it('defaults sandbox to allow-scripts when the manifest declares none', async () => {
    mockFindUnique.mockResolvedValue({
      id: PUBREQ,
      status: 'pending',
      slug: 'plain-app',
      manifest: { scopes: ['models:read:self'] },
    });
    const res = await mintReviewBlockToken({ publishRequestId: PUBREQ, modUserId: MOD_ID });
    expect(res.sandbox).toBe('allow-scripts');
    expect(res.appName).toBe('plain-app'); // falls back to slug
  });

  it('THROWS for a missing request (no oracle) and never signs', async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(
      mintReviewBlockToken({ publishRequestId: PUBREQ, modUserId: MOD_ID })
    ).rejects.toThrow(/not found/);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it('THROWS for a non-pending request (fail-closed) and never signs', async () => {
    mockFindUnique.mockResolvedValue({ ...pendingRow(), status: 'approved' });
    await expect(
      mintReviewBlockToken({ publishRequestId: PUBREQ, modUserId: MOD_ID })
    ).rejects.toThrow(/not pending/);
    expect(mockSign).not.toHaveBeenCalled();
  });
});
