import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const harness = vi.hoisted(() => ({ composeEntities: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/harness-client')>()),
  ...harness,
}));
const compose = vi.hoisted(() => ({ normaliseLabFields: vi.fn() }));
vi.mock('$lib/text-scan-lab/compose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/text-scan-lab/compose')>();
  compose.normaliseLabFields.mockImplementation(actual.normaliseLabFields);
  return { ...actual, ...compose };
});
const endpoint = vi.hoisted(() => ({ callModEndpoint: vi.fn() }));
vi.mock('$lib/server/user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/user-actions.service')>()),
  ...endpoint,
}));

const { runLiteralTry } = await import('../literal-try.server');
const { matchedRules } = await import('../literal-try');

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return data;
};
const match = (ruleId: number, term: string, start = 0, end = term.length) => ({
  ruleId,
  term,
  field: 'Name',
  fieldIndex: 0,
  start,
  end,
});
const answer = (results: unknown[], rules = [{ id: 1, subject: 'Subject One' }]) => ({
  ok: true as const,
  body: { rules, results },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runLiteralTry', () => {
  it('judges pasted text against the rules and returns where they matched', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answer([{ key: 'text', matches: [match(1, 'abc')] }])
    );

    const result = await runLiteralTry(form({ input: 'an abc sample' }));

    expect(endpoint.callModEndpoint).toHaveBeenCalledExactlyOnceWith(
      'text-scan',
      {
        action: 'literalModelRules',
        texts: [{ key: 'text', fields: [{ heading: 'Name', text: 'an abc sample' }] }],
      },
      expect.any(String)
    );
    expect(result).toMatchObject({
      tried: true,
      rules: [{ id: 1, subject: 'Subject One' }],
      items: [
        {
          title: 'Your text',
          fields: [{ heading: 'Name', text: 'an abc sample' }],
          matches: [match(1, 'abc')],
        },
      ],
    });
  });

  it('loads a model by id and judges its fields, naming ones that could not load', async () => {
    harness.composeEntities.mockResolvedValue([
      { entityId: 7, ok: true, fields: [{ heading: 'Name', text: 'seven' }], text: '', userId: 1 },
      { entityId: 8, ok: false, error: 'not found' },
    ]);
    endpoint.callModEndpoint.mockResolvedValue(answer([{ key: '7', matches: [] }]));

    const result = await runLiteralTry(form({ input: '7 8' }));

    expect(harness.composeEntities).toHaveBeenCalledWith('Model', [7, 8]);
    expect(endpoint.callModEndpoint.mock.calls[0][1].texts).toEqual([
      { key: '7', fields: [{ heading: 'Name', text: 'seven' }] },
    ]);
    expect(result).toMatchObject({
      items: [{ title: 'Model 7', matches: [] }],
      skipped: [{ entityId: 8, error: 'not found' }],
    });
  });

  it('sends the edited rules so an unsaved edit can be tried', async () => {
    endpoint.callModEndpoint.mockResolvedValue(answer([{ key: 'text', matches: [] }]));
    const rules = [
      { id: -1, subject: 'New one', description: '', aliases: ['x y z'], enabled: true },
    ];

    await runLiteralTry(form({ input: 'text', rules: JSON.stringify(rules) }));

    expect(endpoint.callModEndpoint.mock.calls[0][1].ruleOverrides).toEqual(rules);
  });

  it.each([
    ['', 400],
    ['https://civitai.com/user/someone', 400],
    ['https://civitai.com/articles/5', 400],
  ])('refuses %j before calling the main app', async (input, status) => {
    expect(await runLiteralTry(form({ input }))).toMatchObject({ status });
    expect(endpoint.callModEndpoint).not.toHaveBeenCalled();
    expect(harness.composeEntities).not.toHaveBeenCalled();
  });

  it('refuses malformed rule edits', async () => {
    expect(await runLiteralTry(form({ input: 'text', rules: '[{"id":0}]' }))).toMatchObject({
      status: 400,
    });
    expect(endpoint.callModEndpoint).not.toHaveBeenCalled();
  });

  it('reports a refusal from the main app instead of an empty result', async () => {
    endpoint.callModEndpoint.mockResolvedValue({ ok: false, error: 'rate limited', status: 429 });
    expect(await runLiteralTry(form({ input: 'text' }))).toMatchObject({
      status: 502,
      data: { error: 'rate limited' },
    });
  });

  it('refuses when none of the models could load', async () => {
    harness.composeEntities.mockResolvedValue([{ entityId: 8, ok: false, error: 'not found' }]);
    expect(await runLiteralTry(form({ input: '8' }))).toMatchObject({ status: 400 });
    expect(endpoint.callModEndpoint).not.toHaveBeenCalled();
  });
});

