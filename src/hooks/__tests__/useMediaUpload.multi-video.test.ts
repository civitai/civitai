// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';

// Our @types/react predates the typing of React 18.3's `act`; see useS3Upload.test.ts.
type ActFn = (cb: () => unknown) => Promise<void>;
const act = (React as unknown as { act: ActFn }).act;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
const uploadContext = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('~/components/FileUpload/FileUploadProvider', () => ({
  useFileUploadContext: () => uploadContext.current,
}));
vi.mock('~/components/MediaUploadSettings/MediaUploadSettingsProvider', () => ({
  useMediaUploadSettingsContext: () => ({
    maxItems: 20,
    maxVideoDuration: 245,
    maxVideoDimensions: 4096,
  }),
}));
const { uploadToS3, releaseUploads, preparing, finishPreparing, dropPending } = vi.hoisted(() => {
  const pendingUploads: (() => void)[] = [];
  const pendingPrep: (() => void)[] = [];
  return {
    uploadToS3: vi.fn(
      (file: File) =>
        new Promise<{ key: string; url: string }>((resolve) =>
          pendingUploads.push(() => resolve({ key: `key-${file.name}`, url: 'https://uploaded' }))
        )
    ),
    releaseUploads: () => pendingUploads.splice(0).forEach((resolve) => resolve()),
    preparing: pendingPrep,
    finishPreparing: () => pendingPrep.splice(0).forEach((resolve) => resolve()),
    // A test that fails early leaves work pending; never resolve it into the next test.
    dropPending: () => {
      pendingUploads.length = 0;
      pendingPrep.length = 0;
    },
  };
});
vi.mock('~/hooks/useS3Upload', () => ({
  useS3Upload: () => ({ files: [], uploadToS3, resetFiles: vi.fn(), removeFile: vi.fn() }),
}));
vi.mock('~/utils/media-preprocessors', () => ({
  preprocessFile: vi.fn(
    (file: File) =>
      new Promise((resolve) =>
        preparing.push(() =>
          resolve({
            type: 'video',
            objectUrl: `blob:${file.name}`,
            metadata: {
              width: 1280,
              height: 720,
              hash: 'h',
              duration: file.name.startsWith('long') ? 600 : 30,
              audio: true,
            },
          })
        )
      )
  ),
}));
vi.mock('~/utils/metadata/audit', () => ({ auditPostImageMeta: vi.fn() }));

import type { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import { useMediaUpload } from '~/hooks/useMediaUpload';

const video = (name: string) => ({ file: new File(['x'], name, { type: 'video/mp4' }) });
const fiveVideos = () => ['1.mp4', '2.mp4', '3.mp4', '4.mp4', '5.mp4'].map(video);

async function mount(onComplete?: (props: MediaUploadOnCompleteProps) => void) {
  const completed: MediaUploadOnCompleteProps[] = [];
  let upload!: ReturnType<typeof useMediaUpload>['upload'];
  function Harness() {
    upload = useMediaUpload({
      count: 0,
      onComplete: (props) => {
        completed.push(props);
        onComplete?.(props);
      },
    }).upload;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(Harness)));
  return {
    completed,
    pick: (picked = fiveVideos()) => upload(picked),
    unmount: () => act(async () => root.unmount()),
  };
}

// Drains preparing and uploading until nothing is left, one round at a time.
async function settleAll() {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      finishPreparing();
      releaseUploads();
    });
  }
}

