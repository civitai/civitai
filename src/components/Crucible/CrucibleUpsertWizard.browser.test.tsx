import { describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as CurrentUserModule from '~/hooks/useCurrentUser';
import type * as AvailableBuzzModule from '~/components/Buzz/useAvailableBuzz';
import type * as UseBuzzModule from '~/components/Buzz/useBuzz';
import type * as ContentRatingSelectModule from '~/components/Challenge/ContentRatingSelect';
import type * as ModelVersionMultiSelectModule from '~/components/Challenge/ModelVersionMultiSelect';
import type * as CrucibleImageUploadModule from '~/components/Crucible/CrucibleImageUpload';
import type * as CrucibleCardModule from '~/components/Cards/CrucibleCard';
import type * as BuzzButtonModule from '~/components/Buzz/BuzzTransactionButton';
import {
  crucibleCreateDefaultValues,
  type CrucibleCreateFormValues,
} from '~/components/Crucible/crucible-create-form';
import { IsClientProvider } from '~/providers/IsClientProvider';
import type * as TrpcModule from '~/utils/trpc';

/** Everything that needs the network is stubbed; the form and the step logic are real. */

type Version = { id: number; modelName: string; minor: boolean; sfwOnly: boolean };
const mocks = vi.hoisted(() => ({ versions: [] as Version[] }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    modelVersion: {
      getVersionsByIds: {
        useQuery: ({ ids }: { ids: number[] }) => ({
          data: mocks.versions.filter(({ id }) => ids.includes(id)),
          isLoading: false,
        }),
      },
    },
  },
}));

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
  ModelVersionMultiSelect: ({ error }: { error?: string }) => (error ? <p>{error}</p> : null),
}));

// Reads feature flags, which the harness doesn't provide.
vi.mock('~/components/Challenge/ContentRatingSelect', async (importOriginal) => ({
  ...(await importOriginal<typeof ContentRatingSelectModule>()),
  ContentRatingSelect: () => null,
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

describe('CrucibleUpsertWizard — required models held to PG and PG-13', () => {
  const R = 1 | 2 | 4;
  const nextButton = () =>
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Next');

  test('explains the conflict and holds the wizard on the requirements step', async () => {
    mocks.versions = [
      { id: 11, modelName: 'Fine Model', minor: false, sfwOnly: false },
      { id: 12, modelName: 'Held Model', minor: false, sfwOnly: true },
    ];
    renderWithProviders(
      <Harness values={valuesOnStep(2, { nsfwLevel: R, allowedResources: [11, 12] })} />
    );

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Held Model can only be required for PG and PG-13 content'
      )
    );
    expect(document.body.textContent).not.toContain('Fine Model can only');
    expect(nextButton()?.disabled).toBe(true);
  });

  test('says nothing once only PG and PG-13 are allowed', async () => {
    mocks.versions = [{ id: 12, modelName: 'Held Model', minor: true, sfwOnly: false }];
    renderWithProviders(
      <Harness values={valuesOnStep(2, { nsfwLevel: 1 | 2, allowedResources: [12] })} />
    );

    await vi.waitFor(() => expect(nextButton()).toBeTruthy());
    expect(document.body.textContent).not.toContain('can only be required');
    expect(nextButton()!.disabled).toBe(false);
  });
});

describe('CrucibleUpsertWizard — creation limits', () => {
  test('states the running-at-once ladder and the 24-hour create cap when creating', async () => {
    renderWithProviders(<Harness values={valuesOnStep(1)} />);

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Free 1, Founder and Bronze 2, Silver 3, Gold 5')
    );
    expect(document.body.textContent).toContain('at most 5 in any 24 hours');
  });
});

describe('CrucibleUpsertWizard — prizes', () => {
  test('tells the host a creator wins at most one prize', async () => {
    renderWithProviders(<Harness values={valuesOnStep(3)} />);

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Each creator can win at most one prize. A creator who places more than once is paid for their best entry, and the next creator moves up.'
      )
    );
  });
});
