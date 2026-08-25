import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `messageAppOwner` — the moderator → app-developer message path.
 *
 * 🔴 WHAT THIS FILE IS ACTUALLY GUARDING, in priority order:
 *
 *   1. THE RECIPIENT IS THE CANONICAL OWNER, never `AppListing.userId`. On an on-site
 *      listing that column is a denormalized copy and is stale-able, so reading it
 *      would send a moderator's private message about an app to a user who no longer
 *      owns it while the real owner hears nothing. The drifted-row fixture below is
 *      the only fixture that can see this: one where the column and the block AGREE
 *      is green against both the correct and the broken resolution.
 *   2. NOTHING IS DELIVERED THAT IS NOT FIRST RECORDED. Every refusal path asserts
 *      the audit write AND the send did not happen — not merely that it threw — and
 *      the happy path asserts the write's invocation ORDER precedes the send's.
 *   3. BOTH rate-limit windows are spent. A short-circuit that skipped the per-listing
 *      counter whenever the per-moderator one allowed would leave the harassment
 *      ceiling unenforced in the normal case, and would pass a test that only checked
 *      "a limit exists".
 *
 * 🔴 `dbRead` AND `dbWrite` ARE DISTINCT (the canonical `dbMock`), and that is
 * load-bearing here rather than hygiene: this service READS the listing off the
 * replica and WRITES the audit row on the primary. Aliasing them would make "the audit
 * row went to the replica" structurally undetectable, which is the exact defect class
 * this file family has been bitten by twice. Asserted explicitly at the end.
 *
 * The rate limiter is mocked at its module boundary so quota outcomes are declarable;
 * the limiter's own Redis mechanics have their own file
 * (`app-moderator-message-rate-limit.test.ts`). `resolveListingAccess` is NOT mocked —
 * it is the thing under test on the ownership axis, and mocking it would delete case 1.
 */

const { mockActorQuota, mockListingQuota, mockBlockedLink, mockNotify } = vi.hoisted(() => ({
  // No declared parameters: `vi.fn` records the arguments it is CALLED with regardless,
  // so `toHaveBeenCalledWith(...)` below is unaffected — and a named-but-unused
  // parameter is what `@typescript-eslint/no-unused-vars` flags.
  mockActorQuota: vi.fn(async () => ({ allowed: true } as unknown)),
  mockListingQuota: vi.fn(async () => ({ allowed: true } as unknown)),
  mockBlockedLink: vi.fn(async () => undefined),
  mockNotify: vi.fn(async () => undefined),
}));

vi.mock('~/server/utils/app-moderator-message-rate-limit', () => ({
  checkModMessageModeratorQuota: mockActorQuota,
  checkModMessageListingQuota: mockListingQuota,
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: mockBlockedLink,
}));
vi.mock('~/server/services/blocks/app-moderator-message-notify', () => ({
  notifyAppModeratorMessage: mockNotify,
}));
vi.mock('~/server/utils/app-block-ids', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  newAppListingModerationEventId: () => 'alme_fixed',
}));

const { messageAppOwner, AppModeratorMessageError } = await import(
  '~/server/services/blocks/app-moderator-message.service'
);

// 🔴 PAIRWISE-DISTINCT, and distinct from every constant the assertions name. Two roles
// sharing a number is how a fixture "proves" a gate that reads the wrong field.
const REAL_OWNER = 42; // OauthClient.userId, reached as appBlock.app.userId
const STALE_NAME = 99; // what the drifted AppListing.userId column still says
const EDITOR = 77; // holds an ACCEPTED seat on the parent
const MOD = 8; // the acting moderator

const LIVE = 'apl_live';
const SHADOW = 'apl_shadow';

const SUBJECT = 'Your listing describes a spend confirmation that does not exist';
const BODY =
  'The store listing says the app "estimates the cost and asks before it spends". ' +
  'It has never shown a confirmation. Please correct the copy or ship the prompt.';

/**
 * A drifted ON-SITE parent: the column says {@link STALE_NAME}, the OauthClient says
 * {@link REAL_OWNER}. Fields are a superset of `resolveListingAccess`'s select, so one
 * row answers the whole resolution.
 */
