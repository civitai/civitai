import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as FliptClient from '~/server/flipt/client';
import type * as NotificationService from '~/server/services/notification.service';
import type * as PromptModule from '~/server/services/text-scan/prompt';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
  getTextScanConfig: vi.fn(),
}));

await import('~/server/services/text-scan/profiles/index');
const { getTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { resetTextScanRolloutCache } = await import('~/server/services/text-scan/mode');
const { scanEntity } = await import('~/server/services/text-scan/submit');
const { applyStorylineTextScan } = await import('~/server/services/text-scan/actions/storyline');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { isFlipt } = await import('~/server/flipt/client');
const { createNotification } = await import('~/server/services/notification.service');
const { submitWorkflow } = await import('@civitai/orchestration-client');
const { getActiveTextScanPrompts, getTextScanConfig, textScanTextHash } = await import(
  '~/server/services/text-scan/prompt'
);
const { storylineTextScanSubject } = await import(
  '~/server/services/text-scan/profiles/storyline.profile'
);

const PROMPTS = Object.fromEntries(
  ['base', 'label:nsfw', 'label:poi', 'label:minor'].map((key, i) => [
    key,
    { id: i + 1, key, content: `${key} prompt` },
  ])
);
const CONFIG = { model: 'air:test', maxInputChars: 1000, thinking: false };

const w = dbMock.dbWrite;
const ID = 10;
const OWNER = 3;
// The hash of the title the fixture storyline has now: a verdict on any other text is stale.
const HASH = textScanTextHash(storylineTextScanSubject({ userId: OWNER, title: 'A story' }));

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

// Conditional on the SCAN's flag, not on the storyline being up: a verdict arriving while a
// moderator holds a takedown is still recorded, or that moderator's restore would publish it.
const takedownWrite = {
  where: {
    id: ID,
    tosViolationByScan: false,
    OR: [{ scanFlagLiftedTextHash: null }, { scanFlagLiftedTextHash: { not: HASH } }],
  },
  data: { tosViolation: true, tosViolationByScan: true },
};
// One write per state of the moderator's flag: the storyline comes back up only when no
// moderator holds a takedown of their own.
const liftWrites = [
  {
    where: { title: 'A story', id: ID, tosViolationByScan: true, tosViolationByModerator: false },
    data: { tosViolation: false, tosViolationByScan: false },
  },
  {
    where: { title: 'A story', id: ID, tosViolationByScan: true, tosViolationByModerator: true },
    data: { tosViolationByScan: false },
  },
];
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

  // A moderator's lift records the hash of storylineTextScanSubject(reviewed title); the verdict
  // compares the textHash the scan submitted. If the two ever hashed different text, a
  // redelivered verdict would take down a title a moderator had cleared.
  it('submits the same text hash a moderator lift records', async () => {
    rollout('{"shadow":100,"active":100}');
    w.storyline.findMany.mockResolvedValue([
      { id: ID, userId: OWNER, title: 'Dark Road' },
    ] as never);
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue(PROMPTS);
    vi.mocked(getTextScanConfig).mockResolvedValue(CONFIG);
    vi.mocked(submitWorkflow).mockResolvedValueOnce({ data: { id: 'wf-9' } } as never);
    expect(await scanEntity({ entityType: 'Storyline', entityId: ID })).toEqual({
      status: 'submitted',
      workflowId: 'wf-9',
    });
    const submitted = (
      vi.mocked(submitWorkflow).mock.calls[0][0].body!.metadata as { textHash: string }
    ).textHash;
    expect(submitted).toEqual(expect.any(String));
    expect(textScanTextHash(storylineTextScanSubject({ userId: OWNER, title: 'Dark Road' }))).toBe(
      submitted
    );
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
      // A raise, conditional on the stored level still being lower.
      expect(updates()).toEqual([
        { where: { id: ID, nsfwLevel: { lt: NsfwLevel.R } }, data: { nsfwLevel: NsfwLevel.R } },
      ]);
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
      expect(updates()).toEqual([
        { where: { id: ID, title: 'A story' }, data: { nsfwLevel: NsfwLevel.PG } },
      ]);
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
      // Not a raise: pinned to the title the verdict judged. A raise: only over a lower level.
      const pinned =
        level <= (row as { nsfwLevel: number }).nsfwLevel
          ? { title: 'A story' }
          : { nsfwLevel: { lt: level } };
      expect(updates()).toEqual([{ where: { id: ID, ...pinned }, data: { nsfwLevel: level } }]);
      expect(createNotification).not.toHaveBeenCalled();
    });
  });

  describe('poi and minor', () => {
    // The fixture's stored level is 0, so every verdict here is a raise.
    const rated = (nsfw: number) => ({
      where: { id: ID, nsfwLevel: { lt: nsfw } },
      data: { nsfwLevel: nsfw },
    });
    const setMinor = { where: { id: ID, minorByScan: false }, data: { minorByScan: true } };
    // Permissive writes hold only while the title is still the one the verdict judged.
    const clearMinor = {
      where: { id: ID, minorByScan: true, title: 'A story' },
      data: { minorByScan: false },
    };
    const notices = () =>
      vi.mocked(createNotification).mock.calls.map(([n]) => (n as { key: string }).key);

    it('a person of interest takes the storyline down as the scan, and tells the owner', async () => {
      await applyStorylineTextScan(args({ ...clean, poi: true }) as never);
      expect(updates()).toEqual([rated(NsfwLevel.PG), clearMinor, takedownWrite]);
      expect(notices()).toEqual([`storyline-title-moderated-${ID}-tos-wf-1`]);
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { storylineId: ID, takenDown: true, title: 'A story' },
        })
      );
    });

    it('a minor with an NSFW title takes it down, and marks the minor', async () => {
      await applyStorylineTextScan(args({ nsfw: NsfwLevel.R, poi: false, minor: true }) as never);
      expect(updates()).toEqual([rated(NsfwLevel.R), setMinor, takedownWrite]);
      // The rating notice and the takedown notice; no third one for the minor on its own.
      expect(notices()).toEqual([
        `storyline-title-moderated-${ID}-${NsfwLevel.R}-wf-1`,
        `storyline-title-moderated-${ID}-tos-wf-1`,
      ]);
    });

    // A minor in a safe-for-work title keeps the storyline up, with its chapters held to
    // `storylineCeiling`.
    it.each([
      ['PG', NsfwLevel.PG],
      ['PG-13', NsfwLevel.PG13],
    ])('a minor with a %s title does not take it down: it marks the minor', async (_n, level) => {
      await applyStorylineTextScan(args({ nsfw: level, poi: false, minor: true }) as never);
      // The cap is written before the lift, so the storyline never comes back up uncapped.
      expect(updates()).toEqual([rated(level), setMinor, ...liftWrites]);
      expect(updates()).not.toContainEqual(takedownWrite);
      expect(notices()).toEqual([`storyline-title-moderated-${ID}-minor-wf-1`]);
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({ details: { storylineId: ID, minor: true, title: 'A story' } })
      );
    });

    // Fail closed: with no rating to judge the title by, a minor finding is treated as NSFW.
    it('a minor with no nsfw verdict takes it down', async () => {
      await applyStorylineTextScan(args({ poi: false, minor: true }) as never);
      expect(updates()).toEqual([setMinor, takedownWrite]);
    });

    it.each([
      // A rating is not tied to the text it was given for: after an edit, an NSFW verdict on the
      // new title must not be outvoted by a safe rating of the old one.
      ['rated it safe, under an NSFW verdict', NsfwLevel.PG13, NsfwLevel.R, true],
      ['rated it safe, with no nsfw verdict', NsfwLevel.PG, undefined, false],
      ['rated it NSFW, over a safe verdict', NsfwLevel.R, NsfwLevel.PG, true],
      ['rated it safe, and the verdict agrees', NsfwLevel.PG, NsfwLevel.PG13, false],
    ])(
      "the higher of a moderator's rating and the verdict judges the title when they %s",
      async (_n, moderatorNsfwLevel, nsfw, down) => {
        w.storyline.findUnique.mockResolvedValue(before({ moderatorNsfwLevel }) as never);
        await applyStorylineTextScan(args({ nsfw, poi: false, minor: true }) as never);
        if (down) expect(updates()).toContainEqual(takedownWrite);
        else expect(updates()).not.toContainEqual(takedownWrite);
      }
    );

    it('a clean verdict lifts only the scan’s own takedown and clears the minor', async () => {
      await applyStorylineTextScan(args(clean) as never);
      expect(updates()).toEqual([rated(NsfwLevel.PG), clearMinor, ...liftWrites]);
      expect(createNotification).not.toHaveBeenCalled();
    });

    it('does not lift when poi is missing, though minor answered clean', async () => {
      await applyStorylineTextScan(args({ nsfw: NsfwLevel.PG, minor: false }) as never);
      expect(updates()).toEqual([rated(NsfwLevel.PG), clearMinor]);
    });

    // A missing minor label moves nothing it decides: neither the lift nor the flag.
    it('does not lift or touch the minor flag when minor is missing', async () => {
      await applyStorylineTextScan(args({ nsfw: NsfwLevel.PG, poi: false }) as never);
      expect(updates()).toEqual([rated(NsfwLevel.PG)]);
    });

    it('takes it down when poi found, minor missing: one finding is enough', async () => {
      await applyStorylineTextScan(args({ nsfw: NsfwLevel.PG, poi: true }) as never);
      expect(updates()).toEqual([rated(NsfwLevel.PG), takedownWrite]);
    });

    it('stays silent when nothing changed (already down or marked by the scan)', async () => {
      w.storyline.updateMany
        .mockResolvedValueOnce({ count: 1 } as never)
        .mockResolvedValueOnce({ count: 0 } as never)
        .mockResolvedValueOnce({ count: 0 } as never);
      await applyStorylineTextScan(args({ ...clean, poi: true }) as never);
      expect(updates()[2]).toEqual(takedownWrite);
      expect(createNotification).not.toHaveBeenCalled();

      vi.clearAllMocks();
      w.storyline.updateMany.mockResolvedValue({ count: 0 } as never);
      await applyStorylineTextScan(args({ nsfw: NsfwLevel.PG, poi: false, minor: true }) as never);
      expect(createNotification).not.toHaveBeenCalled();
    });
  });

  it('does nothing for a storyline that is gone', async () => {
    w.storyline.findUnique.mockResolvedValue(null as never);
    await applyStorylineTextScan(args({ nsfw: NsfwLevel.X, poi: true, minor: true }) as never);
    expect(w.storyline.updateMany).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
});
