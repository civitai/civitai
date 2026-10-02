import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcUtils from '~/utils/trpc';
import type * as UserHoverCardModule from '~/components/UserAvatar/UserHoverCard';
import type * as UserAvatarModule from '~/components/UserAvatar/UserAvatar';

// The SSR render test cannot see this: Mantine's Portal renders nothing on the server whether the dropdown is open
// or not, so "no fetch until opened" and "the list is inside the dropdown" are only observable in a browser.

const mocks = vi.hoisted(() => ({
  hoverCapable: true,
  useQuery: vi.fn((..._a: unknown[]) => ({
    data: [
      { userId: 30, reactions: ['Like', 'Heart'], username: 'reactor-a', deletedAt: null },
      { userId: 20, reactions: ['Cry'], username: null, deletedAt: new Date('2026-01-01') },
    ] as unknown,
    isLoading: false,
    isError: false,
  })),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcUtils>()),
  trpc: { reaction: { getImageReactors: { useQuery: mocks.useQuery } } },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 100 }) }));

vi.mock('~/components/UserAvatar/UserHoverCard', async (importOriginal) => ({
  ...(await importOriginal<typeof UserHoverCardModule>()),
  useHoverCapable: () => mocks.hoverCapable,
}));

// The real avatar needs feature-flag and browsing-level providers this harness does not mount; the row's contract
// with it is only which user it is and whether it links.
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarModule>()),
  UserAvatar: ({
    user,
    linkToProfile,
  }: {
    user: { username?: string | null };
    linkToProfile?: boolean;
  }) => <span data-links={String(!!linkToProfile)}>{user.username ?? '[deleted]'}</span>,
}));

import { renderWithProviders } from '../../../test/component-setup';
import { ImageReactorsPreview } from '~/components/Reaction/ImageReactorsPreview';
import { CREATOR_STUDIO_URL } from '~/shared/constants/creator-studio.constants';

const IMAGE_ID = 555;

const renderBar = () =>
  renderWithProviders(
    <ImageReactorsPreview imageId={IMAGE_ID} ownerId={100}>
      <button type="button">Like reaction</button>
    </ImageReactorsPreview>
  );

beforeEach(() => {
  mocks.useQuery.mockClear();
});

async function expectOpenList() {
  await expect
    .element(page.getByText('Newest accounts first. Only you can see this.'))
    .toBeVisible();
  await expect.element(page.getByText('reactor-a')).toBeVisible();
  expect(mocks.useQuery).toHaveBeenCalledWith({ id: IMAGE_ID });
  expect(page.getByText('reactor-a').element().getAttribute('data-links')).toBe('true');
  expect(page.getByText('[deleted]').element().getAttribute('data-links')).toBe('false');
  expect(
    page.getByRole('link', { name: 'View all in Creator Studio' }).element().getAttribute('href')
  ).toBe(`${CREATOR_STUDIO_URL}/analytics/content/image/${IMAGE_ID}`);
}

describe('owner on a hover-capable pointer', () => {
  test('nothing is fetched until the bar is hovered, then the list opens in the card', async () => {
    mocks.hoverCapable = true;
    renderBar();

    await expect.element(page.getByRole('button', { name: 'Like reaction' })).toBeVisible();
    expect(mocks.useQuery).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Who reacted');

    await userEvent.hover(page.getByRole('button', { name: 'Like reaction' }));
    await expectOpenList();
  });
});

describe('owner on touch', () => {
  test('nothing is fetched until the "Who reacted" button is tapped, then the list opens', async () => {
    mocks.hoverCapable = false;
    renderBar();

    await expect.element(page.getByRole('button', { name: 'Who reacted' })).toBeVisible();
    expect(mocks.useQuery).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Who reacted' }).click();
    await expectOpenList();
  });
});
