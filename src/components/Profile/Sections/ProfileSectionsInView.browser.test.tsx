import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as BrowsingLevelMod from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as ModelCardContextMod from '~/components/Cards/ModelCardContext';
import type * as ImageUtilsMod from '~/components/Image/image.utils';
import type * as ModelUtilsMod from '~/components/Model/model.utils';
import type * as ReviewUtilsMod from '~/components/ResourceReview/resourceReview.utils';
import type * as TrpcMod from '~/utils/trpc';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { MyImagesSection } from './MyImagesSection';
import { MyModelsSection } from './MyModelsSection';
import { OnSaleSection } from './OnSaleSection';
import { PopularModelsSection } from './PopularModelsSection';
import { RecentReviewsSection } from './RecentReviewsSection';
import { ShowcaseSection } from './ShowcaseSection';

const h = vi.hoisted(() => ({ items: [] as any[] }));
// A real react-query query, so a disabled one reports isLoading=false like production does.
function useFakeQuery(enabled?: boolean) {
  return useQuery({
    queryKey: ['profile-section', enabled],
    queryFn: async () => h.items,
    enabled,
  });
}

vi.mock('~/components/Model/model.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelUtilsMod>()),
  useDumbModelFilters: () => ({ filters: {} }),
  useQueryModels: (_filters: unknown, opts: { enabled?: boolean }) => {
    const q = useFakeQuery(opts.enabled);
    return { models: q.data ?? [], isLoading: q.isLoading, isRefetching: q.isRefetching };
  },
}));
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtilsMod>()),
  useDumbImageFilters: () => ({ filters: {} }),
  useQueryImages: (_filters: unknown, opts: { enabled?: boolean }) => {
    const q = useFakeQuery(opts.enabled);
    return { images: q.data ?? [], isLoading: q.isLoading, isRefetching: q.isRefetching };
  },
}));
vi.mock('~/components/ResourceReview/resourceReview.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ReviewUtilsMod>()),
  useQueryResourceReview: (_filters: unknown, opts: { enabled?: boolean }) => {
    const q = useFakeQuery(opts.enabled);
    return { resourceReviews: q.data ?? [], isLoading: q.isLoading };
  },
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'image.getEntitiesCoverImage': {
      useQuery: (_input: unknown, opts: { enabled?: boolean }) => useFakeQuery(opts.enabled),
    },
  }),
}));
vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data: any[] }) => ({ items: data }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelMod>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Cards/ModelCardContext', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelCardContextMod>()),
  ModelCardContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useModelSaleBadges: () => ({}),
}));
// The cards and grid are not under test; the section body is what must (not) show up.
vi.mock('~/components/Profile/ProfileSection', () => ({
  ProfileSection: () => <div data-testid="section-body" style={{ height: 120 }} />,
  ProfileSectionPreview: () => <div data-testid="section-body" style={{ height: 120 }} />,
  ProfileSectionNoResults: () => null,
}));
vi.mock('~/components/Cards/ModelCard', () => ({ ModelCard: () => null }));
vi.mock('~/components/Cards/ImageCard', () => ({ ImageCard: () => null }));
vi.mock('~/components/Cards/GenericImageCard', () => ({ GenericImageCard: () => null }));
vi.mock('~/components/Image/Providers/ImagesProvider', () => ({
  ImagesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('~/components/HatTurf/TurfSummaryProvider', () => ({
  TurfSummaryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const user = {
  id: 1,
  username: 'someone',
  profile: { showcaseItems: [{ entityId: 1, entityType: 'Model' }] },
} as any;

const model = { id: 1 };
const sections = [
  { name: 'MyModelsSection', Section: MyModelsSection, item: model },
  { name: 'PopularModelsSection', Section: PopularModelsSection, item: model },
  { name: 'OnSaleSection', Section: OnSaleSection, item: model },
  { name: 'MyImagesSection', Section: MyImagesSection, item: { id: 1 } },
  {
    name: 'RecentReviewsSection',
    Section: RecentReviewsSection,
    item: {
      id: 1,
      user: { id: 2 },
      recommended: true,
      createdAt: new Date(),
      model: { id: 1, name: 'm' },
      modelVersion: { id: 1 },
    },
  },
  {
    name: 'ShowcaseSection',
    Section: ShowcaseSection,
    item: { entityId: 1, entityType: 'Model', tags: [] },
  },
];

let providerCount = 0;
// A fresh provider id per mount keeps one test's cached size from leaking into the next.
const mount = (Section: React.ComponentType<any>, providerId: string, top: number) =>
  renderWithProviders(
    <IntersectionObserverProvider id={providerId}>
      <div data-testid="host" style={{ position: 'absolute', top, left: 0, width: 600 }}>
        <Section user={user} />
      </div>
    </IntersectionObserverProvider>
  );

const host = () => document.querySelector<HTMLElement>('[data-testid="host"]')!;
const settle = () => new Promise((r) => setTimeout(r, 300));

beforeEach(() => {
  h.items = [];
});

describe.each(sections)('$name', ({ Section, item }) => {
  test('a section that was scrolled away earlier still mounts its observed wrapper, then loads on return', async () => {
    h.items = [item];
    const providerId = `seed-${providerCount++}`;

    // First visit: no cached size, so the section renders at once; being far below the fold, the
    // observer reports it out of view and the hook caches its height.
    const first = await mount(Section, providerId, 20000);
    await settle();
    await first.unmount();

    // Client-side navigation back: the cached size makes inView start false.
    await mount(Section, providerId, 20000);
    await settle();
    expect(host().firstElementChild).not.toBeNull();
    expect(host().querySelector('[data-testid="section-body"]')).toBeNull();

    host().style.top = '0px';
    await expect
      .poll(() => host().querySelector('[data-testid="section-body"]'), { timeout: 5000 })
      .not.toBeNull();
  });

  test('visible with data renders the section', async () => {
    h.items = [item];
    await mount(Section, `visible-${providerCount++}`, 0);
    await expect
      .poll(() => host().querySelector('[data-testid="section-body"]'), { timeout: 5000 })
      .not.toBeNull();
  });

  test('visible with no data renders nothing', async () => {
    h.items = [];
    await mount(Section, `empty-${providerCount++}`, 0);
    await settle();
    expect(host().firstElementChild).toBeNull();
  });
});
