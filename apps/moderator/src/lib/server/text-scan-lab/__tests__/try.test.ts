import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HarnessClient from '$lib/server/text-scan-lab/harness-client';
import type * as UsersService from '$lib/server/users.service';
import type { Reader } from '$lib/server/chat-read-audit';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const users = vi.hoisted(() => ({ userIdByUsername: vi.fn() }));
vi.mock('$lib/server/users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UsersService>()),
  userIdByUsername: users.userIdByUsername,
}));

const harness = vi.hoisted(() => ({ scanTexts: vi.fn(), composeEntities: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessClient>()),
  ...harness,
}));

const reads = vi.hoisted(() => ({
  recordChatMessageReads: vi.fn(async (_reader: number, _ids: number[]) => {}),
}));
vi.mock('$lib/server/chat-read-audit', () => reads);

const { runTry } = await import('../try');
const { LabHarnessError } = await import('$lib/server/text-scan-lab/harness-client');

const READER = 77 as Reader;
const tryWith = (fields: Record<string, string>, opts?: { only?: 'ModelRules' }) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return runTry(READER, data, opts) as Promise<Record<string, unknown>>;
};

const ok = (key: string, scam: boolean) => ({
  key,
  ok: true,
  workflowId: `wf-${key}`,
  promptIds: {},
  output: { scam: { detected: scam, reason: '' } },
  elapsedMs: 5,
});
const run = (results: unknown[], system: string | null = 'SYS', rules: unknown = null) => ({
  results,
  system,
  rules,
});
const echoScan = (_type: string, texts: { key: string }[]) =>
  Promise.resolve(run(texts.map((t) => ok(t.key, false))));
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
const nothingCalled = () => {
  expect(harness.scanTexts).not.toHaveBeenCalled();
  expect(harness.composeEntities).not.toHaveBeenCalled();
};
const rule = (id: number, subject = 'Example') => ({
  id,
  subject,
  description: '',
  aliases: [],
  enabled: true,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runTry — refusals before any scan', () => {
  it('refuses blank input and more than 50 ids', async () => {
    expect(await tryWith({ input: '   ' })).toMatchObject({ status: 400 });
    const ids = Array.from({ length: 51 }, (_, i) => i + 1).join(',');
    expect(await tryWith({ input: ids })).toMatchObject({ status: 400 });
    nothingCalled();
  });

  it('refuses a blank prompt draft by name', async () => {
    const res = await tryWith({
      input: 'buy now',
      prompts: JSON.stringify({ 'label:scam': '  ' }),
    });
    expect((res as { data: { error: string } }).data.error).toBe(
      'Scam / phishing definition is empty — write it, or reset it to current.'
    );
    nothingCalled();
  });

  it('refuses an unknown prompt key as unknown', async () => {
    const res = await tryWith({ input: 'x', prompts: JSON.stringify({ 'label:retired': '' }) });
    expect((res as { data: { error: string } }).data.error).toMatch(
      /^Unknown prompt key label:retired/
    );
    nothingCalled();
  });

  it('refuses rule drafts that share an id, and id 0', async () => {
    for (const rules of [[rule(-1), rule(-1, 'Other')], [rule(0)]])
      expect(await tryWith({ input: 'x', rules: JSON.stringify(rules) })).toMatchObject({
        status: 400,
      });
    nothingCalled();
  });

  it('refuses a profile link on the Model rules page', async () => {
    const res = await tryWith(
      { input: 'https://civitai.com/user/someone' },
      { only: 'ModelRules' }
    );
    expect(res).toMatchObject({ status: 400 });
    nothingCalled();
  });
});

