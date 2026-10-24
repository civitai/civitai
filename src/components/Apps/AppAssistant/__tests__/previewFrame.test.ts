import { describe, expect, it, vi } from 'vitest';
import { fetchPreviewFrame } from '~/components/Apps/AppAssistant/previewFrame';

const FRAME = { blockId: 'my app', iframeSrc: 'https://dev-0123456789abcdef.apps.example/?dev=t' };
const respond = (status: number, body: unknown) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

describe('fetchPreviewFrame', () => {
  it('asks for the escaped block id and returns the frame', async () => {
    const fetchMock = respond(200, FRAME);
    expect(await fetchPreviewFrame('my app', fetchMock)).toEqual(FRAME);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/apps/assistant/preview?blockId=my%20app');
  });

  it('reports a preview that is still coming online, with nothing to frame', async () => {
    expect(await fetchPreviewFrame('my-app', respond(200, { preparing: true }))).toEqual({
      preparing: true,
    });
  });

  it('does not read `preparing` off an error response', async () => {
    await expect(fetchPreviewFrame('my-app', respond(500, { preparing: true }))).rejects.toThrow(
      'The preview is unavailable'
    );
  });

  it("surfaces the route's reason", async () => {
    await expect(
      fetchPreviewFrame(
        'my-app',
        respond(409, { error: 'No live preview is running for this app' })
      )
    ).rejects.toThrow('No live preview is running for this app');
  });

  it('refuses a 200 without an entry URL rather than framing nothing', async () => {
    await expect(fetchPreviewFrame('my-app', respond(200, { blockId: 'my-app' }))).rejects.toThrow(
      'The preview is unavailable'
    );
  });

  it('treats a non-JSON error as unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('Bad Gateway', { status: 502 }));
    await expect(fetchPreviewFrame('my-app', fetchMock)).rejects.toThrow(
      'The preview is unavailable'
    );
  });
});
