import { beforeEach, describe, expect, it, vi } from 'vitest';

const escalateExpired = vi.hoisted(() => vi.fn());
const applyPendingResolutions = vi.hoisted(() => vi.fn());
const settleFinalItems = vi.hoisted(() => vi.fn());
const expireSmites = vi.hoisted(() => vi.fn());
const settleHiddenChecks = vi.hoisted(() => vi.fn());
const resetPendingPlayers = vi.hoisted(() => vi.fn());
const retryPendingConversions = vi.hoisted(() => vi.fn());
const runLabelPass = vi.hoisted(() => vi.fn());
const closeStrandedYesNo = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
const logToAxiom = vi.hoisted(() => vi.fn());
const buzzConfigured = vi.hoisted(() => vi.fn());
const conversionEnabled = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/axiom', () => ({ logToAxiom }));
vi.mock('$lib/server/conversion/runtime', () => ({
  getBuzzPort: () => ({}),
  buzzConfigured,
  conversionEnabled,
}));
vi.mock('$lib/server/conversion/convert', () => ({ retryPendingConversions }));
vi.mock('$lib/server/conversion/label-pass', () => ({ runLabelPass }));
vi.mock('$lib/server/yesno/sweep', () => ({ closeStrandedYesNo }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => ({ maxAgeDays: 14 }) }));
vi.mock('$lib/server/jobs-auth', () => ({ isJobRequest: () => true }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: { mirrorXp: undefined } }));
vi.mock('$lib/server/progression/progression', () => ({ settleFinalItems }));
vi.mock('$lib/server/smites/runtime', () => ({ resetDeps: {} }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({}) }));
vi.mock('$lib/server/hidden/settle', () => ({ settleHiddenChecks }));
vi.mock('$lib/server/smites/smites.service', () => ({ expireSmites, resetPendingPlayers }));
vi.mock('$lib/server/queue/queue.service', () => ({ escalateExpired, applyPendingResolutions }));

const { POST } = await import('./+server');

const run = () =>
  POST({
    request: new Request('http://knights.test/api/jobs/tick', { method: 'POST' }),
  } as never);

