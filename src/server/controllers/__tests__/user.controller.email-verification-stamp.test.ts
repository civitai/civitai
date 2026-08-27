import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlocklistService from '~/server/services/blocklist.service';

/**
 * 🔴 The WRITE half of the email-verification gate.
 *
 * `requiresEmailVerification` decides nothing on its own — it reads a marker, and this is the only
 * place that marker is written. The gate is safe for the 7.1M accounts with no verified address
 * precisely because the marker can only be applied here, at onboarding, going forward. A second
 * writer, or this one applying it to a step other than Profile, is what would make it retroactive.
 *
 * Also covers the `emailVerified` carry-over: the flag attests to ONE address, so typing a different
 * one at this step must clear it. Left in place it both vouches for an address nobody proved and hands
 * the gate a free bypass — sign in with a verified provider, then type someone else's address here.
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

const USER_ID = 4242;
const TYPED_EMAIL = 'typed@example.test';
const PROVIDER_EMAIL = 'provider@example.test';
const VERIFIED_AT = new Date('2026-01-01T00:00:00Z');

function ctx() {
  return {
    user: { id: USER_ID, onboarding: 0, email: PROVIDER_EMAIL },
    domain: 'blue',
  } as unknown as Parameters<typeof completeOnboardingHandler>[0]['ctx'];
}

function runProfile(email: string) {
  return completeOnboardingHandler({
    input: { step: OnboardingSteps.Profile, username: 'ada', email },
    ctx: ctx(),
  } as Parameters<typeof completeOnboardingHandler>[0]);
}

/** The `data` passed to the single `dbWrite.user.update` the step performs. */
function writtenData() {
  const calls = dbMock.dbWrite.user.update.mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertEmailAllowed.mockResolvedValue(undefined);
  mockSend.mockResolvedValue(undefined);
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID });
  dbMock.dbRead.user.findFirst.mockResolvedValue(null);
  redisMock.redis.set.mockResolvedValue('OK');
});

describe('onboarding Profile step — email-verification stamp', () => {
  it('stamps an account that ends the step with no verified address', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      email: null,
      emailVerified: null,
      meta: {},
      username: 'ada',
    });

    await runProfile(TYPED_EMAIL);

    expect(writtenData().meta).toMatchObject({ emailVerificationRequired: true });
  });

  it('does NOT stamp an account whose address is already verified', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      email: PROVIDER_EMAIL,
      emailVerified: VERIFIED_AT,
      meta: {},
      username: 'ada',
    });

    await runProfile(PROVIDER_EMAIL);

    expect(writtenData().meta).toMatchObject({ emailVerificationRequired: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('clears emailVerified and stamps when a verified account types a DIFFERENT address', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      email: PROVIDER_EMAIL,
      emailVerified: VERIFIED_AT,
      meta: {},
      username: 'ada',
    });

    await runProfile(TYPED_EMAIL);

    const data = writtenData();
    expect(data.emailVerified).toBeNull();
    expect(data.meta).toMatchObject({ emailVerificationRequired: true });
  });

  it('leaves emailVerified alone when the address is unchanged', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      email: PROVIDER_EMAIL,
      emailVerified: VERIFIED_AT,
      meta: {},
      username: 'ada',
    });

    await runProfile(PROVIDER_EMAIL);

    expect(writtenData()).not.toHaveProperty('emailVerified');
  });

  it('preserves the rest of meta — other subsystems own those keys', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      email: null,
      emailVerified: null,
      meta: { muteReason: 'strike-escalation', mutedBy: 7 },
      username: 'ada',
    });

    await runProfile(TYPED_EMAIL);

    expect(writtenData().meta).toEqual({
      muteReason: 'strike-escalation',
      mutedBy: 7,
      emailVerificationRequired: true,
    });
  });

  it('sends the verification email for the stamped address', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      email: null,
      emailVerified: null,
      meta: {},
      username: 'ada',
    });
    // `sendEmailVerification` re-reads the row after the write; it sees the stored address.
    dbMock.dbRead.user.findUnique.mockResolvedValueOnce({
      email: null,
      emailVerified: null,
      meta: {},
      username: 'ada',
    });
    dbMock.dbRead.user.findUnique.mockResolvedValueOnce({
      email: TYPED_EMAIL,
      emailVerified: null,
      username: 'ada',
    });

    await runProfile(TYPED_EMAIL);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ to: TYPED_EMAIL });
  });

  /**
   * 🔴 The retroactivity guard. Every OTHER onboarding step must leave `meta` untouched — a stamp
   * written anywhere but here reaches accounts that never went through this step.
   */
  it('writes no stamp on another onboarding step', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      email: PROVIDER_EMAIL,
      emailVerified: null,
      meta: {},
      username: 'ada',
    });

    await completeOnboardingHandler({
      input: { step: OnboardingSteps.BrowsingLevels },
      ctx: ctx(),
    } as Parameters<typeof completeOnboardingHandler>[0]);

    for (const call of dbMock.dbWrite.user.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty('meta');
    }
  });

  /**
   * The behavioural case above covers one step. This covers the rest: the controller may name the
   * marker exactly once, so no step can acquire a second writer without this going red.
   */
  it('names the marker in exactly one place in the controller', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../../../src/server/controllers/user.controller.ts'),
      'utf8'
    );
    const occurrences = source.match(/emailVerificationRequired/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });
});
