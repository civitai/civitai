import { StrictMode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import type * as BrowsingLevelModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as DialogStoreModule from '~/components/Dialog/dialogStore';
import type { MediaUploadOnCompleteProps, UseMediaUploadProps } from '~/hooks/useMediaUpload';
import type { BatchScanStatus } from '~/components/Post/Batch/batch-composer.utils';
import { formatDate } from '~/utils/date-helpers';

const POST_COUNT = 12;

const mocks = vi.hoisted(() => ({
  validateResult: {
    ok: true,
    issues: [] as { code: string; message: string; index?: number; day?: string }[],
    dailyLimit: 100,
    perDay: [] as { day: string; existing: number; incoming: number }[],
  },
  scheduleCalls: [] as {
    resourceIds: number[];
    posts: { clientKey?: string; publishedAt: Date; images: { imageId: number }[] }[];
  }[],
  persistCalls: [] as { images: { url: string }[] }[],
  /** A persist call carrying any of these urls rejects, as a dropped request would. */
  persistFailUrls: [] as string[],
  /** Scan fields by image id; a persisted id not listed reads as Pending and unrated. */
  scanStatus: new Map<number, Partial<BatchScanStatus>>(),
  /** Ids the status query no longer answers: removed, adopted or expired on the server. */
  scanMissing: new Set<number>(),
  /** The last `ImageIngestionStatus` subscriber, to deliver a signal to. */
  signal: null as ((data: { imageId: number; ingestion: string }) => void) | null,
  removeCalls: [] as { ids: number[] }[],
  /** How often the composer asked the status query to refetch. */
  refetches: 0,
  confirmMessage: '',
  /** Throws on these call numbers (1-based), as a call the client stopped waiting for would. */
  throwOnCalls: [] as number[],
  throwMessage: '',
  /** Answer every post as made by an earlier attempt, at this time. */
  alreadyCreatedAt: null as Date | null,
  drafts: new Map<string, unknown>(),
}));

vi.mock('idb-keyval', () => ({
  get: async (key: string) => mocks.drafts.get(key),
  set: async (key: string, value: unknown) => {
    mocks.drafts.set(key, value);
  },
  del: async (key: string) => {
    mocks.drafts.delete(key);
  },
}));
// The pick is a registry dialog too; answer it with a fixed version.
vi.mock('~/components/Dialog/triggers/resource-select', () => ({
  openResourceSelectModal: ({
    onSelect,
  }: {
    onSelect: (resource: { id: number; name: string; model: { name: string } }) => void;
  }) => onSelect({ id: 42, name: 'v2.0', model: { name: 'Neon Noir' } }),
}));

// The real picker's chips need AppProvider; the test measures the payload, not the picker.
vi.mock('~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple', () => ({
  ResourceSelectMultiple: ({
    value,
    onChange,
  }: {
    value?: { id: number }[] | null;
    onChange?: (value: { id: number; name: string; model: { name: string } }[]) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onChange?.([
          ...((value ?? []) as { id: number; name: string; model: { name: string } }[]),
          { id: 42, name: 'v2.0', model: { name: 'Neon Noir' } },
        ])
      }
    >
      Add resource{value?.length ? ` (${value.map((x) => x.id).join(',')})` : ''}
    </button>
  ),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ batchPostScheduling: true, postPlanner: false }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 7, username: 'tester', muted: false, isModerator: false }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelModule>()),
  useBrowsingLevelDebounced: () => 1,
}));
// The confirm step is a registry dialog; the harness mounts no DialogProvider, so confirm inline.
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogStoreModule>()),
  dialogStore: {
    trigger: (args: { props?: { onConfirm?: () => void; message?: string } }) => {
      mocks.confirmMessage = args.props?.message ?? '';
      args.props?.onConfirm?.();
    },
    closeById: () => undefined,
  },
}));
// No signal hub in the harness; the test delivers a signal by calling the subscriber itself.
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalConnection: (
    _message: string,
    callback: (data: { imageId: number; ingestion: string }) => void
  ) => {
    mocks.signal = callback;
  },
}));
// S3 never sees these tests: every dropped file completes as an uploaded image at once.
vi.mock('~/hooks/useMediaUpload', () => ({
  useMediaUpload: ({ onComplete }: UseMediaUploadProps<Record<string, unknown>>) => ({
    canAdd: true,
    error: undefined,
    loading: false,
    files: [],
    progress: 0,
    reset: () => undefined,
    removeFile: () => undefined,
    upload: async (data: { file: File }[]) => {
      data.forEach(({ file }, index) =>
        onComplete({
          status: 'added',
          url: `key-${file.name}`,
          index,
          name: file.name,
          mimeType: file.type,
          type: 'image',
          objectUrl: LOADABLE_IMAGE_DATA_URI,
          metadata: { width: 1, height: 1, hash: 'h', size: 1 },
          meta: {},
        } as MediaUploadOnCompleteProps)
      );
    },
  }),
}));
/** `render-N.png` persists as image N, so a test can name an id before the upload. */
const imageIdFor = (url: string) => Number(url.match(/render-(\d+)/)?.[1] ?? 0);

