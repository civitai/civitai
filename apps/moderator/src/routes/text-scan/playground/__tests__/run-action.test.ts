import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The playground's `run` action with the harness faked. Every scan is billed, so what matters is
 * what reaches the harness — and what is refused before anything does.
 */

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: vi.fn() }));

const drafts = vi.hoisted(() => ({ getDraft: vi.fn(), listDrafts: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/drafts.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/drafts.service')>()),
  getDraft: drafts.getDraft,
  listDrafts: drafts.listDrafts,
}));

const harness = vi.hoisted(() => ({
  scanTexts: vi.fn(),
  quoteTexts: vi.fn(),
  composeEntities: vi.fn(),
  getPrompts: vi.fn(),
}));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/harness-client')>()),
  ...harness,
}));

const { actions } = await import('../+page.server');
const { LabHarnessError } = await import('$lib/server/text-scan-lab/harness-client');

const run = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    locals: { user: { id: 1 }, grants: {} },
  } as unknown as Parameters<typeof actions.run>[0];
  return actions.run(event) as Promise<Record<string, unknown>>;
};

const textRun = (extra: Record<string, string> = {}) =>
  run({
    entityType: 'Comment',
    mode: 'text',
    fields: JSON.stringify([{ heading: 'Comment', text: 'buy now' }]),
    version: 'inline',
    overrides: JSON.stringify({ 'label:scam': 'SCAM DEF' }),
    ...extra,
  });

const ok = (key: string, scam: boolean) => ({
  key,
  ok: true,
  workflowId: `wf-${key}`,
  promptIds: {},
  output: { scam: { detected: scam, reason: '' } },
  elapsedMs: 5,
});
const echoScan = (scam: boolean) => (_type: string, texts: { key: string }[]) =>
  Promise.resolve(texts.map((t) => ok(t.key, scam)));

