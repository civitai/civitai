import { describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as CurrentUserModule from '~/hooks/useCurrentUser';
import type * as AvailableBuzzModule from '~/components/Buzz/useAvailableBuzz';
import type * as UseBuzzModule from '~/components/Buzz/useBuzz';
import type * as ModelVersionMultiSelectModule from '~/components/Challenge/ModelVersionMultiSelect';
import type * as CrucibleImageUploadModule from '~/components/Crucible/CrucibleImageUpload';
import type * as CrucibleCardModule from '~/components/Cards/CrucibleCard';
import type * as BuzzButtonModule from '~/components/Buzz/BuzzTransactionButton';
import {
  crucibleCreateDefaultValues,
  type CrucibleCreateFormValues,
} from '~/components/Crucible/crucible-create-form';
import { IsClientProvider } from '~/providers/IsClientProvider';

/** Everything that needs the network is stubbed; the form and the step logic are real. */

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUserModule>()),
  useCurrentUser: () => ({ id: 4, isModerator: false }),
}));

vi.mock('~/components/Buzz/useAvailableBuzz', async (importOriginal) => ({
  ...(await importOriginal<typeof AvailableBuzzModule>()),
  useAvailableBuzz: () => ['yellow'],
}));

vi.mock('~/components/Buzz/useBuzz', async (importOriginal) => ({
  ...(await importOriginal<typeof UseBuzzModule>()),
  useQueryBuzz: () => ({ data: { accounts: [] } }),
}));

vi.mock('~/components/Challenge/ModelVersionMultiSelect', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionMultiSelectModule>()),
  ModelVersionMultiSelect: () => null,
}));

vi.mock('~/components/Crucible/CrucibleImageUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleImageUploadModule>()),
  CrucibleImageUpload: () => null,
}));

vi.mock('~/components/Cards/CrucibleCard', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleCardModule>()),
  CrucibleCard: () => null,
}));

vi.mock('~/components/Buzz/BuzzTransactionButton', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzButtonModule>()),
  BuzzTransactionButton: () => null,
}));

const { CrucibleUpsertWizard, useCrucibleWizardForm } = await import(
  '~/components/Crucible/CrucibleUpsertWizard'
);

// Step 1 passes (name + cover), so the wizard opens on the step asked for.
const valuesOnStep = (
  step: number,
  overrides: Partial<CrucibleCreateFormValues> = {}
): CrucibleCreateFormValues => ({
  ...crucibleCreateDefaultValues,
  name: 'Official contest',
  coverImage: { url: '6a1c3f3d-29e5-49c1-816f-bfc0f7c5c900', width: 512, height: 704 },
  buzzType: 'yellow',
  step,
  ...overrides,
});

function Harness({ values }: { values: CrucibleCreateFormValues }) {
  const form = useCrucibleWizardForm(values);
  return (
    <IsClientProvider>
      <CrucibleUpsertWizard form={form} loading={false} onSubmit={vi.fn()} />
    </IsClientProvider>
  );
}

const freeEntriesInput = () => {
  const label = [...document.querySelectorAll('label')].find((label) =>
    label.textContent?.includes('Free Entries per User')
  );
  return label ? (document.getElementById(label.htmlFor) as HTMLInputElement | null) : undefined;
};

describe('CrucibleUpsertWizard — free entries', () => {
  // Deliberately not moderator-only.
  test('offers free entries to a host who is not a moderator', async () => {
    renderWithProviders(<Harness values={valuesOnStep(2)} />);

    await vi.waitFor(() => expect(freeEntriesInput()).toBeTruthy());
    expect(freeEntriesInput()!.disabled).toBe(false);
  });

  test('flags more free entries than the entry limit', async () => {
    renderWithProviders(
      <Harness values={valuesOnStep(2, { entryLimit: 1, freeEntriesPerUser: 2 })} />
    );

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Free entries cannot exceed the entry limit per user'
      )
    );
  });

  test('shows them on the review step', async () => {
    renderWithProviders(
      <Harness values={valuesOnStep(4, { entryLimit: 3, freeEntriesPerUser: 1 })} />
    );

    await vi.waitFor(() => expect(document.body.textContent).toContain('First entry free'));
  });
});
