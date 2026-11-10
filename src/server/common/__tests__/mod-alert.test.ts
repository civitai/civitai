import { afterEach, describe, expect, it, vi } from 'vitest';
import { postDiscordAlert } from '~/server/common/mod-alert';

/** What the webhook is sent: `noMentions` turns every mention off, and only when asked. */
function capture() {
  const fetchMock = vi.fn(async (..._a: unknown[]) => ({ ok: true } as Response));
  vi.stubGlobal('fetch', fetchMock);
  return () => JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
}
afterEach(() => vi.unstubAllGlobals());

describe('postDiscordAlert', () => {
  it('noMentions: Discord is told to ping nobody', async () => {
    const body = capture();
    await postDiscordAlert('https://discord.test/hook', {
      title: 't',
      description: '@everyone',
      noMentions: true,
    });
    expect(body().allowed_mentions).toEqual({ parse: [] });
  });

  it('CONTROL: without it the payload is unchanged (no allowed_mentions key)', async () => {
    const body = capture();
    await postDiscordAlert('https://discord.test/hook', { title: 't', description: 'd' });
    expect(Object.keys(body())).toEqual(['embeds']);
  });
});
