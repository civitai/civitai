import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * The monetization section is disclosed in three steps — charge intent, then the rights affirmation,
 * then the pricing controls — and each step must leave nothing behind when it closes. A fee sitting
 * behind a collapsed editor is both an unasked-for charge and a submit the creator can't unblock,
 * which is what shipped before (CU 868kq69rv).
 */

import type * as TrpcModule from '~/utils/trpc';

const mutateAsync = vi.hoisted(() =>
  vi.fn(async (input: unknown) => ({ id: 456, ...(input as object) }))
);

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    modelVersion: {
      getLicensingRoots: { useQuery: () => ({ data: undefined }) },
      getUserEarlyAccessVersions: { useQuery: () => ({ data: [] }) },
      upsert: { useMutation: () => ({ mutateAsync, isPending: false }) },
    },
    useUtils: () => ({
      modelVersion: {
        getById: { invalidate: vi.fn() },
        getByIdForEdit: { invalidate: vi.fn() },
      },
      model: { getById: { invalidate: vi.fn() } },
    }),
  },
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  // earlyAccessModel off keeps the Paid Access sub-section out of the way; this test is about the
  // licensing fee, which is the control that used to render unasked.
  useFeatureFlags: () => ({ licensingFee: true, earlyAccessModel: false }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, tier: 'free', isModerator: false, meta: {} }),
}));
vi.mock('~/components/Buzz/CreatorProgramV2/CreatorProgram.util', () => ({
  useCreatorProgramRequirements: () => ({ requirements: undefined }),
}));
vi.mock('~/components/UserSettings/hooks', () => ({
  useCurrentUserSettings: () => ({ hideDonationGoals: false }),
  useMutateUserSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));
// The description field mounts the whole rich-text editor (tiptap + sticker cosmetics queries), none
// of which this test drives.
vi.mock('~/components/RichTextEditor/RichTextEditorComponent', () => ({
  RichTextEditor: () => <div data-testid="rte" />,
  default: () => <div data-testid="rte" />,
}));

import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';

const model = {
  id: 123,
  name: 'Test model',
  type: 'LORA',
  status: 'Draft',
  availability: 'Public',
  nsfw: false,
  poi: false,
  user: { id: 1 },
} as unknown as React.ComponentProps<typeof ModelVersionUpsertForm>['model'];

const version = {
  id: 456,
  modelId: 123,
  name: 'v1.0',
  baseModel: 'SDXL 1.0',
  trainedWords: ['sks'],
  status: 'Draft',
  licensingFee: 0,
  paidAccess: null,
  donationGoal: null,
  createdAt: null,
  meta: {},
} as unknown as React.ComponentProps<typeof ModelVersionUpsertForm>['version'];

function renderForm(onSubmit: (v?: unknown) => void = vi.fn()) {
  renderWithProviders(
    <ModelVersionUpsertForm model={model} version={version} onSubmit={onSubmit}>
      {() => <button type="submit">Save</button>}
    </ModelVersionUpsertForm>
  );
}

// Koen's case: a first version, where the suggested fee used to be seeded into a visible editor.
// Hypernetwork so the form doesn't also demand trained words, which would block the save for an
// unrelated reason and hide the thing under test.
function renderNewVersionForm(onSubmit: (v?: unknown) => void = vi.fn()) {
  renderWithProviders(
    <ModelVersionUpsertForm
      model={{ ...model, type: 'Hypernetwork' } as typeof model}
      onSubmit={onSubmit}
    >
      {() => <button type="submit">Save</button>}
    </ModelVersionUpsertForm>
  );
}

const chargeSwitch = () => page.getByRole('switch', { name: /I want to charge for this version/ });
const rightsCheckbox = () => page.getByRole('checkbox', { name: /I hold the rights to monetize/ });
const feeInput = () => page.getByLabelText('Licensing fee (Buzz)');

beforeEach(() => {
  mutateAsync.mockClear();
});

describe('ModelVersionUpsertForm — monetization disclosure', () => {
  test('opens with the charge switch alone: no affirmation, no fee editor', async () => {
    renderForm();

    await expect.element(chargeSwitch()).not.toBeChecked();
    expect(rightsCheckbox().elements()).toHaveLength(0);
    expect(feeInput().elements()).toHaveLength(0);
  });

  test('reveals the affirmation first, and the fee editor only after it', async () => {
    renderForm();

    await userEvent.click(chargeSwitch());
    await expect.element(rightsCheckbox()).toBeInTheDocument();
    // The whole point of the ordering: pricing is still not on screen at this step.
    expect(feeInput().elements()).toHaveLength(0);

    await userEvent.click(rightsCheckbox());
    await expect.element(feeInput()).toBeInTheDocument();
    // Seeded on reveal — the suggestion is why the field isn't simply blank.
    expect(Number((feeInput().element() as HTMLInputElement).value)).toBeGreaterThan(0);
  });

  test('leaves no fee behind when the section is closed again', async () => {
    renderForm();

    await userEvent.click(chargeSwitch());
    await userEvent.click(rightsCheckbox());
    await expect.element(feeInput()).toBeInTheDocument();

    await userEvent.click(chargeSwitch());
    expect(feeInput().elements()).toHaveLength(0);

    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ licensingFee: 0 });
  });

  test('a first version saves at no charge without the creator touching monetization', async () => {
    renderNewVersionForm();

    expect(feeInput().elements()).toHaveLength(0);
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ licensingFee: 0 });
  });

  // A pristine edit short-circuits the mutation, so the observable is the form's own onSubmit: it fires
  // only once validation passed, which is what the unasked-for fee used to block.
  test('saves without ever opening the section', async () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);

    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
