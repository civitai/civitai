import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
const endpoint = vi.hoisted(() => ({ callModEndpoint: vi.fn() }));
vi.mock('$lib/server/user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/user-actions.service')>()),
  ...endpoint,
}));

const { runSuggestAliases, runAliasSuggestionResult } = await import('../suggest-aliases.server');

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return data;
};
const suggestion = {
  alias: 'Some Name',
  kind: 'stage_name',
  note: 'why',
  source: 'https://example.com',
};
const answered = (body: unknown) => ({ ok: true as const, body });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runSuggestAliases', () => {
  it('sends the rule as the form holds it, aliases as a list, and returns the suggestions', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answered({ ok: true, status: 'done', suggestions: [suggestion], costTotal: 4 })
    );

    const result = await runSuggestAliases(
      form({ subject: ' Alpha Beta ', description: 'About', aliases: 'One\none\nTwo' })
    );

    expect(endpoint.callModEndpoint).toHaveBeenCalledExactlyOnceWith(
      'text-scan',
      {
        action: 'suggestModelRuleAliases',
        subject: 'Alpha Beta',
        description: 'About',
        existingAliases: ['One', 'Two'],
      },
      expect.any(String),
      expect.any(Number)
    );
    expect(result).toEqual({
      suggested: true,
      status: 'done',
      suggestions: [suggestion],
      costTotal: 4,
    });
  });

  it('keeps a suggestion whose kind this app does not know, filed under other', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answered({ ok: true, status: 'done', suggestions: [{ ...suggestion, kind: 'nickname' }] })
    );
    expect(await runSuggestAliases(form({ subject: 'Alpha' }))).toMatchObject({
      suggestions: [{ alias: 'Some Name', kind: 'other' }],
    });
  });

  it('leaves the cost out when the main app reports none', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answered({ ok: true, status: 'done', suggestions: [] })
    );
    expect(await runSuggestAliases(form({ subject: 'Alpha' }))).toEqual({
      suggested: true,
      status: 'done',
      suggestions: [],
    });
  });

  it('returns the workflow id while the search is still running', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answered({ ok: true, status: 'pending', workflowId: 'wf_0123456789' })
    );
    expect(await runSuggestAliases(form({ subject: 'Alpha' }))).toEqual({
      suggested: true,
      status: 'pending',
      workflowId: 'wf_0123456789',
    });
  });

  it('does not hold the request open for the search', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answered({ ok: true, status: 'pending', workflowId: 'wf_0123456789' })
    );
    await runSuggestAliases(form({ subject: 'Alpha' }));
    expect(endpoint.callModEndpoint.mock.calls[0][3]).toBeLessThanOrEqual(45_000);
  });

  it('refuses a blank subject before spending anything', async () => {
    expect(await runSuggestAliases(form({ subject: '  ' }))).toMatchObject({ status: 400 });
    expect(endpoint.callModEndpoint).not.toHaveBeenCalled();
  });

  it('surfaces a refusal from the main app', async () => {
    endpoint.callModEndpoint.mockResolvedValue({ ok: false, error: 'rate limited', status: 429 });
    expect(await runSuggestAliases(form({ subject: 'Alpha' }))).toMatchObject({
      status: 502,
      data: { error: 'rate limited' },
    });
  });

  it('surfaces the model-side error the main app reports', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answered({ ok: false, error: 'The model’s answer was not valid JSON.' })
    );
    expect(await runSuggestAliases(form({ subject: 'Alpha' }))).toMatchObject({
      status: 502,
      data: { error: 'The model’s answer was not valid JSON.' },
    });
  });

  it('does not trust an unreadable answer', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answered({ ok: true, status: 'done', suggestions: [{ alias: 5, kind: 'stage_name' }] })
    );
    expect(await runSuggestAliases(form({ subject: 'Alpha' }))).toMatchObject({ status: 502 });
  });

  it('drops a source that is not an http(s) link', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answered({
        ok: true,
        status: 'done',
        suggestions: [{ ...suggestion, source: 'javascript:alert(1)' }],
      })
    );
    const result = await runSuggestAliases(form({ subject: 'Alpha' }));
    expect(result).toMatchObject({ suggestions: [{ alias: 'Some Name' }] });
    expect(
      (result as { suggestions: { source?: string }[] }).suggestions[0].source
    ).toBeUndefined();
  });

  it('never retries', async () => {
    endpoint.callModEndpoint.mockResolvedValue({ ok: false, error: 'boom', status: 500 });
    await runSuggestAliases(form({ subject: 'Alpha' }));
    expect(endpoint.callModEndpoint).toHaveBeenCalledTimes(1);
  });
});

describe('runAliasSuggestionResult', () => {
  const fields = { workflowId: 'wf_0123456789', subject: ' Alpha ', aliases: 'One\nTwo' };

  it('asks the main app about that workflow for that rule', async () => {
    endpoint.callModEndpoint.mockResolvedValue(answered({ ok: true, status: 'pending' }));
    expect(await runAliasSuggestionResult(form(fields))).toEqual({
      suggested: true,
      status: 'pending',
    });
    expect(endpoint.callModEndpoint).toHaveBeenCalledExactlyOnceWith(
      'text-scan',
      {
        action: 'aliasSuggestionResult',
        workflowId: 'wf_0123456789',
        subject: 'Alpha',
        existingAliases: ['One', 'Two'],
      },
      expect.any(String),
      expect.any(Number)
    );
  });

  it('returns the suggestions once done', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answered({ ok: true, status: 'done', suggestions: [suggestion], costTotal: 2 })
    );
    expect(await runAliasSuggestionResult(form(fields))).toEqual({
      suggested: true,
      status: 'done',
      suggestions: [suggestion],
      costTotal: 2,
    });
  });

  it('returns a failed search as an answer, not a transport error', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answered({ ok: true, status: 'failed', error: 'workflow wf failed' })
    );
    expect(await runAliasSuggestionResult(form(fields))).toEqual({
      suggested: true,
      status: 'failed',
      error: 'workflow wf failed',
    });
  });

  it('refuses a malformed workflow id before calling the main app', async () => {
    expect(await runAliasSuggestionResult(form({ ...fields, workflowId: '../x' }))).toMatchObject({
      status: 400,
    });
    expect(endpoint.callModEndpoint).not.toHaveBeenCalled();
  });

  it('surfaces a refusal from the main app as a transport error', async () => {
    endpoint.callModEndpoint.mockResolvedValue({ ok: false, error: 'down', status: 502 });
    expect(await runAliasSuggestionResult(form(fields))).toMatchObject({
      status: 502,
      data: { error: 'down' },
    });
    endpoint.callModEndpoint.mockResolvedValue(answered({ ok: false, error: 'not ours' }));
    expect(await runAliasSuggestionResult(form(fields))).toMatchObject({
      status: 502,
      data: { error: 'not ours' },
    });
  });
});
