import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeedbackSchema } from '~/server/schema/feedback.schema';
import type { SessionUser } from '~/types/session';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    isFlipt: vi.fn(),
  },
}));

vi.mock('~/server/flipt/client', () => ({ isFlipt: mocks.isFlipt }));

const { createFeedback, isFeedbackAreaEnabled } = await import('../feedback.service');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.feedback.create.mockResolvedValue({ id: 1 });
  mocks.isFlipt.mockResolvedValue(true);
});

/** What the write layer was actually handed, read off the real call. */
const writtenContext = () => dbMock.dbWrite.feedback.create.mock.calls[0][0].data.context;

/**
 * `createFeedback` persistence for the extended context.
 *
 * The point of asserting on `dbWrite.feedback.create`'s argument rather than on the
 * function's return value: the return is `{ id }` and says nothing about what was
 * stored. A context field can be accepted by the schema, typed in the DTO, and still
 * never reach the column — that is the failure this file exists to catch, and it is
 * invisible from the outside.
 */
describe('createFeedback — extended context', () => {
  const args = {
    userId: 7,
    area: 'bitdex-image-feed' as const,
    message: 'the feed repeated itself',
  };

  it('writes attached image ids into the stored context', async () => {
    await createFeedback({ ...args, context: { images: ['cf-1', 'cf-2'] } });
    expect(writtenContext()).toEqual({ images: ['cf-1', 'cf-2'] });
  });

  it('writes the screenshot id into the stored context', async () => {
    await createFeedback({ ...args, context: { screenshotId: 'cf-shot' } });
    expect(writtenContext()).toEqual({ screenshotId: 'cf-shot' });
  });

  it('writes the Faro session id into the stored context', async () => {
    await createFeedback({ ...args, context: { sessionId: 'faro-abc' } });
    expect(writtenContext()).toEqual({ sessionId: 'faro-abc' });
  });

  it('writes all three alongside the pre-existing fields', async () => {
    await createFeedback({
      ...args,
      context: {
        path: '/images',
        reportedSource: 'bitdex',
        images: ['cf-1'],
        screenshotId: 'cf-shot',
        sessionId: 'faro-abc',
      },
    });
    expect(writtenContext()).toEqual({
      path: '/images',
      reportedSource: 'bitdex',
      images: ['cf-1'],
      screenshotId: 'cf-shot',
      sessionId: 'faro-abc',
    });
    expect(dbMock.dbWrite.feedback.create.mock.calls[0][0].data.userId).toBe(7);
    expect(dbMock.dbWrite.feedback.create.mock.calls[0][0].data.area).toBe('bitdex-image-feed');
  });

  /**
   * THE SEAM. The two halves above are each hermetic — the schema test proves the
   * boundary keeps the fields, this file proves the service writes whatever it is
   * handed — and both would stay green if the schema stripped a field the service
   * happily forwards. Parsing first is what makes them meet.
   */
  it('persists what the BOUNDARY SCHEMA produced, not what the caller typed', async () => {
    const parsed = createFeedbackSchema.parse({
      area: 'bitdex-image-feed',
      message: 'the feed repeated itself',
      context: {
        path: '/images',
        images: ['cf-1', 'cf-2'],
        screenshotId: 'cf-shot',
        sessionId: 'faro-abc',
      },
    });
    await createFeedback({ ...parsed, userId: 7 });
    expect(writtenContext()).toEqual({
      path: '/images',
      images: ['cf-1', 'cf-2'],
      screenshotId: 'cf-shot',
      sessionId: 'faro-abc',
    });
  });

  // Faro absent (dev/test/preview, or a blocked SDK) is the ordinary case: the
  // submission must be written with no sessionId rather than failing.
  it('writes a submission that carries no sessionId', async () => {
    await createFeedback({ ...args, context: { images: ['cf-1'] } });
    expect(writtenContext()).not.toHaveProperty('sessionId');
    expect(writtenContext()).toEqual({ images: ['cf-1'] });
  });

  it('writes an empty object when there is no context at all (invariant guard)', async () => {
    await createFeedback(args);
    expect(writtenContext()).toEqual({});
  });

  /**
   * THE SECOND AREA, END TO END through the boundary schema — the marketplace prompt's
   * payload, parsed and then written.
   *
   * Same seam argument as the case above: the schema strips undeclared keys, so a
   * context the page builds and the service happily forwards can still arrive at the
   * column with the interesting half missing. Parsing first is what makes "the page
   * sends it" and "the column stores it" meet, and `area` is asserted on the write
   * because that value is what a triager filters by.
   */
  it('writes an apps-marketplace submission with the store view it was sent with', async () => {
    const parsed = createFeedbackSchema.parse({
      area: 'apps-marketplace',
      message: 'the store showed no apps',
      context: {
        path: '/apps',
        filters: { kind: 'offsite', category: 'generation', sort: 'newest', query: 'upscale' },
      },
    });
    await createFeedback({ ...parsed, userId: 7 });

    expect(dbMock.dbWrite.feedback.create.mock.calls[0][0].data.area).toBe('apps-marketplace');
    expect(writtenContext()).toEqual({
      path: '/apps',
      filters: { kind: 'offsite', category: 'generation', sort: 'newest', query: 'upscale' },
    });
  });
});

