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
import type * as IsClientModule from '~/providers/IsClientProvider';

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
const flags = vi.hoisted(() => ({
  // earlyAccessModel off keeps the Paid Access sub-section out of the way for the disclosure tests; the
  // removal test turns it on, because that section is what holds the irreversible warning.
  current: { licensingFee: true, earlyAccessModel: false } as Record<string, boolean>,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => flags.current,
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
// The paid-access section opens with a DismissibleAlert, whose `useIsClient()` throws rather than
// defaulting when the provider isn't mounted — unmocked it takes the whole render down. Spread the real
// module so the provider export stays intact if anything in the graph starts using it.
vi.mock('~/providers/IsClientProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof IsClientModule>()),
  useIsClient: () => true,
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
const accessSwitch = () => page.getByRole('switch', { name: /Charge for access to this version/ });
const rightsCheckbox = () => page.getByRole('checkbox', { name: /I hold the rights to monetize/ });
const feeInput = () => page.getByLabelText('Licensing fee (Buzz)');

// A version that already charges, with an affirmation on record — so the disclosure opens straight onto
// the pricing controls, which is how a creator who already priced this version meets the form.
// Published with a permanent gate: that is what makes the paid-access section configurable (and so the
// early-access-loss warning reachable) without an early-access score.
const chargingVersion = {
  ...(version as object),
  status: 'Published',
  licensingFee: 2,
  licensingFeeSettlementCurrency: 'Buzz',
  paidAccess: {
    endsAt: null,
    timeframeDays: null,
    terms: { download: { price: 5000 } },
  },
  meta: {
    rightsAffirmation: {
      userId: 1,
      affirmedAt: '2026-08-01T00:00:00.000Z',
      version: 1,
      statement: 'x',
    },
  },
} as unknown as React.ComponentProps<typeof ModelVersionUpsertForm>['version'];

function renderChargingForm() {
  flags.current = { licensingFee: true, earlyAccessModel: true };
  renderWithProviders(
    <ModelVersionUpsertForm model={model} version={chargingVersion} onSubmit={vi.fn()}>
      {() => <button type="submit">Save</button>}
    </ModelVersionUpsertForm>
  );
}

beforeEach(() => {
  mutateAsync.mockClear();
  flags.current = { licensingFee: true, earlyAccessModel: false };
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

  // Closing the section on a version that already charges is a removal, and it happens with the priced
  // controls off screen — so the warning, the irreversible-early-access note and the undo all have to live
  // outside them.
  test('warns before removing an existing charge, and restores it on request', async () => {
    renderChargingForm();

    await expect.element(chargeSwitch()).toBeChecked();
    const stored = (feeInput().element() as HTMLInputElement).value;
    expect(Number(stored)).toBeGreaterThan(0);

    await userEvent.click(chargeSwitch());
    expect(feeInput().elements()).toHaveLength(0);
    expect(
      page.getByText(/Saving now removes this version's license fee and paid access/).elements()
    ).toHaveLength(1);
    expect(page.getByText(/your payment for early access will be lost/).elements()).toHaveLength(1);

    await userEvent.click(page.getByRole('button', { name: 'Restore the stored settings' }));
    await expect.element(chargeSwitch()).toBeChecked();
    await expect.element(feeInput()).toBeInTheDocument();
    expect((feeInput().element() as HTMLInputElement).value).toBe(stored);
    // The gate half of the restore, which the fee assertions above can't see.
    await expect.element(accessSwitch()).toBeChecked();
    const price = page.getByLabelText('Price for access').element() as HTMLInputElement;
    expect(price.value.replace(/\D/g, '')).toBe('5000');
  });

  // The alarm is keyed to the values, not the switch: clearing the fee with the section OPEN loses just as
  // much, and a switch-position check cannot see it (`hasExistingCharge` forces the section open).
  test('warns when a stored fee is cleared with the section still open', async () => {
    renderChargingForm();

    await expect.element(feeInput()).toBeInTheDocument();
    await userEvent.fill(feeInput(), '0');
    // Read synchronously right after the edit: the warning is absorbing, so if it isn't here now it is
    // not coming, and a poll would only turn a one-second failure into a fifteen-second one.
    expect(page.getByText(/Saving now removes this version/).elements()).toHaveLength(1);
    // Still open — this is an edit in a labelled field, not a collapse.
    await expect.element(chargeSwitch()).toBeChecked();
  });

  // A private model drops its gate on save (handleSubmit substitutes null), while the form's config still
  // reads non-null — so a warning keyed to the raw config is silent on the one save that removes it.
  test('warns that a private model is about to lose its stored gate', async () => {
    flags.current = { licensingFee: true, earlyAccessModel: true };
    renderWithProviders(
      <ModelVersionUpsertForm
        model={{ ...model, availability: 'Private' } as typeof model}
        version={chargingVersion}
        onSubmit={vi.fn()}
      >
        {() => <button type="submit">Save</button>}
      </ModelVersionUpsertForm>
    );

    // Present at first render (no user action), so read it synchronously behind a stable anchor.
    await expect.element(chargeSwitch()).toBeChecked();
    expect(page.getByText(/Saving now removes this version's paid access/).elements()).toHaveLength(
      1
    );
    // The warning is doing the work precisely BECAUSE the gate editor isn't on screen for a private
    // model — without this the test would still pass if that editor came back.
    expect(accessSwitch().elements()).toHaveLength(0);
    // And no restore affordance: handleSubmit substitutes null for a private model whatever we write.
    expect(
      page.getByRole('button', { name: 'Restore the stored settings' }).elements()
    ).toHaveLength(0);
    // The reason replaces it, rather than the line simply vanishing.
    expect(page.getByText(/A private model can't have paid access/).elements()).toHaveLength(1);
  });

  // A grandfathered version — priced before the affirmation existed — has to tick the box to save at all.
  // Clearing that tick on a switch round-trip that changed nothing puts the creator back in front of
  // "Confirmation required", which is the error this ticket was filed about.
  test('keeps the affirmation through a switch round-trip on a version that already charges', async () => {
    renderWithProviders(
      <ModelVersionUpsertForm
        model={model}
        version={
          { ...(version as object), licensingFee: 2 } as React.ComponentProps<
            typeof ModelVersionUpsertForm
          >['version']
        }
        onSubmit={vi.fn()}
      >
        {() => <button type="submit">Save</button>}
      </ModelVersionUpsertForm>
    );

    await userEvent.click(rightsCheckbox());
    await expect.element(rightsCheckbox()).toBeChecked();

    await userEvent.click(chargeSwitch());
    await userEvent.click(chargeSwitch());
    // Synchronous: the tick is absorbing once the section is back, so polling would only stretch a
    // one-second failure into a fifteen-second one.
    await expect.element(rightsCheckbox()).toBeInTheDocument();
    expect((rightsCheckbox().element() as HTMLInputElement).checked).toBe(true);
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
