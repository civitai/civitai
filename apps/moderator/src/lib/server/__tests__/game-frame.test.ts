import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: Record<string, string | undefined> = {};
vi.mock('$env/dynamic/private', () => ({ env }));

const { delistGame } = await import('../game-frame');

const TOKEN = 't'.repeat(40);
const input = {
  slug: 'kraken-cove',
  reason: 'Reported: Hate or harassment; report #991',
  reportId: 991,
  moderator: { id: 7, username: 'modé' },
};
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  env.GF_BASE_URL = 'https://games.example.test';
  env.GF_MOD_SERVICE_TOKEN = TOKEN;
});

describe('delistGame', () => {
  it('sends the service token with the moderator headers and counts the forks', async () => {
    const fetchImpl = reply(200, {
      ok: true,
      id: 'kraken-cove',
      affected: ['a', 'b'],
      state: 'delisted',
    });

    expect(await delistGame(input, fetchImpl)).toEqual({ ok: true, affected: 2 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://games.example.test/api/mod/games/kraken-cove/delist');
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'x-gf-mod-id': '7',
      'x-gf-mod-name': 'mod-7',
    });
    expect(JSON.parse(String(init.body))).toEqual({ reason: input.reason, reportId: 991 });
  });

  it.each([null, '', 'a'.repeat(65), 'a b', 'a\r\nx-evil: 1', 'modé'])(
    'falls back to mod-<id> for a name outside the ASCII header rule (%j)',
    async (username) => {
      const fetchImpl = reply(200, { ok: true, affected: [], state: 'delisted' });
      await delistGame({ ...input, moderator: { id: 7, username } }, fetchImpl);
      const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
      expect(init.headers).toMatchObject({ 'x-gf-mod-name': 'mod-7' });
    }
  );

  it('passes a plain username through as the moderator name', async () => {
    const fetchImpl = reply(200, { ok: true, affected: [], state: 'delisted' });
    await delistGame({ ...input, moderator: { id: 7, username: 'jane_doe.2' } }, fetchImpl);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.headers).toMatchObject({ 'x-gf-mod-name': 'jane_doe.2' });
  });

  it('does not count a 200 that is not Game Frame confirming the delist', async () => {
    const page = vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 }));
    expect(await delistGame(input, page)).toMatchObject({ ok: false, status: 502 });
    expect(await delistGame(input, reply(200, { ok: true, state: 'public' }))).toMatchObject({
      ok: false,
    });
    for (const body of [{ state: 'delisted' }, { ok: false, state: 'delisted' }, null, []])
      expect(await delistGame(input, reply(200, body)), JSON.stringify(body)).toMatchObject({
        ok: false,
      });
  });

  it.each([
    [403, { error: 'forbidden' }, 'Game Frame refused the delist (config).'],
    [404, { error: 'not_found' }, 'Game Frame has no such game.'],
    [400, { error: 'bad_mod_headers' }, 'Game Frame could not delist it: bad_mod_headers'],
    [503, { error: 'store_unreadable', message: 'disk' }, 'Game Frame could not delist it: disk'],
  ])('maps a %i to a refusal', async (status, body, message) => {
    expect(await delistGame(input, reply(status, body))).toMatchObject({ ok: false, message });
  });

  it('reports a timeout or network error as no answer, without the token in the log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error(`request to ... Bearer ${TOKEN}`), { name: 'TimeoutError' });
    });

    expect(await delistGame(input, fetchImpl)).toMatchObject({
      ok: false,
      message: "Game Frame didn't answer. Retrying is safe.",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    log.mockRestore();
  });

  it('refuses without calling out when unconfigured', async () => {
    env.GF_MOD_SERVICE_TOKEN = '';
    const fetchImpl = reply(200, {});
    expect(await delistGame(input, fetchImpl)).toMatchObject({ ok: false, status: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
