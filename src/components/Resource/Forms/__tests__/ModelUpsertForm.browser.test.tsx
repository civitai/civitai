import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';

/**
 * The lock list a moderator's save sends. Only the control the moderator used locks; a value another
 * control's onChange sets locks only when it moves to the restrictive side, and existing locks are
 * kept unless the moderator removes them.
 */

const mutate = vi.hoisted(() => vi.fn());

// Every proc the form does not save through gets react-query's empty result.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const noData = () => ({
    data: undefined,
    error: null,
    status: 'pending',
    isPending: true,
    isLoading: false,
    isFetching: false,
    isError: false,
    isSuccess: false,
    refetch: vi.fn(async () => ({ data: undefined })),
  });
  const inert: Record<string, unknown> = {
    useQuery: noData,
    useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  };
  const modelled: Record<string, Record<string, Record<string, unknown>>> = {
    model: { upsert: { useMutation: () => ({ mutate, isPending: false }) } },
  };
  const proc = (own: Record<string, unknown> = {}) =>
    new Proxy(own, {
      get: (target, key) => (typeof key === 'string' ? target[key] ?? inert[key] : undefined),
    });
  const utils = () =>
    new Proxy(
      {},
      {
        get: () => new Proxy({}, { get: () => ({ invalidate: vi.fn(async () => undefined) }) }),
      }
    );
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: new Proxy(modelled, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined;
        if (key === 'useUtils' || key === 'useContext') return utils;
        const router = target[key] ?? {};
        return new Proxy(router, {
          get: (r, procKey) => (typeof procKey === 'string' ? proc(r[procKey]) : undefined),
        });
      },
    }),
  };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 99, username: 'mod', isModerator: true, meta: {} }),
}));
vi.mock('~/components/Buzz/CreatorProgramV2/CreatorProgram.util', () => ({
  useCreatorProgramRequirements: () => ({ requirements: undefined }),
}));
vi.mock('~/components/UserSettings/hooks', () => ({
  useCurrentUserSettings: () => ({}),
  useMutateUserSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));
// The description field mounts the whole rich-text editor, which nothing here drives.
vi.mock('~/components/RichTextEditor/RichTextEditorComponent', () => ({
  RichTextEditor: () => <div data-testid="rte" />,
  default: () => <div data-testid="rte" />,
}));

import { ModelUpsertForm } from '~/components/Resource/Forms/ModelUpsertForm';

type Model = React.ComponentProps<typeof ModelUpsertForm>['model'];

const baseModel = {
  id: 1,
  name: 'Owner model',
  description: '<p>desc</p>',
  type: 'LORA',
  status: 'Published',
  uploadType: 'Created',
  availability: 'Public',
  nsfw: false,
  poi: false,
  minor: false,
  sfwOnly: false,
  lockedProperties: [] as string[],
  tagsOnModels: [{ id: 5, name: 'character', isCategory: true }],
  user: { id: 1, username: 'owner' },
};

function renderForm(overrides: Partial<typeof baseModel> = {}) {
  renderWithProviders(
    <ModelUpsertForm model={{ ...baseModel, ...overrides } as unknown as Model} onSubmit={vi.fn()}>
      {() => <button type="submit">Save</button>}
    </ModelUpsertForm>
  );
}

async function savedLocks() {
  await page.getByRole('button', { name: 'Save' }).click();
  await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1), { timeout: 5000 });
  return [...(mutate.mock.calls[0][0].lockedProperties as string[])].sort();
}

const matureThemes = () =>
  page.getByRole('checkbox', { name: /Is intended to produce mature themes/ });
const minorBox = () => page.getByRole('checkbox', { name: /Intended to depict a minor character/ });
const sfwOnlyBox = () => page.getByRole('checkbox', { name: /Cannot be used for NSFW generation/ });
const poiRadio = (label: 'Yes' | 'No') => page.getByRole('radio', { name: label, exact: true });

beforeEach(() => {
  mutate.mockClear();
});

