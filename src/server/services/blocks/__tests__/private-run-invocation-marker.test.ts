import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE BEHAVIOURAL HALF of the private-run audit marker: what `recordScopeInvocation`
 * actually writes.
 *
 * Its sibling `src/server/services/__tests__/no-unmarked-private-run-invocation.test.ts` is
 * STRUCTURAL — it can see a MISSING call site but type-checks past a wrong VALUE. This file
 * is the converse: it pins the value and is blind to a call site nobody wired. Neither is
 * sufficient alone.
 *
 * 🔴 THE TWO FAILURE DIRECTIONS, AND THE SECOND ONE IS THE QUIET ONE.
 *   · UNDER-marking → a moderator's review run appears in the delisted app owner's
 *     analytics, which tells a bad actor exactly when review is happening. That is the bug.
 *   · OVER-marking → an ordinary user's row is marked private-run and VANISHES from the
 *     owner's own dashboard. That is worse, because nobody reports numbers they never saw.
 * Every case below asserts one direction or the other, and the ordinary-row cases are not
 * decoration: they are the control that makes the marked-row cases mean something.
 */

// 🔴 THE CANONICAL SHARED MOCKS, not a hand-rolled `vi.mock` of the same specifiers. A
// per-file mock of `~/server/db/client` freezes this file's mock shape into every later file
// in the same worker under `--no-isolate`; `no-direct-shared-module-mock` enforces it, and
// PR 1's own review found exactly this defect in the sibling suite next door.
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

import { recordScopeInvocation } from '~/server/services/blocks/user-app-surface.service';
import { PRIVATE_RUN_INVOCATION_SOURCE } from '~/server/services/blocks/scope-activity-predicate';

const mockCreate = dbMock.dbWrite.blockScopeInvocation.create;
const mockLog = loggingMock.logToAxiom;

/**
 * A single ordinary block-token invocation. Every id is pairwise distinct and distinct from
 * every constant the assertions name, so a mutant that hardcodes one of them moves the
 * output instead of coincidentally matching it.
 */
const ORDINARY = {
  userId: 90210,
  appBlockId: 'apb_marker_fixture',
  blockInstanceId: 'bki_marker_fixture',
  scope: 'apps:storage:read',
  endpoint: '/api/v1/blocks/app-storage/get',
  statusCode: 200,
} as const;

/** The `data` object handed to Prisma by the Nth (default: only) create call. */
const writtenData = (n = 0) => mockCreate.mock.calls[n][0].data;

