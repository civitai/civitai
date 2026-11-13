import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * User Lookup's `grantCreatorScore` form action: the per-grant ceiling follows the operator's grants.
 * The main app's endpoint enforces the same split; this is what lets a large-grant holder's form
 * reach it at all.
 */

const grantCreatorScore = vi.hoisted(() =>
  vi.fn(async (_input: { userId: number; amount: number; reason: string }) => ({
    ok: true as const,
    total: 10_014_899,
  }))
);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
});
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({ getRequestEvent: () => ({ locals: {} }) }));
vi.mock('$lib/server/user-actions.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  grantCreatorScore,
}));

const { actions } = await import('../../../routes/retool/user-lookup/[section]/+page.server');

const event = (amount: number, grants: Record<string, boolean>) => {
  const form = new FormData();
  form.set('userId', '8675309');
  form.set('amount', String(amount));
  form.set('reason', 'Contest judge');
  return {
    request: { formData: async () => form },
    locals: { user: { id: 42 }, grants },
  } as never;
};

const PLAIN = { 'user.creatorScore.grant': true };
const LARGE = { ...PLAIN, 'user.creatorScore.grantLarge': true };

beforeEach(() => {
  grantCreatorScore.mockClear();
});

describe('grantCreatorScore action', () => {
  it('refuses 100,000 from a plain holder without calling the endpoint', async () => {
    const result = await actions.grantCreatorScore(event(100_000, PLAIN));
    expect(result).toMatchObject({ status: 400, data: { scope: 'creatorScore' } });
    expect(grantCreatorScore).not.toHaveBeenCalled();
  });

  it('control: 10,000 from a plain holder reaches the endpoint', async () => {
    await actions.grantCreatorScore(event(10_000, PLAIN));
    expect(grantCreatorScore).toHaveBeenCalledWith(expect.objectContaining({ amount: 10_000 }));
  });

  it('sends 100,000 from a large-grant holder to the endpoint', async () => {
    const result = await actions.grantCreatorScore(event(100_000, LARGE));
    expect(grantCreatorScore).toHaveBeenCalledWith({
      userId: 8675309,
      amount: 100_000,
      reason: 'Contest judge',
    });
    expect(result).toMatchObject({ success: true, outcome: { kind: 'granted', amount: 100_000 } });
  });

  it('refuses 1,000,001 even from a large-grant holder', async () => {
    const result = await actions.grantCreatorScore(event(1_000_001, LARGE));
    expect(result).toMatchObject({ status: 400 });
    expect(grantCreatorScore).not.toHaveBeenCalled();
  });

  it('refuses a large-grant holder who lacks the ordinary grant', async () => {
    const result = await actions.grantCreatorScore(
      event(100_000, { 'user.creatorScore.grantLarge': true })
    );
    expect(result).toMatchObject({ status: 403 });
    expect(grantCreatorScore).not.toHaveBeenCalled();
  });
});
