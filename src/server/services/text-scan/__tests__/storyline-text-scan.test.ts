import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as FliptClient from '~/server/flipt/client';
import type * as NotificationService from '~/server/services/notification.service';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(),
}));

await import('~/server/services/text-scan/profiles/index');
const { getTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { resetTextScanRolloutCache } = await import('~/server/services/text-scan/mode');
const { scanEntity } = await import('~/server/services/text-scan/submit');
const { applyStorylineTextScan } = await import('~/server/services/text-scan/actions/storyline');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { isFlipt } = await import('~/server/flipt/client');
const { createNotification } = await import('~/server/services/notification.service');
const { submitWorkflow } = await import('@civitai/client');

const w = dbMock.dbWrite;
const ID = 10;
const OWNER = 3;
const HASH = 'hash-of-this-title';

const before = (over: Record<string, unknown> = {}) => ({
  userId: OWNER,
  title: 'A story',
  nsfwLevel: 0,
  moderatorNsfwLevel: null,
  ...over,
});

type Verdict = { nsfw?: number; poi?: boolean; minor?: boolean };
const args = (v: Verdict) => ({
  entityId: ID,
  workflowId: 'wf-1',
  textHash: HASH,
  subject: { fields: [], declared: {} },
  outcome: {
    triggeredLabels: [],
    nsfwLevel: v.nsfw ?? null,
    ...(v.nsfw !== undefined && {
      nsfw: { detectedLevel: v.nsfw, declaredLevel: 0, raised: v.nsfw > 1, reason: 'r' },
    }),
    ...(v.poi !== undefined && {
      poi: { detected: v.poi, declared: false, newlyDetected: v.poi, names: [], reason: 'r' },
    }),
    ...(v.minor !== undefined && {
      minor: { detected: v.minor, declared: false, newlyDetected: v.minor, reason: 'r' },
    }),
  },
});
const clean = { nsfw: NsfwLevel.PG, poi: false, minor: false };

const takedownWrite = {
  where: {
    id: ID,
    tosViolation: false,
    OR: [{ scanFlagLiftedTextHash: null }, { scanFlagLiftedTextHash: { not: HASH } }],
  },
  data: { tosViolation: true, tosViolationByScan: true },
};
const liftWrite = {
  where: { id: ID, tosViolationByScan: true },
  data: { tosViolation: false, tosViolationByScan: false },
};
const updates = () => w.storyline.updateMany.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  w.storyline.findUnique.mockReset().mockResolvedValue(before() as never);
  w.storyline.updateMany.mockReset().mockResolvedValue({ count: 1 } as never);
  w.storyline.findMany.mockReset().mockResolvedValue([] as never);
});

describe('Storyline text-scan profile', () => {
  it('scans the title for nsfw, poi and minor, with nothing declared', async () => {
    const profile = getTextScanProfile('Storyline')!;
    expect(profile.labels).toEqual(['nsfw', 'poi', 'minor']);
    w.storyline.findMany.mockResolvedValue([
      { id: ID, userId: OWNER, title: 'Dark Road' },
    ] as never);
    expect((await profile.load([ID])).get(ID)).toEqual({
      userId: OWNER,
      declared: {},
      fields: [{ heading: 'Title', text: 'Dark Road' }],
    });
  });

  it('is registered with an adapter that applies the storyline verdict', () => {
    expect(getModerationAdapter('Storyline')?.applyTextScan).toBe(applyStorylineTextScan);
  });
});

