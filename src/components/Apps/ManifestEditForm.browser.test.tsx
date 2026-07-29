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

  test('renders the scope selector (checkboxes) instead of a raw scopes textarea', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={BASE_MANIFEST}
      />
    );
    // The declared scopes render as CHECKBOXES (selector), seeded checked.
    await expect
      .element(page.getByRole('checkbox', { name: 'models:read:self' }))
      .toBeChecked();
    await expect
      .element(page.getByRole('checkbox', { name: 'user:read:self' }))
      .toBeChecked();
  });

  test('the deferred "Target slots" editor is GONE from the form', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={BASE_MANIFEST}
      />
    );
    // The "Target slots" heading and its slot checkboxes were removed (slots deferred).
    expect(page.getByText('Target slots').elements()).toHaveLength(0);
    expect(page.getByRole('checkbox', { name: 'model.sidebar_top' }).elements()).toHaveLength(0);
  });

  test('OMITS targets from the patch so the server preserves stored.targets (no strict-schema re-validation of stored slots)', async () => {
    const withTargets = { ...BASE_MANIFEST, targets: [{ slotId: 'model.sidebar_top' }] };
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={withTargets}
      />
    );
    await userEvent.click(page.getByRole('button', { name: 'Save & submit for review' }));
    const arg = mocks.mutate.mock.calls[0][0] as {
      patch: Record<string, unknown>;
    };
    // `targets` is NOT sent: the server merges {...stored, ...patch}, so omitting
    // the key preserves stored.targets verbatim. Re-sending them would re-validate
    // a possibly-malformed stored target against the strict updateManifest schema.
    expect('targets' in arg.patch).toBe(false);
    expect(arg.patch.targets).toBeUndefined();
  });

  test('preserves the existing name / description / content-rating / version fields', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={{ ...BASE_MANIFEST, description: 'Does a thing.' }}
      />
    );
    await expect.element(page.getByRole('textbox', { name: 'Name' })).toHaveValue('My Block');
    await expect
      .element(page.getByRole('textbox', { name: 'Description' }))
      .toHaveValue('Does a thing.');
    // New version defaults to a patch bump of the current version.
    await expect.element(page.getByRole('textbox', { name: 'New version' })).toHaveValue('1.0.1');
    await expect.element(page.getByRole('textbox', { name: 'Block ID (immutable)' })).toHaveValue(
      'my-block'
    );
  });

  test('clearing all justification inputs submits an explicit empty object (not undefined) so stored rationale is overwritten', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={BASE_MANIFEST}
      />
    );
    // BASE_MANIFEST seeds a justification for models:read:self — clear it.
    const seededInput = page.getByRole('textbox', { name: 'models:read:self' });
    await userEvent.clear(seededInput);

    await userEvent.click(page.getByRole('button', { name: 'Save & submit for review' }));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const arg = mocks.mutate.mock.calls[0][0] as {
      patch: { scopeJustifications?: Record<string, string> };
    };
    // Explicit {} — NOT undefined — so the server merge overwrites/clears the
    // previously-stored justifications instead of retaining stale rationale.
    expect(arg.patch.scopeJustifications).toEqual({});
    expect(arg.patch.scopeJustifications).not.toBeUndefined();
  });
});

/**
 * Tagline + Category — the two MANIFEST-GOVERNED store fields the onsite author
 * had no surface for at all. Without them an onsite listing was permanently
 * `tagline = null` / `category = null`, which is exactly what made
 * /apps/my-submissions warn "Missing tagline / category" for a field the
 * developer could not set anywhere.
 */
describe('ManifestEditForm — tagline + category (manifest-governed store fields)', () => {
  test('renders both controls, seeded from the stored manifest', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={{ ...BASE_MANIFEST, tagline: 'Does the thing', category: 'utility' }}
      />
    );
    await expect.element(page.getByRole('textbox', { name: 'Tagline' })).toHaveValue(
      'Does the thing'
    );
    // Mantine Select renders as a combobox whose display value is the LABEL.
    await expect.element(page.getByRole('textbox', { name: 'Category' })).toHaveValue('Utility');
  });

  test('Save includes the trimmed tagline + selected category on the patch', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={{ ...BASE_MANIFEST, category: 'utility' }}
      />
    );
    await userEvent.fill(page.getByRole('textbox', { name: 'Tagline' }), '  A crisp one-liner  ');
    await userEvent.click(page.getByRole('button', { name: 'Save & submit for review' }));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const arg = mocks.mutate.mock.calls[0][0] as { patch: Record<string, unknown> };
    expect(arg.patch.tagline).toBe('A crisp one-liner');
    expect(arg.patch.category).toBe('utility');
  });

  test('an EMPTY tagline / unset category submit as explicit null (so the server clears the manifest key)', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={{ ...BASE_MANIFEST, tagline: 'Old pitch' }}
      />
    );
    await userEvent.clear(page.getByRole('textbox', { name: 'Tagline' }));
    await userEvent.click(page.getByRole('button', { name: 'Save & submit for review' }));

    const arg = mocks.mutate.mock.calls[0][0] as { patch: Record<string, unknown> };
    // NOT undefined — an undefined may be dropped in transit and the server's
    // {...stored, ...patch} merge would then retain the stale value.
    expect(arg.patch.tagline).toBeNull();
    expect(arg.patch.category).toBeNull();
  });

  test('lets the author PICK a category from the marketplace taxonomy', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={BASE_MANIFEST}
      />
    );
    await userEvent.click(page.getByRole('textbox', { name: 'Category' }));
    await userEvent.click(page.getByRole('option', { name: 'Games' }));
    await userEvent.click(page.getByRole('button', { name: 'Save & submit for review' }));

    const arg = mocks.mutate.mock.calls[0][0] as { patch: Record<string, unknown> };
    expect(arg.patch.category).toBe('games');
  });

  test('an over-length tagline shows an error and DISABLES Save (advisory client gate)', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={BASE_MANIFEST}
      />
    );
    await userEvent.fill(page.getByRole('textbox', { name: 'Tagline' }), 'a'.repeat(141));

    await expect
      .element(page.getByText('Tagline must be at most 140 characters'))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Save & submit for review' }))
      .toBeDisabled();
  });

  test('an exactly-at-cap tagline is accepted (Save stays enabled)', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={BASE_MANIFEST}
      />
    );
    await userEvent.fill(page.getByRole('textbox', { name: 'Tagline' }), 'a'.repeat(140));
    await expect
      .element(page.getByRole('button', { name: 'Save & submit for review' }))
      .toBeEnabled();
  });

  test('still OMITS targets from the patch when tagline/category are present (no slot clobber)', async () => {
    renderWithProviders(
      <ManifestEditForm
        appBlockId="app-1"
        slug="my-block"
        currentVersion="1.0.0"
        manifest={{
          ...BASE_MANIFEST,
          targets: [{ slotId: 'model.sidebar_top' }],
          tagline: 'Pitch',
          category: 'games',
        }}
      />
    );
    await userEvent.click(page.getByRole('button', { name: 'Save & submit for review' }));
    const arg = mocks.mutate.mock.calls[0][0] as { patch: Record<string, unknown> };
    expect('targets' in arg.patch).toBe(false);
    expect(arg.patch.tagline).toBe('Pitch');
    expect(arg.patch.category).toBe('games');
  });
});
