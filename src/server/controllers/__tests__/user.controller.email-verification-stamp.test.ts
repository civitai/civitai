import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlocklistService from '~/server/services/blocklist.service';

/**
 * 🔴 The WRITE half of the email-verification gate.
 *
 * `requiresEmailVerification` decides nothing on its own — it reads a marker, and this is the only
 * place that marker is written. The gate is safe for the 7.1M accounts with no verified address
 * precisely because the marker can only be applied here, when this step first completes or when it
 * changes the address. A second writer, or this one stamping a bare re-submit, is what would make it
 * retroactive: `onboarding` is caller-supplied, so a re-submit is something any account can perform.
 *
 * Also covers the `emailVerified` carry-over: the flag attests to ONE address, so typing a different
 * one must clear it — and, because the column is `citext`, a case-only retype must NOT.
 */

const { mockAssertEmailAllowed, mockSend } = vi.hoisted(() => ({
  mockAssertEmailAllowed: vi.fn(),
  mockSend: vi.fn(),
}));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  assertEmailAllowed: mockAssertEmailAllowed,
}));

vi.mock('~/server/email/templates/emailVerification.email', () => ({
  emailVerificationEmail: { send: mockSend },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { OnboardingSteps } from '~/server/common/enums';
import { completeOnboardingHandler } from '~/server/controllers/user.controller';
import { refreshSession } from '~/server/auth/session-invalidation';

const USER_ID = 4242;
const TYPED_EMAIL = 'typed@example.test';
const PROVIDER_EMAIL = 'provider@example.test';
const VERIFIED_AT = new Date('2026-01-01T00:00:00Z');

/** `onboarding` on the SESSION. Anything without the Profile bit makes this step a first completion. */
function ctx(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: USER_ID, onboarding: 0, email: PROVIDER_EMAIL, ...overrides },
    domain: 'blue',
  } as unknown as Parameters<typeof completeOnboardingHandler>[0]['ctx'];
}

function runProfile(email: string, ctxOverrides: Record<string, unknown> = {}) {
  return completeOnboardingHandler({
    input: { step: OnboardingSteps.Profile, username: 'ada', email },
    ctx: ctx(ctxOverrides),
  } as Parameters<typeof completeOnboardingHandler>[0]);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    email: PROVIDER_EMAIL,
    emailVerified: null,
    username: 'ada',
    ...overrides,
  };
}

/** The `data` passed to the single `dbWrite.user.update` the step performs. */
function writtenData() {
  const calls = dbMock.dbWrite.user.update.mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0].data as Record<string, unknown>;
}

/**
 * The stamp goes through `setEmailVerificationRequired`, a `jsonb_set` statement — deliberately NOT a
 * read-modify-write of `User.meta`, which is shared with moderation state (`banDetails`,
 * `muteReason`). Reading the SQL text is how that stays pinned; reading the bound value is how the
 * boolean stays pinned.
 */
