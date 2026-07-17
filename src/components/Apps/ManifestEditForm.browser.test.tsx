import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * ManifestEditForm — browser-mode render test (report-only in Tekton).
 *
 * Covers the per-scope justification authoring surface: a Textarea is rendered
 * for each declared scope (seeded from the stored manifest's
 * scopeJustifications), and Save submits a `scopeJustifications` map keyed by the
 * declared scopes onto the updateManifest patch. (AI/agent verification of the
 * rationale is deliberately out of scope — the form only CAPTURES it.)
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    useUtils: () => ({
      blocks: { getMyAppManifest: { invalidate: mocks.invalidate } },
    }),
    blocks: {
      updateManifest: {
        useMutation: (opts?: { onSuccess?: (r: unknown) => void }) => ({
          mutate: (vars: unknown) => {
            mocks.mutate(vars);
            void opts?.onSuccess?.({ version: '1.0.1', publishRequestId: 'pr-1' });
          },
          isPending: false,
          error: null,
          data: undefined,
        }),
      },
    },
  },
}));

const { ManifestEditForm } = await import('./ManifestEditForm');

const BASE_MANIFEST = {
  blockId: 'my-block',
  version: '1.0.0',
  name: 'My Block',
  contentRating: 'g',
  scopes: ['models:read:self', 'user:read:self'],
  scopeJustifications: {
    'models:read:self': 'We show the page model in a widget.',
  },
  targets: [],
};

beforeEach(() => {
  mocks.mutate.mockClear();
  mocks.invalidate.mockClear();
});

describe('ManifestEditForm — per-scope justification authoring', () => {
  test('renders a justification input per declared scope, seeded from the manifest', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={BASE_MANIFEST}
      />
    );
    // One Textarea per declared scope, labelled by the scope id.
    await expect
      .element(page.getByRole('textbox', { name: 'models:read:self' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('textbox', { name: 'user:read:self' }))
      .toBeInTheDocument();
    // The seeded justification is pre-filled.
    await expect
      .element(page.getByRole('textbox', { name: 'models:read:self' }))
      .toHaveValue('We show the page model in a widget.');
  });

  test('Save submits scopeJustifications keyed by declared scopes', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={BASE_MANIFEST}
      />
    );
    // Add a justification for the second scope.
    const secondInput = page.getByRole('textbox', { name: 'user:read:self' });
    await userEvent.fill(secondInput, 'We greet the viewer by username.');

    await userEvent.click(page.getByRole('button', { name: 'Save & submit for review' }));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const arg = mocks.mutate.mock.calls[0][0] as {
      patch: { scopeJustifications?: Record<string, string> };
    };
    expect(arg.patch.scopeJustifications).toEqual({
      'models:read:self': 'We show the page model in a widget.',
      'user:read:self': 'We greet the viewer by username.',
    });
  });
});
