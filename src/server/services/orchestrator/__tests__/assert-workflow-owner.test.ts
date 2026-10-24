import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The submit-side half of the identity guard. The property under test is not "it throws"
 * but "a workflow attributed to the wrong account never reaches the caller as a success,
 * and is torn down" — the thing that did not happen for roughly a thousand generations
 * over six hours on 2026-08-30.
 *
 * Ids here are synthetic. The real ones identify named accounts and a real billing
 * outcome, and this repo is public and permanent.
 */

const { mockDeleteWorkflow, mockObserveMismatch, mockObserveUnverifiable } = vi.hoisted(() => ({
  mockDeleteWorkflow: vi.fn(),
  mockObserveMismatch: vi.fn(),
  mockObserveUnverifiable: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/workflows', () => ({
  deleteWorkflow: mockDeleteWorkflow,
}));
vi.mock('~/server/orchestrator/orchestrator-identity-metrics', () => ({
  observeConsumerMismatch: mockObserveMismatch,
  observeConsumerUnverifiable: mockObserveUnverifiable,
}));

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  assertWorkflowOwner,
  workflowOwnerId,
} from '~/server/services/orchestrator/assert-workflow-owner';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

const mockLogToAxiom = loggingMock.logToAxiom;

const TOKEN = 'orchestrator-token';
const SUBMITTER = 1001;
const STRANGER = 2002;
const STRANGERS_WORKFLOW = `${STRANGER}-20260101000000000`;

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteWorkflow.mockResolvedValue(undefined);
  // The guard short-circuits in dev, where every user shares the system token — pin prod so the
  // branch under test is the one that runs.
  setEnv({ ORCHESTRATOR_MODE: 'prod' });
});

describe('assertWorkflowOwner', () => {
  it('passes a workflow the orchestrator attributed to the submitting user', async () => {
    await expect(
      assertWorkflowOwner({ id: `${SUBMITTER}-20260101000000000` }, SUBMITTER, TOKEN)
    ).resolves.toBeUndefined();

    expect(mockDeleteWorkflow).not.toHaveBeenCalled();
    expect(mockObserveMismatch).not.toHaveBeenCalled();
    expect(mockObserveUnverifiable).not.toHaveBeenCalled();
  });

  it('throws AND tears down when the orchestrator attributed it to someone else', async () => {
    await expect(assertWorkflowOwner({ id: STRANGERS_WORKFLOW }, SUBMITTER, TOKEN)).rejects.toThrow(
      /could not confirm who this generation belongs to/i
    );

    expect(mockDeleteWorkflow).toHaveBeenCalledTimes(1);
    // `throwOnError` is the load-bearing argument: without it a non-2xx teardown resolves and the
    // workflow is reported as deleted while it keeps running and keeps billing the wrong account.
    expect(mockDeleteWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: STRANGERS_WORKFLOW,
        token: TOKEN,
        throwOnError: true,
        signal: expect.anything(),
      })
    );
    expect(mockObserveMismatch).toHaveBeenCalledTimes(1);
    expect(mockObserveMismatch).toHaveBeenCalledWith('deleted');
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'orchestrator-consumer-mismatch',
        userId: SUBMITTER,
        ownerId: STRANGER,
        outcome: 'deleted',
      })
    );
  });

  it('reports delete-failed — in the metric AND the log — when the teardown did not happen', async () => {
    mockDeleteWorkflow.mockRejectedValue(new Error('orchestrator refused the delete'));

    await expect(
      assertWorkflowOwner({ id: STRANGERS_WORKFLOW }, SUBMITTER, TOKEN)
    ).rejects.toThrow();

    expect(mockObserveMismatch).toHaveBeenCalledWith('delete-failed');
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'delete-failed' })
    );
  });

  it.each([
    ['an unrecognised id shape', 'workflow-abc'],
    ['a missing id', undefined],
  ])('fails OPEN on %s, and COUNTS it so a dead guard is visible', async (_label, id) => {
    await expect(assertWorkflowOwner({ id }, SUBMITTER, TOKEN)).resolves.toBeUndefined();

    expect(mockDeleteWorkflow).not.toHaveBeenCalled();
    expect(mockObserveMismatch).not.toHaveBeenCalled();
    // Without this the guard going permanently dead is indistinguishable from a healthy system.
    expect(mockObserveUnverifiable).toHaveBeenCalledTimes(1);
  });

  it('short-circuits in dev, where every user legitimately shares the system token', async () => {
    setEnv({ ORCHESTRATOR_MODE: 'dev' });

    await expect(
      assertWorkflowOwner({ id: STRANGERS_WORKFLOW }, SUBMITTER, TOKEN)
    ).resolves.toBeUndefined();

    expect(mockDeleteWorkflow).not.toHaveBeenCalled();
    expect(mockObserveMismatch).not.toHaveBeenCalled();
    expect(mockObserveUnverifiable).not.toHaveBeenCalled();

    resetEnv();
  });
});

describe('workflowOwnerId', () => {
  it('reads the owning userId off the orchestrator workflow id', () => {
    expect(workflowOwnerId('12345-20260101000000000')).toBe(12345);
  });

  it.each([
    ['no prefix at all', 'workflow-abc'],
    ['a non-numeric prefix', 'wf12-20260101000000000'],
    ['an empty id', ''],
    ['undefined', undefined],
    ['null', null],
  ])('fails OPEN on %s — an id shape we do not own must not reject a generation', (_l, id) => {
    expect(workflowOwnerId(id as string | null | undefined)).toBeNull();
  });

  it.each([
    ['hex', '0x10-2026', 16],
    ['exponent', '1e3-2026', 1000],
    ['signed', '+42-2026', 42],
  ])(
    'fails open rather than letting Number() infer an owner from a %s prefix',
    (_label, id, wouldBe) => {
      // Each of these is what `Number(prefix)` returns, i.e. an owner that is NOT the one the id
      // names — a fail-CLOSED-against-the-wrong-user direction. The /^\d+$/ guard is the only
      // thing separating these from the happy path.
      expect(Number(id.split('-')[0])).toBe(wouldBe);
      expect(workflowOwnerId(id)).toBeNull();
    }
  );

  it('fails open rather than truncating a prefix past MAX_SAFE_INTEGER', () => {
    expect(workflowOwnerId('99999999999999999999-2026')).toBeNull();
  });
});