function stampWrites() {
  return dbMock.dbWrite.$executeRaw.mock.calls
    .map((call) => ({
      sql: (call[0] as unknown as string[]).join('?'),
      values: call.slice(1),
    }))
    .filter((c) => c.sql.includes('emailVerificationRequired'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertEmailAllowed.mockResolvedValue(undefined);
  mockSend.mockResolvedValue(undefined);
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  dbMock.dbRead.user.findFirst.mockResolvedValue(null);
  redisMock.redis.set.mockResolvedValue('OK');
});

describe('onboarding Profile step — email-verification stamp', () => {
  it('stamps an account that ends the step with no verified address', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ email: null }));

    await runProfile(TYPED_EMAIL);

    const [stamp] = stampWrites();
    expect(stamp.sql).toContain('jsonb_set');
    expect(stamp.values).toEqual([true, USER_ID]);
  });

  it('does NOT stamp an account whose address is already verified', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ emailVerified: VERIFIED_AT }));

    await runProfile(PROVIDER_EMAIL);

    expect(stampWrites()[0].values).toEqual([false, USER_ID]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  /**
   * 🔴 `onboarding` is caller-supplied input and `completeOnboardingStep` is `protectedProcedure`, so
   * ANY account can re-submit this step. Without this, an account that has been posting for years
   * marks itself gated by re-sending its own unchanged details.
   */
  it('does NOT stamp a bare re-submit that changes nothing', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row());

    await runProfile(PROVIDER_EMAIL, { onboarding: OnboardingSteps.Profile });

    expect(stampWrites()).toHaveLength(0);
  });

  it('DOES stamp a re-submit that changes the address', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ emailVerified: VERIFIED_AT }));

    await runProfile(TYPED_EMAIL, { onboarding: OnboardingSteps.Profile });

    expect(stampWrites()[0].values).toEqual([true, USER_ID]);
  });

  it('clears emailVerified and stamps when a verified account types a DIFFERENT address', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ emailVerified: VERIFIED_AT }));

    await runProfile(TYPED_EMAIL);

    expect(writtenData().emailVerified).toBeNull();
    expect(stampWrites()[0].values).toEqual([true, USER_ID]);
  });

  it('leaves emailVerified alone when the address is unchanged', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ emailVerified: VERIFIED_AT }));

    await runProfile(PROVIDER_EMAIL);

    expect(writtenData()).not.toHaveProperty('emailVerified');
  });

  /**
   * 🔴 `User.email` is `citext`. A case-only retype is the same address to Postgres, so treating it as
   * a change would revoke a verification the user already earned — over a keystroke, on an address
   * they proved. The onboarding form pre-fills the address, so a retype is an ordinary thing to do.
   */
  it('treats a case-only retype as UNCHANGED (citext)', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(
      row({ email: 'Alice@Example.test', emailVerified: VERIFIED_AT })
    );

    await runProfile('alice@example.test');

    expect(writtenData()).not.toHaveProperty('emailVerified');
    expect(stampWrites()[0].values).toEqual([false, USER_ID]);
    expect(mockAssertEmailAllowed).not.toHaveBeenCalled();
  });

  it('runs the domain blocklist on a genuinely new address', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ email: null }));

    await runProfile(TYPED_EMAIL);

    expect(mockAssertEmailAllowed).toHaveBeenCalledTimes(1);
    expect(mockAssertEmailAllowed).toHaveBeenCalledWith(TYPED_EMAIL);
  });

  /**
   * The comparison is against the ROW, not `ctx.user`, because the session shape is cached for up to
   * 4h. Every other fixture here has the two agreeing, so only this one can tell the fix from its
   * revert: a stale session claims the address is already set while the row says otherwise.
   */
  it('compares against the row, not a stale session', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ email: null }));

    await runProfile(TYPED_EMAIL, { email: TYPED_EMAIL });

    expect(mockAssertEmailAllowed).toHaveBeenCalledWith(TYPED_EMAIL);
    expect(stampWrites()[0].values).toEqual([true, USER_ID]);
  });

  /**
   * The address is passed to the mail path rather than re-read. A re-read hits the replica, which
   * right after this write can still hold the OLD row — and a token minted for the old address
   * silently reverts the change when its link is clicked.
   */
  it('sends to the address just written, not to whatever a re-read returns', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ email: 'stale@example.test' }));
    dbMock.dbRead.user.findUnique.mockResolvedValue(row({ email: 'stale@example.test' }));

    await runProfile(TYPED_EMAIL);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ to: TYPED_EMAIL });
  });

  /**
   * The stamp and `emailVerified` both live on the SESSION shape, which is cached for up to 4h. Without
   * the bust the gate keeps refusing an account that just verified, and the banner keeps nagging one
   * that did not need to — for hours, with the database already correct.
   */
  it('busts the cached session so the stamp takes effect', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row({ email: null }));

    await runProfile(TYPED_EMAIL);

    expect(refreshSession).toHaveBeenCalledWith(USER_ID, expect.objectContaining({}));
  });

  /**
   * 🔴 The retroactivity guard. EVERY other step must leave the marker alone — a stamp written in the
   * ToS step in particular reaches every legacy account that re-accepts the Terms. Driving one step
   * was not enough: a ToS-step writer was green against the single-step version of this test.
   */
  it.each([
    ['BrowsingLevels', OnboardingSteps.BrowsingLevels],
    ['TOS', OnboardingSteps.TOS],
    ['RedTOS', OnboardingSteps.RedTOS],
  ])('writes no stamp on the %s step', async (_label, step) => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row());
    dbMock.dbRead.user.findUnique.mockResolvedValue({ id: USER_ID, settings: {}, meta: {} });

    await completeOnboardingHandler({
      input: { step },
      ctx: ctx(),
    } as Parameters<typeof completeOnboardingHandler>[0]).catch(() => undefined);

    expect(stampWrites()).toHaveLength(0);
    for (const call of dbMock.dbWrite.user.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty('meta');
    }
  });
});
