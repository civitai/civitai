import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Check page's `check` action with the harness faked. What matters is what reaches the harness —
 * and what is refused before anything does.
 */

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const users = vi.hoisted(() => ({ userIdByUsername: vi.fn() }));
vi.mock('$lib/server/users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/users.service')>()),
  userIdByUsername: users.userIdByUsername,
}));

const harness = vi.hoisted(() => ({
  scanTexts: vi.fn(),
  composeEntities: vi.fn(),
}));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/harness-client')>()),
  ...harness,
}));

const { actions } = await import('../+page.server');
const { LabHarnessError } = await import('$lib/server/text-scan-lab/harness-client');

const check = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    locals: { user: { id: 1 }, grants: {} },
  } as unknown as Parameters<typeof actions.check>[0];
  return actions.check(event) as Promise<Record<string, unknown>>;
};

const ok = (key: string, scam: boolean) => ({
  key,
  ok: true,
  workflowId: `wf-${key}`,
  promptIds: {},
  output: { scam: { detected: scam, reason: '' } },
  elapsedMs: 5,
});
const echoScan = (_type: string, texts: { key: string }[]) =>
  Promise.resolve(texts.map((t) => ok(t.key, false)));
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('check — refusals before any scan', () => {
  it('refuses blank input', async () => {
    expect(await check({ input: '   ' })).toMatchObject({ status: 400 });
    nothingCalled();
  });

  it('refuses more than 50 ids', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1).join(',');
    expect(await check({ input: ids })).toMatchObject({ status: 400 });
    nothingCalled();
  });

  it("refuses links to different kinds of content with the parser's notice", async () => {
    const res = await check({
      input: 'https://civitai.com/models/1 https://civitai.com/articles/2',
    });
    expect(res).toMatchObject({ status: 400 });
    expect((res as { data: { error: string } }).data.error).toMatch(/different kinds/);
    nothingCalled();
  });
});

describe('check — what gets scanned', () => {
  it('judges text as the chosen type under its default heading, with active prompts only', async () => {
    harness.scanTexts.mockImplementation(echoScan);
    const res = await check({ input: 'buy now', judgeAs: 'Comment' });
    expect(harness.scanTexts).toHaveBeenCalledWith('Comment', [
      { key: 'text', fields: [{ heading: 'Comment', text: 'buy now' }] },
    ]);
    expect(harness.scanTexts.mock.calls[0]).toHaveLength(2);
    expect(res).toMatchObject({
      checked: true,
      entityType: 'Comment',
      labels: ['scam'],
      notice: null,
      items: [{ key: 'text', current: { ok: true, output: { scam: { detected: false } } } }],
    });
  });

  it('judges an unknown link as text and passes its notice on', async () => {
    harness.scanTexts.mockImplementation(echoScan);
    const res = await check({ input: 'https://example.com/x' });
    expect(harness.scanTexts).toHaveBeenCalledWith('CommentV2', expect.any(Array));
    expect((res as { notice: string }).notice).toBeTruthy();
  });

  it('looks bare ids up as the chosen type', async () => {
    composeAll();
    harness.scanTexts.mockImplementation(echoScan);
    await check({ input: '7, 8', lookupAs: 'Article' });
    expect(harness.composeEntities).toHaveBeenCalledWith('Article', [7, 8]);
    expect(harness.scanTexts).toHaveBeenCalledWith('Article', expect.any(Array));
  });

  it("uses a link's own type whatever Look up as says", async () => {
    composeAll();
    harness.scanTexts.mockImplementation(echoScan);
    await check({ input: 'https://civitai.com/posts/9', lookupAs: 'Model' });
    expect(harness.composeEntities).toHaveBeenCalledWith('Post', [9]);
  });

  it('checks 50 ids at once without asking for confirmation', async () => {
    composeAll();
    harness.scanTexts.mockImplementation(echoScan);
    const ids = Array.from({ length: 50 }, (_, i) => i + 1).join('\n');
    const res = await check({ input: ids });
    expect((res as { items: unknown[] }).items).toHaveLength(50);
  });

  it('resolves a profile link to its account and scans the chosen profile type', async () => {
    users.userIdByUsername.mockResolvedValue(42);
    composeAll();
    harness.scanTexts.mockImplementation(echoScan);
    await check({ input: 'https://civitai.com/user/SomeOne', profileAs: 'User' });
    expect(users.userIdByUsername).toHaveBeenCalledWith('SomeOne');
    expect(harness.composeEntities).toHaveBeenCalledWith('User', [42]);
  });

  it('refuses a profile link whose user does not exist', async () => {
    users.userIdByUsername.mockResolvedValue(null);
    const res = await check({ input: 'https://civitai.com/user/nobody' });
    expect(res).toMatchObject({ status: 400 });
    nothingCalled();
  });
});

