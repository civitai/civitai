// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/FileUpload/FileUploadProvider', () => ({
  useFileUploadContext: () => undefined,
}));
vi.mock('~/components/MediaUploadSettings/MediaUploadSettingsProvider', () => ({
  useMediaUploadSettingsContext: () => ({
    maxItems: 20,
    maxVideoDuration: 600,
    maxVideoDimensions: 4096,
  }),
}));
const { uploadToS3, releaseUploads } = vi.hoisted(() => {
  const pending: (() => void)[] = [];
  return {
    uploadToS3: vi.fn(
      () =>
        new Promise<{ key: string; url: string }>((resolve) =>
          pending.push(() => resolve({ key: 'uploaded-key', url: 'https://uploaded' }))
        )
    ),
    releaseUploads: () => pending.splice(0).forEach((resolve) => resolve()),
  };
});
vi.mock('~/hooks/useS3Upload', () => ({
  useS3Upload: () => ({ files: [], uploadToS3, resetFiles: vi.fn(), removeFile: vi.fn() }),
}));
vi.mock('~/utils/media-preprocessors', () => ({
  preprocessFile: vi.fn(async (file: File) => ({
    type: 'image',
    objectUrl: `blob:${file.name}`,
    metadata: { width: 1, height: 1, hash: 'h' },
  })),
}));
vi.mock('~/utils/metadata/audit', () => ({ auditMetaData: vi.fn() }));

import type { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import { useMediaUpload } from '~/hooks/useMediaUpload';
import { preprocessFile } from '~/utils/media-preprocessors';

const image = (name: string) => ({ file: new File(['x'], name, { type: 'image/jpeg' }) });

/**
 * The post editor passes `count` = images it holds, and a file joins those only once its upload
 * completes. Picks made before that must still get indexes of their own, or the post's images tie
 * and each surface that orders by index can show them in a different order.
 */
async function mount(count: number) {
  const added: MediaUploadOnCompleteProps[] = [];
  let upload!: ReturnType<typeof useMediaUpload>['upload'];
  function Harness({ count }: { count: number }) {
    upload = useMediaUpload({
      count,
      onComplete: (props) => added.push(props),
    }).upload;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (count: number) =>
    act(async () => root.render(React.createElement(Harness, { count })));
  await render(count);
  const pick = (...names: string[]) => act(async () => upload(names.map(image)));
  const finish = () => act(async () => releaseUploads());
  const indexes = () => Object.fromEntries(added.map((x) => [x.objectUrl.slice(5), x.index]));
  return {
    upload: (data: Parameters<typeof upload>[0]) => upload(data),
    pick,
    finish,
    render,
    indexes,
    unmount: () => act(async () => root.unmount()),
  };
}

describe('useMediaUpload image index', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives a pick made while an earlier one is still uploading the next index', async () => {
    const editor = await mount(0);
    await editor.pick('first.jpg');
    await editor.pick('second.jpg');
    await editor.finish();
    expect(editor.indexes()).toEqual({ 'first.jpg': 1, 'second.jpg': 2 });
    await editor.unmount();
  });

  it('continues after a multi-file pick that has not finished', async () => {
    const editor = await mount(0);
    await editor.pick('a.jpg', 'b.jpg');
    await editor.pick('c.jpg');
    await editor.finish();
    await editor.finish(); // c.jpg waits for a free upload slot
    expect(editor.indexes()).toEqual({ 'a.jpg': 1, 'b.jpg': 2, 'c.jpg': 3 });
    await editor.unmount();
  });

  it('gives a pick made while an earlier one is still being prepared the next index', async () => {
    let finishPreparing!: () => void;
    vi.mocked(preprocessFile).mockImplementationOnce(
      (file) =>
        new Promise((resolve) => {
          finishPreparing = () =>
            resolve({
              type: 'image',
              objectUrl: `blob:${(file as File).name}`,
              metadata: { width: 1, height: 1, hash: 'h' },
            } as never);
        })
    );
    const editor = await mount(0);
    let preparing!: Promise<void>;
    await act(async () => {
      preparing = editor.upload([image('slow.jpg')]);
    });
    await editor.pick('fast.jpg');
    await act(async () => {
      finishPreparing();
      await preparing;
    });
    await editor.finish();
    expect(editor.indexes()).toEqual({ 'slow.jpg': 1, 'fast.jpg': 2 });
    await editor.unmount();
  });

  it('follows the images the post already holds', async () => {
    const editor = await mount(5);
    await editor.pick('sixth.jpg');
    await editor.finish();
    await editor.render(6);
    await editor.pick('seventh.jpg');
    await editor.finish();
    expect(editor.indexes()).toEqual({ 'sixth.jpg': 6, 'seventh.jpg': 7 });
    await editor.unmount();
  });
});
