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
const caller = (isEarlyAdopter: boolean) =>
  feedbackRouter.createCaller({
    user: {
      id: USER_ID,
      isModerator: false,
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