function onsiteRow(over: Record<string, unknown> = {}) {
  return {
    id: LIVE,
    userId: STALE_NAME,
    slug: 'prompt-vault',
    kind: 'onsite',
    appBlockId: 'ab_1',
    revisionOfId: null,
    appBlock: { app: { userId: REAL_OWNER } },
    revisionOf: null,
    ...over,
  };
}

function input(over: Record<string, unknown> = {}) {
  return { appListingId: LIVE, subject: SUBJECT, body: BODY, ...over };
}

beforeEach(() => {
  // Per-FILE reset for the shared hybrid mocks, so declare per-test here.
  dbMock.dbRead.appListing.findUnique.mockReset().mockResolvedValue(onsiteRow());
  dbMock.dbRead.appCollaborator.findMany.mockReset().mockResolvedValue([]);
  dbMock.dbWrite.appListingModerationEvent.create
    .mockReset()
    .mockImplementation(async (a: { data: unknown }) => a.data);
  mockActorQuota.mockReset().mockResolvedValue({ allowed: true });
  mockListingQuota.mockReset().mockResolvedValue({ allowed: true });
  mockBlockedLink.mockReset().mockResolvedValue(undefined);
  mockNotify.mockReset().mockResolvedValue(undefined);
});

describe('the recipient is the CANONICAL owner, not the denormalized column', () => {
  it('🔴 a DRIFTED on-site listing notifies the BLOCK owner and NOT the stale column', async () => {
    const result = await messageAppOwner({ input: input(), moderatorUserId: MOD });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const sent = mockNotify.mock.calls[0][0] as { userIds: number[] };
    // BOTH directions on one fixture. Asserting only the inclusion leaves a
    // "notify everyone" mutant alive; asserting only the exclusion leaves "notify
    // nobody" alive — and this service's whole job is delivering to exactly one user.
    expect(sent.userIds).toEqual([REAL_OWNER]);
    expect(sent.userIds).not.toContain(STALE_NAME);
    expect(result.recipientCount).toBe(1);
  });

  it('🔴 the AUDIT row records the canonical owner as the recipient too', async () => {
    // The audit row is the only durable record of who was told. If it disagreed with
    // what was sent, a later review would exonerate or implicate the wrong account.
    await messageAppOwner({ input: input(), moderatorUserId: MOD });
    const data = dbMock.dbWrite.appListingModerationEvent.create.mock.calls[0][0].data as {
      after: { recipientUserIds: number[] };
    };
    expect(data.after.recipientUserIds).toEqual([REAL_OWNER]);
  });

  it('an OFF-SITE listing that HAS a block notifies the COLUMN owner (issue #3844)', async () => {
    // The control that keeps the fix from over-reaching: "always use the block owner"
    // would be a NEW bug on this shape, which `mapAppBlockToListing` really mints.
    dbMock.dbRead.appListing.findUnique.mockResolvedValue(
      onsiteRow({ kind: 'offsite', slug: 'df-qwen-canvas' })
    );
    await messageAppOwner({ input: input(), moderatorUserId: MOD });
    const sent = mockNotify.mock.calls[0][0] as { userIds: number[] };
    expect(sent.userIds).toEqual([STALE_NAME]);
    expect(sent.userIds).not.toContain(REAL_OWNER);
  });

  it('an UNKNOWN kind falls through to the column (fail-closed, matching the resolver)', async () => {
    dbMock.dbRead.appListing.findUnique.mockResolvedValue(onsiteRow({ kind: 'somethingelse' }));
    await messageAppOwner({ input: input(), moderatorUserId: MOD });
    expect((mockNotify.mock.calls[0][0] as { userIds: number[] }).userIds).toEqual([STALE_NAME]);
  });

  it('a SHADOW revision id resolves to the PARENT: owner, slug, quota key and audit row', async () => {
    // A moderator should not have to know which id they pasted. Every downstream key
    // must be the parent's, or a shadow gets its own quota allowance and an audit row
    // that the listing's history read cannot join.
    dbMock.dbRead.appListing.findUnique.mockResolvedValue({
      id: SHADOW,
      userId: STALE_NAME,
      slug: 'rev-01hx',
      kind: 'onsite',
      appBlockId: null,
      revisionOfId: LIVE,
      appBlock: null,
      revisionOf: {
        id: LIVE,
        slug: 'prompt-vault',
        userId: STALE_NAME,
        kind: 'onsite',
        appBlockId: 'ab_1',
        appBlock: { app: { userId: REAL_OWNER } },
      },
    });

    const result = await messageAppOwner({
      input: input({ appListingId: SHADOW }),
      moderatorUserId: MOD,
    });

    expect(result.appListingId).toBe(LIVE);
    expect(mockListingQuota).toHaveBeenCalledWith(LIVE);
    const sent = mockNotify.mock.calls[0][0] as {
      userIds: number[];
      details: { slug: string; listingId: string };
    };
    expect(sent.userIds).toEqual([REAL_OWNER]);
    // The PARENT's public slug — a shadow's own is the synthetic `rev-…`, which names
    // no app the developer would recognise.
    expect(sent.details.slug).toBe('prompt-vault');
    expect(sent.details.listingId).toBe(LIVE);
    const data = dbMock.dbWrite.appListingModerationEvent.create.mock.calls[0][0].data as {
      appListingId: string;
      slug: string;
    };
    expect(data.appListingId).toBe(LIVE);
    expect(data.slug).toBe('prompt-vault');
  });

  it('resolves the owner in ONE read and never asks for a role', async () => {
    // `userId: null` takes the resolver's early return, so the seat lookup is not paid.
    // A future edit passing `moderatorUserId` here would silently add a query per send
    // and compute a role nobody reads.
    await messageAppOwner({ input: input(), moderatorUserId: MOD });
    expect(dbMock.dbRead.appListing.findUnique).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.appCollaborator.findFirst).not.toHaveBeenCalled();
  });
});

