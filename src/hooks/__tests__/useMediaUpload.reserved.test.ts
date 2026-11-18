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
const { uploadToS3, releaseUploads, failUploads } = vi.hoisted(() => {
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  return {
    uploadToS3: vi.fn(
      () =>
        new Promise<{ key: string; url: string }>((resolve, reject) =>
          pending.push({
            resolve: () => resolve({ key: 'uploaded-key', url: 'https://uploaded' }),
            reject,
          })
        )
    ),
    releaseUploads: () => pending.splice(0).forEach((p) => p.resolve()),
    failUploads: () => pending.splice(0).forEach((p) => p.reject(new Error('network'))),
  };
});
vi.mock('~/hooks/useS3Upload', () => ({
  useS3Upload: () => ({ files: [], uploadToS3, resetFiles: vi.fn(), removeFile: vi.fn() }),
}));
vi.mock('~/utils/media-preprocessors', () => ({
  preprocessFile: vi.fn(async (file: File) => {
    if (file.name.startsWith('bad')) throw new Error('unreadable');
    return {
      type: 'image',
      objectUrl: `blob:${file.name}`,
      metadata: { width: 1, height: 1, hash: 'h' },
    };
  }),
}));
vi.mock('~/utils/metadata/audit', () => ({ auditPostImageMeta: vi.fn() }));
vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));

import { useMediaUpload } from '~/hooks/useMediaUpload';

const named = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    file: new File(['x'], `${prefix}${i}.jpg`, { type: 'image/jpeg' }),
  }));

/** `count` stays 0 on purpose: it is what the editor holds, and a slow upload has not reached it. */
async function mount() {
  let hook!: ReturnType<typeof useMediaUpload>;
  const completed: string[] = [];
  function Harness() {
    hook = useMediaUpload({
      count: 0,
      onComplete: (props) => completed.push(`${props.status}:${props.objectUrl}`),
    });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Harness)));
  return {
    pick: (data: ReturnType<typeof named>) => act(async () => hook.upload(data)),
    finish: () => act(async () => releaseUploads()),
    fail: () => act(async () => failUploads()),
    remaining: () => hook.remaining,
    completed,
    unmount: () => act(async () => root.unmount()),
  };
}

describe('useMediaUpload in-flight reservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    releaseUploads();
  });

  it('lets a second pick fill only what the first left of the limit while it is still uploading', async () => {
    const editor = await mount();
    await editor.pick(named('a', 15));
    await editor.pick(named('b', 15));
    expect(editor.remaining()).toBe(0);
    for (let i = 0; i < 25; i++) await editor.finish();
    expect(editor.completed.filter((x) => x.startsWith('added'))).toHaveLength(20);
    await editor.unmount();
  });

  it('returns the reservation when uploads fail', async () => {
    const editor = await mount();
    await editor.pick(named('a', 20));
    expect(editor.remaining()).toBe(0);
    for (let i = 0; i < 25; i++) await editor.fail();
    expect(editor.completed.filter((x) => x.startsWith('error'))).toHaveLength(20);
    expect(editor.remaining()).toBe(20);
    await editor.unmount();
  });

  it('returns the reservation for files that cannot be read', async () => {
    const editor = await mount();
    await editor.pick(named('bad', 20));
    expect(editor.remaining()).toBe(20);
    await editor.unmount();
  });
});