describe('useMediaUpload: five videos in one pick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dropPending();
  });
  // Settles whatever a failed test left in flight, so its warning does not leak into the next.
  afterEach(settleAll);

  it('finishes every queued upload after the dropzone that took the pick unmounts', async () => {
    // On /posts/create the pick is handed to the queue only after the page has switched to
    // /posts/:id/edit, so the create page's instance runs it while unmounted.
    const editor = await mount();
    let picking!: Promise<void>;
    await act(async () => {
      picking = editor.pick();
    });
    await editor.unmount();
    await settleAll();
    await act(async () => picking);
    expect(uploadToS3).toHaveBeenCalledTimes(5);
    expect(editor.completed.map((x) => x.status)).toEqual(Array(5).fill('added'));
  });

  it('uploads the rest when the error callback throws', async () => {
    // One failure per worker: if a throw from onComplete ended its worker, both would stop here.
    uploadToS3
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'));
    const editor = await mount((props) => {
      if (props.status === 'error') throw new Error('callback');
    });
    let picking!: Promise<void>;
    await act(async () => {
      picking = editor.pick();
    });
    await settleAll();
    await act(async () => picking);
    expect(uploadToS3).toHaveBeenCalledTimes(5);
    expect(editor.completed.map((x) => x.status).sort()).toEqual([
      'added',
      'added',
      'added',
      'error',
      'error',
    ]);
    await editor.unmount();
  });
});

const unloadWarned = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe('useMediaUpload: leaving the page mid-upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dropPending();
  });
  afterEach(settleAll);

  it('warns before unload while a pick is prepared or uploaded, and not once it is done', async () => {
    const editor = await mount();
    expect(unloadWarned()).toBe(false);
    let picking!: Promise<void>;
    await act(async () => {
      picking = editor.pick();
    });
    expect(unloadWarned()).toBe(true); // preparing
    await act(async () => finishPreparing());
    await act(async () => picking);
    expect(uploadToS3).toHaveBeenCalled();
    expect(unloadWarned()).toBe(true); // uploading
    await settleAll();
    expect(editor.completed).toHaveLength(5);
    expect(unloadWarned()).toBe(false);
    await editor.unmount();
  });

  it('keeps warning after the dropzone unmounts, because its uploads run on', async () => {
    // Do not move this guard into a useEffect: on /posts/create the pick is uploaded by an
    // instance that has already unmounted, and an effect's cleanup would drop the warning then.
    const editor = await mount();
    let picking!: Promise<void>;
    await act(async () => {
      picking = editor.pick();
    });
    await editor.unmount();
    expect(unloadWarned()).toBe(true);
    await settleAll();
    await act(async () => picking);
    expect(unloadWarned()).toBe(false);
  });

  it('stops warning once a pick is refused or its uploads fail', async () => {
    const editor = await mount();
    // A video over the duration limit refuses the whole pick while it is prepared.
    let picking!: Promise<void>;
    await act(async () => {
      picking = editor.pick([video('long.mp4'), video('1.mp4')]);
    });
    await settleAll();
    await act(async () => picking);
    expect(uploadToS3).not.toHaveBeenCalled();
    expect(unloadWarned()).toBe(false);

    uploadToS3.mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      picking = editor.pick([video('2.mp4'), video('3.mp4')]);
    });
    await settleAll();
    await act(async () => picking);
    expect(editor.completed.map((x) => x.status).sort()).toEqual(['added', 'error']);
    expect(unloadWarned()).toBe(false);
    await editor.unmount();
  });

  it('stops warning once the queued uploads are cancelled', async () => {
    type Tracked = { file: File; abort: () => void };
    let tracked: Tracked[] = [];
    const setFiles = (next: Tracked[] | ((prev: Tracked[]) => Tracked[])) => {
      tracked = typeof next === 'function' ? next(tracked) : next;
    };
    uploadContext.current = [tracked, setFiles];
    try {
      const editor = await mount();
      let picking!: Promise<void>;
      await act(async () => {
        picking = editor.pick();
      });
      await act(async () => finishPreparing());
      await act(async () => picking);
      expect(uploadToS3).toHaveBeenCalledTimes(2); // 3 queued behind the two workers
      tracked
        .filter((x) => ['3.mp4', '4.mp4', '5.mp4'].includes(x.file.name))
        .forEach((x) => x.abort());
      await settleAll();
      expect(uploadToS3).toHaveBeenCalledTimes(2);
      expect(editor.completed).toHaveLength(2);
      expect(unloadWarned()).toBe(false);
      await editor.unmount();
    } finally {
      uploadContext.current = undefined;
    }
  });
});
