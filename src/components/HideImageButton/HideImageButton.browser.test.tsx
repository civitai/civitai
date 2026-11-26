import { cleanNotifications, Notifications } from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { filterPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { HideImageButton } from '~/components/HideImageButton/HideImageButton';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { installTrpcWire, renderWithTrpcWire } from '../../../test/trpcWireHarness';

// The real hidden-preferences hooks over the real tRPC client; only the server is fake. Like
// `toggleHideImage`, `hidden` sets the end state and omitting it flips the current one.
const server = { hidden: new Set<number>(), failNext: false };

let wire: ReturnType<typeof installTrpcWire>;
beforeEach(() => {
  server.hidden.clear();
  server.failNext = false;
  cleanNotifications();
  wire = installTrpcWire({
    'hiddenPreferences.getHidden': () => ({
      hiddenTags: [],
      hiddenUsers: [],
      hiddenModels: [],
      hiddenModel3Ds: [],
      hiddenImages: [...server.hidden].map((id) => ({ id, hidden: true })),
      blockedUsers: [],
      blockedByUsers: [],
    }),
    'hiddenPreferences.toggleHidden': (input) => {
      if (server.failNext) {
        server.failNext = false;
        throw new Error('network down');
      }
      const { data, hidden } = input as { data: Array<{ id: number }>; hidden?: boolean };
      const id = data[0].id;
      const hiding = hidden ?? !server.hidden.has(id);
      if (hiding) server.hidden.add(id);
      else server.hidden.delete(id);
      return { added: [], removed: [], hidden: hiding };
    },
  });
});
afterEach(() => wire.restore());

const image = (id: number) => ({
  id,
  userId: 9,
  nsfwLevel: 1,
  tagIds: [] as number[],
  poi: false,
  minor: false,
  prompt: '',
});

/** Two image cards through the app's own feed filter; a hidden card unmounts its button. */
function Feed() {
  const { hiddenImages } = useHiddenPreferencesData();
  const { items } = filterPreferences({
    type: 'images',
    data: [image(1), image(2)],
    hiddenPreferences: {
      hiddenUsers: new Map(),
      hiddenTags: new Map(),
      hiddenModels: new Map(),
      hiddenModel3Ds: new Map(),
      hiddenImages: new Map(hiddenImages.filter((x) => x.hidden).map((x) => [x.id, true])),
      hiddenLoading: false,
      moderatedTags: [],
      systemHiddenTags: new Map(),
    } as any,
    browsingLevel: 1,
    currentUser: null as any,
    canViewNsfw: true,
  } as any) as { items: Array<{ id: number }> };
  return (
    <>
      {items.map((i) => (
        <div key={i.id} data-testid="card" data-image-id={i.id}>
          <HideImageButton imageId={i.id} />
        </div>
      ))}
    </>
  );
}

const render = (ui: React.ReactElement) =>
  renderWithTrpcWire(
    <>
      <Notifications />
      {ui}
    </>,
    { viewer: { id: 7, username: 'ann' }, flags: {} }
  );

const cardCount = () => document.querySelectorAll('[data-testid="card"]').length;
const toggles = () => wire.callsTo('hiddenPreferences.toggleHidden').map((call) => call.input);

async function hideFirstCard() {
  await render(<Feed />);
  await expect.element(page.getByTestId('card').nth(1)).toBeVisible();
  await userEvent.click(page.getByRole('button', { name: 'Hide' }).first());
  await expect.element(page.getByText('Image hidden')).toBeVisible();
  await expect.poll(cardCount).toBe(1);
}

describe('HideImageButton', () => {
  test('hiding an image offers Undo on the toast, and Undo brings the card back in the feed', async () => {
    await hideFirstCard();

    await userEvent.click(page.getByRole('button', { name: 'Undo' }));

    await expect.poll(cardCount).toBe(2);
    expect(document.querySelector('[data-image-id="1"]')).not.toBeNull();
    await expect.poll(() => page.getByText('Image hidden').elements().length).toBe(0);
  });

  test('Undo asks the server to unhide, not to toggle', async () => {
    await hideFirstCard();
    // Unhidden elsewhere (another tab) before Undo: a toggle would hide it again.
    server.hidden.delete(1);

    await userEvent.click(page.getByRole('button', { name: 'Undo' }));

    await expect.poll(() => toggles().length).toBe(2);
    expect(toggles()[1]).toMatchObject({ kind: 'image', data: [{ id: 1 }], hidden: false });
    await expect.poll(cardCount).toBe(2);
    expect(server.hidden.has(1)).toBe(false);
  });

  test('a failed Undo shows an error, though the hidden card has unmounted', async () => {
    await hideFirstCard();
    server.failNext = true;

    await userEvent.click(page.getByRole('button', { name: 'Undo' }));

    await expect.element(page.getByText('Could not undo')).toBeVisible();
  });

  test('unhiding offers no Undo', async () => {
    server.hidden.add(1);
    await render(<HideImageButton imageId={1} />);
    await userEvent.click(page.getByRole('button', { name: 'Unhide' }));
    await expect.element(page.getByText('Image unhidden')).toBeVisible();
    expect(page.getByRole('button', { name: 'Undo' }).elements()).toHaveLength(0);
  });
});
