import { describe, expect, it, vi } from 'vitest';
import {
  fetchPreviewEntryUrl,
  fetchPreviewFrame,
  PreviewGoneError,
} from '~/components/Apps/AppAssistant/previewFrame';

const HOST = 'dev-0123456789abcdef.apps.example';
const OTHER = 'dev-fedcba9876543210.apps.example';
const FRAME = { blockId: 'my app', host: HOST, iframeSrc: `https://${HOST}/?dev=t` };
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

  // The preview route returns the frame's `host` beside its URL; the URL must be an https URL on it.
  it.each([
    [{ ...FRAME, iframeSrc: `http://${HOST}/?dev=t` }],
    [{ ...FRAME, iframeSrc: `https://${OTHER}/?dev=t` }],
    [{ ...FRAME, iframeSrc: 'not a url' }],
    [{ blockId: 'my app', iframeSrc: FRAME.iframeSrc }],
  ])('refuses an entry URL that is not https on the host the frame names: %j', async (body) => {
    await expect(fetchPreviewFrame('my-app', respond(200, body))).rejects.toThrow();
  });

  it('names the reason when the URL is on another host', async () => {
    await expect(
      fetchPreviewFrame('my-app', respond(200, { ...FRAME, iframeSrc: `https://${OTHER}/?dev=t` }))
    ).rejects.toThrow('The entry URL is not on its tunnel host');
  });

  it('a gone preview is a PreviewGoneError, not a generic failure', async () => {
    await expect(
      fetchPreviewFrame(
        'my-app',
        respond(409, { error: 'No live preview is running for this app' })
      )
    ).rejects.toBeInstanceOf(PreviewGoneError);
  });

  it('treats a non-JSON error as unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('Bad Gateway', { status: 502 }));
    await expect(fetchPreviewFrame('my-app', fetchMock)).rejects.toThrow(
      'The preview is unavailable'
    );
  });
});

describe('fetchPreviewEntryUrl', () => {
  it("returns just the frame's freshly signed entry URL", async () => {
    expect(await fetchPreviewEntryUrl('my app', respond(200, FRAME))).toBe(FRAME.iframeSrc);
  });

  it('rejects while the host is not resolvable yet (nothing to load)', async () => {
    await expect(fetchPreviewEntryUrl('my-app', respond(200, { preparing: true }))).rejects.toThrow(
      'The preview is not ready yet'
    );
  });

  it('rejects a fresh URL on a host other than the one it names', async () => {
    await expect(
      fetchPreviewEntryUrl(
        'my-app',
        respond(200, { ...FRAME, iframeSrc: `https://${OTHER}/?dev=t` })
      )
    ).rejects.toThrow('The entry URL is not on its tunnel host');
  });

  it('rejects when the preview is gone', async () => {
    await expect(
      fetchPreviewEntryUrl(
        'my-app',
        respond(409, { error: 'No live preview is running for this app' })
      )
    ).rejects.toThrow('No live preview is running for this app');
  });
});