describe('runTry — more refusals', () => {
  it('judges text up to the scan limit and refuses longer text, naming the limit', async () => {
    harness.scanTexts.mockImplementation(echoScan);
    await tryWith({ input: 'a'.repeat(600_000) });
    expect(harness.scanTexts).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    const res = await tryWith({ input: 'a'.repeat(600_001) });
    expect(res).toMatchObject({ status: 400 });
    expect((res as { data: { error: string } }).data.error).toContain('600,000 characters');
    nothingCalled();
  });

  it("refuses links to different kinds of content with the parser's notice", async () => {
    const res = await tryWith({
      input: 'https://civitai.com/models/1 https://civitai.com/articles/2',
    });
    expect(res).toMatchObject({ status: 400 });
    expect((res as { data: { error: string } }).data.error).toMatch(/different kinds/);
    nothingCalled();
  });

  it('refuses a profile link whose user does not exist', async () => {
    users.userIdByUsername.mockResolvedValue(null);
    expect(await tryWith({ input: 'https://civitai.com/user/nobody' })).toMatchObject({
      status: 400,
    });
    nothingCalled();
  });

  it('refuses when nothing could be loaded', async () => {
    harness.composeEntities.mockResolvedValue([{ entityId: 8, ok: false, error: 'too-short' }]);
    expect(await tryWith({ input: '8' })).toMatchObject({ status: 400 });
    expect(harness.scanTexts).not.toHaveBeenCalled();
  });

  it('names an unknown key as unknown even when it and a known key are blank', async () => {
    const res = await tryWith({
      input: 'buy now',
      prompts: JSON.stringify({ 'label:retired': '', 'label:scam': '' }),
    });
    expect(res).toMatchObject({ status: 400 });
    const { error } = (res as { data: { error: string } }).data;
    expect(error).toMatch(/^Unknown prompt key label:retired/);
    expect(error).not.toContain('undefined');
    nothingCalled();
  });
});

describe('runTry — what gets scanned', () => {
  it('judges text as the chosen type under its default heading, with active prompts only', async () => {
    harness.scanTexts.mockImplementation(echoScan);
    const res = await tryWith({ input: 'buy now', judgeAs: 'Comment' });
    expect(harness.scanTexts).toHaveBeenCalledWith('Comment', [
      { key: 'text', fields: [{ heading: 'Comment', text: 'buy now' }] },
    ]);
    expect(harness.scanTexts).toHaveBeenCalledTimes(1);
    expect(harness.scanTexts.mock.calls[0]).toHaveLength(2);
    expect(res).toMatchObject({
      tried: true,
      entityType: 'Comment',
      labels: ['scam'],
      items: [{ key: 'text', current: { ok: true }, edited: null }],
      current: { system: 'SYS', rules: null },
      edited: null,
    });
  });

  it('judges as the first type that uses an edited label when the chosen one does not', async () => {
    harness.scanTexts.mockImplementation(echoScan);
    await tryWith({
      input: 'buy now',
      judgeAs: 'Article',
      prompts: JSON.stringify({ 'label:scam': 'SCAM DEF' }),
    });
    expect(harness.scanTexts.mock.calls[0][0]).toBe('ChatMessage');
  });

  it("uses a link's own type whatever Look up as says", async () => {
    composeAll();
    harness.scanTexts.mockImplementation(echoScan);
    await tryWith({ input: 'https://civitai.com/posts/9', lookupAs: 'Model' });
    expect(harness.composeEntities).toHaveBeenCalledWith('Post', [9]);
  });

  it('judges a model link by its rules scan on the Model rules page', async () => {
    composeAll();
    harness.scanTexts.mockImplementation(echoScan);
    await tryWith({ input: 'https://civitai.com/models/7' }, { only: 'ModelRules' });
    expect(harness.composeEntities).toHaveBeenCalledWith('ModelRules', [7]);
    expect(harness.scanTexts.mock.calls[0][0]).toBe('ModelRules');
  });

  it('resolves a profile link to its account', async () => {
    users.userIdByUsername.mockResolvedValue(42);
    composeAll();
    harness.scanTexts.mockImplementation(echoScan);
    await tryWith({ input: 'https://civitai.com/user/SomeOne', profileAs: 'User' });
    expect(harness.composeEntities).toHaveBeenCalledWith('User', [42]);
  });

  it('judges an unknown link as text and passes its notice on', async () => {
    harness.scanTexts.mockImplementation(echoScan);
    const res = await tryWith({ input: 'https://example.com/x' });
    expect(harness.scanTexts).toHaveBeenCalledWith('CommentV2', expect.any(Array));
    expect((res as { notice: string }).notice).toBeTruthy();
  });

  it('records looking chat messages up as a read of them, and nothing else as one', async () => {
    composeAll();
    harness.scanTexts.mockImplementation(echoScan);
    reads.recordChatMessageReads.mockClear();
    await tryWith({ input: '7, 8', lookupAs: 'ChatMessage' });
    expect(reads.recordChatMessageReads).toHaveBeenCalledWith(READER, [7, 8]);

    reads.recordChatMessageReads.mockClear();
    await tryWith({ input: '7, 8', lookupAs: 'Article' });
    expect(reads.recordChatMessageReads).not.toHaveBeenCalled();
  });

  it('looks bare ids up as the chosen type', async () => {
    composeAll();
    harness.scanTexts.mockImplementation(echoScan);
    await tryWith({ input: '7, 8', lookupAs: 'Article' });
    expect(harness.composeEntities).toHaveBeenCalledWith('Article', [7, 8]);
    expect(harness.scanTexts).toHaveBeenCalledWith('Article', expect.any(Array));
  });

  it('checks 50 ids at once', async () => {
    composeAll();
    harness.scanTexts.mockImplementation(echoScan);
    const ids = Array.from({ length: 50 }, (_, i) => i + 1).join('\n');
    const res = await tryWith({ input: ids });
    expect((res as { items: unknown[] }).items).toHaveLength(50);
  });

  it('passes a per-item error through verbatim', async () => {
    harness.scanTexts.mockResolvedValue(
      run([{ key: 'text', ok: false, error: 'orchestrator: quota exceeded' }])
    );
    expect(await tryWith({ input: 'hello' })).toMatchObject({
      items: [{ current: { ok: false, error: 'orchestrator: quota exceeded' } }],
    });
  });

  it('scans only composed entities and reports the rest verbatim', async () => {
    harness.composeEntities.mockResolvedValue([
      { entityId: 7, ok: true, fields: [{ heading: 'Name', text: 'x' }], text: '', userId: 70 },
      { entityId: 8, ok: false, error: 'entity not found' },
    ]);
    harness.scanTexts.mockImplementation(echoScan);
    const res = await tryWith({ input: '7 8' });
    expect(res).toMatchObject({
      items: [{ key: '7', entityId: 7, authorId: 70 }],
      skipped: [{ entityId: 8, error: 'entity not found' }],
    });
  });

  it('returns a whole-request refusal as 502 with its message', async () => {
    harness.scanTexts.mockRejectedValue(new LabHarnessError('Not signed in to the main app'));
    expect(await tryWith({ input: 'hello' })).toMatchObject({
      status: 502,
      data: { error: 'Not signed in to the main app' },
    });
  });
});

