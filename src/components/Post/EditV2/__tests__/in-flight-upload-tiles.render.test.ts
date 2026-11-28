// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackedFile } from '~/components/FileUpload/FileUploadProvider';
import { InFlightUploadTiles } from '~/components/Post/EditV2/InFlightUploadTiles';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

function tracked(file: File, status: TrackedFile['status'] = 'uploading'): TrackedFile {
  return {
    file,
    progress: 40,
    uploaded: 0,
    size: file.size,
    speed: 0,
    timeRemaining: 0,
    status,
    abort: () => undefined,
    url: '',
    name: file.name,
  };
}

function render(files: TrackedFile[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(InFlightUploadTiles, { files })
      )
    )
  );
  return host;
}

describe('InFlightUploadTiles', () => {
  it('previews each file still uploading from a local URL, image as an image and video as a video', () => {
    const image = new File(['i'], 'a.jpeg', { type: 'image/jpeg' });
    const video = new File(['v'], 'b.mp4', { type: 'video/mp4' });
    const el = render([tracked(image, 'pending'), tracked(video)]);

    const img = el.querySelector('img');
    const vid = el.querySelector('video');
    expect(img?.getAttribute('src')).toMatch(/^blob:/);
    expect(img?.getAttribute('alt')).toBe('a.jpeg');
    expect(vid?.getAttribute('src')).toMatch(/^blob:/);
    expect(vid?.getAttribute('aria-label')).toBe('b.mp4');
  });

  it('shows no tile for a file that finished or failed', () => {
    const done = new File(['i'], 'done.jpeg', { type: 'image/jpeg' });
    const failed = new File(['i'], 'failed.jpeg', { type: 'image/jpeg' });
    const el = render([tracked(done, 'success'), tracked(failed, 'error')]);

    expect(el.querySelector('img')).toBeNull();
  });

  it('releases every local URL it made when the tiles go away', () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    render([
      tracked(new File(['i'], 'a.jpeg', { type: 'image/jpeg' })),
      tracked(new File(['v'], 'b.mp4', { type: 'video/mp4' })),
    ]);
    const made = create.mock.results.map((r) => r.value as string);
    expect(made).toHaveLength(2);

    act(() => root?.unmount());
    root = undefined;

    expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual([...made].sort());
  });
});