describe('check — failures', () => {
  it('scans only composed entities and reports the rest verbatim', async () => {
    harness.composeEntities.mockResolvedValue([
      { entityId: 7, ok: true, fields: [{ heading: 'Name', text: 'x' }], text: '', userId: 70 },
      { entityId: 8, ok: false, error: 'entity not found' },
    ]);
    harness.scanTexts.mockImplementation(echoScan);
    const res = await check({ input: '7 8' });
    expect(harness.scanTexts.mock.calls[0][1]).toEqual([
      { key: '7', fields: [{ heading: 'Name', text: 'x' }] },
    ]);
    expect(res).toMatchObject({
      items: [{ key: '7', entityId: 7, authorId: 70 }],
      skipped: [{ entityId: 8, error: 'entity not found' }],
    });
  });

  it('refuses when nothing could be loaded', async () => {
    harness.composeEntities.mockResolvedValue([{ entityId: 8, ok: false, error: 'too-short' }]);
    const res = await check({ input: '8' });
    expect(res).toMatchObject({ status: 400 });
    expect(harness.scanTexts).not.toHaveBeenCalled();
  });

  it('passes a per-item error through verbatim', async () => {
    harness.scanTexts.mockResolvedValue([
      { key: 'text', ok: false, error: 'orchestrator: quota exceeded' },
    ]);
    const res = await check({ input: 'hello' });
    expect(res).toMatchObject({
      items: [{ current: { ok: false, error: 'orchestrator: quota exceeded' } }],
    });
  });

  it('returns a whole-request refusal as 502 with its message', async () => {
    harness.scanTexts.mockRejectedValue(new LabHarnessError('Not signed in to the main app'));
    const res = await check({ input: 'hello' });
    expect(res).toMatchObject({ status: 502, data: { error: 'Not signed in to the main app' } });
  });
});

describe('check — with my changes', () => {
  const overrides = (prompts: Record<string, string>) => JSON.stringify(prompts);

  it('scans current and changed in parallel, the changed run with the overrides', async () => {
    harness.scanTexts.mockImplementation(
      (_type: string, texts: { key: string }[], promptOverrides?: Record<string, string>) =>
        Promise.resolve(texts.map((t) => ok(t.key, promptOverrides !== undefined)))
    );
    const res = await check({
      input: 'buy now',
      overrides: overrides({ 'label:scam': 'SCAM DEF' }),
    });
    expect(harness.scanTexts).toHaveBeenCalledTimes(2);
    expect(harness.scanTexts.mock.calls[0]).toHaveLength(2);
    expect(harness.scanTexts.mock.calls[1][2]).toEqual({ 'label:scam': 'SCAM DEF' });
    expect(res).toMatchObject({
      items: [
        {
          current: { ok: true, output: { scam: { detected: false } } },
          changed: { ok: true, output: { scam: { detected: true } } },
        },
      ],
    });
  });

  it('runs once, with changed null, when there are no overrides', async () => {
    harness.scanTexts.mockImplementation(echoScan);
    const res = await check({ input: 'buy now', overrides: '{}' });
    expect(harness.scanTexts).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ items: [{ changed: null }] });
  });

  it('refuses a blank override by name before any scan', async () => {
    const res = await check({ input: 'buy now', overrides: overrides({ 'label:scam': '  ' }) });
    expect(res).toMatchObject({ status: 400 });
    expect((res as { data: { error: string } }).data.error).toBe(
      'Scam / phishing definition is empty — write it, or reset it to current.'
    );
    nothingCalled();
  });

  it('refuses an unknown key as unknown, even when it is blank', async () => {
    const res = await check({
      input: 'buy now',
      overrides: overrides({ 'label:retired': '', 'label:scam': '' }),
    });
    expect(res).toMatchObject({ status: 400 });
    const { error } = (res as { data: { error: string } }).data;
    expect(error).toMatch(/^Unknown prompt key label:retired/);
    expect(error).not.toContain('undefined');
    nothingCalled();
  });

  it('keeps the current verdicts when only the changed run is refused', async () => {
    harness.scanTexts.mockImplementation(
      (_type: string, texts: { key: string }[], promptOverrides?: Record<string, string>) =>
        promptOverrides
          ? Promise.reject(new LabHarnessError('override too long'))
          : echoScan(_type, texts)
    );
    const res = await check({ input: 'buy now', overrides: overrides({ base: 'BASE PROMPT' }) });
    expect(res).toMatchObject({
      items: [
        {
          current: { ok: true },
          changed: { ok: false, error: 'override too long' },
        },
      ],
    });
  });
});
