import { StrictMode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import type * as BrowsingLevelModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as DialogStoreModule from '~/components/Dialog/dialogStore';
import type { MediaUploadOnCompleteProps, UseMediaUploadProps } from '~/hooks/useMediaUpload';
import { formatDate } from '~/utils/date-helpers';

const POST_COUNT = 12;

const mocks = vi.hoisted(() => ({
  validateResult: {
    ok: true,
    issues: [] as { code: string; message: string; index?: number; day?: string }[],
    dailyLimit: 100,
    perDay: [] as { day: string; existing: number; incoming: number }[],
  },
  scheduleCalls: [] as { posts: { clientKey?: string; publishedAt: Date }[] }[],
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
    trigger: (args: { props?: { onConfirm?: () => void } }) => args.props?.onConfirm?.(),
    closeById: () => undefined,
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
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'post.validateBatchSchedule': {
      useQuery: () => ({ data: mocks.validateResult, isFetching: false, isLoading: false }),
    },
    'post.scheduleBatch': {
      useMutation: () => ({
        isPending: false,
        mutateAsync: async (input: { posts: { clientKey?: string; publishedAt: Date }[] }) => {
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
}));

const { BatchComposer } = await import('./BatchComposer');

function fileInput(): Promise<HTMLInputElement> {
  return vi.waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!el) throw new Error('dropzone file input not found');
    return el;
  });
}

async function uploadPosts(count: number, opts: { strict?: boolean } = {}) {
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
  await expect
    .element(page.getByTestId('batch-grouping-summary'))
    .toHaveTextContent(`${count} posts`);
  return rendered;
}

describe('BatchComposer', () => {
  beforeEach(() => {
    mocks.validateResult = { ok: true, issues: [], dailyLimit: 100, perDay: [] };
    mocks.scheduleCalls = [];
    mocks.throwOnCalls = [];
    mocks.throwMessage = '';
    mocks.alreadyCreatedAt = null;
    mocks.drafts.clear();
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

  test('schedules in chunks and reports the created count', async () => {
    await uploadPosts(POST_COUNT);
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