describe('recordScopeInvocation — the private-run audit marker', () => {
  beforeEach(() => {
    // 🔴 `mockClear`, PER TEST, AND IT IS LOAD-BEARING. `resetSharedMocks()` runs once per
    // FILE, so call history ACCUMULATES between cases here — without this, `writtenData()`
    // reads call 0 of the whole file (the marked row from the first case) and every
    // ordinary-row control below passes or fails for a reason unrelated to the code. It
    // silently inverted three of them on the first run. `mockClear` rather than `mockReset`:
    // reset would wipe the shared node's registered default, which only the setup file
    // re-applies.
    mockCreate.mockClear();
    mockLog.mockClear();
    mockCreate.mockResolvedValue({});
    mockLog.mockResolvedValue(undefined);
  });

  it('marks the row when the verified claim is true', async () => {
    await recordScopeInvocation({ ...ORDINARY, privateRun: true });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // 🔴 THE LITERAL FIRST, THEN THE CONSTANT, AND THE ORDER IS THE POINT. Asserting only
    // against the imported constant is VACUOUS when the constant is absent: a base-ref run
    // with the predicate module reverted made both sides `undefined` and this case passed
    // green over a writer that marked nothing. Measured, not hypothesised. The literal is
    // what makes the case non-vacuous; the constant is what pins writer/reader agreement.
    expect(writtenData().source).toBe('private-run');
    expect(writtenData().source).toBe(PRIVATE_RUN_INVOCATION_SOURCE);
    // The row is otherwise UNCHANGED — the marker must not become a second synthetic-id
    // mechanism. The real app id is what keeps per-app storage, ban revocation and every
    // runtime metric label working, and it is also why the read filter is needed at all.
    expect(writtenData().appBlockId).toBe(ORDINARY.appBlockId);
    expect(writtenData().userId).toBe(ORDINARY.userId);
    expect(writtenData().blockInstanceId).toBe(ORDINARY.blockInstanceId);
  });

  /**
   * 🔴 THE POSITIVE CONTROL FOR THE WHOLE FILE. Marked-row assertions are indistinguishable
   * from a writer that marks EVERYTHING until an ordinary row is shown to come through
   * unmarked. `toHaveBeenCalledWith` is an EXACT match, deliberately: it fails if the
   * marker adds any key at all, which is the property the read filters depend on (an
   * ordinary row must be byte-identical to what this writer produced before the marker
   * existed, so `source` falls to the DB DEFAULT).
   */
  it.each([
    ['the claim is absent', {}],
    ['the claim is explicitly false', { privateRun: false }],
    ['the claim is undefined', { privateRun: undefined }],
  ])('writes a byte-identical ORDINARY row when %s', async (_label, extra) => {
    await recordScopeInvocation({ ...ORDINARY, ...extra });
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        userId: ORDINARY.userId,
        appBlockId: ORDINARY.appBlockId,
        blockInstanceId: ORDINARY.blockInstanceId,
        scope: ORDINARY.scope,
        endpoint: ORDINARY.endpoint,
        statusCode: ORDINARY.statusCode,
      },
    });
    expect(writtenData().source).toBeUndefined();
  });

  it('a non-boolean claim value fails toward the ORDINARY row, not toward suppression', async () => {
    // 🔴 ABSENT OR GARBAGE MUST MEAN "AN ORDINARY ROW". The token verifier rejects a
    // non-boolean `privateRun` outright, so this is belt-and-braces — but the mirror
    // failure (a truthy non-boolean marking the row) would delete an owner's real usage
    // data, so the comparison is pinned rather than left to the boundary two files away.
    await recordScopeInvocation({
      ...ORDINARY,
      privateRun: 'true' as unknown as boolean,
    });
    expect(writtenData().source).toBeUndefined();
  });

  it('the marker WINS over an explicitly-passed source', async () => {
    // The two are disjoint in production (an external-OAuth token cannot carry a
    // block-token claim), so this pins the resolution of a case that should never arise.
    // Private-run wins because the cost of getting it wrong that way is a row missing from
    // an aggregate it was never in; the reverse cost is the leak.
    await recordScopeInvocation({
      ...ORDINARY,
      source: 'external-oauth',
      privateRun: true,
    });
    // Literal as well as constant — see the first case for why the constant alone is
    // vacuous when the constant is absent.
    expect(writtenData().source).toBe('private-run');
    expect(writtenData().source).toBe(PRIVATE_RUN_INVOCATION_SOURCE);
  });

  it('an ordinary external-oauth row is untouched by the marker path', async () => {
    // The control for the case above: with no claim, `source` is passed through verbatim.
    await recordScopeInvocation({
      userId: ORDINARY.userId,
      oauthClientId: 'appblk_marker_fixture',
      scope: 'ModelsRead',
      endpoint: 'model.getById',
      statusCode: 200,
      source: 'external-oauth',
    });
    expect(writtenData().source).toBe('external-oauth');
  });

  it('the marker survives onto the synthetic-appBlockId retry row', async () => {
    // 🔴 THE SECOND WRITE PATH, which had no `source` key at all before this change. It is
    // unreachable for a private run today (the verifier refuses the `privateRun` + `dev`
    // pair, and this branch is gated on `dev`), and it is covered anyway so the marker's
    // correctness does not DEPEND on that refusal holding in another file.
    const fkError = Object.assign(new Error('fk'), { code: 'P2003' });
    mockCreate
      .mockRejectedValueOnce(fkError)
      .mockResolvedValueOnce({});
    await recordScopeInvocation({
      ...ORDINARY,
      appBlockId: 'ephemeral-marker-fixture',
      dev: true,
      privateRun: true,
    });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const retry = writtenData(1);
    expect(retry.appBlockId).toBeNull();
    expect(retry.syntheticAppId).toBe('ephemeral-marker-fixture');
    expect(retry.source).toBe('private-run');
    expect(retry.source).toBe(PRIVATE_RUN_INVOCATION_SOURCE);
  });

  it('the retry row stays byte-identical for an ORDINARY dev token', async () => {
    // The control for the case above — the retry path must not have gained a key on the
    // path that actually runs in production.
    const fkError = Object.assign(new Error('fk'), { code: 'P2003' });
    mockCreate
      .mockRejectedValueOnce(fkError)
      .mockResolvedValueOnce({});
    await recordScopeInvocation({
      ...ORDINARY,
      appBlockId: 'ephemeral-marker-fixture',
      dev: true,
    });
    expect(writtenData(1).source).toBeUndefined();
  });

  it('a marked write that fails is still swallowed, and still logged', async () => {
    // The audit pipeline must never affect a response that has already shipped — the
    // marker must not change that.
    mockCreate.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordScopeInvocation({ ...ORDINARY, privateRun: true })
    ).resolves.toBeUndefined();
    expect(mockLog).toHaveBeenCalledTimes(1);
  });

  it('the marker value is the one the readers exclude, and is not one of the existing two', () => {
    // 🔴 A WRITER AND A FILTER THAT DISAGREE BOTH LOOK CORRECT. Both sides import this
    // constant, so this pins the value itself: it must be distinct from both live `source`
    // values, or the filter would drop an existing population wholesale.
    expect(PRIVATE_RUN_INVOCATION_SOURCE).toBe('private-run');
    expect(PRIVATE_RUN_INVOCATION_SOURCE).not.toBe('app-block');
    expect(PRIVATE_RUN_INVOCATION_SOURCE).not.toBe('external-oauth');
  });
});
