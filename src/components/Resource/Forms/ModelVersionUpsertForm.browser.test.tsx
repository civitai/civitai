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
import type { ModelVersionTerms } from '@civitai/buzz';

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
const currentUser = vi.hoisted(() => ({
  value: { id: 1, tier: 'free', isModerator: false, meta: {} } as Record<string, unknown>,
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => currentUser.value,
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
const accessSwitch = () => page.getByRole('switch', { name: /Charge for access to this version/ });
const feeSwitch = () =>
  page.getByRole('switch', { name: /Charge a fee to generate with this version/ });
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
  currentUser.value = { id: 1, tier: 'free', isModerator: false, meta: {} };
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
    // Each way to charge has its own opt-in: the fee editor waits on its own switch.
    expect(feeInput().elements()).toHaveLength(0);
    await userEvent.click(feeSwitch());
    await expect.element(feeInput()).toBeInTheDocument();
    // Seeded on reveal — the suggestion is why the field isn't simply blank.
    expect(Number((feeInput().element() as HTMLInputElement).value)).toBeGreaterThan(0);
  });

  test('leaves no fee behind when the section is closed again', async () => {
    renderForm();

    await userEvent.click(chargeSwitch());
    await userEvent.click(rightsCheckbox());
    await userEvent.click(feeSwitch());
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

  // The fee switch owns the fee the way the access switch owns the gate: closing it takes the value with
  // it, or the card would hide a charge that still submits.
  test('closing the fee switch clears the fee it revealed', async () => {
    renderForm();

    await userEvent.click(chargeSwitch());
    await userEvent.click(rightsCheckbox());
    await userEvent.click(feeSwitch());
    await expect.element(feeInput()).toBeInTheDocument();

    await userEvent.click(feeSwitch());
    expect(feeInput().elements()).toHaveLength(0);

    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ licensingFee: 0 });
  });

  // The generation radio is local state over a config the toggle replaces wholesale, so a round-trip used
  // to leave "Free for everyone" selected above a config that charges.
  //
  // The radio read is what catches a revert: the SUBMITTED terms are identical either way, because the
  // rebuilt config never carried the free grant — the bug was only ever that the screen lied about it. The
  // payload assertions guard the opposite mistake, "fixing" this by making the config follow the stale
  // radio, which would ship a free grant nobody chose.
  test('the generation choice and the submitted price agree after a toggle round-trip', async () => {
    // Stored price differs from the price a fresh config seeds, so the round-trip leaves the form
    // genuinely changed and the save runs the mutation instead of short-circuiting as pristine.
    flags.current = { licensingFee: true, earlyAccessModel: true };
    renderWithProviders(
      <ModelVersionUpsertForm
        model={model}
        version={
          {
            ...(chargingVersion as object),
            paidAccess: { endsAt: null, timeframeDays: null, terms: { download: { price: 7000 } } },
          } as React.ComponentProps<typeof ModelVersionUpsertForm>['version']
        }
        onSubmit={vi.fn()}
      >
        {() => <button type="submit">Save</button>}
      </ModelVersionUpsertForm>
    );

    const freeRadio = page.getByRole('radio', { name: 'Free for everyone' });
    await userEvent.click(freeRadio);
    expect((freeRadio.element() as HTMLInputElement).checked).toBe(true);

    await userEvent.click(accessSwitch());
    await userEvent.click(accessSwitch());

    // Read synchronously behind the switch state: the radio either followed the config on this render
    // or it did not, so polling would only stretch a one-second failure into a fifteen-second one.
    await expect.element(accessSwitch()).toBeChecked();
    expect(
      (page.getByRole('radio', { name: 'Free for everyone' }).element() as HTMLInputElement).checked
    ).toBe(false);
    expect(
      (page.getByRole('radio', { name: 'Same as the access price' }).element() as HTMLInputElement)
        .checked
    ).toBe(true);

    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const terms = (mutateAsync.mock.calls[0][0] as { paidAccess?: { terms?: ModelVersionTerms } })
      .paidAccess?.terms;
    // What the save actually sends: a paid generation grant, never `{ free: true }`.
    expect(terms?.generation).not.toMatchObject({ free: true });
    expect(terms?.download?.price).toBeGreaterThan(0);
  });

  // An affirmation is a named person accepting liability, so it doesn't survive a transfer. Unscoped, the
  // client read the previous owner's record as current, rendered no checkbox, and the save failed
  // server-side with nothing on screen to tick.
  test('asks the new owner to affirm again after the model changed hands', async () => {
    renderWithProviders(
      <ModelVersionUpsertForm
        // The affirmation on the version belongs to user 1; this model now belongs to user 2.
        model={{ ...model, user: { id: 2 } } as typeof model}
        version={chargingVersion}
        onSubmit={vi.fn()}
      >
        {() => <button type="submit">Save</button>}
      </ModelVersionUpsertForm>
    );

    // Present at first render, so anchor on the switch and then read synchronously.
    await expect.element(chargeSwitch()).toBeChecked();
    expect(rightsCheckbox().elements()).toHaveLength(1);
    expect((rightsCheckbox().element() as HTMLInputElement).checked).toBe(false);
  });

  // Scoping the check to the owner made a moderator editing someone else's transferred model face a
  // checkbox the server discards, blocking a save it would have accepted. The carve-out mirrors the
  // server's: a known owner who isn't the current user.
  test("does not block a moderator editing someone else's transferred model", async () => {
    currentUser.value = { id: 3, tier: 'free', isModerator: true, meta: {} };
    renderWithProviders(
      <ModelVersionUpsertForm
        model={{ ...model, user: { id: 2 } } as typeof model}
        version={chargingVersion}
        onSubmit={vi.fn()}
      >
        {() => <button type="submit">Save</button>}
      </ModelVersionUpsertForm>
    );

    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  });

  // The same carve-out has to reach the disclosure, or the only way to the pricing controls is ticking a
  // statement that is false for the moderator — to satisfy a gate that no longer asks for it.
  test('opens the pricing controls for a moderator without asking them to affirm', async () => {
    currentUser.value = { id: 3, tier: 'free', isModerator: true, meta: {} };
    renderWithProviders(
      <ModelVersionUpsertForm
        model={{ ...model, user: { id: 2 } } as typeof model}
        version={version}
        onSubmit={vi.fn()}
      >
        {() => <button type="submit">Save</button>}
      </ModelVersionUpsertForm>
    );

    await userEvent.click(chargeSwitch());
    // Straight to the ways to charge, with no affirmation in between. Anchored on the switch state and
    // then read synchronously, so a regression fails in a second instead of waiting out the matcher.
    await expect.element(chargeSwitch()).toBeChecked();
    expect(feeSwitch().elements()).toHaveLength(1);
    expect(rightsCheckbox().elements()).toHaveLength(0);
  });

  // A control, not a regression test: this passes unscoped too. It catches passing the WRONG id (the
  // model id, or the current user) rather than the scoping being absent.
  test('does not ask again when the affirmation belongs to the current owner', async () => {
    renderChargingForm();

    await expect.element(chargeSwitch()).toBeChecked();
    expect(rightsCheckbox().elements()).toHaveLength(0);
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

  // `model.poi` hid the paid-access editor without touching what the submit sent, so a POI model
  // re-asserted its stored gate from a control that never rendered. The PAYLOAD is the assertion that
  // matters here: the warning alone would still read green while the gate shipped.
  test('a POI model warns about its stored gate, and submits none', async () => {
    flags.current = { licensingFee: true, earlyAccessModel: true };
    renderWithProviders(
      <ModelVersionUpsertForm
        model={{ ...model, poi: true } as typeof model}
        version={chargingVersion}
        onSubmit={vi.fn()}
      >
        {() => <button type="submit">Save</button>}
      </ModelVersionUpsertForm>
    );

    // Present at first render, so anchor on the switch and then read synchronously.
    await expect.element(chargeSwitch()).toBeChecked();
    expect(page.getByText(/Saving now removes this version's paid access/).elements()).toHaveLength(
      1
    );
    expect(
      page.getByText(/A model depicting a real person can't have paid access/).elements()
    ).toHaveLength(1);
    // The gate editor is off screen — which is why the warning has to carry the message.
    expect(accessSwitch().elements()).toHaveLength(0);

    // An edit elsewhere: the stored config is unchanged, so without this the save short-circuits as
    // pristine and the payload assertion below would never run.
    await userEvent.fill(page.getByLabelText('Name'), 'v1.1');
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    // Null because of POI, not because this form never sends a gate: the blank-price test below submits a
    // gate from the same model and version with POI off.
    expect((mutateAsync.mock.calls[0][0] as { paidAccess?: unknown }).paidAccess).toBeNull();
  });

  // Surfacing the POI notice meant rendering the Monetization card whenever a stored charge is going away.
  // That also made this case reachable for the first time — a non-commercial base model clears the gate
  // through an effect rather than at submit — and a removal with no arm of its own falls through to the
  // reversible early-access wording, offering a Restore that puts back a config the server rejects.
  test('a non-commercial base model says why the gate goes, and offers no restore', async () => {
    flags.current = { licensingFee: true, earlyAccessModel: true };
    renderWithProviders(
      <ModelVersionUpsertForm
        model={model}
        // `chargingVersion` as-is: it carries a licensing fee AND a gate, which is the shape that
        // exercises the Restore link — `removingStoredFee` is a left-hand OR in its condition, so a
        // fee-free fixture would pass while the affordance still rendered.
        version={chargingVersion}
        onSubmit={vi.fn()}
      >
        {() => <button type="submit">Save</button>}
      </ModelVersionUpsertForm>
    );

    // Switched in-session, not loaded that way: the clearing effect is keyed to the base model CHANGING,
    // which is what empties the config behind the unmounted editor and makes this removal reachable.
    await expect.element(accessSwitch()).toBeChecked();
    await userEvent.click(page.getByRole('textbox', { name: 'Base Model' }));
    await userEvent.click(page.getByRole('option', { name: 'Ideogram 4.0' }));

    // Anchor on the line that arrives either way, then read the reason synchronously: on a revert the
    // reason is simply the wrong sentence, and waiting for the right one would spend the full matcher
    // timeout only to report that some text never appeared.
    await expect
      .element(page.getByText(/Saving now removes this version's license fee and paid access/))
      .toBeInTheDocument();
    expect(
      page.getByText(/This base model is licensed for non-commercial use/).elements()
    ).toHaveLength(1);
    // The wrong sentence for this removal: nothing here is about early access ending.
    expect(page.getByText(/your payment for early access will be lost/).elements()).toHaveLength(0);
    // The way back is the picker, not a link, and the sentence has to say so — unlike POI and private,
    // this removal is reversible.
    expect(
      page.getByText(/Switch back to a commercial base model to restore it/).elements()
    ).toHaveLength(1);
    // And no restore: it would re-apply a fee and a gate the server rejects for this base model — the
    // fee behind an editor that is unmounted for non-commercial base models, which is the hidden charge
    // the disclosure work exists to prevent.
    expect(
      page.getByRole('button', { name: 'Restore the stored settings' }).elements()
    ).toHaveLength(0);
  });

  // "A cheaper generation-only price" with an empty box used to save a generation grant carrying no price
  // of its own — which `generationPrice` charges at the DOWNLOAD price. The stored terms are identical to a
  // deliberate "same as the access price", so nothing after this form can tell the two apart.
  test('refuses a blank generation-only price, and saves the one that is typed', async () => {
    flags.current = { licensingFee: true, earlyAccessModel: true };
    renderWithProviders(
      <ModelVersionUpsertForm model={model} version={chargingVersion} onSubmit={vi.fn()}>
        {() => <button type="submit">Save</button>}
      </ModelVersionUpsertForm>
    );

    await userEvent.click(page.getByRole('radio', { name: 'A cheaper generation-only price' }));
    // By placeholder: the label text also matches the radio that reveals this input.
    const genPrice = page.getByPlaceholder('Generation-only price');
    await expect.element(genPrice).toBeInTheDocument();

    // An edit elsewhere, so the save is not short-circuited as pristine: without it the unfixed build
    // writes nothing either, and the test would pass against the bug it exists to catch.
    await userEvent.fill(page.getByLabelText('Name'), 'v1.1');
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    // Both outcomes in one poll, on a short budget. `expect.element` alone would spend the full 15 s
    // matcher timeout on a revert and then report only that some text never appeared; this names the thing
    // that actually went wrong — the blank price was saved — in about a second.
    // Both outcomes in one poll, on the suite's default budget: a revert throws the named error on every
    // attempt, so that is what the timeout reports — rather than fifteen seconds of `expect.element`
    // waiting for text that never comes and then blaming the text.
    await vi.waitFor(() => {
      if (mutateAsync.mock.calls.length)
        throw new Error('saved a blank generation-only price instead of refusing it');
      expect(page.getByText(/Enter a generation-only price/).elements()).toHaveLength(1);
    });

    // The positive control: the same save goes through once the price exists, so the refusal above is the
    // missing price and not the form being unsavable for some unrelated reason.
    // 400, not a round 1000: the free tier's paid-access cap bounds this input at 500, and a value above
    // it is clamped rather than rejected — which would make the payload assertion below read as a bug.
    await userEvent.fill(genPrice, '400');
    await userEvent.click(page.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const terms = (mutateAsync.mock.calls[0][0] as { paidAccess?: { terms?: ModelVersionTerms } })
      .paidAccess?.terms;
    expect(terms?.generation).toMatchObject({ price: 400 });
    expect(terms?.download?.price).toBe(5000);
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
