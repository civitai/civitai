import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CollectionService from '~/server/services/collection.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as ModelFileController from '~/server/controllers/model-file.controller';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getCollectionAiReviewDefaultPrompt: vi.fn(async () => 'prompt'),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: vi.fn(() => ({ collectionAiReview: true })),
}));
vi.mock('~/server/controllers/model-file.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelFileController>()),
  restoreReplacedFileHandler: vi.fn(async () => 'restored'),
}));

const { collectionRouter } = await import('~/server/routers/collection.router');
const { modelFileRouter } = await import('~/server/routers/model-file.router');
const { createCallerFactory, moderatorProcedure, router } = await import('~/server/trpc');
const { getCollectionAiReviewDefaultPrompt } = await import('~/server/services/collection.service');
const { restoreReplacedFileHandler } = await import('~/server/controllers/model-file.controller');

// A procedure built here from the exported `moderatorProcedure`, so these cases hold for any
// procedure a router builds from it, whatever scope it declares.
const bare = vi.fn(async () => 'bare');
const scoped = vi.fn(async () => 'scoped');
const probeRouter = router({
  bare: moderatorProcedure.query(bare),
  scoped: moderatorProcedure.meta({ requiredScope: TokenScope.UserRead }).mutation(scoped),
});

const callCollection = createCallerFactory(collectionRouter);
const callModelFile = createCallerFactory(modelFileRouter);
const callProbe = createCallerFactory(probeRouter);

const MODERATOR = {
  id: 31,
  isModerator: true,
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date('2026-01-01'),
  bannedAt: null,
  muted: false,
};

function ctx(credential: Record<string, unknown> = {}, user: Record<string, unknown> = MODERATOR) {
  return {
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: {},
    track: { action: vi.fn(async () => undefined) },
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
    ...credential,
  } as never;
}

const REDUCED = TokenScope.Full & ~TokenScope.AIServicesWrite;
const key = (apiKeyType: string | undefined, tokenScope = TokenScope.Full, id = 1) => ({
  apiKeyId: id,
  ...(apiKeyType ? { apiKeyType } : {}),
  subject: { type: 'apiKey', id },
  tokenScope,
});
const oauth = (apiKeyType: string, tokenScope: number) => ({
  apiKeyId: 3,
  apiKeyType,
  subject: { type: 'oauth', id: 'client-abc' },
  tokenScope,
});

const allowed: [string, Record<string, unknown>][] = [
  ['a browser session', {}],
  ['a full-scope personal API key', key('User')],
];

const CREDENTIAL_REFUSAL =
  'This action requires a signed-in session or a full-access personal API key.';
const SCOPE_REFUSAL = 'Your API key does not have the required scope for this action';

// The reduced-scope credentials still carry every scope a procedure below declares, so on those
// procedures the scope check passes and the refusal comes from the moderator gate.
const refused: [string, Record<string, unknown>, { reducedScope: boolean }][] = [
  ['a full-scope OAuth access token', oauth('Access', TokenScope.Full), { reducedScope: false }],
  [
    'an OAuth access token granted only the declared scopes',
    oauth('Access', TokenScope.UserRead | TokenScope.CollectionsRead | TokenScope.ModelsWrite),
    { reducedScope: true },
  ],
  ['a full-scope OAuth refresh token', oauth('Refresh', TokenScope.Full), { reducedScope: false }],
  ['a full-scope System key', key('System'), { reducedScope: false }],
  ['a reduced-scope personal API key', key('User', REDUCED), { reducedScope: true }],
  ['a key whose type was not recorded', key(undefined), { reducedScope: false }],
  // A personal key type on an OAuth subject is still an OAuth credential.
  [
    'a full-scope User-typed key issued to an OAuth client',
    oauth('User', TokenScope.Full),
    { reducedScope: false },
  ],
];

const procedures = [
  {
    name: 'collection.getAiReviewDefaultPrompt (read scope)',
    call: (c: Record<string, unknown>, user?: Record<string, unknown>) =>
      callCollection(ctx(c, user)).getAiReviewDefaultPrompt(),
    handler: getCollectionAiReviewDefaultPrompt,
    result: 'prompt',
    declaresScope: true,
  },
  {
    name: 'modelFile.restoreReplaced (write scope)',
    call: (c: Record<string, unknown>, user?: Record<string, unknown>) =>
      callModelFile(ctx(c, user)).restoreReplaced({ id: 9 }),
    handler: restoreReplacedFileHandler,
    result: 'restored',
    declaresScope: true,
  },
  {
    name: 'a moderatorProcedure declaring no scope',
    call: (c: Record<string, unknown>, user?: Record<string, unknown>) =>
      callProbe(ctx(c, user)).bare(),
    handler: bare,
    result: 'bare',
    declaresScope: false,
  },
  {
    name: 'a moderatorProcedure declaring a read scope',
    call: (c: Record<string, unknown>, user?: Record<string, unknown>) =>
      callProbe(ctx(c, user)).scoped(),
    handler: scoped,
    result: 'scoped',
    declaresScope: true,
  },
];

beforeEach(() => vi.clearAllMocks());

describe.each(procedures)('$name credential requirements', (procedure) => {
  it.each(allowed)('runs for a moderator on %s', async (_label, credential) => {
    await expect(procedure.call(credential)).resolves.toBe(procedure.result);
    expect(procedure.handler).toHaveBeenCalledTimes(1);
  });

  it.each(refused)('refuses a moderator on %s', async (_label, credential, { reducedScope }) => {
    // A procedure declaring no scope turns a reduced-scope token away at the scope check.
    const message = reducedScope && !procedure.declaresScope ? SCOPE_REFUSAL : CREDENTIAL_REFUSAL;
    await expect(procedure.call(credential)).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', message })
    );
    expect(procedure.handler).not.toHaveBeenCalled();
  });

  it.each([
    ...allowed,
    ['a full-scope OAuth access token', oauth('Access', TokenScope.Full)] as const,
  ])('refuses a non-moderator on %s', async (_label, credential) => {
    await expect(procedure.call(credential, { ...MODERATOR, isModerator: false })).rejects.toThrow(
      expect.objectContaining({
        code: 'FORBIDDEN',
        message: 'You do not have permission to perform this action',
      })
    );
    expect(procedure.handler).not.toHaveBeenCalled();
  });
});
