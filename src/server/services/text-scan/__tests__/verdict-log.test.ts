import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const { clavataVerdict, logScanVerdict, xguardVerdict } = await import(
  '~/server/services/text-scan/verdict-log'
);

beforeEach(() => vi.clearAllMocks());

describe('xguardVerdict', () => {
  const base = { entityType: 'Model', entityId: 1, workflowId: 'wf', hasAdapter: true };

  it('is clean and not acted when nothing triggered', () => {
    expect(xguardVerdict({ ...base, blocked: false, triggeredLabels: [] })).toMatchObject({
      system: 'xguard',
      flagged: false,
      acted: false,
      tags: [],
    });
  });

  it('flags on a triggered label alone, and on a block alone', () => {
    expect(
      xguardVerdict({ ...base, blocked: false, triggeredLabels: ['Suggestive'] })
    ).toMatchObject({ flagged: true, acted: true, blocked: false, tags: ['Suggestive'] });
    expect(xguardVerdict({ ...base, blocked: true, triggeredLabels: [] })).toMatchObject({
      flagged: true,
      blocked: true,
    });
  });

  it('is not acted when no adapter takes the result', () => {
    expect(
      xguardVerdict({ ...base, hasAdapter: false, blocked: true, triggeredLabels: ['x'] }).acted
    ).toBe(false);
  });
});

describe('clavataVerdict', () => {
  const base = { entityType: 'Comment', entityId: 2, matches: ['Spam'] };

  it('logs a clean result as unflagged and not acted', () => {
    expect(clavataVerdict({ ...base, userId: 5, result: 'FALSE', skipped: true })).toMatchObject({
      system: 'clavata',
      flagged: false,
      acted: false,
    });
  });

  it('logs a dropped NSFW-only match as flagged but not acted', () => {
    expect(clavataVerdict({ ...base, userId: 5, result: 'TRUE', skipped: true })).toMatchObject({
      flagged: true,
      acted: false,
    });
  });

  it('logs a reported result as flagged and acted, keeping its tags', () => {
    expect(clavataVerdict({ ...base, userId: 5, result: 'TRUE', skipped: false })).toMatchObject({
      flagged: true,
      acted: true,
      tags: ['Spam'],
      userId: 5,
    });
  });

  it('drops a non-positive user id and defaults missing matches', () => {
    const v = clavataVerdict({
      ...base,
      matches: undefined,
      userId: -1,
      result: 'TRUE',
      skipped: false,
    });
    expect(v.userId).toBeUndefined();
    expect(v.tags).toEqual([]);
  });
});

describe('logScanVerdict', () => {
  it('writes one scan-verdict event with tags as a single string', async () => {
    await logScanVerdict(
      xguardVerdict({
        entityType: 'Model',
        entityId: 1,
        workflowId: 'wf',
        blocked: false,
        triggeredLabels: ['A', 'B'],
        hasAdapter: true,
      })
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'scan-verdict', system: 'xguard', tags: 'A,B' })
    );
  });

  it('never throws when the log write fails', async () => {
    vi.mocked(loggingMock.logToAxiom).mockRejectedValueOnce(new Error('axiom down'));
    await expect(
      logScanVerdict({
        system: 'text-scan',
        entityType: 'Post',
        entityId: 1,
        flagged: false,
        acted: false,
      })
    ).resolves.toBeUndefined();
  });
});
