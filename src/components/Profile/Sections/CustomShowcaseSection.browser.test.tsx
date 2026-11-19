import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import { requiresImageDbPath } from '~/server/schema/image.schema';
import type * as ArticleUtils from '~/components/Article/article.utils';
import type * as ImageUtils from '~/components/Image/image.utils';
import type * as ModelUtils from '~/components/Model/model.utils';
import { CustomShowcaseSection } from './CustomShowcaseSection';

// The feeds are mocked: these pin what the section asks for and does with the answer, not the feeds' own filtering.
const { useQueryModels, useQueryArticles, useQueryImages, card } = vi.hoisted(() => ({
  useQueryModels: vi.fn(),
  useQueryArticles: vi.fn(),
  useQueryImages: vi.fn(),
  card: (label: string) =>
    function Card({ data }: { data: { id: number } }) {
      return <div data-testid="card">{`${label} ${data.id}`}</div>;
    },
}));
vi.mock('~/components/Model/model.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelUtils>()),
  useQueryModels,
}));
vi.mock('~/components/Article/article.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleUtils>()),
  useQueryArticles,
}));
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtils>()),
  useQueryImages,
}));
vi.mock(
  '~/components/IntersectionObserver/IntersectionObserverProvider',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useInViewDynamic: () => [{ current: null }, true],
  })
);
vi.mock('~/components/Cards/ModelCard', () => ({ ModelCard: card('model') }));
vi.mock('~/components/Cards/ArticleCard', () => ({ ArticleCard: card('article') }));
vi.mock('~/components/Cards/ImageCard', () => ({ ImageCard: card('image') }));
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  ImagesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const user = { id: 7, username: 'creator' } as never;
const items = [3, 1, 2];
const sectionOf = (type: 'Model' | 'Article' | 'Image') => ({
  id: 'abc',
  type,
  title: 'My best',
  items,
});
const feedReturns = (ids: number[]) => {
  const rows = ids.map((id) => ({ id }));
  useQueryModels.mockReturnValue({ models: rows, isLoading: false });
  useQueryArticles.mockReturnValue({ articles: rows, isLoading: false });
  useQueryImages.mockReturnValue({ images: rows, isLoading: false });
};
const cards = () =>
  [...document.querySelectorAll('[data-testid="card"]')].map((c) => c.textContent);
const renderSection = async (type: 'Model' | 'Article' | 'Image' = 'Model') => {
  const screen = await renderWithProviders(
    <CustomShowcaseSection section={sectionOf(type)} user={user} />
  );
  await vi.waitFor(() =>
    expect(
      useQueryModels.mock.calls.length +
        useQueryArticles.mock.calls.length +
        useQueryImages.mock.calls.length
    ).toBeGreaterThan(0)
  );
  return screen;
};

beforeEach(() => {
  useQueryModels.mockReset();
  useQueryArticles.mockReset();
  useQueryImages.mockReset();
});

describe('CustomShowcaseSection', () => {
  test.each([
    ['Model', useQueryModels, { ids: items, username: 'creator' }],
    ['Article', useQueryArticles, { ids: items, username: 'creator' }],
    ['Image', useQueryImages, { ids: items, userId: 7 }],
  ] as const)(
    'a %s section asks its feed for exactly its items, from their owner',
    async (type, hook, args) => {
      feedReturns(items);
      await renderSection(type);
      expect(hook.mock.calls[0][0]).toMatchObject(args);
    }
  );

  test("an Image section's request reaches the image path that honours ids, for any viewer", async () => {
    feedReturns(items);
    await renderSection('Image');
    // As a visitor's request reaches requiresImageDbPath: the handler withdraws `publishedOnly`
    // for anyone but the owner, so `ids` alone has to carry it.
    expect(
      requiresImageDbPath({ ...useQueryImages.mock.calls[0][0], publishedOnly: undefined })
    ).toBe(true);
  });

  test("renders in the creator's order, not the feed's", async () => {
    feedReturns([1, 2, 3]);
    await renderSection();
    expect(cards()).toEqual(['model 3', 'model 1', 'model 2']);
  });

  test('renders only what the feed returns', async () => {
    feedReturns([1, 2]);
    await renderSection();
    expect(cards()).toEqual(['model 1', 'model 2']);
  });

  // Backstop for a feed that ignores ids and returns other rows.
  test('drops a row the feed returns that is not one of its items', async () => {
    feedReturns([9, 1, 2]);
    await renderSection();
    expect(cards()).toEqual(['model 1', 'model 2']);
  });

  test('a section the feed returns nothing for renders nothing', async () => {
    feedReturns([]);
    const { container } = await renderSection();
    expect(container.textContent).not.toContain('My best');
  });
});
