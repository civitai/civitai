import { beforeEach, describe, expect, it, vi } from 'vitest';

const joinOrder = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/join.service', () => ({ joinOrder }));

const { actions } = await import('./+page.server');

const submit = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return actions.join({
    request: new Request('http://knights.test/', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never);
};

beforeEach(() => {
  joinOrder.mockReset();
});

describe('join action', () => {
  it('swears the player in and sends them to play once the warning is accepted', async () => {
    joinOrder.mockResolvedValue({ joined: true });

    await expect(submit({ accepted: 'yes' })).rejects.toMatchObject({
      status: 303,
      location: '/play',
    });
    expect(joinOrder).toHaveBeenCalledWith(expect.anything(), 7);
  });

  it('does not join without accepting the warning', async () => {
    expect(await submit({})).toMatchObject({ status: 400 });
    expect(joinOrder).not.toHaveBeenCalled();
  });

  it('tells the player when joining failed and logs the cause', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    joinOrder.mockRejectedValue(new Error('down'));

    expect(await submit({ accepted: 'yes' })).toMatchObject({
      status: 500,
      data: { message: expect.stringMatching(/try again/i) },
    });
    expect(log).toHaveBeenCalled();
  });
});