describe('runTry — with drafts', () => {
  it('ignores rule drafts unless the judged type is ModelRules', async () => {
    composeAll();
    harness.scanTexts.mockImplementation(echoScan);
    const res = await tryWith({
      input: '7',
      lookupAs: 'Article',
      rules: JSON.stringify([rule(-1)]),
    });
    expect(res).toMatchObject({ entityType: 'Article', edited: null });
    expect(harness.scanTexts).toHaveBeenCalledTimes(1);
    expect(harness.scanTexts.mock.calls[0]).toHaveLength(2);
  });

  it('sends both kinds of draft to the edited run only', async () => {
    composeAll();
    harness.scanTexts.mockImplementation(
      (_type: string, texts: { key: string }[], overrides?: unknown) =>
        Promise.resolve(
          run(
            texts.map((t) => ok(t.key, overrides !== undefined)),
            overrides ? 'EDITED SYS' : 'SYS',
            overrides ? [{ id: -1, subject: 'New' }] : null
          )
        )
    );
    const res = await tryWith(
      {
        input: 'https://civitai.com/models/7',
        prompts: JSON.stringify({ 'label:modelRules': 'POLICY' }),
        rules: JSON.stringify([rule(-1, 'New')]),
      },
      { only: 'ModelRules' }
    );
    expect(harness.scanTexts).toHaveBeenCalledTimes(2);
    expect(harness.scanTexts.mock.calls[0]).toHaveLength(2);
    expect(harness.scanTexts.mock.calls[1][2]).toEqual({
      prompts: { 'label:modelRules': 'POLICY' },
      rules: [rule(-1, 'New')],
    });
    expect(res).toMatchObject({
      current: { system: 'SYS', rules: null },
      edited: { system: 'EDITED SYS', rules: [{ id: -1, subject: 'New' }] },
      items: [{ current: { ok: true }, edited: { ok: true } }],
    });
  });

  it('keeps the current verdicts when only the edited run is refused', async () => {
    harness.scanTexts.mockImplementation(
      (_type: string, texts: { key: string }[], overrides?: unknown) =>
        overrides
          ? Promise.reject(new LabHarnessError('override too long'))
          : echoScan(_type, texts)
    );
    const res = await tryWith({ input: 'buy now', prompts: JSON.stringify({ base: 'BASE' }) });
    expect(res).toMatchObject({
      items: [{ current: { ok: true }, edited: { ok: false, error: 'override too long' } }],
      edited: { system: null, rules: null },
    });
  });
});
