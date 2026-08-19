import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * THE SEAM: the notice (`getArea`, a READ) and the submit endpoint (`create`, a
 * WRITE) are gated by the same flag, and must resolve it identically.
 *
 * Each half is easy to get right alone and the pair is what breaks: if only the read
 * path carries an evaluation context, a cohort member is shown a prompt whose submit
 * is then rejected — or, the other way round, a user who cannot see the prompt is the
 * only one whose submit would succeed. Neither is visible from a test scoped to one
 * procedure, because both procedures pass in isolation.
 *
 * So this drives BOTH through the REAL router, the REAL `feedback.service` and the
 * REAL `buildFliptContext`, stubbing only the Flipt edge, and asserts (a) that the two
 * evaluations are the SAME (flag, entityId, context) triple and (b) that a
 * segment-gated area lets the same user through both doors.
 */

const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({ isFlipt: (...args: unknown[]) => mockIsFlipt(...args) }));

const { feedbackRouter } = await import('~/server/routers/feedback.router');

const USER_ID = 42;

/**
 * `isEarlyAdopter` is the ONLY thing that varies between the two callers below, so a
 * difference in outcome can only be the cohort property — not tier, mute or onboarding.
 */
const caller = (isEarlyAdopter: boolean, isModerator = false) =>
  feedbackRouter.createCaller({
    user: {
      id: USER_ID,
      isModerator,
      muted: false,
      onboarding: OnboardingSteps.Buzz,
      isEarlyAdopter,
    },
    acceptableOrigin: true,
    // A full token scope, or the guarded chain throws FORBIDDEN for a SCOPE reason —
    // which the `create` expectations below would otherwise happily accept.
    tokenScope: TokenScope.Full,
    features: {},
  } as never);

const submission = {
  area: 'bitdex-image-feed' as const,
  message: 'the feed repeated itself',
};

/** What the live `early-adopters` segment does: eq on the STRING 'true'. */
const earlyAdoptersSegment = async (
  _flag: string,
  _entityId: string,
  context?: Record<string, string>
) => context?.isEarlyAdopter === 'true';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.feedback.create.mockResolvedValue({ id: 1 });
  mockIsFlipt.mockImplementation(earlyAdoptersSegment);
});

const evalCalls = () =>
  mockIsFlipt.mock.calls as [string, string, Record<string, string> | undefined][];

describe('feedback flag gate — read and write evaluate the flag identically', () => {
  it('hands Flipt the same flag, entityId and context from getArea and from create', async () => {
    await caller(true).getArea({ area: submission.area });
    await caller(true).create(submission);

    expect(evalCalls()).toHaveLength(2);
    const [read, write] = evalCalls();
    expect(read[0]).toBe('feedback-area-bitdex-image-feed');
    // Not `toEqual(read)` on the whole call by accident: name the three parts, so a
    // future argument that differs between the paths is a visible failure rather than
    // an object comparison nobody reads.
    expect(write[0]).toBe(read[0]);
    expect(write[1]).toBe(read[1]);
    expect(write[2]).toEqual(read[2]);
    // And the context is really there on both — an assertion that two `undefined`s
    // match would be satisfied by the very defect this file exists to prevent.
    expect(read[2]?.isEarlyAdopter).toBe('true');
    expect(write[2]?.isEarlyAdopter).toBe('true');
    expect(read[1]).toBe('42');
  });

  it('a cohort member sees the notice AND can submit', async () => {
    await expect(caller(true).getArea({ area: submission.area })).resolves.toEqual({
      enabled: true,
    });
    await expect(caller(true).create(submission)).resolves.toEqual({ id: 1 });
    expect(dbMock.dbWrite.feedback.create).toHaveBeenCalledTimes(1);
  });

  it('a user outside the cohort sees no notice AND is refused by the submit endpoint', async () => {
    await expect(caller(false).getArea({ area: submission.area })).resolves.toEqual({
      enabled: false,
    });
    // Matched on the message too: mute, onboarding and token-scope middlewares in this
    // chain also throw FORBIDDEN, and a code-only assertion would pass on any of them
    // while saying nothing about the flag.
    await expect(caller(false).create(submission)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Feedback is not being collected here right now.',
    });
    expect(dbMock.dbWrite.feedback.create).not.toHaveBeenCalled();
  });
});