const nothingCalled = () => {
  expect(harness.scanTexts).not.toHaveBeenCalled();
  expect(harness.quoteTexts).not.toHaveBeenCalled();
  expect(harness.composeEntities).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('run — version B prompts', () => {
  it('refuses a blank inline override, naming the key, before any harness call', async () => {
    const res = await textRun({
      overrides: JSON.stringify({ base: 'BASE PROMPT', 'label:scam': '   ' }),
    });
    expect(res).toMatchObject({ status: 400 });
    expect((res as { data: { error: string } }).data.error).toContain('label:scam');
    nothingCalled();
  });

  it('refuses inline overrides that override nothing', async () => {
    const res = await textRun({ overrides: '{}' });
    expect(res).toMatchObject({ status: 400 });
    nothingCalled();
  });

  it('refuses a draft that overrides nothing, a missing draft, and no draft', async () => {
    drafts.getDraft.mockResolvedValueOnce({ id: 3, name: 'empty', prompts: {} });
    expect(await textRun({ version: 'draft', draftId: '3' })).toMatchObject({ status: 400 });
    drafts.getDraft.mockResolvedValueOnce(null);
    expect(await textRun({ version: 'draft', draftId: '4' })).toMatchObject({ status: 404 });
    expect(await textRun({ version: 'draft', draftId: '' })).toMatchObject({
      status: 400,
      data: { error: 'Choose a draft for version B.' },
    });
    nothingCalled();
  });

  it("runs A with no overrides and B with the draft's prompts", async () => {
    drafts.getDraft.mockResolvedValue({ id: 3, name: 'd', prompts: { base: 'BASE PROMPT' } });
    harness.scanTexts.mockImplementation((type, texts, overrides) =>
      echoScan(overrides !== undefined)(type, texts)
    );
    const res = await textRun({ version: 'draft', draftId: '3' });
    expect(harness.scanTexts).toHaveBeenCalledTimes(2);
    expect(harness.scanTexts).toHaveBeenCalledWith('Comment', expect.any(Array));
    expect(harness.scanTexts).toHaveBeenCalledWith('Comment', expect.any(Array), {
      base: 'BASE PROMPT',
    });
    expect(res).toMatchObject({
      ran: true,
      versionB: { name: 'Draft · d', keys: ['base'] },
      items: [
        {
          key: 'text',
          fields: [{ heading: 'Comment', text: 'buy now' }],
          a: { output: { scam: { detected: false } } },
          b: { output: { scam: { detected: true } } },
        },
      ],
    });
  });
});

describe('run — failures', () => {
  it('passes a per-item error through verbatim', async () => {
    harness.scanTexts
      .mockResolvedValueOnce([ok('text', false)])
      .mockResolvedValueOnce([{ key: 'text', ok: false, error: 'orchestrator: quota exceeded' }]);
    const res = await textRun();
    expect(res).toMatchObject({
      items: [{ b: { ok: false, error: 'orchestrator: quota exceeded' } }],
    });
  });

  it("keeps the billed side's results when the other side's request fails", async () => {
    harness.scanTexts
      .mockResolvedValueOnce([ok('text', true)])
      .mockRejectedValueOnce(new LabHarnessError('harness timed out'));
    const res = await textRun();
    expect(res).toMatchObject({
      ran: true,
      errors: { a: null, b: 'harness timed out' },
      items: [
        {
          a: { ok: true, output: { scam: { detected: true } } },
          b: { ok: false, error: 'harness timed out' },
        },
      ],
    });
  });

  it('returns a whole-request refusal as 502 with its message', async () => {
    harness.scanTexts.mockRejectedValue(new LabHarnessError('Not signed in to the main app'));
    const res = await textRun();
    expect(res).toMatchObject({ status: 502, data: { error: 'Not signed in to the main app' } });
  });

  it('refuses text with nothing in it', async () => {
    const res = await textRun({ fields: JSON.stringify([{ heading: 'Comment', text: '  ' }]) });
    expect(res).toMatchObject({ status: 400 });
    nothingCalled();
  });
});

describe('run — entities and the quote', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(',\n');
  const entityRun = (idList: string, extra: Record<string, string> = {}) =>
    textRun({ mode: 'entities', entityType: 'Model', ids: idList, ...extra });
  const composeAll = () =>
    harness.composeEntities.mockImplementation((_t, entityIds: number[]) =>
      Promise.resolve(
        entityIds.map((entityId) => ({
          entityId,
          ok: true,
          fields: [{ heading: 'Name', text: `model ${entityId}` }],
          text: '',
          userId: null,
        }))
      )
    );

  it('refuses a non-id token and more than 50 ids before composing', async () => {
    expect(await entityRun('12, abc')).toMatchObject({ status: 400 });
    expect(await entityRun(ids(51))).toMatchObject({ status: 400 });
    nothingCalled();
  });

  it('scans only composed entities and reports the rest', async () => {
    harness.composeEntities.mockResolvedValue([
      { entityId: 7, ok: true, fields: [{ heading: 'Name', text: 'x' }], text: '', userId: 70 },
      { entityId: 8, ok: false, error: 'entity not found' },
      { entityId: 9, ok: false, error: 'too-short' },
    ]);
    harness.scanTexts.mockImplementation(echoScan(false));
    const res = await entityRun('7 8\n9 7');
    expect(harness.composeEntities).toHaveBeenCalledWith('Model', [7, 8, 9]);
    expect(harness.scanTexts.mock.calls[0][1]).toEqual([
      { key: '7', fields: [{ heading: 'Name', text: 'x' }] },
    ]);
    expect(res).toMatchObject({
      items: [{ key: '7', entityId: 7, authorId: 70 }],
      skipped: [
        { entityId: 8, error: 'entity not found' },
        { entityId: 9, error: 'too-short' },
      ],
    });
  });

  it('quotes a run over 10 items instead of scanning it', async () => {
    composeAll();
    harness.quoteTexts
      .mockResolvedValueOnce({ meanCostTotal: 2, count: 11 })
      .mockResolvedValueOnce({ meanCostTotal: 3, count: 11 });
    const res = await entityRun(ids(11));
    expect(res).toMatchObject({ needsConfirm: true, cost: 55, count: 11 });
    expect(harness.scanTexts).not.toHaveBeenCalled();
  });

  it('reports an unknown cost when either side could not be quoted', async () => {
    composeAll();
    harness.quoteTexts
      .mockResolvedValueOnce({ meanCostTotal: 2, count: 11 })
      .mockResolvedValueOnce({ meanCostTotal: null, count: 11 });
    expect(await entityRun(ids(11))).toMatchObject({ needsConfirm: true, cost: null });
  });

  it('scans a run confirmed with its quote stamp without quoting again', async () => {
    composeAll();
    harness.scanTexts.mockImplementation(echoScan(false));
    const res = await entityRun(ids(11), { confirmed: '11:' });
    expect(harness.quoteTexts).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ran: true });
    expect((res as { items: unknown[] }).items).toHaveLength(11);
  });

  it('re-quotes instead of scanning when the confirmed count no longer matches', async () => {
    composeAll();
    harness.quoteTexts.mockResolvedValue({ meanCostTotal: 1, count: 12 });
    const res = await entityRun(ids(12), { confirmed: '11:' });
    expect(res).toMatchObject({ needsConfirm: true, count: 12, stamp: '12:', changed: true });
    expect(harness.scanTexts).not.toHaveBeenCalled();
  });

  it('does not quote 10 items', async () => {
    composeAll();
    harness.scanTexts.mockImplementation(echoScan(false));
    expect(await entityRun(ids(10))).toMatchObject({ ran: true });
    expect(harness.quoteTexts).not.toHaveBeenCalled();
  });
});