describe('runLiteralTry planning', () => {
  it('refuses more ids than one try can take, naming the limit', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1).join(' ');
    const result = await runLiteralTry(form({ input: ids }));
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/51 ids is more than the 50/) },
    });
    expect(harness.composeEntities).not.toHaveBeenCalled();
    expect(endpoint.callModEndpoint).not.toHaveBeenCalled();
  });

  it('shows the checker notice when links of different kinds are pasted', async () => {
    const result = await runLiteralTry(
      form({ input: 'https://civitai.com/models/1 https://civitai.com/posts/2' })
    );
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining('different kinds of content') },
    });
    expect(endpoint.callModEndpoint).not.toHaveBeenCalled();
  });

  it('loads a model link as an id', async () => {
    harness.composeEntities.mockResolvedValue([
      { entityId: 5, ok: true, fields: [{ heading: 'Name', text: 'five' }], text: '', userId: 1 },
    ]);
    endpoint.callModEndpoint.mockResolvedValue(answer([{ key: '5', matches: [] }]));
    const result = await runLiteralTry(form({ input: 'https://civitai.com/models/5/some-slug' }));
    expect(harness.composeEntities).toHaveBeenCalledWith('Model', [5]);
    expect(result).toMatchObject({ items: [{ title: 'Model 5' }], notice: null });
  });

  it('judges an unknown link as text and carries the notice', async () => {
    endpoint.callModEndpoint.mockResolvedValue(answer([{ key: 'text', matches: [] }]));
    const result = await runLiteralTry(form({ input: 'https://example.com/page' }));
    expect(endpoint.callModEndpoint.mock.calls[0][1].texts).toEqual([
      { key: 'text', fields: [{ heading: 'Name', text: 'https://example.com/page' }] },
    ]);
    expect(result).toMatchObject({
      tried: true,
      notice: expect.stringContaining('judged as text'),
    });
  });

  it('refuses text whose fields do not normalise', async () => {
    compose.normaliseLabFields.mockReturnValueOnce('Every field needs a heading.');
    expect(await runLiteralTry(form({ input: 'some text' }))).toMatchObject({
      status: 400,
      data: { error: 'Every field needs a heading.' },
    });
    compose.normaliseLabFields.mockReturnValueOnce([]);
    expect(await runLiteralTry(form({ input: 'some text' }))).toMatchObject({ status: 400 });
    expect(endpoint.callModEndpoint).not.toHaveBeenCalled();
  });
});

describe('runLiteralTry reading the main app answer', () => {
  it.each([
    ['has no results', { rules: [] }],
    ['has no rules', { results: [] }],
    ['has results that are not a list', { rules: [], results: {} }],
    [
      'has a match without an offset',
      { rules: [], results: [{ key: 'text', matches: [{ ruleId: 1 }] }] },
    ],
  ])('surfaces a body that %s as an error, never as no match', async (_n, body) => {
    endpoint.callModEndpoint.mockResolvedValue({ ok: true, body });
    expect(await runLiteralTry(form({ input: 'text' }))).toMatchObject({
      status: 502,
      data: { error: expect.stringContaining('unreadable') },
    });
  });

  it('surfaces a subject the answer left out, naming it', async () => {
    harness.composeEntities.mockResolvedValue([
      { entityId: 7, ok: true, fields: [{ heading: 'Name', text: 'seven' }], text: '', userId: 1 },
      { entityId: 8, ok: true, fields: [{ heading: 'Name', text: 'eight' }], text: '', userId: 1 },
    ]);
    endpoint.callModEndpoint.mockResolvedValue(answer([{ key: '7', matches: [] }]));
    expect(await runLiteralTry(form({ input: '7 8' }))).toMatchObject({
      status: 502,
      data: { error: expect.stringContaining('Model 8') },
    });
  });
});

describe('matchedRules', () => {
  it('groups the matches by rule, naming each by its subject and listing the terms once', () => {
    const rules = [
      { id: 1, subject: 'Subject One' },
      { id: 2, subject: 'Subject Two' },
    ];
    expect(
      matchedRules(
        [match(2, 'beta'), match(1, 'alpha'), match(2, 'beta', 9, 13), match(2, 'b2')],
        rules
      )
    ).toEqual([
      { ruleId: 2, subject: 'Subject Two', terms: ['beta', 'b2'] },
      { ruleId: 1, subject: 'Subject One', terms: ['alpha'] },
    ]);
  });

  it('falls back to the rule id when the rule is not in the list', () => {
    expect(matchedRules([match(5, 'x')], [])).toEqual([
      { ruleId: 5, subject: 'Rule 5', terms: ['x'] },
    ]);
  });
});