describe('Storyline rollout', () => {
  const rollout = (value: string | undefined) =>
    redisMock.sysRedis.hGetAll.mockResolvedValue((value ? { Storyline: value } : {}) as never);

  beforeEach(() => {
    redisMock.sysRedis.hGetAll.mockReset();
    vi.mocked(isFlipt).mockReset().mockResolvedValue(true);
    resetTextScanRolloutCache();
  });

  // The control: with Storyline active the same call reads the title, so the "off" assertions
  // below are about the rollout and not about a scan that could never start.
  it('reads the title once Storyline is active', async () => {
    rollout('{"shadow":100,"active":100}');
    expect(await scanEntity({ entityType: 'Storyline', entityId: ID })).toEqual({
      status: 'skipped',
      reason: 'missing',
    });
    expect(w.storyline.findMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Storyline has no rollout', () => rollout(undefined)],
    ['the rollout is zero', () => rollout('{"shadow":0,"active":0}')],
    [
      'the kill switch is off',
      () => {
        rollout('{"shadow":100,"active":100}');
        vi.mocked(isFlipt).mockResolvedValue(false);
      },
    ],
  ])('does nothing when %s: no read, no workflow, no write', async (_name, arrange) => {
    arrange();
    expect(await scanEntity({ entityType: 'Storyline', entityId: ID })).toEqual({
      status: 'skipped',
      reason: 'off',
    });
    expect(w.storyline.findMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(w.entityModeration.upsert).not.toHaveBeenCalled();
    expect(w.storyline.updateMany).not.toHaveBeenCalled();
  });
});

describe('applyStorylineTextScan', () => {
  describe('nsfw', () => {
    it("sets the title's rating and tells the owner when it is R or above", async () => {
      await applyStorylineTextScan(args({ nsfw: NsfwLevel.R }) as never);
      expect(updates()).toEqual([{ where: { id: ID }, data: { nsfwLevel: NsfwLevel.R } }]);
      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: OWNER,
          type: 'storyline-title-moderated',
          key: `storyline-title-moderated-${ID}-${NsfwLevel.R}-wf-1`,
          details: { storylineId: ID, level: NsfwLevel.R, title: 'A story' },
        })
      );
    });

    // The title's rating is its latest verdict, not a ratchet: an edited title can lower it.
    it('lowers the rating on a clean verdict, silently', async () => {
      w.storyline.findUnique.mockResolvedValue(before({ nsfwLevel: NsfwLevel.X }) as never);
      await applyStorylineTextScan(args({ nsfw: NsfwLevel.PG }) as never);
      expect(updates()).toEqual([{ where: { id: ID }, data: { nsfwLevel: NsfwLevel.PG } }]);
      expect(createNotification).not.toHaveBeenCalled();
    });

    it.each([
      ['below R', before(), NsfwLevel.PG13],
      [
        'already at that rating (a redelivered callback)',
        before({ nsfwLevel: NsfwLevel.R }),
        NsfwLevel.R,
      ],
      [
        'a moderator has ruled on the rating',
        before({ moderatorNsfwLevel: NsfwLevel.PG }),
        NsfwLevel.X,
      ],
    ])('records the rating without a notice when %s', async (_name, row, level) => {
      w.storyline.findUnique.mockResolvedValue(row as never);
      await applyStorylineTextScan(args({ nsfw: level }) as never);
      expect(updates()).toEqual([{ where: { id: ID }, data: { nsfwLevel: level } }]);
      expect(createNotification).not.toHaveBeenCalled();
    });
  });

  describe('poi and minor', () => {
    it.each([
      ['poi', { ...clean, poi: true }],
      ['minor', { ...clean, minor: true }],
    ])('%s takes the storyline down as the scan, and tells the owner', async (_name, verdict) => {
      await applyStorylineTextScan(args(verdict) as never);
      expect(updates()).toEqual([
        { where: { id: ID }, data: { nsfwLevel: NsfwLevel.PG } },
        takedownWrite,
      ]);
      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          key: `storyline-title-moderated-${ID}-tos-wf-1`,
          details: { storylineId: ID, takenDown: true, title: 'A story' },
        })
      );
    });

    it('stays silent when nothing was taken down (already down, or text a moderator cleared)', async () => {
      w.storyline.updateMany
        .mockResolvedValueOnce({ count: 1 } as never)
        .mockResolvedValueOnce({ count: 0 } as never);
      await applyStorylineTextScan(args({ ...clean, poi: true }) as never);
      expect(updates()[1]).toEqual(takedownWrite);
      expect(createNotification).not.toHaveBeenCalled();
    });

    it("lifts only the scan's own takedown on a clean verdict", async () => {
      await applyStorylineTextScan(args(clean) as never);
      expect(updates()).toEqual([
        { where: { id: ID }, data: { nsfwLevel: NsfwLevel.PG } },
        liftWrite,
      ]);
      expect(createNotification).not.toHaveBeenCalled();
    });

    it.each([
      ['poi is missing', { nsfw: NsfwLevel.PG, minor: false }],
      ['minor is missing', { nsfw: NsfwLevel.PG, poi: false }],
    ])('neither takes down nor lifts when %s', async (_name, verdict) => {
      await applyStorylineTextScan(args(verdict) as never);
      expect(updates()).toEqual([{ where: { id: ID }, data: { nsfwLevel: NsfwLevel.PG } }]);
    });
  });

  it('does nothing for a storyline that is gone', async () => {
    w.storyline.findUnique.mockResolvedValue(null as never);
    await applyStorylineTextScan(args({ nsfw: NsfwLevel.X, poi: true, minor: true }) as never);
    expect(w.storyline.updateMany).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
});
