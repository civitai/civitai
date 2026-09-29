import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PrivateRunAccessModule from '../private-run-access.service';
import type { SessionUser } from '~/types/session';

/**
 * 🔴 DOES A PRIVATE-RUN MOUNT STOP PRODUCING AN OWNER-VISIBLE IMPRESSION — AND DOES AN
 * ORDINARY VIEWER'S MOUNT STILL PRODUCE ONE?
 *
 * Both, in pairs, because the two failure directions are not symmetric in cost:
 *   · UNDER-filtering leaks review activity into the owner's `views.count` and, per
 *     `userId`, into `views.uniqueViewers`. That is the bug; it is at least visible.
 *   · OVER-filtering silently deletes the owner's REAL impressions. Worse — nobody
 *     reports numbers they never saw, and `blockRenders` has no status column, so a
 *     dropped row leaves no trace anywhere.
 * So every suppression case here is paired with a case that must NOT be suppressed, and
 * the un-suppressed half is the positive control without which the suppression is
 * indistinguishable from a gate wired to `true`.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT TEST ────────────────────────────────
 * That the WRITERS call this gate, and that they agree. A structural claim plus a
 * behavioural one, both in
 * `src/tests/api/track/block-render.private-run.test.ts` and
 * `block-render-writer.call-site-ledger.test.ts`. This file is the decision only.
 *
 * ── THE COST CLAIMS ARE ASSERTIONS HERE, NOT PROSE ───────────────────────────
 * The gate sits on a high-volume fire-and-forget beacon, so its ordering is a design
 * property rather than a detail: each cheap gate must SHORT-CIRCUIT the expensive ones.
 * Three cases below assert that by counting calls to the mocks that come after them —
 * an ordering regression is then a red test, not a latency mystery.
 */

const { mockKnown, mockFlag, mockAccess } = vi.hoisted(() => ({
  mockKnown: { isConfirmedNonApprovedAppBlockId: vi.fn() },
  mockFlag: { isAppBlocksPrivateRunEnabled: vi.fn() },
  mockAccess: { resolvePrivateRunAccess: vi.fn() },
}));

vi.mock('~/server/services/blocks/known-app-blocks.service', () => mockKnown);
vi.mock('~/server/services/app-blocks-flag', () => mockFlag);
// `importOriginal` so the REAL `PRIVATE_RUN_REFUSAL_REASONS` tuple is still exported —
// the completeness case below derives its rows from it, and a hand-copied list would
// stay green when a ninth reason is added with no coverage.
vi.mock('~/server/services/blocks/private-run-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PrivateRunAccessModule>()),
  resolvePrivateRunAccess: mockAccess.resolvePrivateRunAccess,
}));

// The CANONICAL logging mock — `~/server/logging/client` has one, so a per-file
// registration of it is a `no-direct-shared-module-mock` failure.
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { PRIVATE_RUN_REFUSAL_REASONS } from '../private-run-access.service';
import { isPrivateRunImpression } from '../private-run-impression.service';

/** A delisted app's id. Distinct from every other constant so a mutant cannot coincide. */
const DELISTED_APP = 'apb_delisted_fixture';
/** A live, approved app's id. */
const APPROVED_APP = 'apb_approved_fixture';

const OWNER = { id: 8801, isModerator: false } as unknown as SessionUser;
const MODERATOR = { id: 8802, isModerator: true } as unknown as SessionUser;
const STRANGER = { id: 8803, isModerator: false } as unknown as SessionUser;

/** The grant shape the gate reads. Only `allowed` is load-bearing to it. */
function grant(audience: 'owner' | 'editor' | 'moderator') {
  return { allowed: true, audience, block: { appBlockId: DELISTED_APP } };
}
function refuse(reason: (typeof PRIVATE_RUN_REFUSAL_REASONS)[number]) {
  return { allowed: false, reason };
}

/** The default world: a signed-in viewer, a non-approved app, the flag on. */
function armed() {
  mockKnown.isConfirmedNonApprovedAppBlockId.mockResolvedValue(true);
  mockFlag.isAppBlocksPrivateRunEnabled.mockResolvedValue(true);
}

