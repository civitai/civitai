import { describe, expect, it, vi } from 'vitest';
import { downloadOutput } from '~/components/ImageGeneration/utils/output-download';

/**
 * Orchestrator output URLs accept `download=true&filename=…`, which makes the orchestrator answer
 * with `Content-Disposition: attachment`. A plain link then saves the file without the browser
 * holding it in memory, so a long video can't hit a fetch timeout.
 */
// Real-format signed query: `:` in exp and `%2B` in sig must reach the orchestrator byte for byte.
const SIGNED =
  'https://orchestration-new.civitai.com/v2/consumer/blobs/abc.mp4?sig=a%2Bb&exp=2027-02-26T17:34:23Z';

const deps = () => ({
  fetchBlob: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
  downloadBlob: vi.fn(),
  openHref: vi.fn(),
});

describe('downloadOutput', () => {
  it('links an orchestrator video straight to the file, keeping its signature', async () => {
    const d = deps();

    await downloadOutput({ url: SIGNED, id: 'abc.mp4', type: 'video' }, d);

    expect(d.fetchBlob).not.toHaveBeenCalled();
    const href = new URL(d.openHref.mock.calls[0][0] as string);
    expect(href.origin + href.pathname).toBe(
      'https://orchestration-new.civitai.com/v2/consumer/blobs/abc.mp4'
    );
    expect(Object.fromEntries(href.searchParams)).toEqual({
      sig: 'a+b',
      exp: '2027-02-26T17:34:23Z',
      download: 'true',
      filename: 'abc.mp4',
    });
  });

  // The player already holds output.url; the link must not reach any other media.
  it('links the exact url the output already has, adding only download and filename', async () => {
    const d = deps();

    await downloadOutput({ url: SIGNED, id: 'abc.mp4', type: 'video' }, d);

    expect(d.openHref.mock.calls[0][0]).toBe(`${SIGNED}&download=true&filename=abc.mp4`);
  });

  it('names a video without an extension in its id as mp4', async () => {
    const d = deps();

    await downloadOutput({ url: SIGNED, id: 'abc', type: 'video' }, d);

    expect(new URL(d.openHref.mock.calls[0][0] as string).searchParams.get('filename')).toBe(
      'abc.mp4'
    );
  });

  it.each([
    ['an image with an extension', 'img.jpeg', 'image', 'img.jpeg'],
    ['a video with an extension', 'clip.webm', 'video', 'clip.webm'],
  ] as const)('links %s directly', async (_label, id, type, filename) => {
    const d = deps();

    await downloadOutput({ url: SIGNED, id, type }, d);

    expect(d.fetchBlob).not.toHaveBeenCalled();
    expect(new URL(d.openHref.mock.calls[0][0] as string).searchParams.get('filename')).toBe(
      filename
    );
  });

  it('fetches an orchestrator image it cannot name, to read its type', async () => {
    const d = deps();

    await downloadOutput({ url: SIGNED, id: 'abc', type: 'image' }, d);

    expect(d.openHref).not.toHaveBeenCalled();
    expect(d.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'abc.png');
  });

  it('fetches outputs from anywhere else, as before', async () => {
    const d = deps();

    await downloadOutput({ url: 'https://image.civitai.com/x/abc', id: 'abc', type: 'image' }, d);

    expect(d.openHref).not.toHaveBeenCalled();
    expect(d.fetchBlob).toHaveBeenCalledWith('https://image.civitai.com/x/abc');
    expect(d.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'abc.png');
  });
});
