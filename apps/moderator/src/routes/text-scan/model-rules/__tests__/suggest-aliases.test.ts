import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
const endpoint = vi.hoisted(() => ({ callModEndpoint: vi.fn() }));
vi.mock('$lib/server/user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/user-actions.service')>()),
  ...endpoint,
}));

const { runSuggestAliases } = await import('../suggest-aliases.server');

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
      answered({ ok: true, suggestions: [suggestion], costTotal: 4 })
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
    expect(result).toEqual({ suggested: true, suggestions: [suggestion] });
  });

  it('allows more time than the default for the web search', async () => {
    endpoint.callModEndpoint.mockResolvedValue(answered({ ok: true, suggestions: [] }));
    await runSuggestAliases(form({ subject: 'Alpha' }));
    expect(endpoint.callModEndpoint.mock.calls[0][3]).toBeGreaterThan(90_000);
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
      answered({ ok: true, suggestions: [{ alias: 5, kind: 'stage_name' }] })
    );
    expect(await runSuggestAliases(form({ subject: 'Alpha' }))).toMatchObject({ status: 502 });
  });

  it('drops a source that is not an http(s) link', async () => {
    endpoint.callModEndpoint.mockResolvedValue(
      answered({ ok: true, suggestions: [{ ...suggestion, source: 'javascript:alert(1)' }] })
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