describe('isPrivateRunImpression — instrument validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSITIVE CONTROL: the gate can return TRUE, and it reaches the predicate to do it', async () => {
    // Without this, every `toBe(false)` below is indistinguishable from a gate that can
    // only ever answer false — e.g. one whose first line is `return false`.
    armed();
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('moderator'));

    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      true
    );
    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE CONTROL: with the same world, a refusal answers FALSE', async () => {
    // The pair for the above: the gate reads the predicate's ANSWER rather than the fact
    // that it was asked.
    armed();
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(refuse('no-role'));

    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: STRANGER })).toBe(
      false
    );
    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledTimes(1);
  });
});

describe('isPrivateRunImpression — a private run is not an impression [REG]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armed();
  });

  for (const audience of ['owner', 'editor', 'moderator'] as const) {
    it(`suppresses the impression for the ${audience} audience`, async () => {
      mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant(audience));
      expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: OWNER })).toBe(true);
    });
  }

  it('threads the SERVER-RESOLVED viewer and the resolved flag into the predicate', async () => {
    // 🔴 THE ARGUMENTS, NOT JUST THE CALL. A structural ledger type-checks past a wrong
    // argument: passing the flag as a hardcoded `true`, or a slug where an appBlockId
    // belongs, or `undefined` for the viewer, would all still "call the predicate".
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('owner'));
    await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: OWNER });

    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledWith({
      by: { appBlockId: DELISTED_APP },
      viewer: OWNER,
      db: 'read',
      privateRunEnabled: true,
    });
    // And the flag is evaluated FOR THIS VIEWER — a global eval would return the flag's
    // BASE value, which is a measured property of this repo's Flipt client and would
    // make the gate answer for the wrong subject.
    expect(mockFlag.isAppBlocksPrivateRunEnabled).toHaveBeenCalledWith({ user: OWNER });
  });
});

describe('isPrivateRunImpression — an ordinary impression survives [INV]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armed();
  });

  it('EVERY refusal reason records the impression, swept over the real tuple', async () => {
    // A refusal means "this mount is not a private run", so the row is real.
    //
    // ⚠️ THIS USED TO CLAIM "a ninth reason added without considering this gate fails
    // HERE". IT CANNOT, and the correction matters more than the sweep does. The gate
    // reads `access.allowed === true` — ONE branch for every reason — so adding a tenth
    // member adds one more PASSING iteration and no mutation of "add a reason" can turn
    // this red. The loop is nine copies of one assertion; it is kept because sweeping the
    // real tuple costs nothing and documents the polarity, not because it is a
    // completeness guard. A guard whose description claims coverage it does not provide
    // is worse than none.
    //
    // The line below IS a working control, and it is the reason the tuple is imported at
    // all: if the `importOriginal` spread ever produced a mocked or empty module, `.length`
    // is `undefined`/`0` and this goes red BEFORE the loop can pass vacuously.
    expect(PRIVATE_RUN_REFUSAL_REASONS.length).toBeGreaterThan(5);
    for (const reason of PRIVATE_RUN_REFUSAL_REASONS) {
      mockAccess.resolvePrivateRunAccess.mockResolvedValue(refuse(reason));
      expect(
        await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: STRANGER }),
        `refusal \`${reason}\` must still record the impression`
      ).toBe(false);
    }
  });

  it('records an ANONYMOUS viewer, and pays nothing to decide it', async () => {
    // Signed-out viewers are the bulk of public impressions and can never privately run.
    // The call counts are the cost claim: gate 1 is free.
    for (const viewer of [undefined, null]) {
      expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer })).toBe(false);
    }
    expect(mockKnown.isConfirmedNonApprovedAppBlockId).not.toHaveBeenCalled();
    expect(mockFlag.isAppBlocksPrivateRunEnabled).not.toHaveBeenCalled();
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
  });

  it('records a session carrying no numeric id', async () => {
    const malformed = { id: undefined } as unknown as SessionUser;
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: malformed })).toBe(
      false
    );
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
  });

  it('🔴 records an APPROVED app without evaluating the flag or the predicate', async () => {
    // The over-filtering bound, and the cost claim, in one case: a publicly mountable app
    // can never be hidden, and the common beacon path stops at a cached set lookup.
    mockKnown.isConfirmedNonApprovedAppBlockId.mockResolvedValue(false);
    // Armed to SUPPRESS if it got that far — so this case fails loudly if the
    // short-circuit is removed rather than passing for the wrong reason.
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('owner'));

    expect(await isPrivateRunImpression({ appBlockId: APPROVED_APP, viewer: OWNER })).toBe(false);
    expect(mockFlag.isAppBlocksPrivateRunEnabled).not.toHaveBeenCalled();
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
  });

  it('🔴 records everything while the FLAG IS OFF, and touches no database', async () => {
    // The kill-switch is a complete rollback: flag off restores the pre-feature
    // behaviour exactly, and costs no query to do it.
    mockFlag.isAppBlocksPrivateRunEnabled.mockResolvedValue(false);
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('moderator'));

    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      false
    );
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
    // 🔴 AND THE CHEAP GATE RAN FIRST. Without this the case pins "4 unreached" but says
    // nothing about 2 PRECEDING 3 — a reordering that put the flag eval ahead of the
    // cached set lookup would keep this green while making every signed-in beacon pay the
    // more expensive of the two. The ordering IS the cost claim, so it is asserted.
    expect(mockKnown.isConfirmedNonApprovedAppBlockId).toHaveBeenCalled();
  });
});

