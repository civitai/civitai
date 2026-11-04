import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as LabelCapture from '~/server/services/text-scan/label-capture';

const { mockResolveEntityAppeal } = vi.hoisted(() => ({ mockResolveEntityAppeal: vi.fn() }));
vi.mock('~/server/services/report.service', () => ({
  resolveEntityAppeal: mockResolveEntityAppeal,
}));
// Label capture runs on real Postgres in label-capture.rulings.behavior.test.ts; here the flag
// writer runs on the plain client so its own statement can be read.
vi.mock('~/server/services/text-scan/label-capture', async (importOriginal) => {
  const { dbMock } = await import('~/__tests__/mocks/db.mock');
  return {
    ...(await importOriginal<typeof LabelCapture>()),
    writeTextScanRuling: (_ruling: unknown, write: (tx: unknown) => unknown) =>
      write(dbMock.dbWrite),
  };
});
// The rollout lives in redis; the row lookup the grant hash does after it stays real.
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanWebSearchMode: async () => 'off',
}));
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';
import {
  loadTextScanTextHash,
  settleFlagAppealsAfterModeratorLift,
  stampModeratorTextScanRuling,
} from '~/server/services/text-scan/actions/appeal-text-hash';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';

const subject = (text: string, declared = {}) => ({
  fields: [
    { heading: 'Name', text },
    { heading: 'Description', text: 'x'.repeat(50_000) },
  ],
  declared,
});

beforeEach(() => vi.clearAllMocks());

// Nested fragments arrive as Sql values; flattening shows the statement Postgres receives.
const flatSql = (call: unknown[]) => {
  const query = Prisma.sql(call[0] as TemplateStringsArray, ...(call.slice(1) as never[]));
  return [Array.from(query.strings), ...query.values] as [string[], ...unknown[]];
};

describe('textScanTextHash', () => {
  it('depends on the text only, not on declared flags', () => {
    expect(textScanTextHash(subject('A', { poi: true }))).toBe(
      textScanTextHash(subject('A', { poi: false }))
    );
  });

  it('changes when the text changes, including past any maxInputChars cap', () => {
    expect(textScanTextHash(subject('A'))).not.toBe(textScanTextHash(subject('B')));
    const long = subject('A');
    const edited = {
      ...long,
      fields: [long.fields[0], { heading: 'Description', text: `${'x'.repeat(50_000)}y` }],
    };
    expect(textScanTextHash(long)).not.toBe(textScanTextHash(edited));
  });
});