describe('ModelUpsertForm moderator locks', () => {
  test('ticking mature themes locks nsfw only; the poi and sfwOnly it clears stay unlocked', async () => {
    renderForm({ poi: true, sfwOnly: true });
    // poi=true disables the mature box; the moderator answers "No" first, which is its own lock.
    await poiRadio('No').click();
    await matureThemes().click();

    expect(await savedLocks()).toEqual(['nsfw', 'poi']);
  });

  test('ticking mature themes on a clean model locks nsfw only', async () => {
    renderForm();
    await matureThemes().click();

    expect(await savedLocks()).toEqual(['nsfw']);
  });

  test('ticking minor locks the set the server locks for minor', async () => {
    renderForm();
    await minorBox().click();

    expect(await savedLocks()).toEqual(['minor', 'nsfw', 'sfwOnly']);
  });

  test('ticking minor locks sfwOnly even when it was already on', async () => {
    renderForm({ sfwOnly: true });
    await minorBox().click();

    expect(await savedLocks()).toEqual(['minor', 'nsfw', 'sfwOnly']);
  });

  test('answering "depicts a real person" locks the set the server locks for poi', async () => {
    renderForm();
    await poiRadio('Yes').click();

    expect(await savedLocks()).toEqual(['nsfw', 'poi', 'sfwOnly']);
  });

  test('a cascade that leaves a restrictive value where it was stored takes no lock', async () => {
    renderForm({ poi: true, minor: true, sfwOnly: true });
    await poiRadio('No').click();

    expect(await savedLocks()).toEqual(['poi']);
  });

  test('locks the form took for a flag are let go when the moderator turns the flag back off', async () => {
    renderForm();
    await poiRadio('Yes').click();
    await poiRadio('No').click();

    expect(await savedLocks()).toEqual(['poi']);
  });

  test('locks the form released come back when the flag is turned on again', async () => {
    renderForm();
    await poiRadio('Yes').click();
    await poiRadio('No').click();
    await poiRadio('Yes').click();

    expect(await savedLocks()).toEqual(['nsfw', 'poi', 'sfwOnly']);
  });

  test('a cascade that turns sfwOnly on locks its set', async () => {
    renderForm({ poi: true, minor: true, sfwOnly: false });
    await poiRadio('No').click();

    expect(await savedLocks()).toEqual(['nsfw', 'poi', 'sfwOnly']);
  });

  test('a stored lock survives a cascade that loosens its field', async () => {
    renderForm({ lockedProperties: ['sfwOnly'], sfwOnly: true });
    await poiRadio('Yes').click();
    await poiRadio('No').click();

    expect(await savedLocks()).toEqual(['poi', 'sfwOnly']);
  });

  test('a lock the moderator removes and adds back is kept when the flag goes off', async () => {
    renderForm();
    await poiRadio('Yes').click();
    const lockInput = page.getByRole('textbox', { name: 'Locked properties' });
    await lockInput.click();
    // An option click toggles it: off, then on again.
    await page.getByRole('option', { name: 'sfwOnly' }).click();
    await page.getByRole('option', { name: 'sfwOnly' }).click();
    await userEvent.keyboard('{Escape}');
    await poiRadio('No').click();

    expect(await savedLocks()).toEqual(['poi', 'sfwOnly']);
  });

  test('re-ticking a minor flag the owner set locks the set the server locks for minor', async () => {
    renderForm({ minor: true, sfwOnly: true });
    await minorBox().click();
    await minorBox().click();

    expect(await savedLocks()).toEqual(['minor', 'nsfw', 'sfwOnly']);
  });

  test('ticking sfwOnly locks the set the server locks for sfwOnly', async () => {
    renderForm();
    await sfwOnlyBox().click();

    expect(await savedLocks()).toEqual(['nsfw', 'sfwOnly']);
  });

  test('a lock the moderator removes stays off through later edits', async () => {
    renderForm();
    await minorBox().click();
    await page.getByRole('textbox', { name: 'Locked properties' }).click();
    await page.getByRole('option', { name: 'nsfw' }).click();
    await userEvent.keyboard('{Escape}');
    await poiRadio('Yes').click();

    expect(await savedLocks()).toEqual(['minor', 'poi', 'sfwOnly']);
  });

  test('a stored lock survives a save that does not touch it', async () => {
    renderForm({ lockedProperties: ['category', 'sfwOnly'], sfwOnly: true });
    await page.getByLabelText(/Name/).first().fill('Renamed by mod');

    expect(await savedLocks()).toEqual(['category', 'sfwOnly']);
    expect(mutate.mock.calls[0][0].name).toBe('Renamed by mod');
  });

  test('ticking a field directly locks it even when the value is permissive', async () => {
    renderForm({ sfwOnly: true });
    await sfwOnlyBox().click();

    expect(await savedLocks()).toEqual(['sfwOnly']);
  });

  test('the moderator can still remove a stored lock', async () => {
    renderForm({ lockedProperties: ['category', 'poi'] });
    // Backspace in an empty MultiSelect search removes the last pill.
    await page.getByRole('textbox', { name: 'Locked properties' }).click();
    await userEvent.keyboard('{Backspace}');
    await userEvent.keyboard('{Escape}');

    expect(await savedLocks()).toEqual(['category']);
  });
});