/**
 * `isFeedbackAreaEnabled` — the EVALUATION CONTEXT, i.e. the third argument.
 *
 * `isFlipt` is `isEnabled(flag, entityId = 'global', context = {})`. Omitting the
 * third argument is not a smaller call, it is a DIFFERENT evaluation: Flipt matches
 * a segment against the context, so with `{}` no segment can match and the answer
 * collapses to the flag's own default. An area switched on for a cohort then reads
 * as off for every one of its members, with nothing logged and no error raised.
 *
 * `buildFliptContext` is the REAL function here (only the Flipt edge is stubbed), so
 * these assertions pin the context the LIVE evaluation would receive rather than a
 * shape invented by the test — the same arrangement as the App Blocks flag tests.
 */
describe('isFeedbackAreaEnabled — the Flipt evaluation context', () => {
  const sessionUser = (over: Partial<SessionUser> = {}): SessionUser =>
    ({
      id: 7,
      showNsfw: false,
      blurNsfw: true,
      browsingLevel: 1,
      onboarding: 0,
      ...over,
    } as SessionUser);

  /** The (flag, entityId, context) triple the service actually handed Flipt. */
  const evalCall = () =>
    mocks.isFlipt.mock.calls[0] as [string, string, Record<string, string> | undefined];

  it('passes a context as the third argument, keyed on the user id', async () => {
    await isFeedbackAreaEnabled({ area: 'bitdex-image-feed', user: sessionUser() });

    const [flag, entityId, context] = evalCall();
    expect(flag).toBe('feedback-area-bitdex-image-feed');
    expect(entityId).toBe('7');
    // The load-bearing assertion. `undefined` here is the defect: a segment-based
    // rollout on this flag could never match, for anybody, ever.
    expect(context).toBeDefined();
    expect(context?.userId).toBe('7');
    expect(context?.isLoggedIn).toBe('true');
  });

  /**
   * A CONTRACT WITH A LIVE SEGMENT, hand-typed on both sides.
   *
   * The `early-adopters` segment constrains `property: isEarlyAdopter`,
   * `operator: eq`, `value: "true"` — the STRING. A typo in the property name, or a
   * boolean `true`, or 'True', fails that constraint as "nobody matches" rather than
   * as an error, so both halves are pinned by literal value. Neither is read from the
   * implementation.
   */
  it('emits isEarlyAdopter as the STRING "true" for an opted-in user', async () => {
    await isFeedbackAreaEnabled({
      area: 'bitdex-image-feed',
      user: sessionUser({ isEarlyAdopter: true }),
    });

    const [, , context] = evalCall();
    expect(context).toHaveProperty('isEarlyAdopter');
    expect(context?.isEarlyAdopter).toBe('true');
    expect(typeof context?.isEarlyAdopter).toBe('string');
    expect(context?.isEarlyAdopter).not.toBe(true as unknown as string);
  });

  it('emits "false" for a user who has not opted in, so an eq-"true" segment excludes them', async () => {
    await isFeedbackAreaEnabled({
      area: 'bitdex-image-feed',
      user: sessionUser({ isEarlyAdopter: false }),
    });

    expect(evalCall()[2]?.isEarlyAdopter).toBe('false');
  });

  /**
   * THE SECOND AREA. `feedbackAreaFlagKey` is a template literal, so a per-area flag
   * key is never written down in the app — the only hand-written copy is the flag in
   * flipt-state's `features.yaml`. If the service derived, say, the wrong slug, every
   * evaluation would resolve an UNKNOWN flag, and an unknown flag reads false: the
   * area would be off for everyone with nothing logged and no error raised.
   *
   * The literal on the right is the contract with that file, typed out rather than
   * built from the area, so this fails if either side moves alone.
   */
  it('derives the apps-marketplace flag key, with the same context as any other area', async () => {
    await isFeedbackAreaEnabled({
      area: 'apps-marketplace',
      user: sessionUser({ isEarlyAdopter: true, isModerator: true }),
    });

    const [flag, entityId, context] = evalCall();
    expect(flag).toBe('feedback-area-apps-marketplace');
    expect(entityId).toBe('7');
    expect(context?.userId).toBe('7');
    // The two properties the live rollout's segments constrain — `early-adopters`
    // matches on isEarlyAdopter, `testers` on isModerator. Both are STRINGS; a
    // boolean here fails the constraint as "nobody matches", not as an error.
    expect(context?.isEarlyAdopter).toBe('true');
    expect(context?.isModerator).toBe('true');
  });

  /**
   * The `testers` arm of the apps-marketplace rollout, behaviourally. That segment is
   * ANY_MATCH_TYPE over `isModerator = "true"` OR a userId allowlist, so a moderator
   * who never opted into the early-adopter program is IN SCOPE — intended, and the
   * half that the early-adopters stub above cannot see.
   */
  describe('against a stub that behaves like the testers segment', () => {
    beforeEach(() => {
      mocks.isFlipt.mockImplementation(
        async (_flag: string, _entityId: string, context?: Record<string, string>) =>
          context?.isModerator === 'true'
      );
    });

    it('is ON for a moderator who is NOT an early adopter', async () => {
      await expect(
        isFeedbackAreaEnabled({
          area: 'apps-marketplace',
          user: sessionUser({ isModerator: true, isEarlyAdopter: false }),
        })
      ).resolves.toBe(true);
    });

    it('and OFF for a non-moderator', async () => {
      await expect(
        isFeedbackAreaEnabled({ area: 'apps-marketplace', user: sessionUser() })
      ).resolves.toBe(false);
    });

    it('and OFF for an anonymous request', async () => {
      await expect(isFeedbackAreaEnabled({ area: 'apps-marketplace' })).resolves.toBe(false);
    });
  });

  it('evaluates an anonymous request with an anonymous context that carries no cohort property', async () => {
    await isFeedbackAreaEnabled({ area: 'bitdex-image-feed' });

    const [flag, entityId, context] = evalCall();
    expect(flag).toBe('feedback-area-bitdex-image-feed');
    // Unchanged: every anonymous request shares one entityId.
    expect(entityId).toBe('anonymous');
    expect(context?.isLoggedIn).toBe('false');
    // ABSENT, not 'false': there is no user to attribute an opt-in to. Either value
    // excludes them from an eq-'true' segment; absence also stops 'anonymous' from
    // being spelled as a member of any cohort segment at all.
    expect('isEarlyAdopter' in (context ?? {})).toBe(false);
    expect(context?.userId).toBeUndefined();
  });

  /**
   * BEHAVIOURAL, not structural. The stub implements what the live `early-adopters`
   * segment does — match iff the context says `isEarlyAdopter === 'true'` — so this
   * asserts the outcome the operator actually wants, not merely that some object was
   * passed. Structurally-correct-but-wrong-property mutations die here too.
   */
  describe('against a stub that behaves like the early-adopters segment', () => {
    beforeEach(() => {
      mocks.isFlipt.mockImplementation(
        async (_flag: string, _entityId: string, context?: Record<string, string>) =>
          context?.isEarlyAdopter === 'true'
      );
    });

    it('a segment-gated area is ON for a member of the cohort', async () => {
      await expect(
        isFeedbackAreaEnabled({
          area: 'bitdex-image-feed',
          user: sessionUser({ isEarlyAdopter: true }),
        })
      ).resolves.toBe(true);
    });

    it('and OFF for a logged-in user outside it', async () => {
      await expect(
        isFeedbackAreaEnabled({ area: 'bitdex-image-feed', user: sessionUser() })
      ).resolves.toBe(false);
    });

    it('and OFF for an anonymous request', async () => {
      await expect(isFeedbackAreaEnabled({ area: 'bitdex-image-feed' })).resolves.toBe(false);
    });
  });
});
