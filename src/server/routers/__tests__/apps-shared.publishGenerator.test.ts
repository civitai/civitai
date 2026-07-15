import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for `apps.shared.publishGenerator` (Custom Generators PR-B) — the
 * structured-generator publish path into the SAME shared_kv store. Mirrors the
 * apps-shared.router harness: mocks the pg pool, block-token verifier, Flipt
 * flag, rate limiters, and subject hydration. The CONTENT-SAFETY belt runs FOR
 * REAL (real includesMinor/includesPoi) with only its redis-backed deps mocked,
 * so the belt-on-prompts test exercises the genuine audit path. The G7 resource
 * gate + backgroundImageRef check are mocked (their own units are covered in
 * generator-publish.service.test.ts) so this file isolates the router wiring:
 * belt → resource gate → quota/caps → INSERT with the kind:'generator'
 * discriminator, and proves the text append path is untouched.
 */

const {
  mockVerifyBlockToken,
  mockParseSubjectUserId,
  mockDbRead,
  mockIsSharedEnabled,
  mockPool,
  mockClient,
  mockGetSessionUser,
  mockCheckAppendRl,
  mockCheckVoteRl,
  mockThrowOnBlockedLinkDomain,
  mockAuditPromptServer,
  mockIsRevoked,
  mockLogToAxiom,
  mockAssertResources,
  mockValidateBg,
} = vi.hoisted(() => {
  const mockClient = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn(async () => mockClient),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  };
  return {
    mockVerifyBlockToken: vi.fn(),
    mockParseSubjectUserId: vi.fn(),
    mockDbRead: { appBlock: { findUnique: vi.fn() }, account: { count: vi.fn() } },
    mockIsSharedEnabled: vi.fn(async () => true),
    mockPool,
    mockClient,
    mockGetSessionUser: vi.fn(),
    mockCheckAppendRl: vi.fn(async () => ({ allowed: true })),
    mockCheckVoteRl: vi.fn(async () => ({ allowed: true })),
    mockThrowOnBlockedLinkDomain: vi.fn(async () => undefined),
    mockAuditPromptServer: vi.fn(async () => undefined),
    mockIsRevoked: vi.fn(async () => false),
    mockLogToAxiom: vi.fn(async () => undefined),
    mockAssertResources: vi.fn(async () => undefined),
    mockValidateBg: vi.fn(async () => undefined),
  };
});

vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: mockVerifyBlockToken,
  parseSubjectUserId: (...args: unknown[]) => mockParseSubjectUserId(...args),
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksSharedStorageEnabled: mockIsSharedEnabled,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/db/appsDb', () => ({ requireAppsDb: () => mockPool }));
vi.mock('~/server/utils/shared-storage-rate-limit', () => ({
  checkSharedAppendRateLimit: (...a: unknown[]) => mockCheckAppendRl(...a),
  checkSharedVoteRateLimit: (...a: unknown[]) => mockCheckVoteRl(...a),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: (...a: unknown[]) => mockThrowOnBlockedLinkDomain(...a),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: (...a: unknown[]) => mockAuditPromptServer(...a),
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: (...a: unknown[]) => mockIsRevoked(...a) },
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...a: unknown[]) => mockLogToAxiom(...a),
}));
// The G7 resource gate + backgroundImageRef check are mocked here (covered in
// generator-publish.service.test.ts). This isolates the router wiring.
vi.mock('~/server/services/apps/generator-publish.service', () => ({
  assertGeneratorResourceStackGeneratable: (...a: unknown[]) => mockAssertResources(...a),
  validateGeneratorBackgroundImage: (...a: unknown[]) => mockValidateBg(...a),
}));

import { appsSharedRouter } from '../apps-shared.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OnboardingSteps } from '~/server/common/enums';

const READ = 'apps:storage:shared:read';
const WRITE = 'apps:storage:shared:write';

function validClaims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti_test',
    blockId: 'app-generators',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_inst',
    ctx: {},
    scopes: [READ, WRITE],
    ...over,
  };
}

