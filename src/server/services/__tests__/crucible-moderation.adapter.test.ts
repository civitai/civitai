import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { XGuardModerationOutput } from '@civitai/client';
import { dbMock, loggingMock } from '~/__tests__/mocks';
import { NsfwLevel } from '~/server/common/enums';
import type * as CrucibleService from '~/server/services/crucible.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as TextModerationService from '~/server/services/text-moderation.service';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as SubmitModule from '~/server/services/text-scan/submit';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

const { cancelCrucible, createNotification, submitTextModeration } = vi.hoisted(() => ({
  cancelCrucible: vi.fn(),
  createNotification: vi.fn(),
  submitTextModeration: vi.fn(),
}));

vi.mock('~/server/services/crucible.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleService>()),
  cancelCrucible,
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));
vi.mock('~/server/services/text-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TextModerationService>()),
  submitTextModeration,
}));

vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'off'),
}));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof SubmitModule>()),
  scanEntity: vi.fn(),
}));

const { crucibleModerationAdapter } = await import('~/server/services/crucible-moderation.adapter');
const { applyCrucibleNsfwEscalation } = await import('~/server/services/crucible-nsfw-escalation');
const { applyCrucibleTextScan } = await import('~/server/services/text-scan/actions/crucible');
const { scanCrucible } = await import('~/server/services/crucible.service');
const { getTextScanMode } = await import('~/server/services/text-scan/mode');
const { scanEntity } = await import('~/server/services/text-scan/submit');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');

const findMany = dbMock.dbRead.crucible.findMany;
const findUnique = dbMock.dbRead.crucible.findUnique;
const findForEscalation = dbMock.dbWrite.crucible.findUnique;
const update = dbMock.dbWrite.crucible.update;
const updateMany = dbMock.dbWrite.crucible.updateMany;
const logToAxiom = loggingMock.logToAxiom;

const ID = 42;
const CREATOR = 7;
const HOUR = 60 * 60 * 1000;
const SFW = NsfwLevel.PG | NsfwLevel.PG13;

const crucible = (overrides: Record<string, unknown> = {}) => ({
  userId: CREATOR,
  nsfwLevel: SFW,
  buzzType: 'green',
  status: CrucibleStatus.Pending,
  endAt: null,
  textNsfw: false,
  ...overrides,
});

// 0.6 sits above the challenge bar (0.5) and below the registry's 0.75, so a verdict driven by it
// proves the challenge threshold is the one applied.
const output = (score: number) =>
  ({
    blocked: false,
    triggeredLabels: [],
    results: [{ label: 'explicit', score, threshold: 0.75, topToken: 'yes' }],
  } as unknown as XGuardModerationOutput);

const scan = (score: number) =>
  crucibleModerationAdapter.applyResult!({
    entityId: ID,
    workflowId: 'wf-1',
    blocked: false,
    triggeredLabels: [],
    output: output(score),
  });

const scanNsfw = () => scan(0.6);

const blockedWrite = {
  where: { id: ID },
  data: { ingestion: 'Blocked', scannedAt: expect.any(Date) },
};

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  updateMany.mockResolvedValue({ count: 1 });
  cancelCrucible.mockResolvedValue({
    crucibleId: ID,
    refundedEntries: 0,
    totalRefunded: 0,
    refundedSeed: 0,
    alreadySettled: 0,
    failedRefunds: [],
  });
  createNotification.mockResolvedValue(undefined);
});

