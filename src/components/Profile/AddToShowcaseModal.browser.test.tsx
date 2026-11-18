import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const IMAGE = 7;

const state = vi.hoisted(() => ({
  profileShowcases: true,
  user: undefined as unknown,
  addToTop: vi.fn(),
  addToSection: vi.fn(),
  openModal: vi.fn(),
  onClose: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFeatureFlags: () =>
    new Proxy(
      {},
      { get: (_, key) => (key === 'profileShowcases' ? state.profileShowcases : true) }
    ),
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCurrentUser: () => ({ id: 1, username: 'fox' }),
}));
vi.mock('~/components/Dialog/triggers/add-to-showcase', () => ({
  openAddToShowcaseModal: state.openModal,
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showErrorNotification: state.showError,
  showSuccessNotification: vi.fn(),
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: state.onClose, zIndex: 200 }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'userProfile.get': { useQuery: () => ({ data: state.user, isLoading: false }) },
    'userProfile.addEntityToShowcase': {
      useMutation: () => ({ mutateAsync: state.addToTop, isPending: false }),
    },
    'userProfile.addToShowcaseSection': {
      useMutation: () => ({ mutateAsync: state.addToSection, isPending: false }),
    },
  }),
}));

const { Menu } = await import('~/components/MantineOverlays');
const { AddToShowcaseMenuItem } = await import('~/components/Profile/AddToShowcaseMenuItem');
const { default: AddToShowcaseModal } = await import('~/components/Profile/AddToShowcaseModal');

const section = (id: string, items: number[], type = 'Image') => ({
  id,
  type,
  title: `Section ${id}`,
  items,
});
const profileWith = (showcaseSections: unknown[], showcaseItems: unknown[] = []) => ({
  username: 'fox',
  profile: { showcaseSections, showcaseItems },
});

beforeEach(() => {
  state.profileShowcases = true;
  state.user = profileWith([section('a', [1])]);
  for (const fn of [
    state.addToTop,
    state.addToSection,
    state.openModal,
    state.onClose,
    state.showError,
  ])
    fn.mockReset();
  state.addToTop.mockResolvedValue({});
  state.addToSection.mockResolvedValue({ added: true, sections: [] });
});

const renderMenuItem = (entityType: 'Image' | 'Model' = 'Image') =>
  renderWithProviders(
    <Menu opened>
      <Menu.Target>
        <button>menu</button>
      </Menu.Target>
      <Menu.Dropdown>
        <AddToShowcaseMenuItem entityType={entityType} entityId={IMAGE} />
      </Menu.Dropdown>
    </Menu>
  );

describe('Add to Showcase on an image', () => {
  test('with an Images section, it opens the section picker', async () => {
    renderMenuItem();
    await userEvent.click(page.getByRole('menuitem', { name: 'Add to Showcase' }));

    expect(state.openModal).toHaveBeenCalledWith({ props: { imageId: IMAGE, username: 'fox' } });
    expect(state.addToTop).not.toHaveBeenCalled();
  });

  test.each([
    ['the flag is off', false, [section('a', [1])]],
    ['there is no Images section', true, [section('m', [1], 'Model')]],
  ])('when %s, it adds to the top showcase in one click', async (_, flag, sections) => {
    state.profileShowcases = flag;
    state.user = profileWith(sections);
    renderMenuItem();
    await userEvent.click(page.getByRole('menuitem', { name: 'Add to Showcase' }));

    await vi.waitFor(() =>
      expect(state.addToTop).toHaveBeenCalledWith({ entityType: 'Image', entityId: IMAGE })
    );
    expect(state.openModal).not.toHaveBeenCalled();
  });
});

test('on a model, it adds to the top showcase even with Images sections', async () => {
  renderMenuItem('Model');
  await userEvent.click(page.getByRole('menuitem', { name: 'Add to Showcase' }));

  await vi.waitFor(() =>
    expect(state.addToTop).toHaveBeenCalledWith({ entityType: 'Model', entityId: IMAGE })
  );
  expect(state.openModal).not.toHaveBeenCalled();
});

describe('the section picker', () => {
  const full = Array.from({ length: 32 }, (_, i) => 100 + i);

  beforeEach(() => {
    state.user = profileWith(
      [
        section('open', [1, 2]),
        section('has', [IMAGE]),
        section('full', full),
        section('m', [], 'Model'),
      ],
      [{ entityType: 'Image', entityId: IMAGE }]
    );
  });

  const row = (name: string | RegExp) => page.getByRole('button', { name });

  test('offers the top showcase and each Images section, with added and full ones disabled', async () => {
    renderWithProviders(<AddToShowcaseModal imageId={IMAGE} username="fox" />);

    await expect.element(row(/Section open/)).toBeEnabled();
    await expect.element(row(/Section open/)).toHaveTextContent('2/32');
    await expect.element(row(/Section has/)).toBeDisabled();
    await expect.element(row(/Section full/)).toBeDisabled();
    await expect.element(row(/Showcase \(top of profile\)/)).toBeDisabled();
    expect(page.getByRole('button', { name: /Section m/ }).elements()).toHaveLength(0);
  });

  test('picking a section adds the image to it and closes', async () => {
    renderWithProviders(<AddToShowcaseModal imageId={IMAGE} username="fox" />);
    await userEvent.click(row(/Section open/));

    expect(state.addToSection).toHaveBeenCalledWith({
      sectionId: 'open',
      entityType: 'Image',
      entityId: IMAGE,
    });
    await vi.waitFor(() => expect(state.onClose).toHaveBeenCalled());
  });

  test('a refused add leaves the picker open', async () => {
    state.addToSection.mockRejectedValue(new Error('This section is full'));
    renderWithProviders(<AddToShowcaseModal imageId={IMAGE} username="fox" />);
    await userEvent.click(row(/Section open/));

    // The close would follow the refusal, so wait for the refusal's notification first.
    await vi.waitFor(() => expect(state.showError).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.onClose).not.toHaveBeenCalled();
  });
});
