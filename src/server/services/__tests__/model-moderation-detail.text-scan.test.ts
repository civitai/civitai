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

describe('getModelModerationDetail — latest poi/minor verdict per label', () => {
  const mainWithPoi = (updatedAt: string, status = 'Succeeded') => ({
    ...MAIN,
    status,
    triggeredLabels: ['nsfw'],
    result: {
      version: 1,
      labels: {
        nsfw: { level: 'r', reason: 'main nsfw' },
        poi: { detected: false, names: [], reason: 'main poi' },
      },
    },
    updatedAt: new Date(updatedAt),
  });

  it('prefers a newer succeeded main verdict over a stale succeeded web-search one', async () => {
    rows = {
      Model: mainWithPoi('2026-10-05T00:00:00Z'),
      'Model:search': {
        ...SEARCH,
        triggeredLabels: ['poi'],
        result: {
          version: 1,
          labels: { poi: { detected: true, names: ['x'], reason: 'stale search poi' } },
        },
        updatedAt: new Date('2026-10-02T00:00:00Z'),
      },
    };
    const { textScan } = await getModelModerationDetail({ id: 7 });
    expect(textScan?.triggeredLabels).toEqual(['nsfw']);
    expect(textScan?.labelVerdicts).toEqual([
      {
        label: 'poi',
        detected: false,
        reason: 'main poi',
        source: 'main',
        status: 'Succeeded',
        updatedAt: new Date('2026-10-05T00:00:00Z'),
      },
    ]);
  });

  it('falls back to the main verdict when the web-search row is pending with no result', async () => {
    rows = {
      Model: mainWithPoi('2026-10-01T00:00:00Z'),
      'Model:search': {
        status: 'Pending',
        nsfwLevel: null,
        triggeredLabels: [],
        result: null,
        updatedAt: new Date('2026-10-06T00:00:00Z'),
      },
    };
    const { textScan } = await getModelModerationDetail({ id: 7 });
    expect(textScan?.labelVerdicts).toMatchObject([
      { label: 'poi', source: 'main', status: 'Succeeded', reason: 'main poi' },
    ]);
  });

  it('takes the web-search verdict when it is the newest succeeded one', async () => {
    rows = { Model: mainWithPoi('2026-10-01T00:00:00Z'), 'Model:search': SEARCH };
    const { textScan } = await getModelModerationDetail({ id: 7 });
    expect(textScan?.labelVerdicts).toEqual([
      {
        label: 'poi',
        detected: false,
        reason: 'search poi',
        source: 'web search',
        status: 'Succeeded',
        updatedAt: SEARCH.updatedAt,
      },
      {
        label: 'minor',
        detected: true,
        reason: 'search minor',
        source: 'web search',
        status: 'Succeeded',
        updatedAt: SEARCH.updatedAt,
      },
    ]);
  });

  it('marks a verdict from an unfinished row with that row status', async () => {
    rows = { Model: mainWithPoi('2026-10-01T00:00:00Z', 'Failed') };
    const { textScan } = await getModelModerationDetail({ id: 7 });
    expect(textScan?.labelVerdicts).toMatchObject([
      { label: 'poi', source: 'main', status: 'Failed' },
    ]);
  });

  it.each(['Pending', 'Failed'])(
    'prefers an older succeeded verdict over a newer %s row still carrying a stale one',
    async (status) => {
      rows = {
        Model: mainWithPoi('2026-10-01T00:00:00Z'),
        'Model:search': {
          ...SEARCH,
          status,
          result: {
            version: 1,
            labels: { poi: { detected: true, names: ['x'], reason: 'stale search poi' } },
          },
          updatedAt: new Date('2026-10-06T00:00:00Z'),
        },
      };
      const { textScan } = await getModelModerationDetail({ id: 7 });
      expect(textScan?.labelVerdicts).toEqual([
        {
          label: 'poi',
          detected: false,
          reason: 'main poi',
          source: 'main',
          status: 'Succeeded',
          updatedAt: new Date('2026-10-01T00:00:00Z'),
        },
      ]);
    }
  );

  it('takes the only row carrying the label even when it failed', async () => {
    rows = {
      Model: MAIN,
      'Model:search': {
        ...SEARCH,
        status: 'Failed',
        result: {
          version: 1,
          labels: { poi: { detected: true, names: ['x'], reason: 'failed search poi' } },
        },
      },
    };
    const { textScan } = await getModelModerationDetail({ id: 7 });
    expect(textScan?.labelVerdicts).toEqual([
      {
        label: 'poi',
        detected: true,
        reason: 'failed search poi',
        source: 'web search',
        status: 'Failed',
        updatedAt: SEARCH.updatedAt,
      },
    ]);
  });
});

describe('getModelModerationDetail — text-scan flag verdicts', () => {
  it('returns the verdict that set each flag, beside the latest scan', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      id: 7,
      name: 'm',
      poi: true,
      minor: true,
      meta: {
        textScanFlags: {
          poi: {
            at: '2026-09-01T00:00:00.000Z',
            workflowId: 'wf-poi',
            reason: 'Names a real actor.',
            names: ['Jane Doe'],
            textHash: 'h1',
            model: 'llm-1',
          },
          minor: {
            at: '2026-09-02T00:00:00.000Z',
            workflowId: 'wf-minor',
            reason: 'Says the character is 15.',
            appealGranted: { at: '2026-09-03T00:00:00.000Z', by: 4, textHash: 'h2' },
          },
        },
      },
    } as never);
    rows = { 'Model:search': SEARCH };

    const { textScanFlags } = await getModelModerationDetail({ id: 7 });

    expect(textScanFlags).toEqual([
      {
        label: 'poi',
        reason: 'Names a real actor.',
        names: ['Jane Doe'],
        at: '2026-09-01T00:00:00.000Z',
        workflowId: 'wf-poi',
        model: 'llm-1',
        appealGranted: null,
        appealUpheld: null,
        open: true,
      },
      {
        label: 'minor',
        reason: 'Says the character is 15.',
        names: [],
        at: '2026-09-02T00:00:00.000Z',
        workflowId: 'wf-minor',
        model: null,
        appealGranted: { at: '2026-09-03T00:00:00.000Z', by: 4, textHash: 'h2' },
        appealUpheld: null,
        open: false,
      },
    ]);
  });

  it('skips a ruling stub that carries no workflowId', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      id: 7,
      name: 'm',
      meta: {
        textScanFlags: { poi: { appealGranted: { at: '2026-09-03T00:00:00.000Z', by: 4 } } },
      },
    } as never);

    const { textScanFlags } = await getModelModerationDetail({ id: 7 });

    expect(textScanFlags).toEqual([]);
  });

  it('is empty when the model has no textScanFlags', async () => {
    const { textScanFlags } = await getModelModerationDetail({ id: 7 });
    expect(textScanFlags).toEqual([]);
  });
});
