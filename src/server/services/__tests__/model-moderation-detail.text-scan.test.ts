import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { getModelModerationDetail } = await import('~/server/services/model.service');

const MAIN = {
  status: 'Succeeded',
  nsfwLevel: 4,
  triggeredLabels: ['nsfw'],
  result: { version: 1, labels: { nsfw: { level: 'r', reason: 'main nsfw' } } },
  updatedAt: new Date('2026-10-01T00:00:00Z'),
};
const SEARCH = {
  status: 'Succeeded',
  nsfwLevel: null,
  triggeredLabels: ['minor'],
  result: {
    version: 1,
    labels: {
      poi: { detected: false, names: [], reason: 'search poi' },
      minor: { detected: true, reason: 'search minor' },
    },
  },
  updatedAt: new Date('2026-10-02T00:00:00Z'),
};

let rows: Record<string, unknown> = {};

beforeEach(() => {
  rows = {};
  dbMock.dbRead.model.findUnique.mockResolvedValue({ id: 7, name: 'm', meta: {} } as never);
  dbMock.dbRead.entityModeration.findUnique.mockImplementation(
    (async (args: { where: { entityType_entityId: { entityType: string } } }) =>
      rows[args.where.entityType_entityId.entityType] ?? null) as never
  );
});

describe('getModelModerationDetail — text scan', () => {
  it('shows the web-search pass poi/minor verdict next to the main pass nsfw verdict', async () => {
    rows = {
      Model: {
        ...MAIN,
        triggeredLabels: ['nsfw', 'poi'],
        result: {
          version: 1,
          labels: {
            nsfw: { level: 'r', reason: 'main nsfw' },
            poi: { detected: true, names: ['x'], reason: 'stale main poi' },
          },
        },
      },
      'Model:search': SEARCH,
    };
    const { textScan } = await getModelModerationDetail({ id: 7 });
    expect(textScan).toMatchObject({ status: 'Succeeded', nsfwLevel: 4 });
    expect(textScan?.triggeredLabels).toEqual(['nsfw', 'minor']);
    expect(textScan?.reasons).toEqual([
      { label: 'nsfw', reason: 'main nsfw' },
      { label: 'poi', reason: 'search poi' },
      { label: 'minor', reason: 'search minor' },
    ]);
  });

  it('keeps the main pass verdict as is when there is no web-search row', async () => {
    rows = { Model: MAIN };
    const { textScan } = await getModelModerationDetail({ id: 7 });
    expect(textScan?.triggeredLabels).toEqual(['nsfw']);
    expect(textScan?.reasons).toEqual([{ label: 'nsfw', reason: 'main nsfw' }]);
  });

  it('shows the web-search verdict when the main pass has no usable row', async () => {
    rows = { 'Model:search': SEARCH };
    const { textScan } = await getModelModerationDetail({ id: 7 });
    expect(textScan?.triggeredLabels).toEqual(['minor']);
    expect(textScan?.reasons.map((r) => r.label)).toEqual(['poi', 'minor']);
  });
});
