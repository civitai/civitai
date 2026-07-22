import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Router } from 'next/router';
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * Wizard-level regression for the post step stealing the user mid-upload: with
 * several files on the upload step, the first to finish invalidates the version
 * query, `hasFiles` flips, and an unguarded resume used to navigate to step 3
 * while the rest were still transferring.
 *
 * Asserting on `router.replace` (rather than the hook) is the point — it's what
 * catches the guard being dropped from the wizard itself.
 */

const versionQuery = vi.hoisted(() => ({ data: undefined as unknown, isInitialLoading: false }));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    modelVersion: {
      getByIdForEdit: { useQuery: () => versionQuery },
      publishPrivateModelVersion: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    useUtils: () => ({}),
  },
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({}) }));

// The wizard's step bodies pull the whole upload/post editor graph, none of which
// this test drives.
vi.mock('~/components/Resource/Files', () => ({
  Files: () => <div data-testid="files" />,
  UploadStepActions: () => <div />,
}));
vi.mock('~/components/Resource/FilesProvider', () => ({
  FilesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/Resource/Forms/ModelVersionUpsertForm', () => ({
  ModelVersionUpsertForm: () => <div />,
}));
vi.mock('~/components/Resource/Forms/PostUpsertForm2', () => ({
  PostUpsertForm2: () => <div data-testid="post-form" />,
}));
vi.mock('~/components/Resource/Forms/TrainingSelectFile', () => ({ default: () => <div /> }));
vi.mock('~/store/s3-upload.store', () => ({
  useS3UploadStore: () => ({ getStatus: () => ({ uploading: 0, error: 0, aborted: 0 }) }),
}));

import { ModelVersionWizard } from '~/components/Resource/Wizard/ModelVersionWizard';

const MODEL_ID = 123;
const VERSION_ID = 456;

function makeVersion({ fileCount }: { fileCount: number }) {
  return {
    id: VERSION_ID,
    name: 'v1',
    files: Array.from({ length: fileCount }, (_, i) => ({ id: i + 1, name: `file-${i}.safetensors` })),
    posts: [],
    model: { id: MODEL_ID, name: 'Test model', user: { id: 1 } },
  };
}

function setVersion(version: unknown) {
  versionQuery.data = version;
}

const router = Router as unknown as {
  replace: ReturnType<typeof vi.fn>;
  query: Record<string, unknown>;
  pathname: string;
};

beforeEach(() => {
  router.replace.mockClear();
  router.query = { id: String(MODEL_ID), versionId: String(VERSION_ID), step: '2' };
  router.pathname = '/models/[id]/model-versions/[versionId]/wizard';
  versionQuery.isInitialLoading = false;
});

describe('ModelVersionWizard auto-resume', () => {
  test('resumes a file-less draft to the upload step, once', async () => {
    setVersion(makeVersion({ fileCount: 0 }));
    await renderWithProviders(<ModelVersionWizard />);

    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(router.replace.mock.calls[0][0]).toContain('step=2');
  });

  test('the first of several uploads finishing does NOT navigate to the post step', async () => {
    setVersion(makeVersion({ fileCount: 0 }));
    const { rerender } = await renderWithProviders(<ModelVersionWizard />);

    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(router.replace.mock.calls[0][0]).toContain('step=2');

    // First upload lands → version query invalidated → refetch returns a file.
    setVersion(makeVersion({ fileCount: 1 }));
    await rerender(<ModelVersionWizard />);

    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(router.replace.mock.calls.some((call) => String(call[0]).includes('step=3'))).toBe(false);
  });

  test('a draft that already has files still resumes forward to the post step', async () => {
    setVersion(makeVersion({ fileCount: 2 }));
    await renderWithProviders(<ModelVersionWizard />);

    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(router.replace.mock.calls[0][0]).toContain('step=3');
  });
});
