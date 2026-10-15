import { describe, expect, it, vi } from 'vitest';
import type * as RulesService from '$lib/server/model-rules.service';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/cache', () => ({ bustKeyBestEffort: vi.fn(async () => true) }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
const service = vi.hoisted(() => ({ listModelRuleVersions: vi.fn(async () => []) }));
vi.mock('$lib/server/model-rules.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RulesService>()),
  ...service,
}));

const { GET } = await import('../history/+server');
const at = (query: string) =>
  ({ url: new URL(`http://x/text-scan/model-rules/history${query}`) } as never);

describe('rule history', () => {
  it('refuses a malformed rule id', async () => {
    await expect(Promise.resolve().then(() => GET(at('?rule=abc')))).rejects.toMatchObject({
      status: 400,
    });
    expect(service.listModelRuleVersions).not.toHaveBeenCalled();
  });

  it('returns an empty history for a rule saved before history was kept', async () => {
    const res = await GET(at('?rule=7'));
    expect(await res.json()).toEqual([]);
    expect(service.listModelRuleVersions).toHaveBeenCalledWith(7);
  });
});