/**
 * The SAME seam for the `/apps` marketplace area, driven through the real router.
 *
 * Worth its own block rather than a parameter on the one above for two reasons. First
 * the flag key: it is derived (`feedback-area-<slug>`) and never written down in the
 * app, so the literal below is the only in-repo statement of what flipt-state must
 * hold — and an unknown flag resolves FALSE, so a mismatch reads as "nobody can leave
 * feedback" rather than as an error. Second the rollout differs: this area targets
 * `early-adopters` OR `testers`, and the `testers` half is ANY_MATCH_TYPE with an
 * `isModerator = "true"` constraint, so a moderator who never opted into the
 * early-adopter program must get through BOTH doors. That is deliberate, not an
 * accident, and it is the case the bitdex block cannot reach.
 */
describe('apps-marketplace — read and write agree, for both segments of its rollout', () => {
  const marketplace = {
    area: 'apps-marketplace' as const,
    message: 'the store showed no apps',
    context: { path: '/apps', filters: { kind: 'offsite', sort: 'newest' } },
  };

  /** What the live rollout does: early-adopters OR testers, the latter incl. mods. */
  const appsMarketplaceRollout = async (
    _flag: string,
    _entityId: string,
    context?: Record<string, string>
  ) => context?.isEarlyAdopter === 'true' || context?.isModerator === 'true';

  beforeEach(() => {
    mockIsFlipt.mockImplementation(appsMarketplaceRollout);
  });

  it('hands Flipt the apps-marketplace flag key from both procedures', async () => {
    await caller(true).getArea({ area: marketplace.area });
    await caller(true).create(marketplace);

    expect(evalCalls()).toHaveLength(2);
    const [read, write] = evalCalls();
    // The hand-typed contract with flipt-state's features.yaml.
    expect(read[0]).toBe('feedback-area-apps-marketplace');
    expect(write[0]).toBe(read[0]);
    expect(write[1]).toBe(read[1]);
    expect(write[2]).toEqual(read[2]);
    expect(read[1]).toBe('42');
  });

  it('lets an early adopter see the notice AND submit, storing the store view', async () => {
    await expect(caller(true).getArea({ area: marketplace.area })).resolves.toEqual({
      enabled: true,
    });
    await expect(caller(true).create(marketplace)).resolves.toEqual({ id: 1 });
    expect(dbMock.dbWrite.feedback.create.mock.calls[0][0].data).toMatchObject({
      area: 'apps-marketplace',
      context: { path: '/apps', filters: { kind: 'offsite', sort: 'newest' } },
    });
  });

  // The `testers` arm: a moderator who never opted in. INTENDED — every moderator is
  // in scope for this area.
  it('lets a moderator who is NOT an early adopter see the notice AND submit', async () => {
    await expect(caller(false, true).getArea({ area: marketplace.area })).resolves.toEqual({
      enabled: true,
    });
    await expect(caller(false, true).create(marketplace)).resolves.toEqual({ id: 1 });
  });

  it('refuses a user in neither segment at both doors', async () => {
    await expect(caller(false).getArea({ area: marketplace.area })).resolves.toEqual({
      enabled: false,
    });
    await expect(caller(false).create(marketplace)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Feedback is not being collected here right now.',
    });
    expect(dbMock.dbWrite.feedback.create).not.toHaveBeenCalled();
  });

  /**
   * The two areas are SEPARATE flags, so switching one on cannot switch the other on.
   * Asserted against a stub that answers only for the marketplace key — a service that
   * ignored `area` when building the key would light both surfaces at once.
   */
  it('is gated independently of the bitdex area', async () => {
    mockIsFlipt.mockImplementation(
      async (flag: string) => flag === 'feedback-area-apps-marketplace'
    );
    await expect(caller(true).getArea({ area: 'apps-marketplace' })).resolves.toEqual({
      enabled: true,
    });
    await expect(caller(true).getArea({ area: 'bitdex-image-feed' })).resolves.toEqual({
      enabled: false,
    });
  });
});