describe('collaborators are opt-in, and the set is de-duplicated', () => {
  it('by DEFAULT an accepted collaborator is NOT notified', async () => {
    dbMock.dbRead.appCollaborator.findMany.mockResolvedValue([{ userId: EDITOR }]);
    await messageAppOwner({ input: input(), moderatorUserId: MOD });
    const sent = mockNotify.mock.calls[0][0] as { userIds: number[] };
    expect(sent.userIds).toEqual([REAL_OWNER]);
    expect(sent.userIds).not.toContain(EDITOR);
    // …and the seat read is not even issued, so the default costs nothing.
    expect(dbMock.dbRead.appCollaborator.findMany).not.toHaveBeenCalled();
  });

  it('includeCollaborators:true adds the ACCEPTED seats, keyed on the PARENT listing', async () => {
    dbMock.dbRead.appCollaborator.findMany.mockResolvedValue([{ userId: EDITOR }]);
    const result = await messageAppOwner({
      input: input({ includeCollaborators: true }),
      moderatorUserId: MOD,
    });
    const sent = mockNotify.mock.calls[0][0] as { userIds: number[] };
    expect(sent.userIds).toEqual([REAL_OWNER, EDITOR]);
    expect(result.recipientCount).toBe(2);
    expect(dbMock.dbRead.appCollaborator.findMany.mock.calls[0][0]).toMatchObject({
      where: { appListingId: LIVE, status: 'accepted' },
    });
  });

  it('the ACCEPTED filter is not widened, and `displayed` is not consulted', async () => {
    // `status: accepted` is CONSENT — a pending invitee is a stranger who happens to
    // have been named, and must not receive moderation correspondence. `displayed` is
    // a public-credit preference, so filtering on it would silently drop an editor who
    // declined a byline but can still fix the listing.
    await messageAppOwner({
      input: input({ includeCollaborators: true }),
      moderatorUserId: MOD,
    });
    const where = dbMock.dbRead.appCollaborator.findMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    expect(where.status).toBe('accepted');
    expect(where).not.toHaveProperty('displayed');
  });

  it('an owner who also holds a seat is notified ONCE', async () => {
    dbMock.dbRead.appCollaborator.findMany.mockResolvedValue([
      { userId: REAL_OWNER },
      { userId: EDITOR },
    ]);
    const result = await messageAppOwner({
      input: input({ includeCollaborators: true }),
      moderatorUserId: MOD,
    });
    expect((mockNotify.mock.calls[0][0] as { userIds: number[] }).userIds).toEqual([
      REAL_OWNER,
      EDITOR,
    ]);
    expect(result.recipientCount).toBe(2);
  });
});