describe('isPrivateRunImpression — failures fail TOWARD recording [INV]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armed();
  });

  it('records the impression when the predicate THROWS — and SAYS SO', async () => {
    mockAccess.resolvePrivateRunAccess.mockRejectedValue(new Error('replica unreachable'));
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      false
    );
    // 🔴 A gate that fails open without a trace means the leak is reopened and nothing
    // says so. The log is what makes the fail-open observable rather than reassuring.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'private-run-impression-gate-failed', type: 'error' }),
      'clickhouse'
    );
  });

  it('NEGATIVE CONTROL: a clean decision logs NOTHING', async () => {
    // Without this, the assertion above is satisfied by a gate that logs on every call —
    // which would flood the beacon path and make the signal worthless.
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('moderator'));
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      true
    );
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('🔴 the fail-open log carries the error CLASS, never the error MESSAGE', async () => {
    // The identifiers belong in the mint's audit line. This is a health signal, and a
    // per-impression health signal that carries identifiers is a second, unreviewed audit
    // trail on a public write path.
    //
    // 🔴 THE MESSAGE IS THE LEAK VECTOR, AND A "no user id" SWEEP DOES NOT CATCH IT. The
    // gate logged `err.message` under a comment promising no user id, and a
    // `PrismaClientValidationError` renders the failing invocation INCLUDING ITS
    // ARGUMENTS — the call inside the try being `user.findUnique({ where: { id:
    // <viewer.id> } })`. A fixture whose error text happens to be clean (`'boom'`) sweeps
    // green over exactly that defect, which is why this pins the SHAPE — class in, message
    // out — instead of grepping the output for today's ids.
    const secret = `prisma-arg-${MODERATOR.id}-${DELISTED_APP}`;
    const err = new TypeError(secret);
    mockAccess.resolvePrivateRunAccess.mockRejectedValue(err);
    await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR });

    const [payload] = loggingMock.logToAxiom.mock.calls[0] as [Record<string, unknown>];
    expect(payload.errorClass, 'the class is what a health signal needs').toBe('TypeError');
    const serialised = JSON.stringify(payload);
    expect(serialised, 'no message text may reach the log').not.toContain(secret);
    expect(serialised).not.toContain(DELISTED_APP);
    expect(serialised).not.toContain(String(MODERATOR.id));
  });

  it('records the impression when the FLAG CLIENT throws', async () => {
    mockFlag.isAppBlocksPrivateRunEnabled.mockRejectedValue(new Error('flipt down'));
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: MODERATOR })).toBe(
      false
    );
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
  });

  it('records the impression when the APPROVED-SET lookup throws', async () => {
    mockKnown.isConfirmedNonApprovedAppBlockId.mockRejectedValue(new Error('db down'));
    mockAccess.resolvePrivateRunAccess.mockResolvedValue(grant('owner'));
    expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: OWNER })).toBe(false);
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
  });

  it('records the impression when the predicate answers a SHAPE it should not', async () => {
    // `allowed === true` is required, not `allowed` truthiness — a future refactor that
    // returns a string, or omits the field, must not be read as a grant.
    for (const weird of [{}, { allowed: 'yes' }, { allowed: 1 }, undefined]) {
      mockAccess.resolvePrivateRunAccess.mockResolvedValue(weird);
      expect(await isPrivateRunImpression({ appBlockId: DELISTED_APP, viewer: OWNER })).toBe(false);
    }
  });
});