vi.mock('~/utils/trpc', async (importOriginal) => {
  // Hook-free (the factory cannot share the component tree's React), so the test re-renders the
  // composer itself once it has changed a status; `data` is cached by content so an unchanged
  // answer keeps its identity between renders, as React Query's would.
  const answers = new Map<string, { images: Record<number, BatchScanStatus> }>();
  const useScanStatusQuery = (input: { ids: number[] }, options?: { enabled?: boolean }) => {
    const images: Record<number, BatchScanStatus> = {};
    for (const id of input.ids) {
      if (mocks.scanMissing.has(id)) continue;
      images[id] = {
        ingestion: 'Pending',
        nsfwLevel: 0,
        blockedFor: null,
        needsReview: null,
        minor: false,
        poi: false,
        ...mocks.scanStatus.get(id),
      };
    }
    const key = JSON.stringify(images);
    const data = answers.get(key) ?? { images };
    answers.set(key, data);
    const enabled = options?.enabled !== false;
    return {
      data: enabled ? data : undefined,
      isSuccess: enabled,
      isPlaceholderData: false,
      isFetching: false,
      isLoading: false,
      refetch: async () => {
        mocks.refetches++;
      },
    };
  };
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'post.validateBatchSchedule': {
        useQuery: () => ({ data: mocks.validateResult, isFetching: false, isLoading: false }),
      },
      'post.persistBatchMedia': {
        useMutation: () => ({
          isPending: false,
          mutateAsync: async (input: { images: { url: string }[] }) => {
            mocks.persistCalls.push(input);
            if (input.images.some((image) => mocks.persistFailUrls.includes(image.url)))
              throw new Error('Failed to fetch');
            return {
              images: input.images.map((image) => ({
                url: image.url,
                imageId: imageIdFor(image.url),
              })),
            };
          },
        }),
      },
      'post.getBatchMediaStatus': { useQuery: useScanStatusQuery },
      'post.removeBatchMedia': {
        useMutation: () => ({
          isPending: false,
          mutate: (input: { ids: number[] }) => {
            mocks.removeCalls.push(input);
          },
        }),
      },
      'post.scheduleBatch': {
        useMutation: () => ({
          isPending: false,
          mutateAsync: async (input: (typeof mocks.scheduleCalls)[number]) => {
            mocks.scheduleCalls.push(input);
            if (mocks.throwOnCalls.includes(mocks.scheduleCalls.length))
              throw new Error(
                mocks.throwMessage || `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
              );
            const earlier = mocks.alreadyCreatedAt;
            return {
              created: input.posts.map((post, index) => ({
                postId: index + 1,
                publishedAt: (earlier ?? post.publishedAt).toISOString(),
                ...(earlier ? { alreadyCreated: true as const } : {}),
              })),
            };
          },
        }),
      },
    }),
  };
});

const { BatchComposer } = await import('./BatchComposer');

function fileInput(): Promise<HTMLInputElement> {
  return vi.waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!el) throw new Error('dropzone file input not found');
    return el;
  });
}

async function uploadPosts(count: number, opts: { strict?: boolean; expectedPosts?: number } = {}) {
  const rendered = await renderWithProviders(
    opts.strict ? (
      <StrictMode>
        <BatchComposer />
      </StrictMode>
    ) : (
      <BatchComposer />
    )
  );
  const files = Array.from(
    { length: count },
    (_, i) => new File(['x'], `render-${i + 1}.png`, { type: 'image/png' })
  );
  await userEvent.upload(await fileInput(), files);
  const expected = opts.expectedPosts ?? count;
  await expect
    .element(page.getByTestId('batch-grouping-summary'))
    .toHaveTextContent(`${expected} post${expected === 1 ? '' : 's'}`);
  return rendered;
}

function thumbs() {
  return page.getByTestId('batch-media-thumb').elements();
}

describe('BatchComposer', () => {
  beforeEach(() => {
    mocks.validateResult = { ok: true, issues: [], dailyLimit: 100, perDay: [] };
    mocks.scheduleCalls = [];
    mocks.throwOnCalls = [];
    mocks.throwMessage = '';
    mocks.alreadyCreatedAt = null;
    mocks.drafts.clear();
    mocks.persistCalls = [];
    mocks.persistFailUrls = [];
    mocks.scanStatus.clear();
    mocks.scanMissing.clear();
    mocks.signal = null;
    mocks.removeCalls = [];
    mocks.refetches = 0;
    mocks.confirmMessage = '';
  });

  test('persists each finished upload and shows its rating once the scan reports one', async () => {
    const rendered = await uploadPosts(2);
    expect(mocks.persistCalls.flatMap((call) => call.images.map((image) => image.url))).toEqual([
      'key-render-1.png',
      'key-render-2.png',
    ]);
    // Absorbing until the status changes below: nothing else takes "Pending" away.
    await expect.element(page.getByTestId('batch-levels')).toHaveTextContent('2 still scanning');
    expect(page.getByTestId('batch-media-scanning').elements()).toHaveLength(2);

    mocks.scanStatus.set(1, { ingestion: 'Scanned', nsfwLevel: 2 });
    mocks.signal?.({ imageId: 99, ingestion: 'Scanned' });
    mocks.signal?.({ imageId: 1, ingestion: 'Scanned' });
    // One refetch for the burst, and none for an image that is not in this batch.
    await vi.waitFor(() => expect(mocks.refetches).toBe(1));
    rendered.rerender(<BatchComposer />);

    await expect.element(page.getByTestId('batch-media-level')).toHaveTextContent('PG-13');
    await expect
      .element(page.getByTestId('batch-levels'))
      .toHaveTextContent('1 PG-13 · 1 still scanning');
    expect(thumbs().map((thumb) => thumb.getAttribute('data-scan'))).toEqual([
      'Scanned',
      'Pending',
    ]);

    await userEvent.click(page.getByRole('button', { name: 'Remove render-1.png' }));
    await expect.poll(() => thumbs().length).toBe(1);
    expect(mocks.removeCalls).toEqual([{ ids: [1] }]);
  });

  test('a blocked image is left out of the plan, the summary says so and it is never sent', async () => {
    mocks.scanStatus.set(2, { ingestion: 'Blocked', blockedFor: 'minor' });
    await uploadPosts(3, { expectedPosts: 2 });
    await expect
      .element(page.getByTestId('batch-blocked'))
      .toHaveTextContent("1 blocked and won't be posted");
    const blocked = thumbs().find((thumb) => thumb.getAttribute('data-scan') === 'Blocked');
    expect(blocked?.textContent).toContain('Blocked');

    await userEvent.click(page.getByTestId('batch-review-button'));
    await expect
      .element(page.getByTestId('batch-review-scan-note'))
      .toHaveTextContent('2 still scanning');
    expect(page.getByTestId('batch-review-row').elements()).toHaveLength(2);
    const schedule = page.getByTestId('batch-schedule-button');
    await expect.element(schedule).toBeEnabled();
    await userEvent.click(schedule);

    await expect
      .element(page.getByTestId('batch-success-summary'))
      .toHaveTextContent('2 posts scheduled');
    expect(mocks.confirmMessage).toContain('2 images are still scanning');
    expect(
      mocks.scheduleCalls.flatMap((call) => call.posts.flatMap((post) => post.images))
    ).toEqual([{ imageId: 1 }, { imageId: 3 }]);
  });

  test('a persist that fails reads as a failed upload and retries without uploading again', async () => {
    mocks.persistFailUrls = ['key-render-2.png'];
    const rendered = await renderWithProviders(<BatchComposer />);
    await userEvent.upload(await fileInput(), [
      new File(['x'], 'render-1.png', { type: 'image/png' }),
      new File(['x'], 'render-2.png', { type: 'image/png' }),
    ]);
    await expect
      .element(page.getByTestId('batch-summary-rail'))
      .toHaveTextContent('2 uploads failed');
    await expect.element(page.getByTestId('batch-review-button')).toBeDisabled();
    expect(thumbs().map((thumb) => thumb.textContent)).toEqual(['Failed', 'Failed']);

    mocks.persistFailUrls = [];
    await userEvent.click(page.getByRole('button', { name: /Retry all/ }));

    await expect.element(page.getByTestId('batch-grouping-summary')).toHaveTextContent('2 posts');
    expect(mocks.persistCalls).toHaveLength(2);
    expect(thumbs()).toHaveLength(2);
    rendered.unmount();
  });

  test('a reload drops an upload the server no longer holds', async () => {
    const rendered = await uploadPosts(3);
    await vi.waitFor(() => {
      const [draft] = [...mocks.drafts.values()] as { media: { imageId?: number }[] }[];
      expect(draft?.media.map((item) => item.imageId)).toEqual([1, 2, 3]);
    });
    mocks.scanMissing.add(2);

    rendered.rerender(<div data-testid="between-reloads" />);
    await expect.element(page.getByTestId('between-reloads')).toBeInTheDocument();
    rendered.rerender(<BatchComposer />);

    await expect.element(page.getByTestId('batch-grouping-summary')).toHaveTextContent('2 posts');
    await expect.poll(() => thumbs().length).toBe(2);
    expect(thumbs().map((thumb) => thumb.querySelector('img')?.getAttribute('src'))).toEqual([
      expect.stringContaining('key-render-1.png'),
      expect.stringContaining('key-render-3.png'),
    ]);
  });

  test('a reload brings every uploaded image back from the draft', async () => {
    const rendered = await uploadPosts(3);
    expect(page.getByTestId('batch-media-thumb').elements()).toHaveLength(3);
    await vi.waitFor(() => {
      const [draft] = [...mocks.drafts.values()] as { media: unknown[] }[];
      expect(draft?.media).toHaveLength(3);
    });

    rendered.rerender(<div data-testid="between-reloads" />);
    await expect.element(page.getByTestId('between-reloads')).toBeInTheDocument();
    expect(page.getByTestId('batch-media-thumb').elements()).toHaveLength(0);
    rendered.rerender(<BatchComposer />);

    await expect.element(page.getByTestId('batch-grouping-summary')).toHaveTextContent('3 posts');
    await expect.poll(() => page.getByTestId('batch-media-thumb').elements().length).toBe(3);
    const thumbs = page.getByTestId('batch-media-thumb').elements();
    expect(thumbs.map((thumb) => thumb.getAttribute('data-status'))).toEqual([
      'added',
      'added',
      'added',
    ]);
    expect(thumbs.map((thumb) => thumb.querySelector('img')?.getAttribute('src'))).toEqual(
      expect.arrayContaining([expect.stringContaining('key-render-1.png')])
    );
  });

  test('a model picked in the composer fills {model} and {version} in the titles', async () => {
    await uploadPosts(2);
    await userEvent.click(page.getByTestId('batch-pick-promoted'));
    await expect.element(page.getByTestId('batch-promoted')).toHaveTextContent('Neon Noir v2.0');
    const template = page.getByTestId('batch-title-template');
    await expect.element(template).toHaveValue('{model} — {n}');
    await userEvent.fill(template, '{model} {version} #{n}');
    await userEvent.click(page.getByRole('radio', { name: 'List' }));
    await vi.waitFor(() => {
      const rows = page.getByTestId('batch-preview-list').element().querySelectorAll('tr');
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toContain('Neon Noir v2.0 #1');
      expect(rows[1].textContent).toContain('Neon Noir v2.0 #2');
    });
  });

  test('preview times never land on the hour', async () => {
    await uploadPosts(POST_COUNT);
    await userEvent.click(page.getByRole('radio', { name: 'List' }));
    await vi.waitFor(() => {
      const cells = page.getByTestId('batch-preview-time').elements();
      expect(cells).toHaveLength(POST_COUNT);
      for (const cell of cells) expect(cell.textContent).not.toMatch(/:00 [AP]M$/);
    });
  });

  test('Review stays disabled with the reason while the validator reports issues', async () => {
    mocks.validateResult = {
      ok: false,
      issues: [{ code: 'cap', day: '2026-10-08', message: '2026-10-08 would have 7 posts' }],
      dailyLimit: 6,
      perDay: [],
    };
    await uploadPosts(POST_COUNT);
    const review = page.getByTestId('batch-review-button');
    await expect.element(review).toBeDisabled();
    await expect
      .element(page.getByTestId('batch-summary-rail'))
      .toHaveTextContent('Fix 1 conflict to continue');
    await expect
      .element(page.getByTestId('batch-issues'))
      .toHaveTextContent('2026-10-08 would have 7 posts');
  });

  test('schedules in chunks with the shared resources and reports the created count', async () => {
    await uploadPosts(POST_COUNT);
    // The picker is the mocked registry dialog; it answers with version 42.
    await userEvent.click(page.getByRole('button', { name: 'Add resource' }));
    await expect
      .element(page.getByRole('button', { name: 'Add resource (42)' }))
      .toBeInTheDocument();
    const review = page.getByTestId('batch-review-button');
    await expect.element(review).toBeEnabled();
    await userEvent.click(review);

    const schedule = page.getByTestId('batch-schedule-button');
    await expect.element(schedule).toBeEnabled();
    await userEvent.click(schedule);

    await expect
      .element(page.getByTestId('batch-success-summary'))
      .toHaveTextContent(`${POST_COUNT} posts scheduled`);
    expect(mocks.scheduleCalls.map((call) => call.posts.length)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(mocks.scheduleCalls[0].posts.map((post) => post.images)).toEqual([
      [{ imageId: 1 }],
      [{ imageId: 2 }],
    ]);
    expect(mocks.scheduleCalls.map((call) => call.resourceIds)).toEqual(
      Array.from({ length: 6 }, () => [42])
    );
  });

  test('the success screen closes on Escape and leaves a fresh composer', async () => {
    await uploadPosts(POST_COUNT);
    await userEvent.click(page.getByTestId('batch-review-button'));
    const schedule = page.getByTestId('batch-schedule-button');
    await expect.element(schedule).toBeEnabled();
    await userEvent.click(schedule);
    await expect
      .element(page.getByTestId('batch-success-summary'))
      .toHaveTextContent(`${POST_COUNT} posts scheduled`);

    await userEvent.keyboard('{Escape}');

    await expect.element(page.getByTestId('batch-progress-modal')).not.toBeInTheDocument();
    await expect.element(page.getByTestId('batch-review-button')).toBeInTheDocument();
  });

  test('submits each chunk once under StrictMode, with a key per post', async () => {
    await uploadPosts(POST_COUNT, { strict: true });
    await userEvent.click(page.getByTestId('batch-review-button'));
    const schedule = page.getByTestId('batch-schedule-button');
    await expect.element(schedule).toBeEnabled();
    await userEvent.click(schedule);

    await expect
      .element(page.getByTestId('batch-success-summary'))
      .toHaveTextContent(`${POST_COUNT} posts scheduled`);
    expect(mocks.scheduleCalls.map((call) => call.posts.length)).toEqual([2, 2, 2, 2, 2, 2]);
    const keys = mocks.scheduleCalls.flatMap((call) => call.posts.map((post) => post.clientKey));
    expect(new Set(keys).size).toBe(POST_COUNT);
    expect(keys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
  });

  test('an earlier attempt still holding the schedule reads as "still working", not a failure', async () => {
    mocks.throwOnCalls = [1];
    mocks.throwMessage = 'Another scheduling request is still running. Try again in a moment.';
    await uploadPosts(POST_COUNT);
    await userEvent.click(page.getByTestId('batch-review-button'));
    const schedule = page.getByTestId('batch-schedule-button');
    await expect.element(schedule).toBeEnabled();
    await userEvent.click(schedule);

    const modal = page.getByTestId('batch-progress-modal');
    await expect.element(modal).toHaveTextContent('Still finishing an earlier attempt');
    await expect.element(modal).not.toHaveTextContent('failed');

    await userEvent.click(page.getByRole('button', { name: 'Try again' }));
    await expect
      .element(page.getByTestId('batch-success-summary'))
      .toHaveTextContent(`${POST_COUNT} posts scheduled`);
  });

  test('a retry resends the same post keys and shows the time an earlier attempt set', async () => {
    mocks.throwOnCalls = [2];
    await uploadPosts(POST_COUNT);
    await userEvent.click(page.getByTestId('batch-review-button'));
    const schedule = page.getByTestId('batch-schedule-button');
    await expect.element(schedule).toBeEnabled();
    await userEvent.click(schedule);

    const modal = page.getByTestId('batch-progress-modal');
    await expect.element(modal).toHaveTextContent('2 scheduled, 10 failed');
    await expect.element(modal).not.toHaveTextContent('Nothing was created');

    // The server finished the call the client gave up on; it answers the retry with those posts.
    const original = new Date('2030-01-02T03:04:00.000Z');
    mocks.alreadyCreatedAt = original;
    await userEvent.click(page.getByRole('button', { name: 'Retry 10' }));

    const keysOf = (call: number) => mocks.scheduleCalls[call].posts.map((post) => post.clientKey);
    expect(keysOf(2)).toEqual(keysOf(1));
    await expect
      .element(page.getByTestId('batch-recognised'))
      .toHaveTextContent(formatDate(original, 'MMM D, h:mm A'));
  });
});