describe('applyResult — blocked', () => {
  it('hides the crucible and tells the creator why', async () => {
    findUnique.mockResolvedValue({ userId: CREATOR });

    await crucibleModerationAdapter.applyResult!({
      entityId: ID,
      workflowId: 'wf-1',
      blocked: true,
      triggeredLabels: ['hate'],
      output: output(0),
    });

    expect(update).toHaveBeenCalledWith(blockedWrite);
    expect(createNotification).toHaveBeenCalledWith({
      userId: CREATOR,
      category: 'System',
      type: 'system-message',
      key: `crucible-text-blocked-wf-1-${ID}`,
      details: {
        message: 'Your crucible was hidden because its text violates our Terms of Service.',
        url: `/crucibles/${ID}`,
      },
    });
    expect(cancelCrucible).not.toHaveBeenCalled();
  });

  it('tells the creator again when a later scan blocks it again', async () => {
    findUnique.mockResolvedValue({ userId: CREATOR });
    const block = (workflowId: string) =>
      crucibleModerationAdapter.applyResult!({
        entityId: ID,
        workflowId,
        blocked: true,
        triggeredLabels: ['hate'],
        output: output(0),
      });

    await block('wf-1');
    await block('wf-2');

    const keys = createNotification.mock.calls.map(([n]) => n.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('applyResult — blocked but deleted since submit', () => {
  it('resolves without writing or notifying', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      crucibleModerationAdapter.applyResult!({
        entityId: ID,
        workflowId: 'wf-1',
        blocked: true,
        triggeredLabels: ['hate'],
        output: output(0),
      })
    ).resolves.toBeUndefined();

    expect(update).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('applyResult — clean', () => {
  it('marks Scanned without touching textNsfw or nsfwLevel, and logs the verdict', async () => {
    findForEscalation.mockResolvedValue(crucible({ textNsfw: true }));

    await scan(0.3);

    expect(update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { ingestion: 'Scanned', scannedAt: expect.any(Date) },
    });
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        name: 'crucible-text-scan',
        crucibleId: ID,
        isNsfw: false,
        scores: [{ label: 'explicit', score: 0.3, threshold: 0.75, topToken: 'yes' }],
      })
    );
    expect(cancelCrucible).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('applyResult — yellow crucible with NSFW text', () => {
  it('raises it to R, flags textNsfw, and notifies the creator', async () => {
    findForEscalation.mockResolvedValue(crucible({ buzzType: 'yellow' }));

    await scanNsfw();

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: ID, moderatorNsfwLevel: null },
      data: {
        ingestion: 'Scanned',
        scannedAt: expect.any(Date),
        textNsfw: true,
        nsfwLevel: SFW | NsfwLevel.R,
      },
    });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: CREATOR,
        key: `crucible-nsfw-raised-${ID}`,
        details: {
          message:
            "Your crucible's rating was raised to R based on its text, so people browsing safe-for-work content won't see it.",
          url: `/crucibles/${ID}`,
        },
      })
    );
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', name: 'crucible-text-scan', isNsfw: true })
    );
    expect(cancelCrucible).not.toHaveBeenCalled();
  });

  it('does not notify a second time when it was already raised', async () => {
    findForEscalation.mockResolvedValue(
      crucible({ buzzType: 'yellow', textNsfw: true, nsfwLevel: SFW | NsfwLevel.R })
    );

    await scanNsfw();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ textNsfw: true, nsfwLevel: SFW | NsfwLevel.R }),
      })
    );
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('applyResult — green crucible with NSFW text, Pending', () => {
  it('cancels as the system user BEFORE the Blocked write, then notifies', async () => {
    findForEscalation.mockResolvedValue(crucible());

    await scanNsfw();

    expect(cancelCrucible).toHaveBeenCalledWith({ id: ID, userId: -1, isModerator: true });
    expect(update).toHaveBeenCalledWith(blockedWrite);
    expect(cancelCrucible.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]
    );
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: CREATOR,
        key: `crucible-nsfw-cancelled-${ID}`,
        details: {
          message:
            'Your crucible was cancelled because its text was flagged as adult content — green crucibles must be safe-for-work. Your Buzz and any entry fees have been refunded; you can recreate it on civitai.red.',
          url: `/crucibles/${ID}`,
        },
      })
    );
    expect(logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crucible-nsfw-escalation-refund-failed' })
    );
  });

  it('records refunds the cancel could not make', async () => {
    findForEscalation.mockResolvedValue(crucible());
    const failedRefunds = [{ entryId: null, userId: CREATOR, error: 'buzz 500' }];
    cancelCrucible.mockResolvedValue({
      crucibleId: ID,
      refundedEntries: 0,
      totalRefunded: 0,
      refundedSeed: 0,
      alreadySettled: 0,
      failedRefunds,
    });

    await scanNsfw();

    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'crucible-nsfw-escalation-refund-failed',
        crucibleId: ID,
        failedRefunds,
      })
    );
  });
});

describe('applyResult — green crucible with NSFW text, still running', () => {
  it('claims it as Cancelled only while it is Pending, or Active before its end or unentered', async () => {
    findForEscalation.mockResolvedValue(crucible({ status: CrucibleStatus.Active }));

    await scanNsfw();

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: ID,
        OR: [
          { status: CrucibleStatus.Pending },
          {
            status: CrucibleStatus.Active,
            OR: [{ endAt: null }, { endAt: { gt: expect.any(Date) } }, { entries: { none: {} } }],
          },
        ],
      },
      data: { status: CrucibleStatus.Cancelled },
    });
    expect(cancelCrucible).toHaveBeenCalledWith({ id: ID, userId: -1, isModerator: true });
    expect(update).toHaveBeenCalledWith(blockedWrite);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: `crucible-nsfw-cancelled-${ID}` })
    );
  });
});

