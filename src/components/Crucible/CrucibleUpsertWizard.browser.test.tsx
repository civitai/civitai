import { beforeEach, describe, expect, test, vi } from 'vitest';
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

/**
 * Free entries are for official contests: the server refuses them from anyone but a moderator,
 * so the wizard offers the field to moderators only. Everything that needs the network is stubbed;
 * the form and the step logic are real.
 */

const mocks = vi.hoisted(() => ({ isModerator: false }));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUserModule>()),
  useCurrentUser: () => ({ id: 4, isModerator: mocks.isModerator }),
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

const freeEntriesInput = () =>
  [...document.querySelectorAll('label')].find((label) =>
    label.textContent?.includes('Free Entries per User')
  );

beforeEach(() => {
  mocks.isModerator = false;
});

describe('CrucibleUpsertWizard — free entries', () => {
  test('offers free entries to a moderator', async () => {
    mocks.isModerator = true;
    renderWithProviders(<Harness values={valuesOnStep(2)} />);

    await vi.waitFor(() => expect(freeEntriesInput()).toBeTruthy());
  });

  test('does not offer them to anyone else', async () => {
    renderWithProviders(<Harness values={valuesOnStep(2)} />);

    // Rendered alongside the field it would sit under, so its absence is not a step still loading.
    await vi.waitFor(() => expect(document.body.textContent).toContain('Entry Limit per User'));
    expect(freeEntriesInput()).toBeUndefined();
  });

  test('flags more free entries than the entry limit', async () => {
    mocks.isModerator = true;
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
    mocks.isModerator = true;
    renderWithProviders(
      <Harness values={valuesOnStep(4, { entryLimit: 3, freeEntriesPerUser: 1 })} />
    );

    await vi.waitFor(() => expect(document.body.textContent).toContain('First entry free'));
  });
});
