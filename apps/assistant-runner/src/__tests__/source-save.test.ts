import { describe, expect, it } from 'vitest';

import { CivitaiSourceSaves, SOURCE_SAVE_PATH } from '../app-assistant/source-save';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
// TEST-ONLY placeholders: never a real credential.
const SECRET = 'test-only-runner-secret-source-save-0123';
const GRANT = 'test-only-grant-source-save';

/**
 * The runner's half of App Assistant → the app's source repo: it asks civitai to commit the open
 * app as the run's user (the grant), sending only the app's key; civitai reads the files itself.
 * New surface: invariant guards.
 */
describe('CivitaiSourceSaves', () => {
  function client(answer: () => Response | Promise<Response>) {
    const sent: { url: string; init: RequestInit }[] = [];
    const saves = new CivitaiSourceSaves({
      civitaiUrl: 'https://civitai.example/',
      secret: SECRET,
      log: quiet,
      fetch: async (input, init) => {
        sent.push({ url: String(input), init: init! });
        return answer();
      },
    });
    return { saves, sent };
  }

  it('POSTs { grant, app } to civitai with the runner secret, and nothing else', async () => {
    const { saves, sent } = client(() => new Response('{"saved":true}', { status: 200 }));
    await saves.forRun(async () => GRANT)('my-app');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`https://civitai.example/${SOURCE_SAVE_PATH}`);
    expect(sent[0].init.method).toBe('POST');
    expect(sent[0].init.headers).toEqual({
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ grant: GRANT, app: 'my-app' });
  });

  it('no live grant: no call at all', async () => {
    const { saves, sent } = client(() => new Response('{}'));
    await saves.forRun(async () => null)('my-app');
    expect(sent).toEqual([]);
  });

  it('never throws: a refusal, an outage or an unreachable civitai all resolve', async () => {
    for (const answer of [
      () => new Response('{"code":"NOT_FOUND"}', { status: 404 }),
      () => new Response('nope', { status: 503 }),
      () => Promise.reject(new Error('ECONNREFUSED')),
    ]) {
      const { saves } = client(answer);
      await expect(saves.forRun(async () => GRANT)('my-app')).resolves.toBeUndefined();
    }
  });
});