describe('nothing is delivered that was not first recorded', () => {
  it('the audit write is invoked BEFORE the send', async () => {
    await messageAppOwner({ input: input(), moderatorUserId: MOD });
    const writeOrder = dbMock.dbWrite.appListingModerationEvent.create.mock.invocationCallOrder[0];
    const sendOrder = mockNotify.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(sendOrder);
  });

  it('a failed audit write means NO send at all', async () => {
    dbMock.dbWrite.appListingModerationEvent.create.mockRejectedValue(
      new Error('23514 check constraint')
    );
    await expect(messageAppOwner({ input: input(), moderatorUserId: MOD })).rejects.toThrow();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('the audit row carries the action, the actor, the subject, the body and the fan-out', async () => {
    await messageAppOwner({
      input: input({ includeCollaborators: true }),
      moderatorUserId: MOD,
    });
    const data = dbMock.dbWrite.appListingModerationEvent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      id: 'alme_fixed',
      appListingId: LIVE,
      slug: 'prompt-vault',
      action: 'message-owner',
      actorUserId: MOD,
      // The SUBJECT in `reason` and the BODY in `detail`: a history that recorded only
      // that a message was sent could not be reviewed for what was said.
      reason: SUBJECT,
      detail: BODY,
      after: { recipientUserIds: [REAL_OWNER], includeCollaborators: true },
    });
    // No state changed, so there is deliberately no `before`.
    expect((data as Record<string, unknown>).before).toBeUndefined();
  });

  it('the notification key is the audit event id, so a retry delivers once', async () => {
    await messageAppOwner({ input: input(), moderatorUserId: MOD });
    expect((mockNotify.mock.calls[0][0] as { key: string }).key).toBe(
      'app-moderator-message:alme_fixed'
    );
  });

  it('the moderator is recorded in the audit row and ABSENT from what the recipient gets', async () => {
    // Attribution belongs in the log, not on the wire — naming the individual to the
    // developer is the retaliation vector the rest of the moderation surface declines
    // to open.
    await messageAppOwner({ input: input(), moderatorUserId: MOD });
    const details = (mockNotify.mock.calls[0][0] as { details: Record<string, unknown> }).details;
    expect(Object.values(details)).not.toContain(MOD);
    expect(JSON.stringify(details)).not.toContain(String(MOD));
  });
});