beforeEach(() => {
  escalateExpired.mockReset();
  applyPendingResolutions.mockReset();
  settleFinalItems.mockReset();
  settleFinalItems.mockResolvedValue({ items: 0, votes: 0, failed: 0 });
  settleHiddenChecks.mockReset();
  settleHiddenChecks.mockResolvedValue({ graded: 0, failed: 0, resets: 0 });
  expireSmites.mockReset();
  expireSmites.mockResolvedValue(0);
  resetPendingPlayers.mockReset();
  resetPendingPlayers.mockResolvedValue({ due: 0, failed: 0 });
  logToAxiom.mockReset();
  buzzConfigured.mockReset();
  buzzConfigured.mockReturnValue(true);
  conversionEnabled.mockReset();
  conversionEnabled.mockReturnValue(true);
  retryPendingConversions.mockReset();
  retryPendingConversions.mockResolvedValue({ retried: 0, paid: 0, failed: 0 });
  closeStrandedYesNo.mockReset();
  closeStrandedYesNo.mockResolvedValue({ unplayable: 0, stale: 0, failed: 0 });
  runLabelPass.mockReset();
  runLabelPass.mockResolvedValue({ done: true, labelsWritten: 0, labelFailures: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('POST /api/jobs/tick', () => {
  it('reports both steps when both succeed', async () => {
    escalateExpired.mockResolvedValue({ escalated: 2 });
    applyPendingResolutions.mockResolvedValue({ applied: 1 });

    const response = await run();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      escalated: 2,
      applied: 1,
      settledVotes: 0,
      hiddenChecksGraded: 0,
      yesNoClosed: 0,
      expiredSmites: 0,
      resets: 0,
      conversionsRetried: 0,
      labels: { done: true, labelsWritten: 0, labelFailures: 0 },
    });
  });

  it('writes labels and retries unconfirmed conversions even when an earlier step failed', async () => {
    escalateExpired.mockRejectedValue(new Error('db down'));
    applyPendingResolutions.mockResolvedValue({ applied: 0 });

    const response = await run();

    expect(retryPendingConversions).toHaveBeenCalled();
    expect(runLabelPass).toHaveBeenCalled();
    expect(response.status).toBe(500);
  });

  it('bounds the conversion retries by count and time', async () => {
    escalateExpired.mockResolvedValue({ escalated: 0 });
    applyPendingResolutions.mockResolvedValue({ applied: 0 });

    await run();

    expect(retryPendingConversions).toHaveBeenCalledWith(
      {},
      {},
      expect.objectContaining({ limit: expect.any(Number), budgetMs: expect.any(Number) })
    );
  });

  it('skips the conversion retries without a warning while conversion is switched off, and still writes labels', async () => {
    conversionEnabled.mockReturnValue(false);
    escalateExpired.mockResolvedValue({ escalated: 0 });
    applyPendingResolutions.mockResolvedValue({ applied: 0 });

    const response = await run();

    expect(response.status).toBe(200);
    expect(retryPendingConversions).not.toHaveBeenCalled();
    expect(logToAxiom).not.toHaveBeenCalled();
    expect(runLabelPass).toHaveBeenCalled();
  });

  it('skips the conversion retries with a warning when Buzz is not configured, and still answers 200', async () => {
    buzzConfigured.mockReturnValue(false);
    escalateExpired.mockResolvedValue({ escalated: 1 });
    applyPendingResolutions.mockResolvedValue({ applied: 0 });

    const response = await run();

    expect(response.status).toBe(200);
    expect(retryPendingConversions).not.toHaveBeenCalled();
    expect(runLabelPass).toHaveBeenCalled();
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', name: 'knights-conversion-retries-skipped' })
    );
  });

  it('answers 500 when the label pass fails', async () => {
    escalateExpired.mockResolvedValue({ escalated: 0 });
    applyPendingResolutions.mockResolvedValue({ applied: 0 });
    runLabelPass.mockRejectedValue(new Error('label store down'));

    expect((await run()).status).toBe(500);
  });

  it('still writes back settled ratings when the escalation fails, then answers 500', async () => {
    escalateExpired.mockRejectedValue(new Error('db down'));
    applyPendingResolutions.mockResolvedValue({ applied: 1 });

    const response = await run();

    expect(applyPendingResolutions).toHaveBeenCalled();
    expect(response.status).toBe(500);
  });

  it('still escalates when the write-back fails, then answers 500', async () => {
    escalateExpired.mockResolvedValue({ escalated: 2 });
    applyPendingResolutions.mockRejectedValue(new Error('main app down'));

    const response = await run();

    expect(escalateExpired).toHaveBeenCalled();
    expect(response.status).toBe(500);
  });

  it('pays out settled votes after the write-back, even when that failed, and answers 500 if the payout fails', async () => {
    escalateExpired.mockResolvedValue({ escalated: 0 });
    applyPendingResolutions.mockRejectedValue(new Error('main app down'));
    settleFinalItems.mockRejectedValue(new Error('db down'));

    const response = await run();

    expect(settleFinalItems).toHaveBeenCalled();
    expect(response.status).toBe(500);
  });

  it('answers 500 when an item could not be paid out, after sweeping the rest', async () => {
    escalateExpired.mockResolvedValue({ escalated: 0 });
    applyPendingResolutions.mockResolvedValue({ applied: 0 });
    settleFinalItems.mockResolvedValue({ items: 2, votes: 1, failed: 1 });

    expect((await run()).status).toBe(500);
  });

  it('retries career resets, and answers 500 while one still cannot be done', async () => {
    escalateExpired.mockResolvedValue({ escalated: 0 });
    applyPendingResolutions.mockResolvedValue({ applied: 0 });
    resetPendingPlayers.mockResolvedValue({ due: 1, failed: 1 });

    const response = await run();

    expect(resetPendingPlayers).toHaveBeenCalled();
    expect(response.status).toBe(500);
  });

  it('answers 500 when grading hidden checks fails, after running the other steps', async () => {
    escalateExpired.mockResolvedValue({ escalated: 0 });
    applyPendingResolutions.mockResolvedValue({ applied: 0 });
    settleHiddenChecks.mockRejectedValue(new Error('db down'));

    const response = await run();

    expect(resetPendingPlayers).toHaveBeenCalled();
    expect(expireSmites).toHaveBeenCalled();
    expect(response.status).toBe(500);
  });

  it('retries resets before it expires smites', async () => {
    escalateExpired.mockResolvedValue({ escalated: 0 });
    applyPendingResolutions.mockResolvedValue({ applied: 0 });
    await run();
    expect(resetPendingPlayers.mock.invocationCallOrder[0]).toBeLessThan(
      expireSmites.mock.invocationCallOrder[0]
    );
  });

  it('sweeps stranded yes/no questions with the configured age, reports them, and fails the tick when one cannot be closed', async () => {
    escalateExpired.mockResolvedValue({ escalated: 0 });
    applyPendingResolutions.mockResolvedValue({ applied: 0 });
    closeStrandedYesNo.mockResolvedValue({ unplayable: 2, stale: 1, failed: 0 });
    const ok = await run();
    expect(closeStrandedYesNo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ now: expect.any(Date), maxAgeDays: 14 })
    );
    expect(await ok.json()).toMatchObject({ yesNoClosed: 3 });

    closeStrandedYesNo.mockResolvedValue({ unplayable: 0, stale: 0, failed: 1 });
    expect((await run()).status).toBe(500);
  });
});