// `~/server/services/text-scan/profiles` is the registry FILE; only the barrel registers profiles.
// Without the side-effect import every hash comes back null, and a grant with a null hash was a
// permanent exemption.
describe('loadTextScanTextHash', () => {
  it('registers the Model and Bounty profiles through the barrel', () => {
    expect(getTextScanProfile('Model')).toBeDefined();
    expect(getTextScanProfile('Bounty')).toBeDefined();
  });

  it('hashes the entity text read through the profile', async () => {
    dbMock.dbWrite.bounty.findMany.mockResolvedValue([
      { id: 9, userId: 5, name: 'B', description: null, nsfw: false, nsfwLevel: 1, poi: false },
    ]);
    const hash = await loadTextScanTextHash('Bounty', 9);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('returns null for an entity the profile cannot load', async () => {
    dbMock.dbWrite.bounty.findMany.mockResolvedValue([]);
    expect(await loadTextScanTextHash('Bounty', 9)).toBeNull();
  });
});

describe('stampModeratorTextScanRuling', () => {
  it('writes a moderator ruling on the current text for the label', async () => {
    dbMock.dbWrite.model.findMany.mockResolvedValue([
      {
        id: 7,
        userId: 5,
        name: 'M',
        description: null,
        nsfw: false,
        poi: false,
        minor: true,
        modelVersions: [],
      },
    ]);
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);

    expect(await stampModeratorTextScanRuling({ modelId: 7, userId: 3, label: 'minor' })).toBe(
      true
    );

    const [strings, ...flatValues] = flatSql(dbMock.dbWrite.$executeRaw.mock.calls[0]);
    const text = strings.join('?');
    expect(text).toContain(`'appealGranted', jsonb_build_object(`);
    expect(text).toContain(`'via', 'moderator'`);
    // The ruling is on the current state, so a pending re-detection goes with it.
    expect(text).toContain(`- 'redetected'`);
    expect(flatValues).toEqual(expect.arrayContaining([3, 7]));
  });

  it('carries the moderator reason and note into the ruling, and omits them when not given', async () => {
    dbMock.dbWrite.model.findMany.mockResolvedValue([
      {
        id: 7,
        userId: 5,
        name: 'M',
        description: null,
        nsfw: false,
        poi: false,
        minor: true,
        modelVersions: [],
      },
    ]);
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);

    await stampModeratorTextScanRuling({
      modelId: 7,
      userId: 3,
      label: 'minor',
      reason: 'Adult character',
      note: 'checked the sheet',
    });
    const [withText, ...withValues] = flatSql(dbMock.dbWrite.$executeRaw.mock.calls[0]);
    // Reason binds immediately before note, so a swap cannot pass.
    const at = withValues.indexOf('Adult character');
    expect(at).toBeGreaterThan(-1);
    expect(withValues.slice(at, at + 2)).toEqual(['Adult character', 'checked the sheet']);
    expect(withText.join('?')).toContain('jsonb_strip_nulls');

    await stampModeratorTextScanRuling({ modelId: 7, userId: 3, label: 'minor' });
    const [, ...bareValues] = flatSql(dbMock.dbWrite.$executeRaw.mock.calls[1]);
    // Absent fields bind as null, which jsonb_strip_nulls drops, so the ruling carries no key.
    expect(bareValues.filter((v) => v === null)).toHaveLength(2);
  });

  // The scan skips a model that is not public; a ruling on one its owner unpublished must not.
  it('records a ruling on a model that is not public', async () => {
    dbMock.dbWrite.model.findMany.mockResolvedValue([
      {
        id: 7,
        userId: 5,
        name: 'M',
        description: null,
        nsfw: false,
        poi: false,
        minor: true,
        status: 'Unpublished',
        availability: 'Public',
        modelVersions: [],
      },
    ]);
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);

    expect(await stampModeratorTextScanRuling({ modelId: 7, userId: 3, label: 'minor' })).toBe(
      true
    );
    expect(dbMock.dbWrite.model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [7] }, deletedAt: null } })
    );
  });

  it('stamps the hash it is given without reading the current text', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);

    expect(
      await stampModeratorTextScanRuling({
        modelId: 7,
        userId: 3,
        label: 'minor',
        textHash: 'seen-h',
      })
    ).toBe(true);

    expect(dbMock.dbWrite.model.findMany).not.toHaveBeenCalled();
    const [, ...values] = flatSql(dbMock.dbWrite.$executeRaw.mock.calls[0]);
    expect(values).toEqual(expect.arrayContaining(['seen-h']));
  });

  it('writes nothing and reports false when the text cannot be read', async () => {
    dbMock.dbWrite.model.findMany.mockResolvedValue([]);
    expect(await stampModeratorTextScanRuling({ modelId: 7, userId: 3, label: 'minor' })).toBe(
      false
    );
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('settleFlagAppealsAfterModeratorLift', () => {
  const modelRow = {
    id: 7,
    userId: 5,
    name: 'M',
    description: null,
    nsfw: false,
    poi: false,
    minor: false,
    modelVersions: [],
  };
  const stampedValues = () =>
    dbMock.dbWrite.$executeRaw.mock.calls.flatMap((c) => flatSql(c).slice(1));

  const stampedTexts = () =>
    dbMock.dbWrite.$executeRaw.mock.calls.map((c) => flatSql(c)[0].join('?'));

  beforeEach(() => {
    dbMock.dbWrite.model.findMany.mockResolvedValue([modelRow]);
    dbMock.dbWrite.model.findUnique.mockResolvedValue({ minor: false, poi: false });
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
    mockResolveEntityAppeal.mockResolvedValue([]);
  });

  it('approves the pending appeal and records the ruling once nothing is flagged', async () => {
    await settleFlagAppealsAfterModeratorLift({ modelId: 7, userId: 3, liftedLabels: ['minor'] });

    expect(stampedValues()).toEqual(expect.arrayContaining([3, 7]));
    expect(stampedTexts()).toEqual([expect.stringContaining(`->'minor'`)]);
    expect(mockResolveEntityAppeal).toHaveBeenCalledWith({
      ids: [7],
      entityType: EntityType.Model,
      status: AppealStatus.Approved,
      userId: 3,
      // A lifted flag says nothing about a locked setting the owner asked about.
      modelAppealKind: 'flag',
    });
  });

  it('records a ruling per lifted label', async () => {
    await settleFlagAppealsAfterModeratorLift({
      modelId: 7,
      userId: 3,
      liftedLabels: ['minor', 'poi'],
    });

    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(2);
    expect(stampedTexts()).toEqual([
      expect.stringContaining(`->'minor'`),
      expect.stringContaining(`->'poi'`),
    ]);
    expect(mockResolveEntityAppeal).toHaveBeenCalledTimes(1);
  });

  it('stamps the hash of the latest completed scan, as an overturn does', async () => {
    dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
      result: { version: 1, textHash: 'scanned-hash' },
    });

    await settleFlagAppealsAfterModeratorLift({ modelId: 7, userId: 3, liftedLabels: ['poi'] });

    expect(stampedValues()).toContain('scanned-hash');
  });

  it('leaves the appeal open while the other flag is still set', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({ minor: false, poi: true });
    await settleFlagAppealsAfterModeratorLift({ modelId: 7, userId: 3, liftedLabels: ['minor'] });
    dbMock.dbWrite.model.findUnique.mockResolvedValue({ minor: true, poi: false });
    await settleFlagAppealsAfterModeratorLift({ modelId: 7, userId: 3, liftedLabels: ['poi'] });

    expect(mockResolveEntityAppeal).not.toHaveBeenCalled();
  });

  it('still approves when the text cannot be read, recording nothing', async () => {
    dbMock.dbWrite.model.findMany.mockResolvedValue([]);

    await settleFlagAppealsAfterModeratorLift({ modelId: 7, userId: 3, liftedLabels: ['minor'] });

    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockResolveEntityAppeal).toHaveBeenCalledTimes(1);
  });

  it('never throws, and still approves when recording the ruling fails', async () => {
    dbMock.dbWrite.$executeRaw.mockRejectedValue(new Error('db down'));

    await expect(
      settleFlagAppealsAfterModeratorLift({ modelId: 7, userId: 3, liftedLabels: ['minor'] })
    ).resolves.toBeUndefined();
    expect(mockResolveEntityAppeal).toHaveBeenCalledTimes(1);

    mockResolveEntityAppeal.mockRejectedValue(new Error('appeal write failed'));
    await expect(
      settleFlagAppealsAfterModeratorLift({ modelId: 7, userId: 3, liftedLabels: ['minor'] })
    ).resolves.toBeUndefined();
  });

  it('skips the rulings a caller already recorded', async () => {
    await settleFlagAppealsAfterModeratorLift({
      modelId: 7,
      userId: 3,
      liftedLabels: ['minor'],
      recordRulings: false,
    });

    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockResolveEntityAppeal).toHaveBeenCalledTimes(1);
  });
});