function trustedUser(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    isModerator: false,
    bannedAt: null,
    muted: false,
    onboarding: OnboardingSteps.Buzz,
    emailVerified: new Date('2020-01-01'),
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    ...over,
  };
}

function fakeCtx(user?: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}
const caller = () => appsSharedRouter.createCaller(fakeCtx() as never);

function validGenerator(over: Record<string, unknown> = {}) {
  return {
    name: 'Anime Generator',
    description: 'nice pictures',
    buttons: [
      {
        label: 'Anime',
        workflowType: 'textToImage',
        checkpointVersionId: 100,
        loras: [{ versionId: 200, weight: 0.8 }],
        promptTemplate: 'masterpiece, {subject}',
        params: { steps: 25, quantity: 1 },
        exposedInputs: { prompt: true },
      },
    ],
    ...over,
  };
}

// Resolve the row-count + quota SELECTs so a valid publish reaches the INSERT.
function mockPublishDataPath() {
  mockPool.query.mockImplementation(async (sql: string) => {
    if (sql.includes('author_user_id') && sql.includes('count(*)'))
      return { rows: [{ n: '0' }], rowCount: 1 };
    if (sql.includes('.quota'))
      return { rows: [{ used_bytes: '0', row_count: '0' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsSharedEnabled.mockImplementation(async () => true);
  mockParseSubjectUserId.mockImplementation((sub: string) =>
    sub === 'anon' ? null : Number(sub.split(':')[1])
  );
  mockGetSessionUser.mockResolvedValue(trustedUser());
  mockDbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_test', status: 'approved' });
  mockDbRead.account.count.mockResolvedValue(0);
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mockCheckAppendRl.mockResolvedValue({ allowed: true });
  mockThrowOnBlockedLinkDomain.mockResolvedValue(undefined);
  mockAuditPromptServer.mockResolvedValue(undefined);
  mockLogToAxiom.mockResolvedValue(undefined);
  mockAssertResources.mockResolvedValue(undefined);
  mockValidateBg.mockResolvedValue(undefined);
});

describe('publishGenerator — happy path', () => {
  it('writes a kind:"generator" row and returns a ULID key', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPublishDataPath();
    const out = await caller().publishGenerator({ blockToken: 't', value: validGenerator() });
    expect(out.key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // Resource gate ran with the token subject as viewer.
    expect(mockAssertResources).toHaveBeenCalledTimes(1);
    expect(mockAssertResources.mock.calls[0][0]).toMatchObject({
      viewer: { id: 42, isModerator: false },
    });

    // The stored value is discriminated by kind:'generator'.
    const insert = (mockClient.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].includes('INSERT INTO "app_app_generators".shared_kv')
    );
    expect(insert).toBeTruthy();
    const stored = JSON.parse(String((insert![1] as unknown[])[2])) as {
      kind: string;
      generator: { name: string };
    };
    expect(stored.kind).toBe('generator');
    expect(stored.generator.name).toBe('Anime Generator');
  });

  it('validates backgroundImageRef when present', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPublishDataPath();
    await caller().publishGenerator({
      blockToken: 't',
      value: validGenerator({ backgroundImageRef: '9876' }),
    });
    expect(mockValidateBg).toHaveBeenCalledWith('9876');
  });

  it('skips backgroundImageRef validation when absent', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockPublishDataPath();
    await caller().publishGenerator({ blockToken: 't', value: validGenerator() });
    expect(mockValidateBg).not.toHaveBeenCalled();
  });
});

describe('publishGenerator — content-safety belt on prompts', () => {
  it('rejects a minor-content promptTemplate (BAD_REQUEST) + files a Report, no INSERT', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    await expect(
      caller().publishGenerator({
        blockToken: 't',
        value: validGenerator({
          buttons: [
            {
              label: 'x',
              workflowType: 'textToImage',
              checkpointVersionId: 100,
              params: { quantity: 1 },
              promptTemplate: '13 year old girl',
            },
          ],
        }),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const report = (mockPool.query.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      c[0].includes('shared_kv_reports')
    );
    expect(report).toBeTruthy();
    expect(String((report![1] as unknown[])[3])).toContain('auto:');
    // Belt rejected BEFORE the resource gate + INSERT.
    expect(mockAssertResources).not.toHaveBeenCalled();
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('rejects a blocked-link promptTemplate (BAD_REQUEST)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockThrowOnBlockedLinkDomain.mockRejectedValueOnce(new Error('invalid urls'));
    await expect(
      caller().publishGenerator({
        blockToken: 't',
        value: validGenerator({
          buttons: [
            {
              label: 'x',
              workflowType: 'textToImage',
              checkpointVersionId: 100,
              params: { quantity: 1 },
              promptTemplate: 'visit http://bad.example',
            },
          ],
        }),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockAssertResources).not.toHaveBeenCalled();
  });

  it('rejects a minor-content button LABEL (BAD_REQUEST), no INSERT', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    await expect(
      caller().publishGenerator({
        blockToken: 't',
        value: validGenerator({
          buttons: [
            {
              label: '13 year old girl',
              workflowType: 'textToImage',
              checkpointVersionId: 100,
              params: { quantity: 1 },
              promptTemplate: '',
            },
          ],
        }),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockAssertResources).not.toHaveBeenCalled();
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('rejects a blocked-link negativePrompt (BAD_REQUEST), no INSERT', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockThrowOnBlockedLinkDomain.mockRejectedValueOnce(new Error('invalid urls'));
    await expect(
      caller().publishGenerator({
        blockToken: 't',
        value: validGenerator({
          buttons: [
            {
              label: 'ok',
              workflowType: 'textToImage',
              checkpointVersionId: 100,
              params: { quantity: 1, negativePrompt: 'avoid http://bad.example' },
              promptTemplate: 'nice',
            },
          ],
        }),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockAssertResources).not.toHaveBeenCalled();
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('rejects an audit-flagged name (BAD_REQUEST) + emits the content-block warning', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAuditPromptServer.mockRejectedValueOnce(new Error('Your prompt was flagged'));
    await expect(
      caller().publishGenerator({
        blockToken: 't',
        value: validGenerator({ name: 'flagged text' }),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const emit = (mockLogToAxiom.mock.calls as Array<[Record<string, unknown>, string?]>).find(
      (c) => c[1] === 'block-audit' && c[0]?.name === 'app-blocks-shared-storage-content-block'
    );
    expect(emit).toBeTruthy();
    expect(JSON.stringify(emit![0])).not.toContain('flagged text');
  });
});

describe('publishGenerator — G7 resource gate', () => {
  it('rejects when the resource gate throws (FORBIDDEN), no INSERT', async () => {
    const { TRPCError } = await import('@trpc/server');
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockAssertResources.mockRejectedValueOnce(
      new TRPCError({ code: 'FORBIDDEN', message: 'a pinned resource is not available' })
    );
    await expect(
      caller().publishGenerator({ blockToken: 't', value: validGenerator() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});

describe('publishGenerator — auth/trust parity with append', () => {
  it('anon NEVER publishes (UNAUTHORIZED)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ sub: 'anon' }));
    await expect(
      caller().publishGenerator({ blockToken: 't', value: validGenerator() })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('a token missing the write scope is rejected (FORBIDDEN)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims({ scopes: [READ] }));
    await expect(
      caller().publishGenerator({ blockToken: 't', value: validGenerator() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an untrusted (too-new) writer is denied (FORBIDDEN)', async () => {
    mockVerifyBlockToken.mockResolvedValueOnce(validClaims());
    mockGetSessionUser.mockResolvedValueOnce(trustedUser({ createdAt: new Date() }));
    await expect(
      caller().publishGenerator({ blockToken: 't', value: validGenerator() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});