describe('applyResult — green crucible with NSFW text, already cancelled', () => {
  it('finishes the refunds without notifying again (a redelivery after a crash, or a moderator cancel)', async () => {
    findForEscalation.mockResolvedValue(crucible({ status: CrucibleStatus.Cancelled }));
    updateMany.mockResolvedValue({ count: 0 });

    await scanNsfw();

    expect(cancelCrucible).toHaveBeenCalledWith({ id: ID, userId: -1, isModerator: true });
    expect(update).toHaveBeenCalledWith(blockedWrite);
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('applyResult — green crucible with NSFW text, claim lost (ended or finalizing)', () => {
  it('blocks and holds for review without refunding', async () => {
    findForEscalation.mockResolvedValue(crucible({ status: CrucibleStatus.Active }));
    updateMany.mockResolvedValue({ count: 0 });

    await scanNsfw();

    expect(cancelCrucible).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(blockedWrite);
    expect(createNotification).not.toHaveBeenCalled();
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'crucible-nsfw-escalation-held',
        crucibleId: ID,
      })
    );
  });
});

// Product decision, 2026-10-03: an SFW crucible created on civitai.red is listed on civitai.com and
// may hold green entry fees, but flagged text still raises it to R and keeps it running rather than
// cancelling it. Its green entrants lose sight of it on .com; prizes pay yellow either way. Do not
// "fix" this into a cancel without asking.
describe('applyResult — SFW crucible created on the mature site, with NSFW text', () => {
  it('raises it to R and keeps it running, rather than cancelling it', async () => {
    findForEscalation.mockResolvedValue(
      crucible({ buzzType: 'yellow', status: CrucibleStatus.Active })
    );

    await scanNsfw();

    expect(cancelCrucible).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ textNsfw: true, nsfwLevel: SFW | NsfwLevel.R }),
      })
    );
  });
});

describe('applyCrucibleNsfwEscalation — row gone', () => {
  it('does nothing', async () => {
    findForEscalation.mockResolvedValue(null);

    await applyCrucibleNsfwEscalation({ entityId: ID, isNsfw: true });

    expect(update).not.toHaveBeenCalled();
    expect(cancelCrucible).not.toHaveBeenCalled();
  });
});

describe('applyCrucibleNsfwEscalation — moderator override', () => {
  it('does not raise a crucible a moderator already rated', async () => {
    findForEscalation.mockResolvedValue(
      crucible({ buzzType: 'yellow', status: CrucibleStatus.Active, moderatorNsfwLevel: 1 })
    );

    await applyCrucibleNsfwEscalation({ entityId: ID, isNsfw: true });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { ingestion: 'Scanned', scannedAt: expect.any(Date) },
    });
    expect(cancelCrucible).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('does not raise over a moderator rating that committed after the read, and still settles', async () => {
    findForEscalation.mockResolvedValue(
      crucible({ buzzType: 'yellow', status: CrucibleStatus.Active, moderatorNsfwLevel: null })
    );
    updateMany.mockResolvedValue({ count: 0 });

    await applyCrucibleNsfwEscalation({ entityId: ID, isNsfw: true, greenCancels: false });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ID, moderatorNsfwLevel: null } })
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { ingestion: 'Scanned', scannedAt: expect.any(Date) },
    });
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('applyCrucibleNsfwEscalation — greenCancels:false', () => {
  it('raises a green crucible instead of cancelling it', async () => {
    findForEscalation.mockResolvedValue(
      crucible({ status: CrucibleStatus.Active, moderatorNsfwLevel: null })
    );

    await applyCrucibleNsfwEscalation({ entityId: ID, isNsfw: true, greenCancels: false });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ textNsfw: true, nsfwLevel: SFW | NsfwLevel.R }),
      })
    );
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: CrucibleStatus.Cancelled } })
    );
    expect(cancelCrucible).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalledWith(blockedWrite);
  });
});