describe('rate limiting — BOTH windows, and a refusal writes and sends nothing', () => {
  it('🔴 BOTH counters are spent even when the moderator counter allows', async () => {
    // The mutation this exists for: `if (!actor.allowed) throw; …` with the listing
    // check behind an `else` leaves the harassment ceiling unenforced for every mod
    // under their own cap, i.e. the normal case.
    await messageAppOwner({ input: input(), moderatorUserId: MOD });
    expect(mockActorQuota).toHaveBeenCalledWith(MOD);
    expect(mockListingQuota).toHaveBeenCalledWith(LIVE);
  });

  it('an exhausted MODERATOR window refuses with RATE_LIMITED; no write, no send', async () => {
    mockActorQuota.mockResolvedValue({ allowed: false, retryAfterSeconds: 1800 });
    const err = await messageAppOwner({ input: input(), moderatorUserId: MOD }).then(
      () => {
        throw new Error('expected a refusal');
      },
      (e) => e as InstanceType<typeof AppModeratorMessageError>
    );
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toContain('1800');
    expect(dbMock.dbWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('an exhausted LISTING window refuses even when the moderator has budget left', async () => {
    mockActorQuota.mockResolvedValue({ allowed: true });
    mockListingQuota.mockResolvedValue({ allowed: false, retryAfterSeconds: 900 });
    const err = await messageAppOwner({ input: input(), moderatorUserId: MOD }).then(
      () => {
        throw new Error('expected a refusal');
      },
      (e) => e as InstanceType<typeof AppModeratorMessageError>
    );
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toContain('900');
    expect(dbMock.dbWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('when BOTH are exhausted the LONGER retry-after is reported', async () => {
    mockActorQuota.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });
    mockListingQuota.mockResolvedValue({ allowed: false, retryAfterSeconds: 3400 });
    await expect(messageAppOwner({ input: input(), moderatorUserId: MOD })).rejects.toMatchObject({
      message: expect.stringContaining('3400'),
    });
  });
});

describe('text validation runs BEFORE the quota is spent', () => {
  it('a blocked link domain refuses with BLOCKED_LINK; no write, no send', async () => {
    mockBlockedLink.mockRejectedValue(new Error('invalid urls: evil.example'));
    const err = await messageAppOwner({ input: input(), moderatorUserId: MOD }).then(
      () => {
        throw new Error('expected a refusal');
      },
      (e) => e as InstanceType<typeof AppModeratorMessageError>
    );
    expect(err.code).toBe('BLOCKED_LINK');
    expect(dbMock.dbWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    // 🔴 The ordering claim, asserted rather than described: a rejected draft must not
    // consume the RECIPIENT's hourly allowance, or a moderator fixing a typo would
    // silently spend the ceiling that protects the developer from being spammed.
    expect(mockListingQuota).not.toHaveBeenCalled();
    expect(mockActorQuota).not.toHaveBeenCalled();
  });

  it('the link scan covers the SUBJECT as well as the body', async () => {
    await messageAppOwner({ input: input(), moderatorUserId: MOD });
    expect(mockBlockedLink).toHaveBeenCalledTimes(1);
    const scanned = mockBlockedLink.mock.calls[0][0] as string;
    expect(scanned).toContain(SUBJECT);
    expect(scanned).toContain(BODY);
  });

  it('a whitespace-only body is refused as INVALID_TEXT despite satisfying the schema min', async () => {
    // ' '.repeat(30) passes `z.string().min(20)` and would arrive as an empty message
    // under a "Civitai moderation sent you a message" push.
    const err = await messageAppOwner({
      input: input({ body: ' '.repeat(30) }),
      moderatorUserId: MOD,
    }).then(
      () => {
        throw new Error('expected a refusal');
      },
      (e) => e as InstanceType<typeof AppModeratorMessageError>
    );
    expect(err.code).toBe('INVALID_TEXT');
    expect(dbMock.dbWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('a whitespace-only subject is refused the same way', async () => {
    await expect(
      messageAppOwner({ input: input({ subject: '   ' }), moderatorUserId: MOD })
    ).rejects.toMatchObject({ code: 'INVALID_TEXT' });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('an over-long body is refused even if a caller skipped the schema', async () => {
    await expect(
      messageAppOwner({ input: input({ body: 'x'.repeat(2001) }), moderatorUserId: MOD })
    ).rejects.toMatchObject({ code: 'INVALID_TEXT' });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('the delivered text is TRIMMED, in the notification and in the audit row alike', async () => {
    await messageAppOwner({
      input: input({ subject: `  ${SUBJECT}  `, body: `\n${BODY}\n` }),
      moderatorUserId: MOD,
    });
    const details = (mockNotify.mock.calls[0][0] as { details: { subject: string; body: string } })
      .details;
    expect(details.subject).toBe(SUBJECT);
    expect(details.body).toBe(BODY);
    const data = dbMock.dbWrite.appListingModerationEvent.create.mock.calls[0][0].data as {
      reason: string;
      detail: string;
    };
    expect(data.reason).toBe(SUBJECT);
    expect(data.detail).toBe(BODY);
  });
});

describe('a missing listing', () => {
  it('refuses with NOT_FOUND before any quota, write or send', async () => {
    dbMock.dbRead.appListing.findUnique.mockResolvedValue(null);
    const err = await messageAppOwner({ input: input(), moderatorUserId: MOD }).then(
      () => {
        throw new Error('expected a refusal');
      },
      (e) => e as InstanceType<typeof AppModeratorMessageError>
    );
    expect(err.code).toBe('NOT_FOUND');
    expect(mockActorQuota).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('the read pool and the write pool are not interchangeable', () => {
  it('the listing is READ on the replica and the audit row WRITTEN on the primary', async () => {
    await messageAppOwner({ input: input(), moderatorUserId: MOD });
    expect(dbMock.dbRead.appListing.findUnique).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.appListing.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.appListingModerationEvent.create).not.toHaveBeenCalled();
  });
});
