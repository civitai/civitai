import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callMainApp } = vi.hoisted(() => ({ callMainApp: vi.fn() }));
vi.mock('$lib/server/main-app', () => ({ callMainApp }));
vi.mock('$lib/server/main-app-flags', () => ({ darkFlagEnabled: vi.fn(async () => true) }));
vi.mock('$lib/server/session-cookies', () => ({ sessionCookies: () => 'cookie' }));
vi.mock('$lib/server/db', () => {
  const version = { id: 5, name: 'v', modelId: 1, modelName: 'm', userId: 7 };
  const chain = {
    innerJoin: () => chain,
    select: () => chain,
    where: () => chain,
    executeTakeFirst: async () => version,
  };
  return { dbRead: { selectFrom: () => chain } };
});

const { actions } = await import('./+page.server');

const createLink = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return actions.createLink({
    params: { versionId: '5' },
    locals: { user: { id: 7, isModerator: false } },
    request: new Request('https://studio.test/models/gifts/5?/createLink', {
      method: 'POST',
      body,
    }),
  } as unknown as Parameters<typeof actions.createLink>[0]);
};

beforeEach(() => {
  callMainApp.mockReset();
  callMainApp.mockResolvedValue({ ok: true, data: { id: 1, code: 'cvg_x' } });
});

describe('createLink', () => {
  it('sends the claim cap the creator set', async () => {
    await createLink({ maxRedemptions: '100' });
    expect(callMainApp).toHaveBeenCalledWith(
      '/api/v1/model-versions/5/gifts/link',
      'cookie',
      expect.objectContaining({ body: expect.objectContaining({ maxRedemptions: 100 }) })
    );
  });

  it.each<Record<string, string>>([
    {},
    { maxRedemptions: '' },
    { maxRedemptions: '0' },
    { maxRedemptions: '101' },
  ])('refuses %o without calling the main app', async (fields) => {
    await expect(createLink(fields)).resolves.toMatchObject({ status: 400 });
    expect(callMainApp).not.toHaveBeenCalled();
  });
});