describe('applyFailure', () => {
  it('marks Error only on a crucible still Pending', async () => {
    await crucibleModerationAdapter.applyFailure!({
      entityId: ID,
      workflowId: 'wf-1',
      status: 'expired',
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: ID, ingestion: 'Pending' },
      data: { ingestion: 'Error' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('swallows a failed write', async () => {
    updateMany.mockRejectedValue(new Error('db down'));

    await expect(
      crucibleModerationAdapter.applyFailure!({
        entityId: ID,
        workflowId: 'wf-1',
        status: 'failed',
      })
    ).resolves.toBeUndefined();
  });
});

describe('submit', () => {
  it('scans as Crucible through text-scan when the flag is active, without XGuard', async () => {
    vi.mocked(getTextScanMode).mockResolvedValueOnce('active');
    vi.mocked(scanEntity).mockResolvedValueOnce({ status: 'submitted', workflowId: 'ts-1' });

    const result = await crucibleModerationAdapter.submit({ entityId: ID, content: 'Neon Nights' });

    expect(scanEntity).toHaveBeenCalledWith({
      entityType: 'Crucible',
      entityId: ID,
      force: undefined,
      fromRetry: true,
    });
    expect(submitTextModeration).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'ts-1' });
  });

  it('settles a retry the scan skips, so the crucible does not stay Pending', async () => {
    vi.mocked(getTextScanMode).mockResolvedValueOnce('active');
    vi.mocked(scanEntity).mockResolvedValueOnce({ status: 'skipped', reason: 'too-short' });
    findForEscalation.mockResolvedValue({ ...crucible(), name: 'Neon', description: null });

    const result = await crucibleModerationAdapter.submit({ entityId: ID, content: 'Neon' });

    expect(result).toBeNull();
    expect(update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { ingestion: 'Scanned', scannedAt: expect.any(Date) },
    });
  });

  // The retry cron re-submits through this adapter; a flag flipped off mid-flight hands the
  // crucible back to XGuard.
  it('falls back to XGuard when the flag turned off before the scan read it', async () => {
    vi.mocked(getTextScanMode).mockResolvedValueOnce('active');
    vi.mocked(scanEntity).mockResolvedValueOnce({ status: 'skipped', reason: 'off' });
    submitTextModeration.mockResolvedValue({ id: 'wf-9' });

    const result = await crucibleModerationAdapter.submit({ entityId: ID, content: 'Neon Nights' });

    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Crucible', entityId: ID })
    );
    expect(result).toEqual({ id: 'wf-9' });
  });

  it('scans as Crucible with the challenge labels at low priority', async () => {
    submitTextModeration.mockResolvedValue({ id: 'wf-9' });

    const result = await crucibleModerationAdapter.submit({ entityId: ID, content: 'Neon Nights' });

    expect(submitTextModeration).toHaveBeenCalledWith({
      entityType: 'Crucible',
      entityId: ID,
      content: 'Neon Nights',
      labels: ['nsfw', 'explicit'],
      priority: 'low',
    });
    expect(result).toEqual({ id: 'wf-9' });
  });
});

describe('resolveContent', () => {
  it('maps each crucible id to its name and description text', async () => {
    findMany.mockResolvedValue([
      { id: 1, name: 'Neon Nights', description: '<p>Glow in the dark</p>' },
      { id: 2, name: 'No Description', description: null },
    ]);

    const content = await crucibleModerationAdapter.resolveContent([1, 2, 3]);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [1, 2, 3] } } })
    );
    expect([...content.keys()]).toEqual([1, 2]);
    expect(content.get(1)).toContain('Neon Nights');
    expect(content.get(1)).toContain('Glow in the dark');
    expect(content.get(2)).toBe('No Description');
  });
});

describe('scanCrucible under text-scan', () => {
  beforeEach(() => {
    vi.mocked(getTextScanMode).mockResolvedValueOnce('active');
  });

  it('settles a skipped scan so the crucible does not stay Pending', async () => {
    vi.mocked(scanEntity).mockResolvedValueOnce({ status: 'skipped', reason: 'too-short' });
    findForEscalation.mockResolvedValue({ ...crucible(), name: 'Neon', description: null });

    await scanCrucible(ID);

    expect(update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { ingestion: 'Scanned', scannedAt: expect.any(Date) },
    });
    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  it('passes a moderator rescan through as force', async () => {
    vi.mocked(scanEntity).mockResolvedValueOnce({ status: 'submitted', workflowId: 'ts-2' });
    findForEscalation.mockResolvedValue({ name: 'Neon', description: null });

    await scanCrucible(ID, { forceRescan: true });

    expect(scanEntity).toHaveBeenCalledWith({ entityType: 'Crucible', entityId: ID, force: true });
  });
});

describe('applyTextScan', () => {
  it('applies text-scan verdicts through the Crucible action', () => {
    expect(crucibleModerationAdapter.applyTextScan).toBe(applyCrucibleTextScan);
  });
});

describe('moderation registry', () => {
  it('routes the Crucible entity type to this adapter', () => {
    expect(getModerationAdapter('Crucible')).toBe(crucibleModerationAdapter);
  });
});
