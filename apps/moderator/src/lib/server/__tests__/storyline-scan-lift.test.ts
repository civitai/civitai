import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The spoke's half of lifting a title-scan takedown: it asks the main app, and records the
 * moderator's activity only for a lift the main app made.
 */

const { callModEndpoint, recordModActivity } = vi.hoisted(() => ({
  callModEndpoint: vi.fn(),
  recordModActivity: vi.fn(),
}));

vi.mock('../mod-activity', () => ({ recordModActivity }));
vi.mock('../user-actions.service', () => ({ callModEndpoint }));

const { liftStorylineScanTakedown } = await import('../storyline-scan-lift.service');

const lift = () =>
  liftStorylineScanTakedown({ storylineId: 10, reviewedTitle: 'The title I read', moderatorId: 7 });

beforeEach(() => vi.clearAllMocks());

describe('liftStorylineScanTakedown', () => {
  it('asks the main app to lift for the reviewed title, and records the lift', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { storylineId: 10, tosViolation: false } });

    expect(await lift()).toEqual({ ok: true, tosViolation: false });
    expect(callModEndpoint).toHaveBeenCalledExactlyOnceWith(
      'storyline/lift-title-takedown',
      { storylineId: 10, reviewedTitle: 'The title I read' },
      'Lift takedown'
    );
    expect(recordModActivity.mock.calls).toEqual([
      [{ userId: 7, entityType: 'storyline', entityId: 10, activity: 'lift' }],
    ]);
  });

  it("reports a storyline a moderator's takedown keeps down", async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { storylineId: 10, tosViolation: true } });
    expect(await lift()).toEqual({ ok: true, tosViolation: true });
  });

  // A timeout told as a refusal reads as "not lifted", and a retry is then refused as not scan-held.
  it.each([
    ['a timeout', { ok: false, error: 'Lift takedown failed.', requestNeverSent: false }],
    ['a server error', { ok: false, error: 'Lift takedown returned 502.', status: 502 }],
  ])('says the lift may have gone through after %s', async (_label, outcome) => {
    callModEndpoint.mockResolvedValue(outcome);

    const result = await lift();

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/may have gone through/) });
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('passes on a refusal and records nothing', async () => {
    callModEndpoint.mockResolvedValue({
      ok: false,
      error: 'Lift takedown: The title has changed since it was reviewed',
      status: 400,
      reason: 'The title has changed since it was reviewed',
    });

    expect(await lift()).toEqual({
      ok: false,
      error: 'Lift takedown: The title has changed since it was reviewed',
    });
    expect(recordModActivity).not.toHaveBeenCalled();
  });
});
